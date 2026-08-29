// Stream quality probing.
//
// Providers routinely list several genuinely different feeds under one
// identical channel name - the same "Sportsnet 360" can be 1080p60 on one
// stream id and 720p30 on another, with the same name, group and tvg-id.
// Nothing in the playlist distinguishes them, so the only way to tell is
// to open the stream and look.
//
// That makes this the one part of the app that deliberately contacts the
// provider's streaming endpoints rather than just its playlist, which is
// why every caller is expected to keep it slow, sequential and opt-in.
// See the throttle below and the caller in server.js.

const { execFile } = require('child_process');
const path = require('path');

// ffprobe ships with ffmpeg, installed in the Dockerfile. Absent on a
// bare `npm start` outside Docker, which is handled explicitly rather
// than surfacing as a confusing ENOENT.
const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe';

// How long to let ffprobe run before giving up. A live stream that hasn't
// produced a decodable frame in this long is not one worth listing.
//
// Raised from 12s when bitrate measurement was added: the probe now holds
// the connection for PROBE_SAMPLE_SECONDS on purpose, and the old ceiling
// left almost no room for connect time on top of that - a healthy but
// slow-to-start stream would have been reported as dead.
const PROBE_TIMEOUT_MS = 25000;

// How much of the stream to actually read. Bitrate cannot be taken from
// metadata on a live feed - see measureVideoBitrate - so it has to be
// counted off the wire, and this is the window it is counted over. Long
// enough to average across a GOP or two (a keyframe is far larger than
// the frames after it, so a one-second sample reads high or low depending
// purely on where it landed), short enough to keep a 20-channel check
// inside a few minutes.
const PROBE_SAMPLE_SECONDS = 8;

// Minimum gap between two probes that actually contact the provider.
// Enforced here rather than trusting the caller, because the cost of
// getting this wrong is the provider rate-limiting or banning the
// account - and a misbehaving page could otherwise fire them in parallel.
// Cache hits bypass this entirely; they contact nothing.
const MIN_PROBE_INTERVAL_MS = 2500;

// Results are cached in memory only, never written to disk. A provider
// can re-encode a channel at any time, and a stale "1080p60" badge that
// survived a restart would be worse than no badge - it would look
// authoritative while being wrong. Restarting clears it; so does the TTL,
// which bounds staleness inside a long-running container.
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const probeCache = new Map(); // url -> { result, probedAt }

let lastProbeStartedAt = 0;

// "60000/1001" -> 59.94 -> 60. Broadcast frame rates are almost always
// expressed as these ratios rather than round numbers, and showing
// "59.94" where a user expects "60" reads as a different thing entirely.
// Snapped only when within 0.1 of a standard rate, so a genuinely odd
// frame rate still shows its real value.
const STANDARD_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120];

function parseFrameRate(ratio) {
  const match = String(ratio || '').match(/^(\d+)\/(\d+)$/);
  if (!match) return null;
  const [, num, den] = match;
  if (Number(den) === 0) return null;
  const fps = Number(num) / Number(den);
  if (!isFinite(fps) || fps <= 0) return null;

  for (const standard of STANDARD_RATES) {
    if (Math.abs(fps - standard) < 0.1) {
      // 29.97 and 59.94 are universally written as 30 and 60.
      return Math.round(standard);
    }
  }
  return Math.round(fps * 100) / 100;
}

// ffprobe's codec names, in the spelling people actually use. hevc IS
// h265 and nothing else, but a badge reading "hevc" makes you look it up
// - and telling h264 from h265 at a glance is most of the point of
// showing the codec at all, since the same bitrate buys markedly more
// picture on the newer one.
const CODEC_DISPLAY_NAMES = {
  hevc: 'h265',
  h264: 'h264',
  mpeg2video: 'mpeg2',
  av1: 'av1',
  vp9: 'vp9',
};

