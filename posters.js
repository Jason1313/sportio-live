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

    if (usable) {
      home = backdrop(alt);
    } else {
      // No usable alternate, so the home side is shaded away from the
      // other one instead. Stepped until it clears rather than swung once.
      //
      // One step was enough while this was football only, where a team
      // without a usable alternate is the exception. It is the rule in
      // hockey: not one of 124 NHL fixtures had an alternate colour
      // published for the home side, so the shade is the whole mechanism
      // there - and one swing left Chicago's red against Detroit's a
      // hair under the threshold, two reds with nothing but the seam
      // between them.
      //
      // The first amount is the one football was tuned on, so every pair
      // that already cleared it comes out of here unchanged.
      const goLighter = luminance(away) <= 0.25;
      const steps = goLighter ? [0.26, 0.40, 0.55, 0.70] : [0.50, 0.65, 0.78, 0.88];
      // Each step shades the ORIGINAL colour further, never the result of
      // the step before - compounding would run away from the team's
      // colour far faster than the numbers here suggest.
      const base = home;
      for (const amount of steps) {
        home = goLighter ? lighten(base, amount) : darken(base, amount);
        if (colorGap(away, home) >= TOO_CLOSE) break;
      }
    }
  }
  return { away, home };
}

// ------------------------------------------------------------------- art
const W = 600, H = 900;
const MID = H / 2;

// The matchup poster is square, and the wrestling one below is not.
//
// Both used to be 2:3, which is the shape a poster is when it is drawn
// from nothing. A matchup card is not that any more - it is ESPN's
// square artwork - and a tall frame around a square picture is two bands
// of filler. The drawn matchup poster is square for the same reason: it
// only ever stands in for the artwork, and a fallback that changed the
// card's shape would announce itself more loudly than the picture it was
// standing in for.
const SQ = 600;
const SQ_MID = SQ / 2;
// A hairline of white across the join. Two halves that came out close to
// each other still read as two with a line between them, and it costs
// nothing on the pairs that were never in doubt.
const SEAM = 4;
// Sized to the square's half rather than the tall one's: each half is
// 300 deep, so a 236 chip leaves the same margin above and below that
// 340 left in a 450-deep half.
const CHIP = { size: 236, radius: 24, awayCy: SQ_MID / 2, homeCy: SQ_MID * 1.5 };
const LOGO = 184;

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
  const x = (SQ - CHIP.size) / 2;
  const y = cy - CHIP.size / 2;
  const art = logoData
    ? `<image href="${logoData}" x="${(SQ - LOGO) / 2}" y="${cy - LOGO / 2}"` +
      ` width="${LOGO}" height="${LOGO}" preserveAspectRatio="xMidYMid meet"/>`
    : nameOnChip(SQ / 2, cy, name, darken(color, 0.55));

  return `<rect x="${x}" y="${y}" width="${CHIP.size}" height="${CHIP.size}"` +
    ` rx="${CHIP.radius}" fill="#ffffff" filter="url(#chip-drop)"/>${art}`;
}

// The poster. Away on top, home below, which is the order the matchup is
// written in everywhere else in the app.
function buildMatchupPoster({
  awayLogoData, homeLogoData, awayName, homeName,
  awayColor, homeColor, homeAltColor,
}) {
  const { away, home } = splitColors(awayColor, homeColor, homeAltColor);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SQ} ${SQ}" width="${SQ}" height="${SQ}">` +
    '<defs>' +
      '<filter id="chip-drop" x="-25%" y="-25%" width="150%" height="150%">' +
        '<feDropShadow dx="0" dy="9" stdDeviation="13" flood-color="#000000" flood-opacity="0.4"/>' +
      '</filter>' +
      '<radialGradient id="edge-shade" cx="0.5" cy="0.5" r="0.8">' +
        '<stop offset="0.55" stop-color="#000000" stop-opacity="0"/>' +
        '<stop offset="1" stop-color="#000000" stop-opacity="0.32"/>' +
      '</radialGradient>' +
    '</defs>' +
    `<rect width="${SQ}" height="${SQ_MID}" fill="${away}"/>` +
    `<rect y="${SQ_MID}" width="${SQ}" height="${SQ_MID}" fill="${home}"/>` +
    `<rect y="${SQ_MID - SEAM / 2}" width="${SQ}" height="${SEAM}" fill="#ffffff" opacity="0.85"/>` +
    `<rect width="${SQ}" height="${SQ}" fill="url(#edge-shade)"/>` +
    chip(CHIP.awayCy, awayLogoData, awayName, away) +
    chip(CHIP.homeCy, homeLogoData, homeName, home) +
    '</svg>';
}

