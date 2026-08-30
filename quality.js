// How a stream's quality is described and rated.
//
// The measuring is not here, and is not done anywhere any more: readings
// come from streamcheck.js, which reads published sweeps covering a whole
// provider. This file is what turns one of those readings into something
// a person can act on - a band, a score for ordering within it, and the
// single line a badge shows.
//
// This was probe.js, which ran ffprobe against the stream itself. That
// gave a better reading in two narrow ways - a true frame width, and a
// measurement of this minute rather than of a sweep days old - and cost
// a connection to the provider and up to a minute per channel. Published
// data covers an entire playlist in one request and says which channels
// are dead, so the measuring went and the judging stayed.

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

function formatBitrate(bitsPerSecond) {
  if (!bitsPerSecond || bitsPerSecond <= 0) return '';
  return bitsPerSecond >= 1000000
    ? `${(bitsPerSecond / 1000000).toFixed(1)}Mbps`
    : `${Math.round(bitsPerSecond / 1000)}kbps`;
}

// Bits per pixel per frame - the number the whole rating is built on.
//
// Resolution and frame rate describe the container a stream is poured
// into; this describes how much information is being spent filling it.
// Two 1080p60 feeds at 2 and 8 Mbps are identical by every other measure
// and are not remotely the same to watch, and a 720p feed handed the
// same bitrate as a 1080p one is getting more than twice as much per
// pixel.
//
// Frame rate, not field rate, and full frame height either way - an
// interlaced frame still carries every line, just not from one instant.
function bitsPerPixel({ bitrate, width, height, fps }) {
  if (!bitrate || !width || !height || !fps) return null;
  const value = bitrate / (width * height * fps);
  return isFinite(value) && value > 0 ? value : null;
}

// ---------------------------------------------------------------------
// Quality rating
// ---------------------------------------------------------------------
//
// The rating is bits per pixel, and nothing else.
//
// Earlier versions weighed a resolution ceiling against how close the
// bitrate came to filling it. That needed a table of what each
// resolution "wants" - a table that had to be tuned, was wrong twice,
// and decided outcomes for reasons nobody could see. bpp already carries
// resolution and frame rate inside it: a 1080p60 feed needs 2.25x the
// bitrate of a 720p60 one to reach the same figure, so spending the same
// bitrate on more pixels shows up as the lower number it honestly is.
// One measure, and the bands are read straight off it.
const BPP_BANDS = [
  [0.10, 'great'],
  [0.07, 'good'],
  [0.05, 'okay'],
  [0, 'bad'],
];

// Below this the stream is Bad whatever its bpp. Sport is motion, and
// half the frames of it is not something a generous bitrate buys back -
// a 30fps feed with beautiful still frames is still a 30fps feed of a
// fast-moving game.
//
// Applied to the rate the badge shows, which for an interlaced mode is
// its field rate: 1080i60 carries sixty distinct samples of motion a
// second, and marking something the badge itself calls "1080i60" as too
// slow would be indefensible on its face. Interlacing costs it in the
// ordering nudge below instead.
const MIN_SMOOTH_FPS = 50;

const TIER_DISPLAY_NAMES = {
  great: 'Great',
  good: 'Good',
  okay: 'Okay',
  bad: 'Bad',
};

function tierDisplayName(tier) {
  return TIER_DISPLAY_NAMES[tier] || '';
}

function tierForBpp(bpp) {
  for (const [floor, tier] of BPP_BANDS) {
    if (bpp >= floor) return tier;
  }
  return 'bad';
}

// The rate the badge shows, and the one the smoothness rule is applied
// to - field rate for interlaced, frame rate otherwise.
function displayedRate(fps, interlaced) {
  if (!fps) return null;
  return interlaced ? Math.round(fps * 2) : fps;
}

// A 0-100 figure used ONLY for ordering one stream against another. The
// tier is what anybody reads and it comes from bpp alone; this exists so
// two streams inside one band can still be told apart, and so the better
// of two near-identical readings is the one with more pixels behind it.
//
// Piecewise across the band edges, so 0.05, 0.07 and 0.10 always land on
// the same scores whatever else is changed.
const SCORE_POINTS = [
  [0, 0], [0.05, 40], [0.07, 60], [0.10, 80], [0.20, 100],
];

// The score interval each band owns, matching the band edges in
// SCORE_POINTS. A stream can move within its own interval and never out
// of it.
const TIER_SCORE_RANGE = {
  bad: [0, 39.9],
  okay: [40, 59.9],
  good: [60, 79.9],
  great: [80, 100],
};

function bppScore(bpp) {
  if (bpp <= 0) return 0;
  for (let i = 1; i < SCORE_POINTS.length; i++) {
    const [x1, y1] = SCORE_POINTS[i - 1];
    const [x2, y2] = SCORE_POINTS[i];
    if (bpp <= x2) return y1 + ((bpp - x1) / (x2 - x1)) * (y2 - y1);
  }
  return 100;
}

