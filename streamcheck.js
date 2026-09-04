// Published stream measurements from streamcheck.pro.
//
// It runs its own sweep across a set of IPTV providers and publishes the
// result: for every channel, whether it is alive, and if so its codec,
// resolution, frame rate and video and audio bitrates. That is the same
// set of facts probe.js opens a connection to measure, already measured.
//
// Two things make it worth using in preference to probing:
//
//   - One request returns an entire provider. Measured against Strong:
//     57,192 rows in about five seconds, so an account's whole playlist
//     is enriched for the cost of a single fetch rather than a sixty
//     second sample per channel.
//   - It reports channel_status, which probing can only infer from a
//     failure. Of those 57,192 rows, 16,868 were Blackscreen and 10,738
//     Dead - two thirds of what a user would otherwise discover one
//     timeout at a time.
//
// And two that mean it does not replace probing:
//
//   - It is a periodic sweep, not a live reading. A run is days old.
//   - The channel ids are the provider's own stream ids, which is what
//     makes the join possible at all, but they are NOT unique across
//     providers - the same id returns a different channel on a different
//     service. Every lookup is therefore scoped to one provider, and an
//     account has to say which one it is on.
//
// Underneath it is a Metabase public dashboard, so this reads its JSON
// API rather than scraping a page. That is somebody else's internal
// interface and it can change without notice, which is why every failure
// here is soft: the caller falls back to ffprobe and the app keeps
// working.

const axios = require('axios');

const BASE = process.env.STREAMCHECK_BASE || 'https://streamcheck.pro';
const DASHBOARD = process.env.STREAMCHECK_DASHBOARD || '0610a6a7-b20d-45df-b2bd-e24111362f3c';

// The two cards on that dashboard worth reading. The summary is tiny and
// names every provider along with the date each was last swept; the
// table is the per-channel detail.
const SUMMARY_CARD = { dashcard: 459, card: 382 };
const TABLE_CARD = { dashcard: 461, card: 383 };
const PROVIDER_FIELD = 534;

// How often to ASK whether there is anything new, which is not how often
// anything is downloaded - see refreshProvider. The summary card is
// about 7KB.
const FRESHNESS_CHECK_MS = 6 * 60 * 60 * 1000;

// A ceiling on how long a table is served without any re-check at all,
// for the case where the summary card itself is unreachable.
const TABLE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const SUMMARY_TIMEOUT_MS = 20000;
const TABLE_TIMEOUT_MS = 120000;

async function queryCard({ dashcard, card }, parameters, timeout) {
  const url = `${BASE}/api/public/dashboard/${DASHBOARD}/dashcard/${dashcard}/card/${card}`;
  const res = await axios.get(url, {
    params: { parameters: JSON.stringify(parameters || []) },
    headers: { accept: 'application/json' },
    timeout,
    // The provider table is around 20MB. Axios defaults to unlimited but
    // says so here, because a silent truncation would look like a
    // provider that had lost half its channels.
    maxContentLength: 128 * 1024 * 1024,
    maxBodyLength: 128 * 1024 * 1024,
  });
  const data = res.data && res.data.data;
  if (!data || !Array.isArray(data.rows) || !Array.isArray(data.cols)) {
    throw new Error('Unexpected response shape from streamcheck.pro');
  }
  return data;
}

// The provider list and the date each was last swept, from one small
// request. The providers are the columns; the dates are one row.
async function fetchSummary() {
  const data = await queryCard(SUMMARY_CARD, [], SUMMARY_TIMEOUT_MS);
  const providers = data.cols.slice(1).map(c => c.name);
  const runRow = data.rows.find(r => /most recent run/i.test(String(r[0]))) || [];
  const runDates = {};
  providers.forEach((name, i) => {
    const value = runRow[i + 1];
    if (value) runDates[name] = String(value);
  });
  return { providers, runDates };
}

// "1080p" -> 1080. The table reports a label rather than a frame size, so
// the width has to be assumed from it - 16:9 at that height. It is right
// for everything but an anamorphic feed, which this cannot see and
// ffprobe can. Worth knowing when the two disagree.
const RESOLUTION_HEIGHTS = { '4K': 2160, '2160P': 2160, '1440P': 1440, '1080P': 1080, '720P': 720, '576P': 576, '480P': 480, SD: 480 };

function heightFromResolution(label) {
  if (!label) return null;
  const key = String(label).trim().toUpperCase();
  if (RESOLUTION_HEIGHTS[key]) return RESOLUTION_HEIGHTS[key];
  const digits = key.match(/^(\d{3,4})/);
  return digits ? Number(digits[1]) : null;
}

