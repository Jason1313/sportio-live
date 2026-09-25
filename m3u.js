// M3U support - parsing and caching layer.
//
// This is the foundation everything else (wizard setup, Category Search,
// catalog/stream routes) builds on. Design was validated against a real
// provider's actual playlist before any of this was written, including
// the multi-category channel membership handled below.
//
// A playlist is fetched and parsed on a schedule into a shared background
// cache, never on a visitor's request - a real one is tens of thousands
// of entries and a few seconds to fetch. See startM3uScheduler below.
//
// There used to be an EPG beside it: a ~150MB XMLTV file, fetched on the
// same schedule, parsed in two or three seconds and held in memory, for
// the programme text the tier matcher read. The tier matcher was removed
// and nothing read the parse again, so the file was being downloaded
// twice a day per provider for a log line. It is no longer fetched.

const axios = require('axios');

// ---------------------------------------------------------------------
// Playlist parsing
// ---------------------------------------------------------------------

// Parses raw M3U playlist text into:
// - channels: array of { id, name, logo, streamUrl, categories: [...] }
//   (categories is always an array - the SAME stream URL can genuinely be
//   listed under more than one group-title at once)
// - categoryList: array of { name, channelCount }, sorted alphabetically
//
// Deliberately not a full M3U-spec parser - just enough structure
// extraction for the fields actually used, matching the real-world
// format confirmed during design against actual provider output.
//
// KEYED BY streamUrl, NOT tvg-id. This was originally keyed by tvg-id on
// the assumption that one tvg-id means one channel. That is false against
// real provider data: tvg-id identifies the NETWORK for EPG purposes, and
// providers routinely list many genuinely different feeds of that network
// (different qualities, different source servers, 4K variants, backups)
// under one shared tvg-id. Measured on a real 18k-entry playlist: 1,278
// tvg-ids were used by more than one entry, and keying by tvg-id silently
// discarded 2,048 DISTINCT stream URLs - keeping only whichever feed
// happened to appear first in the file and merging every other feed's
// group membership onto it. The practical effect was that if that first
// feed was dead, the channel was dead everywhere, even though the
// provider had supplied several working alternates.
//
// Keying by URL means one entry per real, distinct stream. tvg-id is
// retained on each channel as a non-unique attribute, which is what the
// link healer wants from it - several feeds of the same network share
// one, so a saved link whose URL rotated can find its network again.
// See networks.resolveLinkEntry.
function parseM3UPlaylist(content) {
  const blocks = content.split(/(?=#EXTINF:)/);
  const channelsByUrl = new Map();

  for (const block of blocks) {
    if (!block.startsWith('#EXTINF:')) continue;

    const idMatch = block.match(/tvg-id="([^"]*)"/);
    const logoMatch = block.match(/tvg-logo="([^"]*)"/);
    const groupMatch = block.match(/group-title="([^"]*)"/);
    // The name is everything after the first comma that is not inside a
    // quoted attribute. It used to be everything after the LAST comma,
    // which cut any name holding one: a Strong8K NBC folder writes its
    // stations "... DALLAS, TX (D) RAW", and 102 of them arrived named
    // "TX (D) RAW" - no network, no call sign, nothing a channel pattern
    // or a person could recognise. The quotes are stepped over rather
    // than split on, since a group-title can hold a comma of its own.
    const extinfLine = block.split('\n')[0].replace(/\r$/, '');
    const nameMatch = extinfLine.match(/^#EXTINF:[^,"]*(?:"[^"]*"[^,"]*)*,(.*)$/);
    const urlMatch = block.match(/\n(https?:\/\/\S+)/);

    // Skip malformed entries rather than let one bad line break the whole
    // parse - a missing id or stream URL means the entry isn't usable
    // anyway.
    if (!idMatch || !urlMatch) continue;

    const id = idMatch[1];
    const name = (nameMatch ? nameMatch[1] : id).trim();
    const logo = logoMatch ? logoMatch[1] : '';
    const streamUrl = urlMatch[1].trim();
    const group = groupMatch ? groupMatch[1] : '';

    // First listing of a URL wins for name/logo - if the same stream is
    // listed twice under different names, either is equally valid and
    // there's no basis for preferring the later one.
    if (!channelsByUrl.has(streamUrl)) {
      channelsByUrl.set(streamUrl, { id, name, logo, streamUrl, categories: new Set() });
    }
    if (group) {
      channelsByUrl.get(streamUrl).categories.add(group);
    }
  }

  const channels = [...channelsByUrl.values()].map(ch => ({
    ...ch,
    categories: [...ch.categories]
  }));

  const categoryCounts = new Map();
  for (const ch of channels) {
    for (const cat of ch.categories) {
      categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
    }
  }
  const categoryList = [...categoryCounts.entries()]
    .map(([name, channelCount]) => ({ name, channelCount }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { channels, categoryList };
}

// ---------------------------------------------------------------------
// Fetch + parse a full source
// ---------------------------------------------------------------------

// Fetches and parses one playlist. The slow part - seconds, not
// milliseconds, for a real-sized playlist - which is why only the
// background refresh and the setup wizard call it, never a visitor.
//
// Failures carry playlistFailed/playlistError so the wizard can say what
// went wrong rather than a generic failure.
async function fetchAndParseM3USource(playlistUrl) {
  let playlistText;
  try {
    const res = await axios.get(playlistUrl, { timeout: 30000, responseType: 'text', transformResponse: [d => d] });
    playlistText = res.data;
  } catch (reason) {
    const err = new Error('Failed to fetch M3U source');
    err.playlistFailed = true;
    err.playlistError = reason.message;
    throw err;
  }

  const { channels, categoryList } = parseM3UPlaylist(playlistText);
  if (channels.length === 0) {
    // File-sharing hosts (Google Drive in particular) answer 200 OK with
    // an HTML quota/consent page rather than the file when they're
    // throttling. That arrives as a perfectly successful HTTP response
    // containing no #EXTINF lines, and "contained no usable channels" is
    // a misleading way to describe it - the playlist is fine, the host
    // just didn't serve it. Naming the real cause saves a long hunt.
    const head = String(playlistText || '').slice(0, 500).toLowerCase();
    const looksLikeHtml = head.includes('<html') || head.includes('<!doctype html');
    const err = new Error(looksLikeHtml
      ? 'Host returned an HTML page instead of the playlist (usually a download quota or consent interstitial, common with Google Drive links)'
      : 'Playlist parsed but contained no usable channels');
    err.playlistFailed = true;
    err.playlistError = err.message;
    throw err;
  }

  return { channels, categoryList, fetchedAt: Date.now() };
}

// The host a playlist is served from, for logs. Never the whole URL: a
// playlist URL carries the account's username and password in its path,
// and these lines exist to be pasted into a chat when something breaks.
function describeSource(playlistUrl) {
  try {
    return new URL(String(playlistUrl)).host || 'playlist';
  } catch (err) {
    return 'playlist';
  }
}

// ---------------------------------------------------------------------
// Cache store
// ---------------------------------------------------------------------

// Keyed by playlistUrl - the natural unique identifier for a source,
// since different users can each bring their own, completely different
// provider. This is a shared, in-memory cache: the heavy parsed catalog
// data is never stored per-user (a user's own stored data stays tiny -
// just their two URLs), matching the settled design. Refresh cadence
// itself is a single global admin setting (built separately, in the
// scheduler) - this map just holds whatever the most recent successful
// parse produced, independent of how the refresh was triggered.
const m3uSourceCache = new Map(); // playlistUrl -> parsed source result

async function refreshM3USource(playlistUrl) {
  const parsed = await fetchAndParseM3USource(playlistUrl);
  m3uSourceCache.set(playlistUrl, parsed);
  return parsed;
}

function getCachedM3USource(playlistUrl) {
  return m3uSourceCache.get(playlistUrl) || null;
}

// ---------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------

// Finds the next actual UTC instant matching one of the configured
// day-of-week + clock-time combinations, in the given timezone.
// Deliberately computes the UTC offset separately for EACH candidate day
// (via noon UTC on that specific date as an anchor) rather than reusing
// "now's" offset - the two can genuinely differ across a DST transition,
// and a schedule spanning one needs the correct offset for the actual
// candidate day, not whatever offset happened to be in effect when this
// function was called. Verified against real test cases during design,
// including a DST-fallback transition specifically (confirmed it
// correctly used the post-transition offset, not a stale pre-transition
// one) and multi-time-per-day rollover within the same day.
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function getOffsetMinutesAt(dateUtcNoon, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' });
  const parts = formatter.formatToParts(dateUtcNoon);
  const offsetPart = parts.find(p => p.type === 'timeZoneName').value; // e.g. 'GMT-4' or 'GMT+9'
  const match = offsetPart.match(/GMT([+-]\d+)(?::(\d+))?/);
  if (!match) return 0;
  const hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  return hours * 60 + (hours < 0 ? -minutes : minutes);
}

// daysOfWeek: array of 'sun'..'sat' (any subset). times: array of 'HH:MM'
// 24-hour strings (any subset, one schedule can have several times per
// day). Searches up to 8 days ahead - always finds a match given at
// least one day and one time are configured.
function computeNextScheduledRun(daysOfWeek, times, timeZone, now = new Date()) {
  const daySet = new Set(daysOfWeek.map(d => d.toLowerCase()));
  const sortedTimes = [...times].sort();

  const nowFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23'
  });
  const nowParts = nowFormatter.formatToParts(now);
  const get = (type) => nowParts.find(p => p.type === type).value;
  const todayY = parseInt(get('year'), 10), todayM = parseInt(get('month'), 10), todayD = parseInt(get('day'), 10);

  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const candidateUtcNoon = new Date(Date.UTC(todayY, todayM - 1, todayD + dayOffset, 12, 0, 0));
    const candidateDayName = DAY_NAMES[candidateUtcNoon.getUTCDay()];
    if (!daySet.has(candidateDayName)) continue;

    const offsetMinutes = getOffsetMinutesAt(candidateUtcNoon, timeZone);

    for (const t of sortedTimes) {
      const [hh, mm] = t.split(':').map(Number);
      const candidateUtcMs = Date.UTC(todayY, todayM - 1, todayD + dayOffset, hh, mm, 0) - offsetMinutes * 60000;
      const candidateDate = new Date(candidateUtcMs);
      if (candidateDate > now) {
        return candidateDate;
      }
    }
  }
  return null; // shouldn't happen with at least one day and one time configured
}