// Small enough that it can never move a stream between bands - those are
// 20 points apart and this is worth at most 2.4 - and large enough to
// settle a tie. At the same bpp, more pixels is more picture.
function resolutionNudge(height, interlaced) {
  const byHeight = height >= 2160 ? 2.4
    : height >= 1440 ? 2.2
    : height >= 1080 ? 2.0
    : height >= 900 ? 1.5
    : height >= 720 ? 1.0
    : height >= 576 ? 0.5
    : 0;
  // An interlaced frame is two half-pictures from different instants, so
  // it is worth less than a progressive one of the same height.
  return interlaced ? byHeight * 0.5 : byHeight;
}

// Returns { score, tier, tooSlow } or null when there is not enough to
// judge on.
//
// bpp is the whole basis, which is also why a reading recovered from a
// stored label rates identically to one measured a moment ago: the label
// carries the bpp.
function scoreQuality(reading) {
  if (!reading || !reading.height) return null;
  const { height, fps, interlaced, bpp } = reading;

  // Without a bitrate there is no bpp and so no honest rating -
  // resolution on its own is exactly what this exists to stop people
  // trusting. A legacy "1080p60" label lands here and stays unrated
  // rather than being guessed at.
  if (!bpp) return null;

  const rate = displayedRate(fps, interlaced);
  const tooSlow = rate != null && rate < MIN_SMOOTH_FPS;

  const tier = tooSlow ? 'bad' : tierForBpp(bpp);

  // A stream failing the smoothness rule sorts below everything that
  // passes it, however many bits it spends on its few frames.
  if (tooSlow) {
    return { score: Math.round(Math.min(39, bppScore(bpp) * 0.4) * 10) / 10, tier, tooSlow };
  }

  // The nudge is kept INSIDE the band. Added freely it could carry a
  // 1080p feed at 0.099bpp above a 720p one at 0.101 - two points of
  // resolution beating the band boundary itself, so a Good stream would
  // outrank a Great one in a list sorted by score. bpp decides the band
  // and decides the order between bands; resolution only ever settles
  // position within one.
  const [floor, ceiling] = TIER_SCORE_RANGE[tier];
  const nudged = bppScore(bpp) + resolutionNudge(height, interlaced);
  const score = Math.min(ceiling, Math.max(floor, nudged));

  return { score: Math.round(score * 10) / 10, tier, tooSlow };
}

// What the badge shows: the verdict, the format, and the number the
// verdict was read off. Everything else - codec, bitrate, how many
// checks are behind it, how much it swings - is real but secondary and
// lives in the hover detail, rather than crowding the one line that has
// to be readable at a glance down a list of ten.
function formatQualityLabel({ height, fps, interlaced, bpp, tier }) {
  if (!height) return '';

  // Broadcast names an interlaced mode by its FIELD rate: 29.97 frames a
  // second interlaced is "1080i60" everywhere it is written down, never
  // "1080i30". Progressive is named by its frame rate as normal.
  const scan = interlaced ? 'i' : 'p';
  const rate = displayedRate(fps, interlaced) || '';

  const parts = [];
  const tierName = tierDisplayName(tier);
  if (tierName) parts.push(tierName);
  parts.push(String(height) + scan + rate);
  if (bpp) parts.push(bpp.toFixed(3) + 'bpp');
  return parts.join(' \u00b7 ');
}

// Recovers a rateable reading from a label this module wrote, so a
// quality saved in a previous session rates the same as a fresh one
// without a second field having to be persisted beside it.
// "Great \u00b7 1080p60 \u00b7 0.101bpp" -> { height, fps, interlaced, bpp, tier }
function parseQualityLabel(label) {
  // Split on the separator rather than pattern-matching across the whole
  // string: each field is recognised by its own shape, and anything
  // unrecognised is ignored rather than mistaken for something else.
  const parts = String(label || '').split('\u00b7').map(p => p.trim()).filter(Boolean);

  const out = { height: null, fps: null, interlaced: false, bpp: null, tier: null, codec: null };
  for (const part of parts) {
    const form = part.match(/^(\d{3,4})([pi])(\d+)?$/);
    if (form) {
      out.height = Number(form[1]);
      out.interlaced = form[2] === 'i';
      const labelled = form[3] ? Number(form[3]) : null;
      // Written as a field rate for interlaced, so halve it back.
      out.fps = labelled ? (out.interlaced ? labelled / 2 : labelled) : null;
      continue;
    }
    const bppPart = part.match(/^([\d.]+)bpp$/);
    if (bppPart) { out.bpp = Number(bppPart[1]); continue; }
    if (/^[\d.]+(Mbps|kbps)$/.test(part)) continue;
    const tierKey = part.toLowerCase();
    if (TIER_DISPLAY_NAMES[tierKey]) { out.tier = tierKey; continue; }
    // Labels written before this format carried the codec; keep it.
    if (/^[a-z][a-z0-9]*$/i.test(part) && !out.codec) out.codec = part;
  }

  return out.height ? out : null;
}

function scoreQualityLabel(label) {
  const reading = parseQualityLabel(label);
  return reading ? scoreQuality(reading) : null;
}

module.exports = {
  bitsPerPixel,
  scoreQuality,
  scoreQualityLabel,
  formatQualityLabel,
  parseQualityLabel,
  tierForBpp,
  tierDisplayName,
  displayCodec,
  formatBitrate,
  MIN_SMOOTH_FPS,
};
