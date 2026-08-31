// Wrestling schedules.
//
// Its own section rather than a corner of MMA: freestyle and folkstyle
// are not mixed martial arts, and the section is meant to hold college
// duals alongside the pro promotions later.
//
// Nothing published serves this. ESPN has no wrestling sport at all -
// measured, their core API lists seventeen sports and wrestling is not
// one, and none of their forty-eight MMA leagues is a wrestling
// promotion. Tapology refuses any client that is not a browser (403).
// Wikipedia keeps a tidy table and is wrong: against the promotion's own
// site it had two of three upcoming dates off by days. So the source is
// the promotion, read from the pages it publishes to the public.
'use strict';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_ALT = MONTHS.join('|');

const RAF_ORIGIN = 'https://www.realamericanfreestyle.com';
const RAF_GALLERY = `${RAF_ORIGIN}/events-gallery`;

// A browser user agent, because the site is a CDN-fronted Webflow build
// and the plainer agents get inconsistent treatment.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' +
    ' (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
};

// Six hours. The promotion adds a card every few weeks and announces one
// perhaps monthly, so nothing here changes fast - but a fetch is one
// gallery page plus one page per upcoming event, which is four requests
// at present. Cheap enough to be current within a day without being a
// nuisance to somebody else's web host.
const CACHE_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12000;

// How far ahead a card is worth showing. The promotion runs one event
// every few weeks, so a week-long window would be empty most of the
// time - the same reason the MMA section uses a long one.
const SCHEDULE_DAYS = 120;

// ---------------------------------------------------------------- html
const flatten = (html) => String(html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, '\n')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

async function getText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------- parsing
//
// Anchored on the date, not on class names. The page is Webflow output
// and its classes are generated, so a restyle would rename all of them
// while "October 23, 2026" stays exactly what it is.
const DATE_LINE = new RegExp(`^(${MONTH_ALT})\\s+(\\d{1,2}),\\s+(\\d{4})$`, 'i');

// "9:00 PM EST" beside a date on an event's own page.
const DATE_TIME = new RegExp(
  `(${MONTH_ALT})\\s+(\\d{1,2}),\\s+(\\d{4})\\s+(\\d{1,2}):(\\d{2})\\s*(AM|PM)\\s*([A-Za-z]{2,4})`, 'i');

// The promotion writes "EST" in October and "CST" in July, so the
// abbreviations name a region rather than an offset. Resolving them to a
// zone and letting the date decide the offset gets what was meant -
// nine in the evening, Eastern - instead of an hour's error all summer.
const ZONES = {
  est: 'America/New_York', edt: 'America/New_York', et: 'America/New_York',
  cst: 'America/Chicago', cdt: 'America/Chicago', ct: 'America/Chicago',
  mst: 'America/Denver', mdt: 'America/Denver', mt: 'America/Denver',
  pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', pt: 'America/Los_Angeles',
};

function offsetMinutesAt(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
    .formatToParts(instant);
  const name = (parts.find(p => p.type === 'timeZoneName') || {}).value || '';
  const m = name.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
  if (!m) return 0;
  const hours = parseInt(m[1], 10);
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  return hours * 60 + (hours < 0 ? -minutes : minutes);
}

// A wall-clock reading in a named zone, as an instant. The offset is
// taken at midday on the day in question rather than at the reading
// itself, so the answer does not depend on which side of a daylight
// change a midnight event happens to land.
function instantFrom(year, monthIndex, day, hour, minute, timeZone) {
  const noon = new Date(Date.UTC(year, monthIndex, day, 12, 0, 0));
  const offset = offsetMinutesAt(noon, timeZone);
  return new Date(Date.UTC(year, monthIndex, day, hour, minute, 0) - offset * 60000);
}