// A matchup poster built on ESPN's own stitched artwork.
//
// ESPN renders one of these for every event: a square split on the
// diagonal, each half in that team's colour with its logo already drawn
// to read on it. That last part is the whole reason to use it. The
// drawn poster above has to solve the same problem itself, from two
// published colours and two logos it has never seen together, and
// splitColors exists because that goes wrong often enough to need
// rescuing.
//
// The artwork at its own size, and nothing else.
//
// It was briefly wrapped in the 2:3 frame the drawn posters used, with
// the extra sixth top and bottom filled by sampling the artwork's own
// corners. That worked - the seam was invisible - and it was still the
// wrong answer: a tall frame around a square picture is two bands of
// filler however well their colour is matched. The card is now the shape
// the picture is.
//
// 400 because that is what ESPN renders. No scaling here, so the only
// resampling is whatever the browser does fitting it to the grid.
const STITCH = 400;

function buildStitchedPoster({ art }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `viewBox="0 0 ${STITCH} ${STITCH}" width="${STITCH}" height="${STITCH}">` +
    `<image xlink:href="${art}" x="0" y="0" width="${STITCH}" height="${STITCH}"/>` +
    '</svg>';
}

// ------------------------------------------------------------ wrestling
//
// A promotion's card has no two teams to split a poster between - it has
// a headline fight and the artwork the promotion drew for it. So the art
// is the poster, letterboxed onto a 2:3 field rather than cropped to it,
// because these are 16:9 and square graphics with the names along the
// bottom, and object-cover would cut exactly that off.
//
// The band behind it carries the promotion's colours so a card with no
// artwork yet still looks like it belongs to the same section.
function wrapToWidth(text, perLine, maxLines) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > perLine && line) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, perLine - 1)}\u2026`;
    return kept;
  }
  return lines;
}

// A promotion's card, drawn rather than photographed.
//
// The promotion's own artwork was tried first and dropped: it arrives in
// mixed shapes, none of them 2:3, and a poster built around it was
// mostly letterboxing. This is the same answer the MMA cards give - the
// promotion's mark and the name of the event - which also makes a card
// a couple of kilobytes instead of a few hundred.
//
// The type is set in a system stack rather than drawn as geometry. A
// poster is loaded as an image and can never reach a web font, so the
// face differs by platform; textLength pins the wordmark to a fixed
// width so that difference changes the letterforms and not the layout.
// The fighters' names cannot be handled that way - they are arbitrary
// text - so they are wrapped and left to the local font.
function buildEventPoster({ code, title, place, accent = '#C8102E' }) {
  const ground = '#0B1B2B';
  const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

  const text = (body, { y, size, weight = 700, fill = '#ffffff', spacing = 0, length = null }) =>
    `<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="${FONT}"` +
    ` font-size="${size}" font-weight="${weight}" letter-spacing="${spacing}" fill="${fill}"` +
    (length ? ` textLength="${length}" lengthAdjust="spacingAndGlyphs"` : '') +
    `>${escapeXml(body)}</text>`;

  // Two mat circles, which is what a wrestling surface looks like from
  // above, sized and placed so they read as a watermark rather than as
  // a diagram.
  const mat =
    `<g fill="none" stroke="${accent}" stroke-opacity="0.16">` +
      `<circle cx="${W / 2}" cy="330" r="250" stroke-width="26"/>` +
      `<circle cx="${W / 2}" cy="330" r="150" stroke-width="14"/>` +
    '</g>';

  const nameLines = wrapToWidth(title, 22, 3);
  const nameTop = 620 - (nameLines.length - 1) * 21;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    '<defs>' +
      `<linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0" stop-color="#14304a"/><stop offset="1" stop-color="${ground}"/>` +
      '</linearGradient>' +
    '</defs>' +
    `<rect width="${W}" height="${H}" fill="url(#ground)"/>` +
    mat +
    `<rect y="0" width="${W}" height="10" fill="${accent}"/>` +

    // The mark: initials over the full name, the way the promotion
    // writes itself.
    text('RAF', { y: 372, size: 172, weight: 800, spacing: 6, length: 330 }) +
    `<rect x="${(W - 300) / 2}" y="410" width="300" height="3" fill="${accent}"/>` +
    text('REAL AMERICAN FREESTYLE', { y: 452, size: 22, weight: 700, spacing: 4, fill: '#ffffffcc', length: 400 }) +

    // The card's own number, then its headline.
    (code ? text(code.toUpperCase(), { y: 556, size: 30, weight: 800, spacing: 5, fill: accent }) : '') +
    nameLines.map((line, i) => text(line, { y: nameTop + i * 42, size: 34, weight: 700 })).join('') +
    (place ? text(place, { y: 742, size: 22, weight: 600, fill: '#ffffff8c' }) : '') +

    text('FOX NATION', { y: 836, size: 19, weight: 700, spacing: 5, fill: '#ffffff73', length: 200 }) +
    `<rect y="${H - 10}" width="${W}" height="10" fill="${accent}"/>` +
    '</svg>';
}


module.exports = {
  buildMatchupPoster,
  buildStitchedPoster,
  buildEventPoster,
  // Exported for the tests, which check the colour rules directly rather
  // than by reading them out of finished markup.
  splitColors, backdrop, colorGap, luminance, normalizeColor, darken, lighten,
  POSTER_WIDTH: W, POSTER_HEIGHT: H,
};