// Refreshes every distinct M3U source currently in use, given a getter
// function returning [{playlistUrl}, ...] - deliberately a
// callback rather than this module reaching into server.js's userConfigs
// directly, so m3u.js stays a self-contained module with no dependency
// on the caller's internal state (matching how the rest of this module
// is structured and independently testable). Sources are deduplicated by
// playlistUrl first, since multiple users can genuinely share the exact
// same provider - no reason to fetch and parse the same playlist twice
// in the same refresh cycle. Each source refreshes independently;
// one failing (bad URL, provider down, etc) doesn't block the others.
async function refreshAllM3USources(getActiveSources) {
  const sources = getActiveSources();
  const uniqueByPlaylistUrl = new Map();
  // A playlist is all a source needs. This used to require an EPG URL as
  // well, so an account that had left the optional EPG field blank was
  // never refreshed on schedule at all - it only ever filled from the
  // on-demand warm in server.js, and went stale from there.
  for (const s of sources) {
    if (s && s.playlistUrl) uniqueByPlaylistUrl.set(s.playlistUrl, s);
  }

  const results = await Promise.allSettled(
    [...uniqueByPlaylistUrl.values()].map(({ playlistUrl }) => refreshM3USource(playlistUrl))
  );

  let succeeded = 0;
  let failed = 0;

  results.forEach((result, i) => {
    const { playlistUrl } = [...uniqueByPlaylistUrl.values()][i];
    if (result.status === 'rejected') {
      failed++;
      // The bare message is always "Failed to fetch M3U source", which
      // says nothing about which URL broke or why. The reason object
      // carries that detail, so spell it out - a failure here takes the
      // whole account offline and "Failed to fetch" is not enough to act
      // on.
      const err = result.reason;
      console.error(`[M3U scheduler] Failed to refresh a source on ${describeSource(playlistUrl)}: ${err.playlistError || err.message}`);
    } else {
      succeeded++;
      console.log(`[M3U scheduler] Refreshed a source on ${describeSource(playlistUrl)}: ${result.value.channels.length} channels, ${result.value.categoryList.length} categories`);
    }
  });

  return { total: uniqueByPlaylistUrl.size, succeeded, failed };
}

