// Bare Knuckle FC's schedule.
//
// Scraped, because nothing publishes it. ESPN carries forty-eight MMA
// leagues and not one of them is bare knuckle - measured against their
// own leagues index, which lists everything from Pancrase to Shooto
// Brazil and has no entry for this - and the three slugs worth guessing
// (bkfc, bare-knuckle, bkb) all answer 400. The catch-all league that
// sweeps up LFA and RIZIN does not carry it either. So the source is the
// promotion, read from the page it publishes to the public.
//
// Same shape as wrestling.js and for the same reason, with one useful
// difference: BKFC puts the start time on the index itself, so this is
// one request per refresh rather than one per card.
'use strict';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_ALT = MONTHS.join('|');

const BKFC_ORIGIN = 'https://www.bkfc.com';
const BKFC_EVENTS = `${BKFC_ORIGIN}/events`;

// A browser user agent. The site is a CDN-fronted Webflow build, the
// same platform the wrestling promotion uses, and the plainer agents get
// inconsistent treatment.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' +
    ' (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
};

// Six hours. The promotion runs a card most weeks and announces them
// months out, so nothing here changes fast, and the whole schedule is
// one request.
const CACHE_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12000;

// How far ahead a card is worth showing. Deliberately the same window
// the MMA section uses for ESPN's promotions, because this sits in that
// section beside them and a shorter one would make BKFC's schedule look
// thinner than it is - measured live, the published schedule runs four
// months out.
const SCHEDULE_DAYS = 180;

// The zone every published time is in.
//
// The page states no zone at all - it prints "October 3, 2026 5:00 AM"
// and lets a luxon script rewrite it in the reader's own zone once the
// page is running, which a scraper never sees. Read as America/New_York
// the whole schedule makes sense and nothing else does: of the nine
// cards published, all five outside the United States land on exactly
// 7:00 PM at their own venue - Manchester, Glasgow, Belgrade, and
// Queensland's 5:00 AM reading as 7:00 PM local - and the four American
// ones land on 7 or 8 in the evening in their own state. Read as UTC the
// same five land mid-afternoon.
const SOURCE_ZONE = 'America/New_York';

// ---------------------------------------------------------------- time
//
// Wrestling.js carries the same two functions for the same reason. They
// are not shared: that module resolves an abbreviation the promotion
// prints ("EST" in October, "CST" in July) to a region, and this one has
// a fixed zone and no abbreviation to resolve, so the twenty lines they
// would share is the arithmetic and not the problem.
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

// ------------------------------------------------------------- parsing
const DATE_ONLY = new RegExp(`^(${MONTH_ALT})\\s+(\\d{1,2}),?\\s+(\\d{4})$`, 'i');
const DATE_TIME = new RegExp(
  `^(${MONTH_ALT})\\s+(\\d{1,2}),?\\s+(\\d{4})\\s+(\\d{1,2}):(\\d{2})\\s*(AM|PM)$`, 'i');

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

// The page as a stream of images, event links and text, which is what
// the parse below walks. Anchored on none of the class names: this is
// Webflow output and its classes are generated, so a restyle renames
// every one of them while "October 17, 2026 8:00 PM" stays what it is.
function tokenize(html) {
  const tokens = [];
  const re = /<img\b[^>]*?\bsrc="([^"]+)"[^>]*>|<a\b[^>]*?\bhref="(\/events\/[^"?#]+)"|>([^<]{2,160})</g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) { tokens.push({ img: m[1] }); continue; }
    if (m[2]) { tokens.push({ href: m[2] }); continue; }
    const text = m[3]
      .replace(/&#x27;|&#39;/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/&amp;/gi, '&')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/\s+/g, ' ')
      .trim();
    if (text) tokens.push({ text });
  }
  return tokens;
}