function displayCodec(codecName) {
  if (!codecName) return null;
  return CODEC_DISPLAY_NAMES[codecName] || codecName;
}

// tt/bb/tb/bt are the interlaced field orders; progressive and unknown
// are not. Worth separating because an interlaced feed and a progressive
// one of the same height are not the same picture - interlaced combs on
// exactly the fast motion a sports feed is made of - and both were being
// labelled "1080p" indiscriminately.
const INTERLACED_FIELD_ORDERS = new Set(['tt', 'bb', 'tb', 'bt']);

function isInterlaced(fieldOrder) {
  return INTERLACED_FIELD_ORDERS.has(String(fieldOrder || '').toLowerCase());
}

function formatBitrate(bitsPerSecond) {
  if (!bitsPerSecond || bitsPerSecond <= 0) return '';
  return bitsPerSecond >= 1000000
    ? `${(bitsPerSecond / 1000000).toFixed(1)}Mbps`
    : `${Math.round(bitsPerSecond / 1000)}kbps`;
}

// Bits per pixel per frame - the number that actually predicts how a
// stream looks, as against how big it claims to be.
//
// Resolution and frame rate describe the container; this describes how
// much information is being spent filling it. Two 1080p60 feeds at 2 and
// 8 Mbps are the same by every other measure here and are not remotely
// the same to watch, which is the exact case the whole probe exists to
// settle. As a rough guide for h264: under about 0.05 blocks up on fast
// motion, 0.10 is respectable, above 0.15 is clean. h265 buys roughly a
// third off those thresholds for the same picture.
//
// Frame rate, not field rate, and full frame height either way - an
// interlaced frame still carries every line, just not from one instant.
function bitsPerPixel({ bitrate, width, height, fps }) {
  if (!bitrate || !width || !height || !fps) return null;
  const value = bitrate / (width * height * fps);
  return isFinite(value) && value > 0 ? value : null;
}

