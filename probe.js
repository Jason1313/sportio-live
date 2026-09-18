// Measuring one stream with ffprobe.
//
// This came out once, on 2026-08-29, when streamcheck.pro's published
// sweeps replaced it: they cover a whole provider in one request and say
// which channels are dead. It is back for the one kind of provider those
// sweeps cannot describe - a reseller like Flix-Streams, which renumbers
// every channel so no published id matches, and whose names only look
// like they line up. Matching them by name put a 1080p60 badge on FOX 28
// Cedar Rapids, which plays at 720p60: the name found a different Strong
// feed of the same station. Opening the stream is the only reading that
// cannot be about some other feed.
//
// Only the measuring came back. Judging a reading - the bands, the badge
// line, the score - stayed in quality.js, so a tested channel and a
// published one are rated by the same rules.
//
// This is the one part of the app that deliberately opens the provider's
// streams rather than just its lists, which is why it is slow on purpose:
// one probe at a time, with a gap between them. Providers cap concurrent
// connections, and a burst of probes is how an account gets rate limited.

const { execFile } = require('child_process');

// ffprobe ships with ffmpeg, installed in the Dockerfile. Absent on a
// bare `npm start` outside Docker, which is reported plainly rather than
// surfacing as an ENOENT.
const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe';

// How much of the stream to read, in seconds of media.
//
// Bitrate cannot be taken from metadata on a live feed, so it is counted
// off the wire over this window. Twenty was settled on last time against
// a real provider: it bursts roughly the first thirty seconds of media
// and then serves in real time, so twenty sits inside the burst and a
// channel comes back in about ten seconds, while sixty cost about forty.
// Overridable, because the right answer depends on the provider.
const PROBE_SAMPLE_SECONDS = Math.max(
  5,
  Math.min(300, Number(process.env.PROBE_SAMPLE_SECONDS) || 20)
);

// Has to clear the sample window with room for connect time on top, and
// is sized for a provider that paces its output in real time, so one
// that bursts is never cut short.
const PROBE_TIMEOUT_MS = 45000;

// Dropped from the front of every sample. The first keyframe lands in
// the opening of a connection and is several times the size of the
// frames after it, so a window starting on one reads high.
const BITRATE_WARMUP_SECONDS = 2;

// Minimum gap between two probes. Enforced here rather than trusted to
// the page, because the cost of getting it wrong is the provider limiting
// the account, and a page could otherwise fire several at once.
const MIN_PROBE_INTERVAL_MS = 2500;

// "60000/1001" -> 60. Broadcast rates are written as these ratios, and
// "59.94" where somebody expects "60" reads as a different thing. Snapped
// only within 0.1 of a standard rate, so an odd rate shows its real value.
const STANDARD_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120];

function parseFrameRate(ratio) {
  const match = String(ratio || '').match(/^(\d+)\/(\d+)$/);
  if (!match) return null;
  const [, num, den] = match;
  if (Number(den) === 0) return null;
  const fps = Number(num) / Number(den);
  if (!isFinite(fps) || fps <= 0) return null;
  for (const standard of STANDARD_RATES) {
    if (Math.abs(fps - standard) < 0.1) return Math.round(standard);
  }
  return Math.round(fps * 100) / 100;
}

// tt/bb/tb/bt are the interlaced field orders. An interlaced feed and a
// progressive one of the same height are not the same picture - it combs
// on exactly the motion a sports feed is made of - and without this both
// read "1080p".
const INTERLACED_FIELD_ORDERS = new Set(['tt', 'bb', 'tb', 'bt']);

function isInterlaced(fieldOrder) {
  return INTERLACED_FIELD_ORDERS.has(String(fieldOrder || '').toLowerCase());
}

// Video bitrate counted from the packets ffprobe read, or null when there
// were too few to say anything.
function measureVideoBitrate(packets, videoIndex, fps) {
  const video = (packets || [])
    .filter(p => Number(p.stream_index) === Number(videoIndex) && Number(p.size) > 0)
    .map(p => ({ size: Number(p.size), time: Number(p.dts_time) }));
  // A handful of packets is as likely to be one keyframe as a sample.
  if (video.length < 10) return null;

  const timed = video.filter(p => Number.isFinite(p.time));
  if (timed.length < 10) {
    // No usable timestamps. One packet is one frame closely enough to
    // fall back on.
    if (!fps) return null;
    const seconds = video.length / fps;
    const bytes = video.reduce((n, p) => n + p.size, 0);
    return { bitrate: Math.round((bytes * 8) / seconds), seconds };
  }

  const opened = timed.reduce((min, p) => Math.min(min, p.time), Infinity);
  const afterWarmup = timed.filter(p => p.time >= opened + BITRATE_WARMUP_SECONDS);
  // Only skip the warm-up if enough is left to be worth measuring.
  const sample = afterWarmup.length >= 10 ? afterWarmup : timed;

  let bytes = 0;
  let first = Infinity;
  let last = -Infinity;
  for (const packet of sample) {
    bytes += packet.size;
    if (packet.time < first) first = packet.time;
    if (packet.time > last) last = packet.time;
  }
  // The span excludes the last frame's own duration, which on a short
  // sample would overstate the rate.
  const span = (last - first) + (fps ? 1 / fps : 0);
  if (!(span > 0.5)) return null;
  return { bitrate: Math.round((bytes * 8) / span), seconds: span };
}