// Their spelling to ffprobe's, so a record from here and a record from a
// probe describe a codec the same way and the rating cannot tell them
// apart.
const CODECS = { H264: 'h264', HEVC: 'hevc', H265: 'hevc', MPEG2VIDEO: 'mpeg2video', MPEG4: 'mpeg4', AV1: 'av1', VP9: 'vp9' };

function normaliseCodec(name) {
  if (!name) return null;
  return CODECS[String(name).trim().toUpperCase()] || String(name).toLowerCase();
}

function rowReader(cols) {
  const index = {};
  cols.forEach((c, i) => { index[c.name] = i; });
  return (row, name) => (index[name] === undefined ? null : row[index[name]]);
}

// One provider's whole table, indexed by stream id.
//
// Only the fields that are used are kept. The response is around 20MB and
// most of it is timestamps, screenshot URLs and grouping keys that
// nothing here reads; holding all of it per provider would be the one
// genuinely expensive thing about this.
async function fetchProviderTable(provider) {
  const parameters = [{
    type: 'string/=',
    value: [provider],
    id: '4c5bf1da',
    target: ['dimension', ['field', PROVIDER_FIELD, { 'base-type': 'type/Text' }], { 'stage-number': 0 }],
  }];
  const data = await queryCard(TABLE_CARD, parameters, TABLE_TIMEOUT_MS);
  const get = rowReader(data.cols);

  const byId = new Map();
  for (const row of data.rows) {
    const id = get(row, 'channel_id');
    if (id === null || id === undefined) continue;
    const height = heightFromResolution(get(row, 'video_resolution'));
    const kbps = get(row, 'video_bitrate_kbps');
    byId.set(String(id), {
      status: get(row, 'channel_status') || null,
      name: get(row, 'channel_name') || '',
      height,
      // Assumed, not measured - see heightFromResolution.
      width: height ? Math.round((height * 16) / 9) : null,
      fps: get(row, 'video_frame_rate') || null,
      codec: normaliseCodec(get(row, 'video_codec')),
      bitrate: kbps ? Number(kbps) * 1000 : null,
      audioCodec: get(row, 'audio_codec') || null,
      audioBitrate: get(row, 'audio_bitrate_kbps') ? Number(get(row, 'audio_bitrate_kbps')) * 1000 : null,
      runDate: get(row, 'run_timestamp_text') || null,
    });
  }
  return byId;
}

// provider -> { byId, runDate, fetchedAt, checkedAt }
const cache = new Map();
const inFlight = new Map();

let summaryCache = null; // { providers, runDates, fetchedAt }
let summaryInFlight = null;

// The shortest a forced check will still reuse an answer for.
//
// `force` means "do not trust the six-hour interval", not "ask again
// within the same second". Both callers that force walk a list of
// providers - the boot warmer and the daily refresh - and the sweep
// dates cannot change between two providers of one pass, so asking once
// per provider was the same 7KB question repeated for one answer. At a
// second a time that is most of what a two-provider warm spends outside
// the tables themselves.
const FORCED_SUMMARY_FLOOR_MS = 60 * 1000;

// Deduplicated as well as cached, because the interesting caller asks
// with `force`: concurrent callers share one request rather than opening
// two.
async function getSummary(force) {
  const interval = force ? FORCED_SUMMARY_FLOOR_MS : FRESHNESS_CHECK_MS;
  if (summaryCache && Date.now() - summaryCache.fetchedAt < interval) {
    return summaryCache;
  }
  if (summaryInFlight) return summaryInFlight;

  summaryInFlight = (async () => {
    try {
      const summary = await fetchSummary();
      summaryCache = { ...summary, fetchedAt: Date.now() };
      return summaryCache;
    } finally {
      summaryInFlight = null;
    }
  })();
  return summaryInFlight;
}

// Every provider the dashboard covers, for the account setting to choose
// from. Falls back to whatever was last seen rather than an empty list,
// since an empty dropdown reads as "this feature is broken".
async function listProviders() {
  try {
    const summary = await getSummary(false);
    return summary.providers;
  } catch (err) {
    console.error('[Streamcheck] Could not list providers:', err.message);
    return summaryCache ? summaryCache.providers : [];
  }
}