// The UI's one-line summary, and what gets persisted onto a saved
// channel. Degrades a piece at a time rather than all at once: an
// unreadable bitrate still leaves the resolution and codec worth showing,
// and a stream that only yields its height still labels as "1080p".
//
// Old stored labels are plain "1080p60" strings and stay perfectly
// readable, so nothing needs migrating.
function formatQualityLabel({ height, fps, interlaced, codec, bitrate, bpp }) {
  if (!height) return '';

  // Broadcast names an interlaced mode by its FIELD rate: 29.97 frames a
  // second interlaced is "1080i60" everywhere it is written down, never
  // "1080i30". Progressive is named by its frame rate as normal.
  const scan = interlaced ? 'i' : 'p';
  const rate = fps ? (interlaced ? Math.round(fps * 2) : fps) : '';

  const parts = [`${height}${scan}${rate}`];
  const codecLabel = displayCodec(codec);
  if (codecLabel) parts.push(codecLabel);
  const bitrateLabel = formatBitrate(bitrate);
  if (bitrateLabel) parts.push(bitrateLabel);
  if (bpp) parts.push(`${bpp.toFixed(3)}bpp`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------
// Quality scoring
// ---------------------------------------------------------------------
//
// One number for "how good will this look", so a list of ten feeds of the
// same channel can be ordered instead of read.
//
// Two terms, multiplied. A CEILING for what the format could look like at
// its best - 1080p60 can look better than 720p60, which can look better
// than 1080p30 - and an ADEQUACY for how close the bitrate gets to
// filling it. Neither works alone, which is the whole problem: resolution
// alone ranks a starved 1080p above a well-fed 720p, and bits per pixel
// alone ranks a small slow stream above a big fast one because it has
// less to fill.
//
// Measured against real readings from a live provider. A 1080p60 feed at
// 3.8 Mbps (0.030bpp) lands below every 720p60 at 5+ Mbps, which is the
// right answer - at that bitrate the extra pixels are being spent on
// blocking artefacts rather than detail.

// Bits per pixel per frame at which h264 stops visibly improving on
// sports content. Everything else is expressed relative to this, so the
// codecs sit in the right ratio to each other rather than needing their
// own tables: h265 reaches the same picture on roughly a third less.
const REFERENCE_BPP = {
  h264: 0.070,
  hevc: 0.045,
  h265: 0.045,
  av1: 0.038,
  vp9: 0.050,
  mpeg2video: 0.130,
  mpeg2: 0.130,
};
const DEFAULT_REFERENCE_BPP = 0.070;

// What each resolution is worth at full bitrate. Deliberately not
// proportional to pixel count - 1080p is 2.25x the pixels of 720p and
// nothing like 2.25x the picture, and treating it as such would make
// resolution swamp every other term.
const RESOLUTION_CEILINGS = [
  [2160, 118], [1440, 108], [1080, 100], [900, 90],
  [720, 82], [576, 68], [480, 58], [360, 45], [0, 32],
];

function resolutionCeiling(height) {
  for (const [minHeight, ceiling] of RESOLUTION_CEILINGS) {
    if (height >= minHeight) return ceiling;
  }
  return 32;
}

// Frame rate matters more than the pixel count it is usually traded
// against: 60fps at 720p is a better watch than 30fps at 1080p on sport,
// and the curve is set so that it comes out that way (82 against 75).
function frameRateFactor(fps) {
  if (!fps) return 0.85;   // unknown - assume typical rather than punish
  return 0.5 + 0.5 * Math.min(1, fps / 60);
}

// Saturating. Below the reference bitrate every bit buys real picture;
// above it they buy progressively less, and past about 1.5x nothing at
// all - which is what stops a wildly over-provisioned 720p feed from
// outranking a properly fed 1080p one.
function adequacy(ratio) {
  if (!ratio || ratio <= 0) return 0;
  const SATURATION = 1.75;
  return (1 - Math.exp(-SATURATION * ratio)) / (1 - Math.exp(-SATURATION));
}

const QUALITY_TIERS = [
  [90, 'excellent'],
  [78, 'good'],
  [62, 'fair'],
  [45, 'poor'],
  [0, 'bad'],
];

function tierForScore(score) {
  for (const [minScore, tier] of QUALITY_TIERS) {
    if (score >= minScore) return tier;
  }
  return 'bad';
}

// Returns { score, tier } or null when there is not enough to judge on.
//
// bpp is all the adequacy term needs, and that is not a shortcut: the
// ratio works out as bpp/referenceBpp exactly, because the reference
// bitrate is referenceBpp x the same pixel count bpp was divided by. It
// means a reading recovered from a stored label scores identically to one
// measured a moment ago, with no width to carry around.
function scoreQuality(reading) {
  if (!reading || !reading.height) return null;
  const { height, fps, interlaced, codec, bpp, anamorphic, width, profile, audioChannels } = reading;

  // Without a bitrate there is no adequacy term and therefore no honest
  // score - resolution on its own is the thing this exists to stop people
  // trusting. A legacy "1080p60" label lands here and stays untiered.
  if (!bpp) return null;

  let ceiling = resolutionCeiling(height);

  // Interlaced carries half the temporal information its field rate
  // suggests, and combs on the motion sport is made of.
  ceiling *= frameRateFactor(interlaced && fps ? fps : fps);
  if (interlaced) ceiling *= 0.92;

  // A 1440x1080 frame is stretched to 1920 on screen. Not a total loss -
  // it is still 1080 lines - but it is not a 1920x1080 picture either.
  if (anamorphic && width && height) {
    const expectedWidth = (height * 16) / 9;
    if (width < expectedWidth) ceiling *= Math.sqrt(width / expectedWidth);
  }

  // Baseline has no B-frames and spends its bitrate worse than Main or
  // High at the same number.
  if (profile && /baseline/i.test(profile)) ceiling *= 0.95;

  const referenceBpp = REFERENCE_BPP[String(codec || '').toLowerCase()] || DEFAULT_REFERENCE_BPP;
  let score = ceiling * adequacy(bpp / referenceBpp);

  // Surround audio is a genuine difference between two otherwise equal
  // feeds, but it is not picture - deliberately small enough to break a
  // tie and never to move a stream between tiers.
  if (audioChannels && audioChannels > 2) score += 1.5;

  const rounded = Math.max(0, Math.min(120, Math.round(score * 10) / 10));
  return { score: rounded, tier: tierForScore(rounded) };
}

// Recovers a scoreable reading from a label this module wrote, so a
// quality saved in a previous session tiers the same as a fresh one
// without a second field having to be persisted alongside it.
// "1080p60 · h264 · 6.0Mbps · 0.048bpp" -> { height, fps, interlaced, codec, bpp }
function parseQualityLabel(label) {
  const text = String(label || '');
  const form = text.match(/(\d{3,4})([pi])(\d+)?/);
  if (!form) return null;
  const height = Number(form[1]);
  const interlaced = form[2] === 'i';
  // The label writes an interlaced mode by its field rate, so halve it
  // back to the frame rate the score is computed on.
  const labelled = form[3] ? Number(form[3]) : null;
  const fps = labelled ? (interlaced ? labelled / 2 : labelled) : null;

  const bppMatch = text.match(/([\d.]+)bpp/);
  const codecMatch = text.match(/·\s*([a-z0-9]+)\s*·/i);
  return {
    height,
    fps,
    interlaced,
    codec: codecMatch ? codecMatch[1] : null,
    bpp: bppMatch ? Number(bppMatch[1]) : null,
  };
}

function scoreQualityLabel(label) {
  const reading = parseQualityLabel(label);
  return reading ? scoreQuality(reading) : null;
}

// Counts the video bitrate off the wire.
//
// ffprobe DOES report stream.bit_rate, and on a live MPEG-TS feed it is
// almost always empty - it is read from container metadata, and a live
// mux carries none. So it is measured instead: total the video packets
// and divide by the timespan they cover.
//
// Video packets only. The audio track is real bandwidth but it is not
// picture, and folding it in would flatter a stream with 5.1 audio into
// looking like it had a better image.
function measureVideoBitrate(packets, videoIndex, fps) {
  const videoPackets = packets.filter(p =>
    Number(p.stream_index) === Number(videoIndex) && Number(p.size) > 0);
  // Too few to average anything meaningful over - a handful of packets is
  // as likely to be one keyframe as a representative sample.
  if (videoPackets.length < 10) return null;

  let bytes = 0;
  let earliest = Infinity;
  let latest = -Infinity;
  for (const packet of videoPackets) {
    bytes += Number(packet.size);
    const time = Number(packet.dts_time);
    if (Number.isFinite(time)) {
      if (time < earliest) earliest = time;
      if (time > latest) latest = time;
    }
  }

  // Preferred: the span the packets actually cover. Reduced by one frame
  // because the last packet's own duration is not inside the span between
  // first and last timestamp, which at a short sample would overstate the
  // rate by a percent or two.
  let seconds = null;
  if (Number.isFinite(earliest) && Number.isFinite(latest) && latest > earliest) {
    seconds = (latest - earliest) + (fps ? 1 / fps : 0);
  }
  // Fallback for a stream that reports no usable timestamps: one video
  // packet is one frame closely enough for this.
  if (!seconds && fps) seconds = videoPackets.length / fps;
  if (!seconds || seconds <= 0.5) return null;

  return Math.round((bytes * 8) / seconds);
}

function getCached(url) {
  const entry = probeCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.probedAt > CACHE_TTL_MS) {
    probeCache.delete(url);
    return null;
  }
  return entry.result;
}

function clearProbeCache() {
  probeCache.clear();
}

// Reads a previous result WITHOUT probing. Used by the stream routes to
// label a channel with its measured quality - they must never open a
// connection to the provider just to decorate a title, and they run on
// every catalog click.
//
// Returns null when nothing has been probed, which is the normal case
// after a restart. Callers fall back to whatever the link itself recorded.
function getCachedProbeLabel(url) {
  const cached = getCached(url);
  return cached && cached.ok && cached.label ? cached.label : null;
}

// The full argument list, and a reduced one to fall back to.
//
// The reduced list is what this probe asked for before bitrate
// measurement existed, and it is kept because ffprobe builds vary: an
// older one - in somebody else's image, or a distro behind Alpine's -
// may not accept the packet section or -read_intervals. The cost of
// being wrong about that would be every quality check failing rather
// than merely losing the new fields, which is a bad trade for a feature
// that used to work. So an option error, and only an option error, drops
// back to the known-good list and still returns a resolution.
const FFPROBE_OPTION_ERROR = /unrecognized option|unknown option|failed to set value|option .* not found/i;

function ffprobeArgs(url, legacy) {
  if (legacy) {
    return [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate,codec_name,field_order',
      '-of', 'json',
      '-analyzeduration', '3000000',
      '-probesize', '3000000',
      '-rw_timeout', '8000000',
      url
    ];
  }

  return [
      '-v', 'error',
      // Every stream, not just v:0. Audio says something a picture
      // measurement cannot - 5.1 against stereo separates two feeds that
      // are otherwise identical - and -select_streams is global, so
      // restricting it here would also restrict the packets below and
      // make the audio unreachable in this one call. Packets are filtered
      // back down to the video stream in code instead, which keeps this
      // to a single connection to the provider.
      '-show_entries',
      'stream=index,codec_type,codec_name,profile,width,height,avg_frame_rate,' +
      'r_frame_rate,field_order,pix_fmt,sample_aspect_ratio,color_transfer,' +
      'channels,channel_layout:packet=size,dts_time,stream_index',
      // The bitrate sample window. Without this ffprobe reads to the end
      // of the file, which for a live stream is never.
      '-read_intervals', `%+${PROBE_SAMPLE_SECONDS}`,
      '-of', 'json',
      // Enough of the stream to find a keyframe and read the SPS.
      '-analyzeduration', '3000000',
      '-probesize', '3000000',
      // Stops ffprobe hanging on a socket that connects but never sends.
      '-rw_timeout', '8000000',
      url
  ];
}

function runFfprobe(url, options = {}) {
  const legacy = options.legacy === true;
  return new Promise((resolve, reject) => {
    // maxBuffer is raised for the packet list: eight seconds of 60fps
    // video is a few hundred packet objects, and audio adds more. Still
    // far below what a stalled stream could produce, so it stays a guard.
    execFile(FFPROBE_BIN, ffprobeArgs(url, legacy), {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024
    }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') {
          return reject(new Error('ffprobe is not installed in this container'));
        }
        if (err.killed) {
          return reject(new Error('Timed out - the stream did not respond'));
        }
        const message = String(stderr || err.message).trim().split('\n')[0] || 'probe failed';
        if (!legacy && FFPROBE_OPTION_ERROR.test(message)) {
          const optionError = new Error(message);
          optionError.ffprobeOptionError = true;
          return reject(optionError);
        }
        return reject(new Error(message));
      }
      resolve(stdout);
    });
  });
}