// The full argument list, and the reduced one the probe used before it
// counted bitrate. ffprobe builds vary, and an older one may reject the
// packet section or -read_intervals; falling back on an option error, and
// only then, still gets a resolution rather than failing every test.
const FFPROBE_OPTION_ERROR = /unrecognized option|unknown option|failed to set value|option .* not found/i;

function ffprobeArgs(url, legacy) {
  if (legacy) {
    return [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=index,codec_type,width,height,avg_frame_rate,r_frame_rate,codec_name,field_order',
      '-of', 'json',
      '-analyzeduration', '3000000',
      '-probesize', '3000000',
      '-rw_timeout', '8000000',
      url,
    ];
  }
  return [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries',
    'stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,field_order' +
    ':packet=size,dts_time,stream_index',
    // The bitrate window. Without it ffprobe reads to the end of the
    // stream, which for a live one is never.
    '-read_intervals', `%+${PROBE_SAMPLE_SECONDS}`,
    '-of', 'json',
    '-analyzeduration', '3000000',
    '-probesize', '3000000',
    // Stops ffprobe hanging on a socket that connects but never sends.
    '-rw_timeout', '8000000',
    url,
  ];
}

function runFfprobe(url, legacy) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE_BIN, ffprobeArgs(url, legacy), {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') return reject(new Error('ffprobe is not installed on the server'));
        if (err.killed) return reject(new Error('Timed out - the stream did not respond'));
        // The LAST line of ffprobe's complaint, which is where it says
        // what finally happened - "Server returned 403 Forbidden" comes
        // after the lines about what it was trying. It can name the URL,
        // which carries the account password, so anything URL-shaped is
        // cut out before it goes anywhere.
        const lines = String(stderr || err.message).trim().split('\n').map(l => l.trim()).filter(Boolean);
        const message = (lines[lines.length - 1] || 'probe failed')
          .replace(/\bhttps?:\/\/\S+/gi, '<stream>');
        const error = new Error(message);
        if (!legacy && FFPROBE_OPTION_ERROR.test(message)) error.optionError = true;
        return reject(error);
      }
      resolve(stdout);
    });
  });
}

let lastProbeStartedAt = 0;
let queue = Promise.resolve();

// Measures one stream. Resolves to
//   { ok: true, width, height, fps, interlaced, codec, bitrate, sampleSeconds }
//   { ok: false, error }
// and never rejects: a stream that will not open is an ordinary answer
// here - finding those is half of what testing is for.
//
// Queued, so two callers never have probes open at once, and spaced by
// MIN_PROBE_INTERVAL_MS from the start of the last one.
function probeStream(url) {
  const run = queue.then(async () => {
    const wait = MIN_PROBE_INTERVAL_MS - (Date.now() - lastProbeStartedAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastProbeStartedAt = Date.now();
    return measure(url);
  });
  // The queue carries on whatever this one did.
  queue = run.catch(() => {});
  return run;
}

async function measure(url) {
  try {
    let stdout;
    try {
      stdout = await runFfprobe(url, false);
    } catch (err) {
      if (!err.optionError) throw err;
      console.error('[Probe] ffprobe rejected the detailed options, falling back:', err.message);
      stdout = await runFfprobe(url, true);
    }
    const parsed = JSON.parse(stdout);
    const video = (parsed.streams || []).find(s => s.codec_type === 'video') || (parsed.streams || [])[0];
    if (!video || !video.height) return { ok: false, error: 'No video stream found' };

    const fps = parseFrameRate(video.avg_frame_rate) || parseFrameRate(video.r_frame_rate);
    const measured = measureVideoBitrate(parsed.packets, video.index, fps);
    return {
      ok: true,
      width: video.width || null,
      height: video.height,
      fps,
      interlaced: isInterlaced(video.field_order),
      codec: video.codec_name || null,
      bitrate: measured ? measured.bitrate : null,
      sampleSeconds: measured ? Math.round(measured.seconds * 10) / 10 : null,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  probeStream,
  parseFrameRate,
  isInterlaced,
  measureVideoBitrate,
  PROBE_SAMPLE_SECONDS,
  MIN_PROBE_INTERVAL_MS,
};
