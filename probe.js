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
const PROBE_TIMEOUT_MS = 12000;

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

// A short label for the UI: "1080p60", "720p30", or just "1080p" when the
// frame rate couldn't be determined.
function formatQualityLabel({ height, fps }) {
  if (!height) return '';
  return fps ? `${height}p${fps}` : `${height}p`;
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

function runFfprobe(url) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE_BIN, [
      '-v', 'error',
      // First video stream only. Audio and subtitle streams say nothing
      // about picture quality and only slow the probe down.
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate,codec_name',
      '-of', 'json',
      // Enough of the stream to find a keyframe and read the SPS, without
      // pulling megabytes of video for what is a two-number answer.
      '-analyzeduration', '3000000',
      '-probesize', '3000000',
      // Stops ffprobe hanging on a socket that connects but never sends.
      '-rw_timeout', '8000000',
      url
    ], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') {
          return reject(new Error('ffprobe is not installed in this container'));
        }
        if (err.killed) {
          return reject(new Error('Timed out - the stream did not respond'));
        }
        return reject(new Error(String(stderr || err.message).trim().split('\n')[0] || 'probe failed'));
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
    const stdout = await runFfprobe(url);
    const stream = (JSON.parse(stdout).streams || [])[0];
    if (!stream || !stream.height) {
      result = { ok: false, error: 'No video stream found' };
    } else {
      const fps = parseFrameRate(stream.avg_frame_rate) || parseFrameRate(stream.r_frame_rate);
      result = {
        ok: true,
        width: stream.width || null,
        height: stream.height,
        fps,
        codec: stream.codec_name || null,
        label: formatQualityLabel({ height: stream.height, fps })
      };
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
  clearProbeCache,
  MIN_PROBE_INTERVAL_MS,
  CACHE_TTL_MS,
};