// Probes one stream. Returns
//   { ok: true, cached, width, height, fps, codec, label }
//   { ok: false, cached: false, error }
//
// Never throws: a channel that won't probe is a normal outcome here (a
// dead feed is exactly what the user is trying to find), so it's reported
// as data rather than as an exception the caller has to wrap.
// `force` bypasses the cache for one call. Needed because a failure is
// very often about conditions at that moment rather than the stream
// itself: providers cap concurrent connections, so probing while you have
// something playing consumes the last slot and the probe times out. That
// result is worth remembering (so a search doesn't re-probe dead feeds
// every time) but must not be permanent - confirmed in practice, where
// the first two probes failed against an active stream and the rest
// succeeded.
async function probeStream(url, options = {}) {
  const { force = false } = options;

  const cached = force ? null : getCached(url);
  if (cached) return { ...cached, cached: true };

  // Serialise against the provider. Awaiting here means concurrent
  // callers queue rather than all firing at once.
  const sinceLast = Date.now() - lastProbeStartedAt;
  if (sinceLast < MIN_PROBE_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, MIN_PROBE_INTERVAL_MS - sinceLast));
  }
  lastProbeStartedAt = Date.now();

  let result;
  try {
    let stdout;
    try {
      stdout = await runFfprobe(url);
    } catch (err) {
      if (!err.ffprobeOptionError) throw err;
      console.error('[Probe] ffprobe rejected the detailed options, falling back:', err.message);
      stdout = await runFfprobe(url, { legacy: true });
    }
    const parsed = JSON.parse(stdout);
    const streams = parsed.streams || [];
    const video = streams.find(s => s.codec_type === 'video') || streams[0];
    const audio = streams.find(s => s.codec_type === 'audio') || null;

    if (!video || !video.height) {
      result = { ok: false, error: 'No video stream found' };
    } else {
      const fps = parseFrameRate(video.avg_frame_rate) || parseFrameRate(video.r_frame_rate);
      const interlaced = isInterlaced(video.field_order);
      const bitrate = measureVideoBitrate(parsed.packets || [], video.index, fps);
      const bpp = bitsPerPixel({ bitrate, width: video.width, height: video.height, fps });

      result = {
        ok: true,
        width: video.width || null,
        height: video.height,
        fps,
        interlaced,
        codec: video.codec_name || null,
        profile: video.profile || null,
        pixFmt: video.pix_fmt || null,
        // Not 1:1 means the stored frame is narrower or wider than what
        // gets displayed: a 1440x1080 feed presents as 1080 and carries a
        // quarter fewer pixels than a real one. The label cannot show
        // that without becoming unreadable, so it rides in the details.
        sampleAspectRatio: video.sample_aspect_ratio || null,
        anamorphic: !!video.sample_aspect_ratio
          && !['1:1', '0:1', 'N/A'].includes(video.sample_aspect_ratio),
        hdr: ['smpte2084', 'arib-std-b67'].includes(String(video.color_transfer || '')),
        audioCodec: audio ? audio.codec_name || null : null,
        audioChannels: audio && audio.channels ? audio.channels : null,
        audioLayout: audio ? audio.channel_layout || null : null,
        bitrate,
        bpp,
        label: formatQualityLabel({ height: video.height, fps, interlaced, codec: video.codec_name, bitrate, bpp })
      };

      const scored = scoreQuality({
        height: video.height, width: video.width, fps, interlaced,
        codec: video.codec_name, bpp,
        anamorphic: result.anamorphic, profile: video.profile,
        audioChannels: result.audioChannels,
      });
      result.score = scored ? scored.score : null;
      result.tier = scored ? scored.tier : null;
    }
  } catch (err) {
    result = { ok: false, error: err.message };
  }

  // Failures are cached too. A dead stream stays dead for the moment, and
  // re-probing it on every search is exactly the traffic this is trying
  // to avoid.
  probeCache.set(url, { result, probedAt: Date.now() });
  return { ...result, cached: false };
}

module.exports = {
  probeStream,
  getCachedProbeLabel,
  parseFrameRate,
  formatQualityLabel,
  parseQualityLabel,
  scoreQuality,
  scoreQualityLabel,
  tierForScore,
  formatBitrate,
  bitsPerPixel,
  measureVideoBitrate,
  isInterlaced,
  displayCodec,
  clearProbeCache,
  MIN_PROBE_INTERVAL_MS,
  CACHE_TTL_MS,
  PROBE_SAMPLE_SECONDS,
};
