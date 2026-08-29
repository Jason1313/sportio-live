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
const PROBE_TIMEOUT_MS = 45000;

// How much of the stream to actually read.
//
// Bitrate cannot be taken from metadata on a live feed - see
// measureVideoBitrate - so it is counted off the wire, and this is the
// window it is counted over.
//
// Twenty seconds, up from eight. Eight was not wrong so much as too
// short to be repeatable: measured six times on one channel it returned
// 3.3, 4.5, 6.5, 7.1, 4.3 and 4.9 Mbps. That is not the stream changing,
// it is a variable-bitrate encoder being asked what it weighs over a
// window narrow enough for one crowd shot or one static studio segment
// to dominate the answer. Sport swings hard between the two. A longer
// window averages across enough of both for the number to settle, and
// the sample is reported alongside it so a reading taken over less can
// be recognised as one.
const PROBE_SAMPLE_SECONDS = 20;

// Discarded from the front of every sample. The opening of a live
// connection is the least typical part of it: the first keyframe lands
// there, and a keyframe is several times the size of the frames after
// it, so a window that starts on one reads high.
const BITRATE_WARMUP_SECONDS = 2;

// Below this, the numbers still get reported but are flagged as taken
// over too little to trust - a stream that yielded three seconds before
// stalling has been measured, just not well.
const MIN_CONFIDENT_SAMPLE_SECONDS = 6;

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
function formatQualityLabel({ height, fps, interlaced, codec, bitrate, bpp, tier }) {
  if (!height) return '';

  // Broadcast names an interlaced mode by its FIELD rate: 29.97 frames a
  // second interlaced is "1080i60" everywhere it is written down, never
  // "1080i30". Progressive is named by its frame rate as normal.
  const scan = interlaced ? 'i' : 'p';
  const rate = fps ? (interlaced ? Math.round(fps * 2) : fps) : '';

  // The verdict leads, because it is the part that can be read at a
  // glance; the measurements that produced it follow for anyone who
  // wants to check the working.
  const parts = [];
  const tierName = tierDisplayName(tier);
  if (tierName) parts.push(tierName);
  parts.push(`${height}${scan}${rate}`);
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

// Higher resolutions need FEWER bits per pixel to look equally good, and
// leaving that out was actively wrong: it had a 3.8 Mbps 720p feed
// outranking a 7.3 Mbps 1080p one, which is the reverse of what anyone
// looking at the two would say.
//
// The reason is that a bigger picture has more for the encoder to
// exploit - more spatial redundancy, and artefacts spread over more
// pixels are less visible at the same viewing distance. Real encoding
// ladders show it plainly: they give 1080p roughly 1.8x the bitrate of
// 720p, not the 2.25x the pixel count alone would demand. These factors
// are that ratio, with the table calibrated at 720p.
// Tuned so the crossover lands at roughly EQUAL ABSOLUTE BITRATE: give
// a 1080p60 and a 720p60 feed the same Mbps and the 1080p wins, which is
// the ordinary case; the 720p only takes it when it has meaningfully
// more to spend. An earlier set demanded 1.85x for 1080p and produced
// the opposite - a 5.4 Mbps 720p scoring 90 against the same bitrate at
// 1080p scoring 69, which is not a defensible reading of those two
// streams. These sit nearer 1.5x.
const RESOLUTION_BPP_FACTORS = [
  [2160, 0.46], [1440, 0.56], [1080, 0.66], [900, 0.80],
  [720, 1.00], [576, 1.15], [480, 1.25], [0, 1.40],
];

function referenceBppFor(codec, height) {
  const base = REFERENCE_BPP[String(codec || '').toLowerCase()] || DEFAULT_REFERENCE_BPP;
  for (const [minHeight, factor] of RESOLUTION_BPP_FACTORS) {
    if (height >= minHeight) return base * factor;
  }
  return base * 1.30;
}

// What each resolution is worth at full bitrate. Deliberately not
// proportional to pixel count - 1080p is 2.25x the pixels of 720p and
// nothing like 2.25x the picture, and treating it as such would make
// resolution swamp every other term.
// Compressed deliberately. Resolution is the headline number and the
// least reliable one: it says how many pixels arrive, not whether there
// are enough bits to make them worth having. Keeping 720p close behind
// 1080p leaves the bitrate term room to overturn the order, which is
// what it should do when a 1080p feed is starved - while still letting
// 1080p win outright when both are properly fed.
const RESOLUTION_CEILINGS = [
  [2160, 115], [1440, 106], [1080, 100], [900, 92],
  [720, 85], [576, 72], [480, 62], [360, 48], [0, 34],
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

// Asymmetric on purpose, and this is where most of the verdict is
// decided.
//
// BELOW the reference bitrate the penalty is superlinear: at half the
// bits a stream is well under half as watchable, because compression
// artefacts do not fade in gently - they arrive as blocking on exactly
// the fast motion sport is made of. An exponent above 1 is what makes a
// starved 1080p feed fall behind a well-fed 720p one rather than merely
// slipping a place.
//
// ABOVE it the reward is small and saturates fast. Past the point where
// the encode is visually transparent there is nothing left to buy, so a
// lavishly over-provisioned 720p feed gains a few points and cannot
// climb past a 1080p feed that is also properly fed.
const ADEQUACY_SHORTFALL_EXPONENT = 1.35;
const ADEQUACY_SURPLUS_CEILING = 0.12;

function adequacy(ratio) {
  if (!ratio || ratio <= 0) return 0;
  if (ratio <= 1) return Math.pow(ratio, ADEQUACY_SHORTFALL_EXPONENT);
  return 1 + ADEQUACY_SURPLUS_CEILING * (1 - Math.exp(-2 * (ratio - 1)));
}

// Six bands, so the badge answers "is this worth watching" without the
// numbers beside it having to be interpreted. The boundaries are placed
// against real readings from a live provider rather than round numbers:
// Okay and below is where a feed starts visibly costing you something.
const QUALITY_TIERS = [
  [100, 'excellent'],
  [87, 'great'],
  [74, 'good'],
  [62, 'okay'],
  [40, 'poor'],
  [0, 'bad'],
];

const TIER_DISPLAY_NAMES = {
  excellent: 'Excellent',
  great: 'Great',
  good: 'Good',
  okay: 'Okay',
  poor: 'Poor',
  bad: 'Bad',
};

function tierForScore(score) {
  for (const [minScore, tier] of QUALITY_TIERS) {
    if (score >= minScore) return tier;
  }
  return 'bad';
}

function tierDisplayName(tier) {
  return TIER_DISPLAY_NAMES[tier] || '';
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

  let score = ceiling * adequacy(bpp / referenceBppFor(codec, height));

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
  // Split on the separator rather than pattern-matching across the whole
  // string. With a tier word in front, a regex looking for "codec between
  // two separators" happily matched "1080p60" instead - each field is
  // recognised by its own shape here, and unknown fields are ignored
  // rather than mistaken for something else.
  const parts = String(label || '').split('·').map(p => p.trim()).filter(Boolean);

  const out = { height: null, fps: null, interlaced: false, codec: null, bpp: null, tier: null };
  for (const part of parts) {
    const form = part.match(/^(\d{3,4})([pi])(\d+)?$/);
    if (form) {
      out.height = Number(form[1]);
      out.interlaced = form[2] === 'i';
      const labelled = form[3] ? Number(form[3]) : null;
      // The label writes an interlaced mode by its field rate, so halve
      // it back to the frame rate the score is computed on.
      out.fps = labelled ? (out.interlaced ? labelled / 2 : labelled) : null;
      continue;
    }
    const bpp = part.match(/^([\d.]+)bpp$/);
    if (bpp) { out.bpp = Number(bpp[1]); continue; }
    if (/^[\d.]+(Mbps|kbps)$/.test(part)) continue;   // bitrate is implied by bpp
    const tierKey = part.toLowerCase();
    if (TIER_DISPLAY_NAMES[tierKey]) { out.tier = tierKey; continue; }
    if (/^[a-z][a-z0-9]*$/i.test(part) && !out.codec) out.codec = part;
  }

  return out.height ? out : null;
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
  const videoPackets = packets
    .filter(p => Number(p.stream_index) === Number(videoIndex) && Number(p.size) > 0)
    .map(p => ({ size: Number(p.size), time: Number(p.dts_time) }));
  // Too few to average anything meaningful over - a handful of packets is
  // as likely to be one keyframe as a representative sample.
  if (videoPackets.length < 10) return null;

  const timed = videoPackets.filter(p => Number.isFinite(p.time));

  // No usable timestamps at all. One video packet is one frame closely
  // enough to fall back on, but the result is not corroborated by
  // anything, so it says so.
  if (timed.length < 10) {
    if (!fps) return null;
    const seconds = videoPackets.length / fps;
    const bytes = videoPackets.reduce((n, p) => n + p.size, 0);
    return {
      bitrate: Math.round((bytes * 8) / seconds),
      sampleSeconds: Math.round(seconds * 10) / 10,
      variation: null,
      confident: false,
    };
  }

  const opened = timed.reduce((min, p) => Math.min(min, p.time), Infinity);
  const afterWarmup = timed.filter(p => p.time >= opened + BITRATE_WARMUP_SECONDS);
  // Only skip the warm-up if there is enough left to be worth measuring;
  // on a short sample the opening is all there is.
  const sample = afterWarmup.length >= 10 ? afterWarmup : timed;

  let bytes = 0;
  let first = Infinity;
  let last = -Infinity;
  for (const packet of sample) {
    bytes += packet.size;
    if (packet.time < first) first = packet.time;
    if (packet.time > last) last = packet.time;
  }

  // The span between first and last timestamp excludes the last frame's
  // own duration, which at a short sample would overstate the rate.
  const span = (last - first) + (fps ? 1 / fps : 0);
  if (!(span > 0.5)) return null;

  // Per-second buckets, so the answer can say how steady the stream is
  // rather than only what it averaged. A feed swinging three to one
  // across a sample has not been mismeasured - it genuinely varies, and
  // that is worth seeing rather than hiding inside a mean.
  const buckets = new Map();
  for (const packet of sample) {
    const second = Math.floor(packet.time - first);
    buckets.set(second, (buckets.get(second) || 0) + packet.size);
  }
  const seconds = [...buckets.keys()].sort((a, b) => a - b);
  // The final bucket is a partial second and always reads low.
  if (seconds.length > 2) seconds.pop();
  const rates = seconds.map(k => buckets.get(k) * 8);

  let variation = null;
  if (rates.length >= 3) {
    const low = rates.reduce((m, r) => Math.min(m, r), Infinity);
    const high = rates.reduce((m, r) => Math.max(m, r), 0);
    if (low > 0) variation = Math.round((high / low) * 10) / 10;
  }

  return {
    bitrate: Math.round((bytes * 8) / span),
    sampleSeconds: Math.round(span * 10) / 10,
    variation,
    confident: span >= MIN_CONFIDENT_SAMPLE_SECONDS,
  };
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
      const measured = measureVideoBitrate(parsed.packets || [], video.index, fps);
      const bitrate = measured ? measured.bitrate : null;
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
        // How the bitrate was arrived at, so a number taken over three
        // seconds of a stalling stream is not read as the same kind of
        // fact as one taken over twenty.
        sampleSeconds: measured ? measured.sampleSeconds : null,
        bitrateVariation: measured ? measured.variation : null,
        bitrateConfident: measured ? measured.confident : false,
      };

      // Scored before the label is written, because the label leads with
      // the tier the score produces.
      const scored = scoreQuality({
        height: video.height, width: video.width, fps, interlaced,
        codec: video.codec_name, bpp,
        anamorphic: result.anamorphic, profile: video.profile,
        audioChannels: result.audioChannels,
      });
      result.score = scored ? scored.score : null;
      result.tier = scored ? scored.tier : null;
      result.label = formatQualityLabel({
        height: video.height, fps, interlaced, codec: video.codec_name,
        bitrate, bpp, tier: result.tier,
      });
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
  tierDisplayName,
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