// Every event on the gallery, in the order the page lists them.
//
// The page is walked as a stream of images, links and text. A date line
// closes an event: what came just before it is the title, what follows
// is the location, and the nearest image and /events/ link above it
// belong to the same card.
function parseGallery(html) {
  const tokens = [];
  const re = /<img\b[^>]*?\bsrc="([^"]+)"[^>]*>|<a\b[^>]*?\bhref="(\/events\/[^"?#]+)"|>([^<]{2,120})</g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) { tokens.push({ img: m[1] }); continue; }
    if (m[2]) { tokens.push({ href: m[2] }); continue; }
    const text = m[3].replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ').trim();
    if (text) tokens.push({ text });
  }

  const events = [];
  for (let i = 0; i < tokens.length; i++) {
    const here = tokens[i].text;
    if (!here) continue;
    const date = DATE_LINE.exec(here);
    if (!date) continue;

    let title = null;
    let code = null;
    let image = null;
    for (let j = i - 1; j >= 0 && j > i - 14; j--) {
      const t = tokens[j];
      if (t.text && !title) { title = t.text; continue; }
      // The card number sits just above the matchup name on announced
      // events ("RAF14", then "Tsarukyan vs Danis"), and is the whole
      // title on ones with no headline yet.
      if (t.text && !code && /^RAF[\s-]?\w{0,10}$/i.test(t.text)) code = t.text;
      if (t.img && !image) image = t.img;
    }
    // The location is simply the next line.
    let location = null;
    for (let j = i + 1; j < tokens.length && j < i + 5; j++) {
      if (tokens[j].text) { location = tokens[j].text; break; }
    }

    const monthIndex = MONTHS.findIndex(mo => mo.toLowerCase() === date[1].toLowerCase());
    events.push({
      code: code || null,
      title: title || code || 'Real American Freestyle',
      location: location || '',
      image: image || null,
      slug: null,
      year: Number(date[3]),
      monthIndex,
      day: Number(date[2]),
    });
  }

  // The link to an event's own page is matched by name, not by
  // position. Each card is rendered twice - once in a promo strip and
  // once in the list below - and only the second carries a link, so
  // scanning outward from a date runs into the NEXT card's link and
  // quietly files RAF 14 under the Moscow event's start time.
  const slugs = [...new Set([...html.matchAll(/href="(\/events\/[^"?#]+)"/g)].map(m => m[1]))];
  const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const slugByKey = new Map(slugs.map(s => [key(s.replace('/events/', '')), s]));
  for (const event of events) {
    event.slug = slugByKey.get(key(event.code)) || null;
  }

  // The gallery renders each upcoming card twice - once in a promo
  // strip at the top and once in the full list below - and the two
  // carry different parts of it. The promo has the artwork; only the
  // list item has the link to the event's own page. So duplicates are
  // merged rather than deduplicated, taking whichever copy has each
  // field. Dropping the second copy is what left every event without a
  // link, and so without a start time.
  const merged = new Map();
  for (const event of events) {
    const key = `${event.year}-${event.monthIndex}-${event.day}|${event.title.toLowerCase()}`;
    const held = merged.get(key);
    if (!held) { merged.set(key, event); continue; }
    for (const field of ['code', 'image', 'slug', 'location']) {
      if (!held[field] && event[field]) held[field] = event[field];
    }
  }
  return [...merged.values()];
}

// The start time, which the gallery does not carry - it is only on the
// event's own page, in the "how to watch" block.
function parseStartTime(html, event) {
  const m = DATE_TIME.exec(flatten(html).replace(/\n+/g, ' '));
  if (!m) return null;

  const monthIndex = MONTHS.findIndex(mo => mo.toLowerCase() === m[1].toLowerCase());
  // Only trust it when it is the same day the gallery gave. An event
  // page carries a nav strip listing the other cards, and matching one
  // of those would put this event at another event's time.
  if (monthIndex !== event.monthIndex || Number(m[2]) !== event.day || Number(m[3]) !== event.year) {
    return null;
  }

  let hour = Number(m[4]) % 12;
  if (/pm/i.test(m[6])) hour += 12;
  const zone = ZONES[m[7].toLowerCase()] || 'America/New_York';
  return { instant: instantFrom(event.year, monthIndex, event.day, hour, Number(m[5]), zone), zone };
}

// ------------------------------------------------------------- caching
let cache = null;      // { events, fetchedAt }
let inFlight = null;

async function loadEvents() {
  const gallery = await getText(RAF_GALLERY);
  const parsed = parseGallery(gallery);

  // Midnight-anchored, so an event is still "upcoming" all through the
  // day it happens rather than disappearing at its start time.
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const horizon = Date.now() + SCHEDULE_DAYS * 24 * 60 * 60 * 1000;

  const events = [];
  for (const event of parsed) {
    // Midday, as a stand-in until the event's own page gives a time.
    const provisional = instantFrom(event.year, event.monthIndex, event.day, 12, 0, 'America/New_York');
    if (provisional.getTime() < cutoff || provisional.getTime() > horizon) continue;
    events.push({ ...event, date: provisional, hasTime: false });
  }

  // Only the cards that are still to come are worth a second request.
  for (const event of events) {
    if (!event.slug) continue;
    try {
      const page = await getText(RAF_ORIGIN + event.slug);
      const timed = parseStartTime(page, event);
      if (timed) {
        event.date = timed.instant;
        event.zone = timed.zone;
        event.hasTime = true;
      }
    } catch (err) {
      // A card with no time still belongs on the schedule; it just shows
      // the day rather than the hour.
      console.error(`[RAF] Could not read ${event.slug}: ${err.message}`);
    }
  }

  events.sort((a, b) => a.date - b.date);
  return events;
}

async function getEvents({ force = false } = {}) {
  if (!force && cache && (Date.now() - cache.fetchedAt) < CACHE_MS) return cache.events;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const events = await loadEvents();
      cache = { events, fetchedAt: Date.now() };
      console.log(`[RAF] ${events.length} scheduled event(s) from the promotion's site.`);
      return events;
    } catch (err) {
      console.error(`[RAF] Could not read the schedule: ${err.message}`);
      // Stale beats empty: an outage should not empty the section of a
      // card that is still going ahead.
      return cache ? cache.events : [];
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

module.exports = {
  getEvents,
  SCHEDULE_DAYS,
  // Exported for the tests, which check the parsing against saved pages
  // rather than by reaching across the network.
  parseGallery,
  parseStartTime,
  instantFrom,
  RAF_ORIGIN,
};