// The answer to "does this re-download every day": no.
//
// What happens on a schedule is a 7KB question - has this provider been
// swept since the copy in memory? Only when the answer changes is the
// 20MB table pulled again. The sweeps are weekly in practice, so the big
// fetch happens about weekly however often this is called, and an
// instance nobody is using fetches nothing at all, because none of this
// runs on a timer - it is driven by lookups.
async function ensureProvider(provider, options = {}) {
  if (!provider) return null;

  const existing = cache.get(provider);
  const now = Date.now();

  // `force` skips the interval and asks straight away. The scheduled
  // daily check uses it: the whole point of running at a fixed hour is
  // that it does not care when the last lookup happened to be.
  if (!options.force && existing && now - existing.checkedAt < FRESHNESS_CHECK_MS) return existing;

  const pending = inFlight.get(provider);
  if (pending) return pending;

  const job = (async () => {
    try {
      let latestRun = null;
      try {
        const summary = await getSummary(true);
        latestRun = summary.runDates[provider] || null;
      } catch (err) {
        console.error('[Streamcheck] Freshness check failed:', err.message);
      }

      // Nothing new to fetch. The table stands and the clock resets.
      if (existing && latestRun && latestRun === existing.runDate) {
        existing.checkedAt = now;
        return existing;
      }
      // The freshness check failed but what is held is not yet stale
      // enough to distrust.
      if (existing && !latestRun && now - existing.fetchedAt < TABLE_MAX_AGE_MS) {
        existing.checkedAt = now;
        return existing;
      }

      const started = Date.now();
      const byId = await fetchProviderTable(provider);
      const entry = {
        byId,
        runDate: latestRun || (byId.size ? [...byId.values()][0].runDate : null),
        fetchedAt: Date.now(),
        checkedAt: Date.now(),
      };
      cache.set(provider, entry);
      console.log(`[Streamcheck] ${provider}: ${byId.size} channels for run ${entry.runDate || 'unknown'}` +
        ` in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return entry;
    } catch (err) {
      console.error(`[Streamcheck] Could not load ${provider}:`, err.message);
      // A stale table beats no table - the alternative is every channel
      // losing its rating because somebody else's site had a bad minute.
      return existing || null;
    } finally {
      inFlight.delete(provider);
    }
  })();

  inFlight.set(provider, job);
  return job;
}

// Asks each provider whether it has been swept since the copy in memory,
// and pulls the table again only for those where it has.
//
// The asking is cheap and the pulling is not - a summary is about 7KB
// against 20MB for a table - which is what makes a daily check
// affordable when the sweeps themselves are weekly. Most days this
// downloads nothing and simply confirms there is nothing to download.
//
// Providers are done one at a time rather than in parallel: this is
// somebody else's public dashboard, and a handful of 20MB queries fired
// at once is not a reasonable way to treat it.
async function refreshProviders(providers) {
  const results = [];
  for (const provider of [...new Set(providers)].filter(Boolean)) {
    const before = cache.get(provider);
    const previousRun = before ? before.runDate : null;
    const previousCount = before ? before.byId.size : 0;

    const entry = await ensureProvider(provider, { force: true });
    results.push({
      provider,
      ok: !!entry,
      previousRun,
      runDate: entry ? entry.runDate : null,
      channels: entry ? entry.byId.size : 0,
      updated: !!entry && entry.runDate !== previousRun,
      firstLoad: !before && !!entry,
      previousCount,
    });
  }
  return results;
}

// One channel, or null when the provider is unknown, unreachable, or
// simply does not list that id.
async function lookup(provider, streamId) {
  if (!provider || !streamId) return null;
  const entry = await ensureProvider(provider);
  if (!entry) return null;
  const record = entry.byId.get(String(streamId));
  return record ? { ...record, provider } : null;
}

// Whether a provider's table is already in memory, so a caller can
// decide to enrich a whole page of results without triggering a 20MB
// download inside a request that was meant to be quick.
function isLoaded(provider) {
  return !!(provider && cache.get(provider));
}

// Every record held for a provider, keyed by stream id, or null when
// nothing is loaded. Read-only by contract - callers summarise it, and
// the map handed back is the live one rather than a copy because it runs
// to tens of thousands of rows and cloning it to count them would cost
// more than the counting.
function snapshot(provider) {
  const entry = provider ? cache.get(provider) : null;
  return entry ? entry.byId : null;
}

function lookupCached(provider, streamId) {
  const entry = provider ? cache.get(provider) : null;
  if (!entry) return null;
  const record = entry.byId.get(String(streamId));
  return record ? { ...record, provider } : null;
}

function describeCache() {
  return [...cache.entries()].map(([provider, entry]) => ({
    provider,
    channels: entry.byId.size,
    runDate: entry.runDate,
    fetchedAt: new Date(entry.fetchedAt).toISOString(),
    checkedAt: new Date(entry.checkedAt).toISOString(),
  }));
}

function clearCache() {
  cache.clear();
  inFlight.clear();
  summaryCache = null;
}

module.exports = {
  listProviders,
  ensureProvider,
  refreshProviders,
  lookup,
  lookupCached,
  snapshot,
  isLoaded,
  describeCache,
  clearCache,
  heightFromResolution,
  normaliseCodec,
  FRESHNESS_CHECK_MS,
};