// Every card the page lists, read off one rigid five-token shape:
//
//     HREF /events/<slug>
//     TEXT BKFC 95 NEWARK HERRING vs DODSON     <- the name
//     TEXT October 17, 2026                     <- the day
//     TEXT October 17, 2026 8:00 PM             <- the anchor
//     TEXT PRUDENTIAL CENTER - NEWARK, NJ       <- the venue
//
// Requiring all of it, rather than scanning outward from the date, is
// what keeps the page's other renderings of the same events out. Each
// card is drawn up to three times - a countdown hero at the top, a
// "Next" strip, and this list - and the copies carry the same strings in
// a different order, the hero putting the name AFTER the time. Scanning
// outward finds whichever copy is nearest and files a card under another
// card's venue; insisting the name sits two above the time and a link
// three above it describes the list and nothing else.
//
// The headline fighters sit just above the link when there are any
// ("JAMEL HERRING", "JOHN DODSON"), and a card with none says "Fights
// TBA" there instead. Taken when they are there and skipped when they
// are not - they are worth having because a card with no channel behind
// it falls through to a search on the names, and not worth insisting on,
// because a card announced before its fights are is still a card.
function parseEvents(html) {
  const tokens = tokenize(html);
  const events = [];

  for (let i = 3; i < tokens.length; i++) {
    const at = tokens[i].text && DATE_TIME.exec(tokens[i].text);
    if (!at) continue;

    const day = tokens[i - 1].text && DATE_ONLY.exec(tokens[i - 1].text);
    if (!day) continue;

    const name = tokens[i - 2].text;
    const link = tokens[i - 3].href;
    if (!name || !link || DATE_ONLY.test(name)) continue;

    // The same day, said twice. A card's own two lines always agree; a
    // mismatch means the shape has been matched across two cards.
    if (day[1].toLowerCase() !== at[1].toLowerCase()
        || day[2] !== at[2] || day[3] !== at[3]) continue;

    const venue = (tokens[i + 1] || {}).text || '';

    const fighters = [tokens[i - 5], tokens[i - 4]]
      .map(t => (t && t.text) || '')
      .filter(t => t && !/^fights tba$/i.test(t) && !/^vs$/i.test(t));

    let hour = Number(at[4]) % 12;
    if (/pm/i.test(at[6])) hour += 12;
    const monthIndex = MONTHS.findIndex(mo => mo.toLowerCase() === at[1].toLowerCase());

    events.push({
      slug: link,
      name,
      location: DATE_ONLY.test(venue) ? '' : venue,
      fighters: fighters.length === 2 ? fighters : [],
      date: instantFrom(Number(at[3]), monthIndex, Number(at[2]), hour, Number(at[5]), SOURCE_ZONE),
    });
  }

  // By slug, which is the only thing on the page that is genuinely one
  // per card. Two cards can share a day - October 17 carries both
  // Belgrade and Newark - so a date key would merge them into one.
  const bySlug = new Map();
  for (const event of events) {
    if (!bySlug.has(event.slug)) bySlug.set(event.slug, event);
  }
  return [...bySlug.values()];
}

// ------------------------------------------------------------- caching
let cache = null;      // { events, fetchedAt }
let inFlight = null;

async function loadEvents() {
  const parsed = parseEvents(await getText(BKFC_EVENTS));

  // Midnight-anchored, so a card is still listed all through the day it
  // happens rather than disappearing at its own start time.
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const horizon = Date.now() + SCHEDULE_DAYS * 24 * 60 * 60 * 1000;

  const events = parsed.filter(e => e.date.getTime() >= cutoff && e.date.getTime() <= horizon);
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
      console.log(`[BKFC] ${events.length} scheduled event(s) from the promotion's site.`);
      return events;
    } catch (err) {
      console.error(`[BKFC] Could not read the schedule: ${err.message}`);
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
  BKFC_ORIGIN,
  // Exported so the parse can be run against a saved page rather than
  // by reaching across the network.
  parseEvents,
  instantFrom,
  SOURCE_ZONE,
};