// Starts the self-rescheduling background refresh loop. Fetches
// immediately on startup (so the app isn't empty for hours after a fresh
// deploy - a settled design decision, not an afterthought), then
// schedules itself for the next slot based on whatever the current
// admin-configured cadence is at the time each refresh fires - so a
// settings change takes effect on the very next cycle, not requiring a
// restart. getSettings returns the current {refreshesPerDay, timeZone}
// live (not a snapshot taken once at startup), for exactly this reason.
let schedulerTimeoutHandle = null;

// Retry schedule used when a refresh cycle fails outright. Doubling from
// 2 minutes up to a 30-minute ceiling: quick enough that a transient host
// error recovers in minutes, slow enough not to hammer a provider that is
// rate-limiting us - which is the most likely cause of a fast failure in
// the first place.
const RETRY_BASE_MS = 2 * 60 * 1000;
const RETRY_MAX_MS = 30 * 60 * 1000;

function startM3uScheduler(getActiveSources, getSettings) {
  let consecutiveFailures = 0;

  async function runAndReschedule() {
    const result = await refreshAllM3USources(getActiveSources);

    // Every source failed and there was at least one to fetch. Waiting
    // for the next scheduled slot would leave the account with an empty
    // cache - no categories, no channel picker, and no streams at all -
    // for up to twelve hours on a twice-daily cadence. Observed exactly
    // that: a boot-time failure at 23:06 with the next slot at 10:00.
    //
    // A source that fails now keeps whatever it last parsed, so this only
    // matters when the cache is cold. It is still worth retrying either
    // way, since stale data is worse than fresh.
    if (result.total > 0 && result.succeeded === 0) {
      consecutiveFailures++;
      const delay = Math.min(RETRY_BASE_MS * Math.pow(2, consecutiveFailures - 1), RETRY_MAX_MS);
      console.error(`[M3U scheduler] All ${result.total} source(s) failed (attempt ${consecutiveFailures}). Retrying in ${(delay / 60000).toFixed(1)} minutes.`);
      schedulerTimeoutHandle = setTimeout(runAndReschedule, delay);
      return;
    }
    consecutiveFailures = 0;

    const { daysOfWeek, times, timeZone } = getSettings();
    const nextRun = computeNextScheduledRun(daysOfWeek, times, timeZone);
    if (!nextRun) {
      console.error('[M3U scheduler] Could not compute next run - check daysOfWeek/times settings. Retrying in 1 hour.');
      schedulerTimeoutHandle = setTimeout(runAndReschedule, 60 * 60 * 1000);
      return;
    }
    const delay = nextRun.getTime() - Date.now();
    console.log(`[M3U scheduler] Next refresh at ${nextRun.toISOString()} (in ${(delay / 1000 / 60).toFixed(1)} minutes)`);
    schedulerTimeoutHandle = setTimeout(runAndReschedule, delay);
  }

  // Immediate first fetch, not scheduled - a brand-new deploy shouldn't
  // wait up to a full refresh interval before having any M3U data at all.
  runAndReschedule();
}

function stopM3uScheduler() {
  if (schedulerTimeoutHandle) {
    clearTimeout(schedulerTimeoutHandle);
    schedulerTimeoutHandle = null;
  }
}

module.exports = {
  parseM3UPlaylist,
  fetchAndParseM3USource,
  describeSource,
  refreshM3USource,
  getCachedM3USource,
  computeNextScheduledRun,
  refreshAllM3USources,
  startM3uScheduler,
  stopM3uScheduler,
  m3uSourceCache
};