// Matchup poster art, drawn from the team data rather than stamped out
// of an illustrated template.
//
// The old poster laid each mark straight onto a band of that team's own
// primary colour, which fails in two ways that are not the same problem.
// A mark vanishes into its own band - Michigan State's dark green Spartan
// on dark green, Miami's orange U on orange - because the colour behind
// it was chosen by the same people who chose the mark. And two teams can
// publish colours a shade apart, or the identical colour: New England
// and Seattle both list #002a5c, so the split stopped reading as a split
// at all.
//
// Both are answered here. The marks sit on their own light chips, so
// nothing has to survive whatever is behind it, and the two halves are
// pulled apart when they are too close to tell one from the other.
'use strict';

// ---------------------------------------------------------------- colour
const hexToRgb = (c) => {
  const h = String(c || '').replace('#', '').padStart(6, '0').slice(0, 6);
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) || 0);
};
const rgbToHex = (rgb) => '#' + rgb
  .map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
  .join('');
const mix = (a, b, t) => hexToRgb(a).map((v, i) => v + (hexToRgb(b)[i] - v) * t);

// ESPN sends colours as bare hex digits with no leading hash. Handed
// straight to a fill attribute that is not a colour at all, and paints
// black - so everything that can reach the markup goes through here.
const normalizeColor = (c) => rgbToHex(hexToRgb(c));
const darken = (c, t) => rgbToHex(mix(c, '#000000', t));
const lighten = (c, t) => rgbToHex(mix(c, '#ffffff', t));

