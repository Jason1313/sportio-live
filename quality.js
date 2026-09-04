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
// Three verdicts, from bpp read against the resolution it was spent on.
//
//   1080p60/50 over 0.060 bpp, or 720p60/50 over 0.080  ->  Good
//   1080p60/50 over 0.040 bpp, or 720p60/50 over 0.060  ->  Okay
//   anything below                                      ->  Low Quality
//
// The two thresholds per row are not a mistake: the same bpp is harder to
// reach at 1080p, which is 2.25x the pixels, so 0.060 there is the
// equivalent standard to 0.080 at 720p.
//
// This used to be one bpp ladder with no resolution in it, on the
// reasoning that bpp already carries resolution inside it. It does, but
// not the standard being asked of it - a 720p feed and a 1080p feed at
// the same bpp are not equally well served, and one flat set of cutoffs
// had to be wrong for one of them. It was also quietly disagreeing with
// autopick.js, whose top two bands are exactly the Good thresholds
// above: a channel the picker rated best-in-class could show a middling
// badge. Same numbers in both places now, so the badge explains the pick.
//
// Ordered by minHeight, first match wins. Above 1080p uses the 1080p row
// - a 4K feed is judged by the strictest standard here, not excluded from
// judgement - and below 720p there is no row, which is Low Quality
// whatever the bitrate.
const TIER_THRESHOLDS = [
  { minHeight: 1080, good: 0.060, okay: 0.040 },
  { minHeight: 720,  good: 0.080, okay: 0.060 },
];

function thresholdsFor(height) {
  return TIER_THRESHOLDS.find(row => height >= row.minHeight) || null;
}

// Below this the stream is Low Quality whatever its bpp. Sport is
// motion, and
// half the frames of it is not something a generous bitrate buys back - a
// 30fps feed with beautiful still frames is still a 30fps feed of a
// fast-moving game. This is why the rule reads "60/50" and not a bpp
// figure on its own.
//
// Applied to the rate the badge shows, which for an interlaced mode is
// its field rate: 1080i60 carries sixty distinct samples of motion a
// second, and marking something the badge itself calls "1080i60" as too
// slow would be indefensible on its face. Interlacing costs it in the
// ordering nudge below instead.
const MIN_SMOOTH_FPS = 50;

const TIER_DISPLAY_NAMES = {
  good: 'Good',
  okay: 'Okay',
  low: 'Low Quality',
};

// Words this module used to write into labels, so a quality saved under
// the old four-band system is still recognised as a verdict rather than
// mistaken for a codec. The word itself is discarded either way - the
// tier is always recomputed from the numbers beside it - but a label has
// to be parsed correctly before it can be re-rated.
const LEGACY_TIER_WORDS = new Set(['great', 'bad']);

function tierDisplayName(tier) {
  return TIER_DISPLAY_NAMES[tier] || '';
}

// The verdict for one reading. Height and frame rate decide which
// standard applies; bpp is measured against it.
function tierFor({ height, bpp, rate }) {
  if (!height || !bpp) return 'low';
  if (rate != null && rate < MIN_SMOOTH_FPS) return 'low';
  const bar = thresholdsFor(height);
  if (!bar) return 'low';
  if (bpp >= bar.good) return 'good';
  if (bpp >= bar.okay) return 'okay';
  return 'low';
}

// The rate the badge shows, and the one the smoothness rule is applied
// to - field rate for interlaced, frame rate otherwise.
function displayedRate(fps, interlaced) {
  if (!fps) return null;
  return interlaced ? Math.round(fps * 2) : fps;
}

// A 0-100 figure used ONLY for ordering one stream against another. The
// tier is what anybody reads; this exists so two streams inside one band
// can still be told apart, and so the better of two near-identical
// readings is the one with more pixels behind it.
//
// Each tier owns an interval and a stream never leaves its own, so the
// ordering can never contradict the badge - a Good stream always sorts
// above every Okay one, whatever their raw bpp figures are. That matters
// now that the thresholds differ by resolution: 0.075 bpp is Good at
// 1080p and merely Okay at 720p, and a single bpp-to-score curve would
// have put the Okay one first.
const TIER_SCORE_RANGE = {
  low: [0, 39.9],
  okay: [40, 69.9],
  good: [70, 100],
};

// How far through its own tier a reading sits, 0 to 1.
//
// Measured against the same thresholds the tier came from, so the two
// cannot disagree. Good runs from its floor to twice that floor, which
// is where the scale tops out - past roughly 0.12 bpp at 1080p the
// picture stops visibly improving and there is nothing left to rank on.
function tierProgress(tier, bpp, bar) {
  if (!bar) return 0;
  if (tier === 'good') return clamp01((bpp - bar.good) / bar.good);
  if (tier === 'okay') return clamp01((bpp - bar.okay) / (bar.good - bar.okay));
  return clamp01(bpp / bar.okay);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

// Small enough that it can never move a stream between bands - the
// narrowest is 30 points and this is worth at most 2.4 - and large enough
// to settle a tie. At the same bpp, more pixels is more picture.
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

  const tier = tierFor({ height, bpp, rate });

  // Below 720p there is no standard to measure against, so a reading
  // still needs somewhere to sort. The 720p bar stands in - it is the
  // lowest real one - and everything here is Low Quality anyway, so this
  // only decides the order among streams nobody should be picking.
  const bar = thresholdsFor(height) || TIER_THRESHOLDS[TIER_THRESHOLDS.length - 1];

  // The nudge is kept INSIDE the band. Added freely it could carry a
  // 1080p feed just under a threshold above a 720p one just over it -
  // two points of resolution beating the boundary itself, so an Okay
  // stream would outrank a Good one in a list sorted by score. The tier
  // decides the order between bands; resolution only ever settles
  // position within one.
  const [floor, ceiling] = TIER_SCORE_RANGE[tier];
  const span = ceiling - floor;

  // A stream failing the smoothness rule sits at the bottom of Low
  // Quality, however many bits it spends on its few frames - the bitrate
  // is not the problem with it.
  const progress = tooSlow ? 0 : tierProgress(tier, bpp, bar);
  const nudged = floor + progress * span + resolutionNudge(height, interlaced);
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
    if (tierKey === 'low quality') { out.tier = 'low'; continue; }
    if (LEGACY_TIER_WORDS.has(tierKey)) continue;
    // Labels written before this format carried the codec; keep it.
    if (/^[a-z][a-z0-9]*$/i.test(part) && !out.codec) out.codec = part;
  }

  return out.height ? out : null;
}

function scoreQualityLabel(label) {
  const reading = parseQualityLabel(label);
  return reading ? scoreQuality(reading) : null;
}

// A label written under an older rating system, restated under the
// current one.
//
// The tier is always recomputed from the numbers, so an old reading is
// already RATED correctly wherever a score is used - but the stored
// string still spells out a verdict that no longer exists, and a badge
// reading "Great" beside a system that has no Great is worse than one
// that simply reads "Good". Returns the label unchanged when there is
// nothing to restate.
function restateQualityLabel(label) {
  const reading = parseQualityLabel(label);
  if (!reading) return label || '';
  const scored = scoreQuality(reading);
  if (!scored) return label || '';
  return formatQualityLabel({ ...reading, tier: scored.tier });
}

module.exports = {
  bitsPerPixel,
  scoreQuality,
  scoreQualityLabel,
  formatQualityLabel,
  parseQualityLabel,
  restateQualityLabel,
  tierFor,
  tierDisplayName,
  TIER_DISPLAY_NAMES,
  displayCodec,
  formatBitrate,
  MIN_SMOOTH_FPS,
};