// WCAG relative luminance.
function luminance(c) {
  const [r, g, b] = hexToRgb(c).map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// How far apart two colours look. Crude on purpose: it only has to answer
// "will these read as one flat colour", and they will whenever every
// channel is close.
const colorGap = (a, b) =>
  Math.sqrt(hexToRgb(a).reduce((s, v, i) => s + (v - hexToRgb(b)[i]) ** 2, 0));

// A team's colour made usable as a half of the card. Near-white marks
// (Wake Forest's sand, New Orleans' gold) and near-black ones are both
// pulled toward the middle, so there is always something for a white
// chip to sit against and the card never goes to paper or to pitch.
function backdrop(c) {
  const l = luminance(c);
  if (l > 0.5) return darken(c, 0.45);
  if (l < 0.02) return lighten(c, 0.14);
  return normalizeColor(c);
}

const TOO_CLOSE = 60;

// The two halves, guaranteed to read as two.
//
// The home side is the one that moves, so the away team always keeps its
// true colour, and it moves to the home team's own published alternate
// first - that is still the team's colour. Seattle against New England is
// the case that earns it: two identical navies, with Seattle's action
// green sitting right there in the same payload.
//
// The alternate is judged as published, not as backdrop() would leave it.
// A white alternate darkens into a perfectly usable mid grey and would
// pass any test applied afterwards, and grey is not a team colour, it is
// the absence of one - hence the chroma floor.
function splitColors(awayColor, homeColor, homeAltColor) {
  const away = backdrop(awayColor);
  let home = backdrop(homeColor);

  if (colorGap(away, home) < TOO_CLOSE) {
    const alt = homeAltColor ? normalizeColor(homeAltColor) : null;
    const chroma = alt ? Math.max(...hexToRgb(alt)) - Math.min(...hexToRgb(alt)) : 0;
    const usable = alt && chroma > 28
      && luminance(alt) > 0.03 && luminance(alt) < 0.75
      && colorGap(away, backdrop(alt)) >= 90;

    home = usable ? backdrop(alt)
      : (luminance(away) > 0.25 ? darken(home, 0.5) : lighten(home, 0.26));
  }
  return { away, home };
}

// ------------------------------------------------------------------- art
const W = 600, H = 900;
const BAR_HALF = 28;            // the rule across the join, either side of centre
const BAR_TOP = H / 2 - BAR_HALF;
const BAR_BOTTOM = H / 2 + BAR_HALF;
const BAR_FILL = '#111a23';
const CHIP = { size: 332, radius: 30, awayCy: 214, homeCy: 686 };
const LOGO = 264;

// "AT" drawn as geometry rather than set in a typeface.
//
// A poster is loaded as an image, so it can never reach a web font, and
// the system fallback differs on every platform it lands on - which for
// two letters centred in a rule is a difference worth removing. Monoline
// strokes, which is what the label wants at this size anyway.
function atMark(cx, cy, height, color) {
  const stroke = Math.max(2, height * 0.17);
  const aWidth = height * 0.8;
  const tWidth = height * 0.72;
  const gap = height * 0.5;
  const left = cx - (aWidth + gap + tWidth) / 2;
  const tLeft = left + aWidth + gap;
  const top = cy - height / 2;
  const bottom = cy + height / 2;

  return `<g stroke="${color}" stroke-width="${stroke}" fill="none" stroke-linecap="square">` +
    `<path d="M${left} ${bottom}L${left + aWidth / 2} ${top}L${left + aWidth} ${bottom}"/>` +
    `<path d="M${left + aWidth * 0.21} ${bottom - height * 0.3}H${left + aWidth * 0.79}"/>` +
    `<path d="M${tLeft} ${top}H${tLeft + tWidth}"/>` +
    `<path d="M${tLeft + tWidth / 2} ${top}V${bottom}"/></g>`;
}

const escapeXml = (str) => String(str == null ? '' : str)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// Splits a name into two roughly balanced lines at the word boundary
// nearest the middle. Only ever seen when a logo could not be fetched.
function splitNameForWrap(name) {
  const words = String(name || 'Team').trim().split(/\s+/);
  if (words.length <= 1) return [name || 'Team'];
  const mid = Math.round(words.length / 2);
  return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
}

// What goes on the chip when the mark could not be fetched. The team's
// name, which is the one thing that cannot be drawn as geometry, so this
// is the single place a system font is relied on - and it only appears
// when the alternative is an empty white square.
function nameOnChip(cx, cy, name, color) {
  const lines = splitNameForWrap(name).map(escapeXml);
  const size = 30;
  return lines.map((line, i) => {
    const offset = i - (lines.length - 1) / 2;
    return `<text x="${cx}" y="${cy + offset * size * 1.2 + size * 0.35}"` +
      ` font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"` +
      ` font-size="${size}" font-weight="700" fill="${color}" text-anchor="middle">${line}</text>`;
  }).join('');
}

function chip(cy, logoData, name, color) {
  const x = (W - CHIP.size) / 2;
  const y = cy - CHIP.size / 2;
  const art = logoData
    ? `<image href="${logoData}" x="${(W - LOGO) / 2}" y="${cy - LOGO / 2}"` +
      ` width="${LOGO}" height="${LOGO}" preserveAspectRatio="xMidYMid meet"/>`
    : nameOnChip(W / 2, cy, name, darken(color, 0.55));

  return `<rect x="${x}" y="${y}" width="${CHIP.size}" height="${CHIP.size}"` +
    ` rx="${CHIP.radius}" fill="#ffffff" filter="url(#chip-drop)"/>${art}`;
}

// The poster. Away above the rule, home below, which is the order the
// matchup is written in everywhere else in the app.
function buildMatchupPoster({
  awayLogoData, homeLogoData, awayName, homeName,
  awayColor, homeColor, homeAltColor,
}) {
  const { away, home } = splitColors(awayColor, homeColor, homeAltColor);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    '<defs>' +
      '<filter id="chip-drop" x="-25%" y="-25%" width="150%" height="150%">' +
        '<feDropShadow dx="0" dy="9" stdDeviation="13" flood-color="#000000" flood-opacity="0.4"/>' +
      '</filter>' +
      '<radialGradient id="edge-shade" cx="0.5" cy="0.5" r="0.8">' +
        '<stop offset="0.55" stop-color="#000000" stop-opacity="0"/>' +
        '<stop offset="1" stop-color="#000000" stop-opacity="0.32"/>' +
      '</radialGradient>' +
    '</defs>' +
    `<rect width="${W}" height="${BAR_TOP}" fill="${away}"/>` +
    `<rect y="${BAR_BOTTOM}" width="${W}" height="${H - BAR_BOTTOM}" fill="${home}"/>` +
    `<rect y="${BAR_TOP}" width="${W}" height="${BAR_HALF * 2}" fill="${BAR_FILL}"/>` +
    `<rect width="${W}" height="${H}" fill="url(#edge-shade)"/>` +
    atMark(W / 2, H / 2, 22, '#ffffff') +
    chip(CHIP.awayCy, awayLogoData, awayName, away) +
    chip(CHIP.homeCy, homeLogoData, homeName, home) +
    '</svg>';
}

module.exports = {
  buildMatchupPoster,
  // Exported for the tests, which check the colour rules directly rather
  // than by reading them out of finished markup.
  splitColors, backdrop, colorGap, luminance, normalizeColor, darken, lighten,
  POSTER_WIDTH: W, POSTER_HEIGHT: H,
};
