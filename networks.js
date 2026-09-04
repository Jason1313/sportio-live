// Network link system - broadcast detection and user-provided channel links.
//
// Two jobs, kept in one module because they're two halves of one idea:
//
//   1. Given an ESPN competition, work out which national TV network is
//      carrying the game (resolveNetworkFromCompetition).
//   2. Given that network, resolve the user's saved channel links for it
//      into playable stream URLs (resolveNetworkLinks).
//
// Deliberately a separate module rather than more of server.js: this is
// pure logic over plain data with no Express or filesystem dependency, so
// it's directly testable the way m3u.js is.

// ---------------------------------------------------------------------
// Network registry
// ---------------------------------------------------------------------

// The canonical network slots a user can configure links for. Data, not
// branching logic - adding a network later is an edit to this array and
// nothing else.
//
// `aliases` exist because ESPN's own naming is neither stable nor
// consistent with itself. All of these are real strings observed live
// from the scoreboard API, not guesses: "NFL Net" (not "NFL Network"),
// "CW" (not "The CW"), "CBSSN" and "CBS Sports Network" both appear.
// Matching is done on a normalized form (see normalizeNetworkName), so
// case and internal spacing don't need their own alias entries -
// "ESPN 2" and "ESPN2" both normalize to "espn2".
//
// `kind` distinguishes two genuinely different configuration problems:
//   'cable'     - one national feed. The user picks essentially one
//                 channel, maybe a backup or two.
//   'broadcast' - no national channel exists in reality. FOX/CBS/NBC/ABC/CW
//                 are hundreds of local affiliates, and the user picks the
//                 markets they want. This is what makes 5 slots useful.
const NETWORKS = [
  // Broadcast networks - affiliate-based, used by both NFL and CFB.
  { key: 'FOX',  label: 'FOX',  kind: 'broadcast', aliases: ['FOX', 'Fox'] },
  { key: 'CBS',  label: 'CBS',  kind: 'broadcast', aliases: ['CBS'] },
  { key: 'NBC',  label: 'NBC',  kind: 'broadcast', aliases: ['NBC'] },
  { key: 'ABC',  label: 'ABC',  kind: 'broadcast', aliases: ['ABC'] },
  { key: 'CW',   label: 'The CW', kind: 'broadcast', aliases: ['CW', 'The CW', 'CW Network'] },

  // Telemundo is affiliate-based like the four above - WNJU New York,
  // KVEA Los Angeles, WSCV Miami - which is why it is 'broadcast' and not
  // 'cable' despite being thought of as one national channel.
  //
  // Carried for soccer: it has the Spanish-language Premier League
  // rights, and ESPN listed it on 3 of the next 30 fixtures. ESPN writes
  // it as the bare word "Tele", which is why that is an alias rather than
  // an abbreviation anyone would guess.
  { key: 'TELEMUNDO', label: 'Telemundo', kind: 'broadcast',
    aliases: ['Telemundo', 'Tele'] },

  // Cable/satellite networks - single national feed.
  { key: 'ESPN',    label: 'ESPN',        kind: 'cable', aliases: ['ESPN'] },
  { key: 'ESPN2',   label: 'ESPN2',       kind: 'cable', aliases: ['ESPN2'] },
  { key: 'ESPNU',   label: 'ESPNU',       kind: 'cable', aliases: ['ESPNU'] },
  { key: 'FS1',     label: 'FS1',         kind: 'cable', aliases: ['FS1', 'Fox Sports 1'] },
  { key: 'CBSSN',   label: 'CBS Sports Network', kind: 'cable', aliases: ['CBSSN', 'CBS Sports Network', 'CBS Sports Net'] },
  { key: 'BTN',     label: 'Big Ten Network',    kind: 'cable', aliases: ['BTN', 'Big Ten Network'] },
  { key: 'SECN',    label: 'SEC Network',        kind: 'cable', aliases: ['SEC Network', 'SECN'] },
  { key: 'ACCN',    label: 'ACC Network',        kind: 'cable', aliases: ['ACC Network', 'ACCN'] },
  { key: 'NFLN',    label: 'NFL Network',        kind: 'cable', aliases: ['NFL Network', 'NFL Net'] },

  // NFL RedZone. A cable network like the rest, with one extra property:
  // `pinnedTo` (see getPinnedNetworksForSport) puts it at the head of a
  // league's own catalog whether or not a game is on.
  //
  // It needs that because whip-around coverage has no ESPN event behind
  // it - RedZone is never any single game's broadcaster, so nothing in
  // the scoreboard feed will ever resolve to it and no card would exist
  // to click on a Sunday afternoon, which is precisely when it is the
  // most useful thing in the row.
  //
  // The aliases cover both spellings because providers use both; the
  // normalized form (see normalizeNetworkName) collapses the spacing, so
  // "NFL REDZONE" and "NFL Red Zone" are already the same key.
  { key: 'REDZONE', label: 'NFL RedZone', kind: 'cable', pinnedTo: 'NFL',
    aliases: ['NFL RedZone', 'NFL Red Zone', 'RedZone', 'Red Zone', 'NFL RZ'] },
  // The single biggest soccer carrier on American linear TV: measured
  // over three weeks it held 5 of 30 Premier League fixtures and 1 of 27
  // Bundesliga, more than any other channel in either. ESPN writes it
  // "USA Net".
  { key: 'USANET',  label: 'USA Network', kind: 'cable',
    aliases: ['USA Network', 'USA Net', 'USA'] },
  { key: 'TNT',     label: 'TNT',         kind: 'cable', aliases: ['TNT'] },
  { key: 'TRUTV',   label: 'truTV',       kind: 'cable', aliases: ['truTV', 'TruTV'] },

  // Event bucket, not a network. UFC events resolve to Paramount+, which
  // is streaming and correctly yields no network slot - so there would be
  // nowhere to hang UFC channels without this. `sport` binds it to one
  // sport instead of to a broadcaster, which is what UFC actually needs:
  // the same handful of channels carry the card regardless of who holds
  // the rights that month.
  //
  // kind 'event' entries are excluded from alias lookup (see below), so a
  // broadcast literally named "UFC" can never resolve to this slot - it's
  // only ever reached explicitly, by the sport.
  { key: 'UFC', label: 'UFC', kind: 'event', sport: 'UFC', aliases: ['UFC', 'UFC Fight Pass', 'UFC PPV'] },

  // A search bucket. Like the event bucket above in that it is bound to
  // events rather than to a broadcaster, and unlike it in holding search
  // terms instead of pinned channels.
  //
  // A promotion's card appears in a playlist under whatever the provider
  // called it that week - "RAF 14" one month, the broadcaster's own
  // channel the next - so there is no stable stream id to pin. The terms
  // are what stays true between events.
  //
  // Bound to the promotion, not to the sport: the wrestling section is
  // meant to hold college duals too, and a search for this promotion's
  // name would find nothing for those and vice versa. Each gets its own
  // bucket, reached by the searchKey the event carries.
  { key: 'RAF', label: 'Real American Freestyle', kind: 'search', sport: 'WRESTLING',
    aliases: [] },
];

// Buckets that hold search terms rather than channels. The dashboard
// draws them differently and the stream route resolves them differently,
// so both need to ask.
const SEARCH_NETWORK_KEYS = new Set(NETWORKS.filter(n => n.kind === 'search').map(n => n.key));

function isSearchNetwork(key) {
  return SEARCH_NETWORK_KEYS.has(String(key || '').toUpperCase());
}

// Names that are streaming services, never a linear channel the IPTV
// provider would carry under that name. These must NOT resolve to a
// network slot: a CFB game on ESPN+ is not a game on ESPN, and treating
// it as one would send the user to the wrong channel entirely.
//
// This matters more than it looks. On a sampled FBS Saturday, ESPN+ was
// the single most common national broadcast - 13 of 46 games, more than
// ESPN and ABC combined. Those games fall through to the tier system,
// which is the right place for them: providers list ESPN+ events as
// individual per-event channels whose names carry the matchup.
//
// `geoBroadcasts[].type.shortName` already reports 'Streaming' vs 'TV'
// and is the primary signal; this list is a second gate for the case
// where only the older `broadcasts[]` array is present, which carries no
// type information at all.
const STREAMING_ONLY = new Set([
  'espn+', 'espnplus', 'espnunlmtd', 'espnunlimited', 'espn3',
  'peacock', 'paramount+', 'hbomax', 'max', 'netflix',
  'primevideo', 'amazonprimevideo', 'nfl+', 'appletv+', 'fubo', 'venu',
  // ACC Network Extra is a streaming overflow tier, NOT ACC Network.
  // Same prefix, different product - worth stating because the names
  // look near-identical in a listing.
  'accnx', 'accnetworkextra',
  'btn+', 'btnplus', 'secn+', 'espnews',
]);

// Lowercase, strip everything that isn't a letter or digit. Makes
// "ESPN 2" / "ESPN2" / "espn-2" all one key, so aliases only need to
// cover genuinely different names rather than every spacing variant.
function normalizeNetworkName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9+]/g, '');
}

// Only real networks participate in alias lookup. Event buckets are
// reached explicitly by sport, never by matching a broadcast name.
const NETWORK_BY_ALIAS = new Map();
for (const net of NETWORKS) {
  if (net.kind === 'event') continue;
  for (const alias of net.aliases) {
    NETWORK_BY_ALIAS.set(normalizeNetworkName(alias), net.key);
  }
}

// The event bucket bound to a sport, if one exists. This is what lets UFC
// have configurable links at all, given its broadcaster never resolves to
// a network slot.
function getEventNetworkForSport(sportKey) {
  const sport = String(sportKey || '').toUpperCase();
  return NETWORKS.find(n => n.kind === 'event' && n.sport === sport)?.key || null;
}

const NETWORK_BY_KEY = new Map(NETWORKS.map(n => [n.key, n]));

// The networks pinned to a sport's own catalog, in registry order.
//
// A pinned network gets a permanent card at the head of that league's
// row, ahead of the games and independent of them. Unlike every other
// entry in a league catalog it is not an event: there is no date, no
// score and nothing that makes it come or go with the schedule, which is
// the whole point - RedZone is worth one click on any Sunday, and
// hanging it off a game would mean it disappeared in the weeks it is
// most wanted.
//
// Deliberately keyed off the sport rather than a list of ids here, so a
// second pinned network later (a league's own 24/7 channel, say) is one
// property on its registry entry and nothing else.
function getPinnedNetworksForSport(sportKey) {
  const sport = String(sportKey || '').toUpperCase();
  return NETWORKS.filter(n => n.pinnedTo === sport);
}

function isPinnedNetwork(networkKey) {
  return !!NETWORK_BY_KEY.get(networkKey)?.pinnedTo;
}

function isStreamingOnlyName(name) {
  return STREAMING_ONLY.has(normalizeNetworkName(name));
}

// ---------------------------------------------------------------------
// Broadcast extraction
// ---------------------------------------------------------------------

// Pulls the NATIONAL broadcasts out of an ESPN competition, tagged with
// whether each is linear TV or a streaming service.
//
// Filtering to national is essential and easy to get wrong: the raw
// `broadcasts` array mixes markets together, so a single NFL game reads
// as ["NFL Net", "WCBS", "KDKA-TV"] - one national network plus both
// teams' local affiliates. Taking that flattened list at face value would
// have us hunting for a channel named "KDKA-TV".
//
// geoBroadcasts is preferred because it's the only one of the two that
// reports type (TV vs Streaming). broadcasts[] is the fallback for events
// where geoBroadcasts is absent.
function extractNationalBroadcasts(competition) {
  const out = [];
  const seen = new Set();

  const add = (name, type) => {
    if (!name) return;
    const key = normalizeNetworkName(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    // A name on the streaming list is streaming regardless of what the
    // feed claims - the list is more specific than the type field.
    out.push({ name, type: isStreamingOnlyName(name) ? 'Streaming' : type });
  };

  for (const geo of competition.geoBroadcasts || []) {
    if (geo.market?.type !== 'National') continue;
    add(geo.media?.shortName, geo.type?.shortName === 'Streaming' ? 'Streaming' : 'TV');
  }

  if (out.length === 0) {
    for (const b of competition.broadcasts || []) {
      if (b.market !== 'national') continue;
      // No type information available here, so assume TV and let the
      // streaming-name list catch the known exceptions.
      for (const name of b.names || []) add(name, 'TV');
    }
  }

  return out;
}

// Resolves the canonical network slot key for a game, or null.
//
// Returns null when the game is streaming-only, on a network with no slot
// defined, or has no national broadcast at all. Null is not an error - it
// is the signal to fall back to the tier system, which is the correct
// outcome for all three of those cases.
function resolveNetworkFromBroadcasts(nationalBroadcasts) {
  for (const b of nationalBroadcasts || []) {
    if (b.type === 'Streaming') continue;
    const key = NETWORK_BY_ALIAS.get(normalizeNetworkName(b.name));
    if (key) return key;
  }
  return null;
}

function resolveNetworkFromCompetition(competition) {
  const nationalBroadcasts = extractNationalBroadcasts(competition);
  return {
    nationalBroadcasts,
    network: resolveNetworkFromBroadcasts(nationalBroadcasts)
  };
}

// ---------------------------------------------------------------------
// Saved link storage
// ---------------------------------------------------------------------

const MAX_LINKS_PER_NETWORK = 10;

// A saved link identifies a channel by its stream URL, because that is
// the only genuinely unique identifier a playlist offers. tvg-id is NOT
// unique - measured on a real playlist, 1,278 tvg-ids covered more than
// one distinct feed, and a single network routinely appears under several
// ids (FS1 exists as both 'fs1.us' and 'foxsports1.us').
//
// tvgId/name/group ride along purely as healing metadata: if the exact URL
// stops appearing after a playlist refresh, they're what we search by to
// find where that channel moved to. See resolveLinkEntry.
//
// providerId names which of the account's providers the link came from.
// An account can carry several, and a stream id is only unique WITHIN one
// of them - so without this a link saved from the second provider would
// be rebuilt against the first one's credentials and play a completely
// different channel. Empty on links saved before an account had more than
// one provider, which callers read as the primary provider - the only one
// those links could ever have come from.
function makeLinkEntry({ url, tvgId, name, group, streamId, type, probedQuality, providerId }) {
  return {
    type: type || (streamId ? 'xtream' : 'm3u'),
    url: url || '',
    streamId: streamId || null,
    providerId: typeof providerId === 'string' ? providerId : '',
    tvgId: tvgId || '',
    name: name || '',
    group: group || '',
    // Last measured resolution/frame rate, e.g. "1080p60". Stored so the
    // label survives a restart - the probe cache is memory-only, so
    // without this a stream would show its quality in Stremio only until
    // the container next restarted. It is a record of the last check, not
    // a live reading; the dashboard is where it gets refreshed.
    probedQuality: probedQuality || '',
  };
}

// Rejects anything malformed rather than storing junk that silently
// resolves to nothing later. Returns { ok, error, links }.
function validateNetworkLinks(networkKey, rawLinks) {
  if (!NETWORK_BY_KEY.has(networkKey)) {
    return { ok: false, error: `Unknown network: ${networkKey}` };
  }
  if (!Array.isArray(rawLinks)) {
    return { ok: false, error: 'Links must be an array.' };
  }
  if (rawLinks.length > MAX_LINKS_PER_NETWORK) {
    return { ok: false, error: `At most ${MAX_LINKS_PER_NETWORK} links per network.` };
  }

  const links = [];
  const seen = new Set();
  for (const raw of rawLinks) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'Each link must be an object.' };
    }
    const entry = makeLinkEntry(raw);
    if (entry.type === 'xtream') {
      if (!entry.streamId || !/^\d+$/.test(String(entry.streamId))) {
        return { ok: false, error: 'Xtream links need a numeric stream id.' };
      }
      // Scoped by provider, because a stream id is only unique within one.
      // Two providers each numbering a channel 1568650 is ordinary and
      // they are different channels, so an unscoped check would reject
      // the second one and make a two-provider network un-saveable.
      const key = `${entry.providerId}|${entry.streamId}`;
      if (seen.has(key)) {
        return { ok: false, error: 'The same stream is listed twice for this network.' };
      }
      seen.add(key);
    } else {
      if (!/^https?:\/\//i.test(entry.url)) {
        return { ok: false, error: 'M3U links need an http(s) stream URL.' };
      }
      // Same URL twice in one network's slots is always a mistake - it
      // would just produce a duplicate entry in the player's list.
      if (seen.has(entry.url)) {
        return { ok: false, error: 'The same stream is listed twice for this network.' };
      }
      seen.add(entry.url);
    }
    links.push(entry);
  }
  return { ok: true, links };
}

// ---------------------------------------------------------------------
// Saved channels
// ---------------------------------------------------------------------

// Channels the user keeps for their own sake, unattached to any network.
//
// Providers spin up temporary channels for one-off events - a wrestling
// card, a title fight - named after the event rather than any station.
// There is no network to file those under, and no reason for the game
// matcher to know about them, but they are still worth keeping to hand
// once found.
//
// Same entry shape as network links, so healing, quality probing and
// encryption at rest all apply unchanged.
const MAX_SAVED_CHANNELS = 50;

function validateSavedChannels(rawChannels) {
  if (!Array.isArray(rawChannels)) {
    return { ok: false, error: 'Saved channels must be an array.' };
  }
  if (rawChannels.length > MAX_SAVED_CHANNELS) {
    return { ok: false, error: `At most ${MAX_SAVED_CHANNELS} saved channels.` };
  }

  const channels = [];
  const seenUrls = new Set();
  for (const raw of rawChannels) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'Each saved channel must be an object.' };
    }
    const entry = makeLinkEntry(raw);
    if (!/^https?:\/\//i.test(entry.url)) {
      return { ok: false, error: 'Saved channels need an http(s) stream URL.' };
    }
    if (seenUrls.has(entry.url)) continue;   // silently dedupe rather than reject
    seenUrls.add(entry.url);
    channels.push(entry);
  }
  return { ok: true, channels };
}

// ---------------------------------------------------------------------
// Link resolution + healing
// ---------------------------------------------------------------------

// Accepts either one playlist or a function from providerId to that
// provider's playlist, so callers holding a single source do not have to
// wrap it. See resolveNetworkLinks.
function sourceResolver(source) {
  return typeof source === 'function' ? source : () => source;
}

// Resolves one saved link against the current parsed playlist.
//
// Providers rotate stream URLs, and channels move between groups. Rather
// than let a saved link simply die, this walks progressively weaker
// identifiers to find where the channel went. Order matters: each step is
// a weaker claim than the one above it, so the first hit is the most
// trustworthy one available.
//
// Returns { status, url, channel, note }:
//   'ok'      - exact URL still present
//   'healed'  - URL changed, matched by fallback identity (note says how)
//   'missing' - nothing matched; caller decides how to surface it
function resolveLinkEntry(entry, source) {
  if (entry.type === 'xtream') {
    // Xtream URLs are rebuilt from credentials at request time, so there
    // is nothing to heal - the id either still exists or it doesn't. The
    // caller supplies the URL builder since only it holds the credentials.
    return { status: 'ok', url: null, channel: null, note: 'xtream' };
  }

  const channels = source?.channels || [];

  const exact = channels.find(c => c.streamUrl === entry.url);
  if (exact) return { status: 'ok', url: exact.streamUrl, channel: exact, note: '' };

  // tvg-id + same group: strongest remaining signal. Same network, same
  // section of the playlist - almost certainly the same feed re-hosted.
  if (entry.tvgId && entry.group) {
    const hit = channels.find(c => c.id === entry.tvgId && c.categories.includes(entry.group));
    if (hit) return { status: 'healed', url: hit.streamUrl, channel: hit, note: 'matched tvg-id + group' };
  }

  // Exact name + group. Deliberately BELOW tvg-id, because names in
  // event-style groups are rewritten as the schedule changes - a provider
  // relabels its ESPN feed to "NCAAF 01: NC State at Wake Forest 7:30pm",
  // so a name match there is worth less than an id match.
  if (entry.name && entry.group) {
    const hit = channels.find(c => c.name === entry.name && c.categories.includes(entry.group));
    if (hit) return { status: 'healed', url: hit.streamUrl, channel: hit, note: 'matched name + group' };
  }

  // tvg-id anywhere. Weakest useful signal: right network, but possibly a
  // different feed of it than the one originally chosen.
  if (entry.tvgId) {
    const hit = channels.find(c => c.id === entry.tvgId);
    if (hit) return { status: 'healed', url: hit.streamUrl, channel: hit, note: 'matched tvg-id only' };
  }

  return { status: 'missing', url: null, channel: null, note: 'no matching channel in playlist' };
}

// Resolves every saved link for one network, in the user's own priority
// order (slot 1 first). Missing links are dropped from the playable list
// but reported separately, so the caller can tell the difference between
// "nothing configured" and "configured but broken" - two situations that
// need very different messages.
//
// `source` may be one parsed playlist, or a function taking the link's
// providerId and returning that provider's playlist. An account can hold
// several providers, and healing a link against the wrong one's channel
// list is worse than not healing it at all - it would swap a broken link
// for a confidently wrong one.
function resolveNetworkLinks(networkLinks, networkKey, source, buildXtreamUrl) {
  const entries = (networkLinks && networkLinks[networkKey]) || [];
  const sourceFor = sourceResolver(source);
  const resolved = [];
  const problems = [];

  entries.forEach((entry, index) => {
    const result = resolveLinkEntry(entry, sourceFor(entry.providerId));

    if (entry.type === 'xtream') {
      const url = buildXtreamUrl ? buildXtreamUrl(entry.streamId, entry.providerId) : null;
      if (url) resolved.push({ ...entry, url, slot: index + 1, status: 'ok' });
      else problems.push({ slot: index + 1, name: entry.name, reason: 'no Xtream credentials configured' });
      return;
    }

    if (result.status === 'missing') {
      problems.push({ slot: index + 1, name: entry.name || entry.url, reason: result.note });
      return;
    }

    resolved.push({
      ...entry,
      url: result.url,
      name: result.channel?.name || entry.name,
      group: result.channel?.categories?.[0] || entry.group,
      slot: index + 1,
      status: result.status,
      note: result.note,
    });
  });

  return { resolved, problems };
}

// Resolves saved channels against the current playlist, healing rotated
// URLs exactly as network links are healed. Returns the same
// { resolved, problems } split so the caller can tell "gone" from
// "moved".
function resolveSavedChannels(savedChannels, source) {
  const sourceFor = sourceResolver(source);
  const resolved = [];
  const problems = [];

  (savedChannels || []).forEach((entry, index) => {
    const result = resolveLinkEntry(entry, sourceFor(entry.providerId));
    if (result.status === 'missing') {
      problems.push({ slot: index + 1, name: entry.name || entry.url, reason: result.note });
      return;
    }
    resolved.push({
      ...entry,
      url: result.url,
      name: result.channel?.name || entry.name,
      group: result.channel?.categories?.[0] || entry.group,
      slot: index + 1,
      status: result.status,
      note: result.note,
    });
  });

  return { resolved, problems };
}

function getNetworkLabel(networkKey) {
  return NETWORK_BY_KEY.get(networkKey)?.label || networkKey;
}

// ---------------------------------------------------------------------
// Automatic playlist search
// ---------------------------------------------------------------------
//
// A third source of channels, sitting between the user's hand-picked
// links and the tier system.
//
// Some events never have a fixed channel to configure. Providers file
// them as one throwaway listing per card, named after the promotion and
// the card number, and both the name and the stream URL change every
// event. A curated link list cannot track that, and the tier system
// cannot find it either - tiers match on the two fighters' names, which a
// listing called "UFC 320 PPV" never spells out.
//
// So a sport can declare a standing search instead: terms to look for in
// a channel's name, optionally confined to particular playlist groups. It
// runs fresh on every stream request, so tonight's card is found the
// moment the provider lists it, with nothing to configure.
//
// Results rank BELOW the configured links and ABOVE the tier results. A
// hand-picked, quality-checked channel is a deliberate choice and always
// wins; but a name match confined to the right group is a much stronger
// signal than a tier-4 nickname hit, which is inference over EPG text.
const AUTO_SEARCH = {
  // UFC cards land in the provider's Paramount+ PPV group, one listing
  // per card. Confining the search to that group is what keeps it useful:
  // an unconfined search for "UFC" across the whole service also returns
  // the 24/7 Fight Pass replay loops, which are never the live card.
  UFC: { terms: ['UFC'], groups: ['Paramount+ PPV'] },
};

// ---------------------------------------------------------------------
// Promotions within a league
// ---------------------------------------------------------------------
//
// ESPN files Dana White's Contender Series under the UFC league: the same
// league id (3321, "Ultimate Fighting Championship"), the same scoreboard
// endpoint, the same Paramount+ broadcaster. Confirmed live against real
// events - there is no field anywhere on the event that separates the
// two. Only the event's own name does, and it does so unambiguously
// ("Dana White's Contender Series: Season 10, Week 4", shortName "Dana
// White's Contender Series").
//
// They are not the same show and they do not share channels. A UFC card
// is a PPV the user has hand-picked and quality-checked channels for;
// DWCS is a Tuesday-night prospect show that never appears on any of
// them. Serving the UFC link list for a DWCS event - which is exactly
// what happened before this existed, because the event bucket is bound to
// the whole sport - sends the user to a channel showing something else.
//
// A promotion therefore overrides two things, and only these two, for the
// events it claims:
//
//   networkKey - which configured link slot applies, or null for none
//   autoSearch - the standing search to run instead of the league's own
//
// Everything else (artwork, the fighter-name tiers, date filtering) is
// genuinely shared with the parent league and deliberately left alone.
const PROMOTIONS = [
  {
    key: 'DWCS',
    label: "Dana White's Contender Series",
    sport: 'UFC',
    // Three spellings because two different systems name this show.
    // Providers label it "DWCS"; ESPN writes it out in full. Matching any
    // of the three means the classifier survives ESPN reformatting the
    // name, which is the only signal it has.
    match: /dana white|contender series|\bdwcs\b/i,
    // Deliberately null rather than 'UFC'. This is the entire point of
    // the promotion existing: the UFC slot's channels are wrong here, and
    // showing them ranked first is worse than showing nothing, because
    // they look authoritative and play something else.
    networkKey: null,
    // Unconfined by group, unlike UFC's. There is no PPV group for a show
    // that is not a PPV, and providers file DWCS wherever they please -
    // so the terms have to carry the whole search.
    autoSearch: { terms: ['DWCS', 'Dana White', 'Contender Series'] },
  },
  {
    key: 'PFL',
    label: 'Professional Fighters League',
    sport: 'UFC',
    // Claimed two ways, because neither alone is enough. The league
    // (3347) catches PFL's own cards including any named nothing like
    // it; the name catches the ones ESPN files under its catch-all
    // instead - "2026 PFL Africa: Morocco" sits in `other`, not `pfl`,
    // confirmed live.
    league: 'PFL',
    match: /\bpfl\b/i,
    // PFL's regional cards arrive under the catch-all league, whose
    // artwork is a generic ESPN icon. Naming the promotion's own key here
    // means a PFL Africa card carries the PFL logo like PFL Chicago does,
    // rather than looking like a different show.
    artworkKey: 'PFL',
    // PFL is on ESPN+, a streaming service that resolves to no channel,
    // and there is no configured slot for it. Same reasoning as DWCS: the
    // UFC slot's channels would be wrong here.
    networkKey: null,
    // One term, unconfined by group. "PFL" is distinctive enough on its
    // own that a group filter would only risk excluding the very listing
    // being looked for.
    autoSearch: { terms: ['PFL'] },
  },
  {
    key: 'OTHER',
    label: 'Other promotions',
    sport: 'UFC',
    // ESPN's catch-all league. Whatever is in here is, by construction,
    // a promotion nobody has written a rule for - LFA, UAE Warriors,
    // RIZIN, Road to UFC. Claimed by league only: it has no name of its
    // own to match, because it is not one show.
    league: 'OTHER',
    // No configured slot, and deliberately NO standing search. There is
    // no term that would be right across an open-ended set of
    // promotions, and a wrong guess here is worse than nothing: it fills
    // the list with confident-looking channels showing another sport
    // entirely. The event still gets a card, and the watch portal's own
    // search is how the user pulls in whatever their provider actually
    // called it.
    networkKey: null,
    autoSearch: null,
  },
];

// The promotion claiming an event, or null when it is the parent
// league's own (a real UFC card).
//
// Two ways to claim an event, checked most specific first:
//
//   match  - a regex over the event name. A promotion naming itself in
//            the title is making a specific claim about THIS event.
//   league - the ESPN league the event was fetched from.
//
// Name goes first, which is the opposite of what "a league is a fact and
// a regex is a guess" would suggest, and it is deliberate. ESPN's
// catch-all league is not a fact about anything - it means only "no
// dedicated league exists", and it is where PFL's regional cards land.
// Checking the league first would hand every one of them to the
// catch-all and lose the PFL search that plainly applies. Only
// promotions with genuinely distinctive names carry a `match` at all, so
// this cannot misfire on a card that says nothing about itself: those
// fall through to the league, which is where the catch-all correctly
// picks them up.
function getPromotionForEvent(sportKey, eventName, leagueKey) {
  const sport = String(sportKey || '').toUpperCase();
  const league = String(leagueKey || '').toUpperCase();
  const name = String(eventName || '');

  const candidates = PROMOTIONS.filter(p => p.sport === sport);

  if (name) {
    const byName = candidates.find(p => p.match && p.match.test(name));
    if (byName) return byName;
  }
  if (league) {
    return candidates.find(p => p.league === league) || null;
  }
  return null;
}

// Caps how many auto-found channels are appended. These are inferred, not
// chosen, and a provider that lists one card under twenty near-identical
// names should not push the configured links' backstop off the end of the
// list. Deliberately the same ceiling as MAX_LINKS_PER_NETWORK - the two
// serve the same "one section of the player's list" budget.
const MAX_AUTO_SEARCH_RESULTS = 10;

function getAutoSearch(sportKey) {
  return AUTO_SEARCH[String(sportKey || '').toUpperCase()] || null;
}

// Lowercased, with every run of punctuation flattened to a single space.
// Group and channel names arrive decorated in ways that carry no meaning
// here - "US | PARAMOUNT+ PPV", "UFC 320: Ankalaev vs. Pereira" - so both
// sides get flattened before they are compared.
//
// Unlike normalizeNetworkName, '+' is dropped rather than kept. There it
// is load-bearing (ESPN+ is not ESPN, and confusing the two sends the
// user to the wrong channel); here it is noise, because the same provider
// writes the one group as "PARAMOUNT+ PPV" and "PARAMOUNT + PPV" and both
// have to match a config written as "Paramount+ PPV". Keeping '+' made
// the second of those silently miss.
function normalizeForSearch(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whether a channel sits in one of the groups a search config asked for.
// Every word of the configured name must appear somewhere in the group's
// own name, in any order.
//
// Deliberately not an exact comparison. Providers prefix their groups by
// country and decorate them with separators, so a config written as
// "Paramount+ PPV" has to match a group actually named "US | PARAMOUNT+
// PPV" - which an exact match would miss, silently returning nothing at
// all rather than visibly failing.
//
// An empty/absent group list means "anywhere in the service", which is
// what the promotions with no dedicated group of their own need.
// Returns the channel's OWN group name that satisfied the filter, so the
// caller can label the result with the group it was actually found in
// rather than whichever group the provider happened to list first. A
// channel filed under both "PPV EVENTS" and "US | Paramount Plus PPV"
// was found via the second, and saying so is the whole point of showing
// a group at all.
//
// Three distinct returns, deliberately: the matched group name, '' when
// the config has no filter (every group qualifies, none is "the" match),
// and null for no match.
function findMatchingGroup(groups, wantedGroups) {
  if (!Array.isArray(wantedGroups) || wantedGroups.length === 0) return '';
  for (const wanted of wantedGroups) {
    const words = normalizeForSearch(wanted).split(' ').filter(Boolean);
    if (words.length === 0) continue;
    const hit = (groups || []).find(group => {
      const normalized = normalizeForSearch(group);
      return words.every(word => normalized.includes(word));
    });
    if (hit) return hit;
  }
  return null;
}

function groupMatchesAny(groups, wantedGroups) {
  return findMatchingGroup(groups, wantedGroups) !== null;
}

// Whether a channel's name carries any one of the search terms. A
// multi-word term needs all its words present, in any order.
//
// Each word must START at a word boundary rather than merely appear as a
// substring, which is what keeps "UFC" off a channel whose name happens to
// contain those three letters mid-word. It is deliberately NOT anchored at
// the end too: providers write both "UFC 320" and "UFC320", and a trailing
// boundary would reject the second.
//
// Matched against the name only, never the group. The group filter is
// already how a search gets narrowed, and letting group text satisfy the
// term as well would make { terms: ['UFC'], groups: ['Paramount+ PPV'] }
// return that entire group regardless of what each channel actually is.
function nameMatchesAnyTerm(name, terms) {
  const normalized = normalizeForSearch(name);
  if (!normalized) return false;
  return (terms || []).some(term => {
    const words = normalizeForSearch(term).split(' ').filter(Boolean);
    if (words.length === 0) return false;
    return words.every(word => new RegExp(`\\b${escapeRegex(word)}`).test(normalized));
  });
}

// Runs one search config over a channel list, returning the matches as
// { name, url, group }.
//
// `channels` is the M3U parser's own { name, streamUrl, categories }
// shape. The Xtream path normalises its stream list into that same shape
// before calling, so there is one implementation here rather than one per
// connection type.
function autoSearchChannels(channels, config, options = {}) {
  if (!config) return [];
  const { limit = MAX_AUTO_SEARCH_RESULTS } = options;
  const terms = Array.isArray(config.terms) ? config.terms : [];
  if (terms.length === 0) return [];

  const out = [];
  for (const channel of channels || []) {
    if (!channel || !channel.streamUrl) continue;
    const matchedGroup = findMatchingGroup(channel.categories, config.groups);
    if (matchedGroup === null) continue;
    if (!nameMatchesAnyTerm(channel.name, terms)) continue;
    out.push({
      name: channel.name || '',
      url: channel.streamUrl,
      group: matchedGroup || (channel.categories || [])[0] || '',
      providerId: channel.providerId || '',
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------
// Stream policy
// ---------------------------------------------------------------------

// Every sport now works the same way, so there is no policy table here
// any more.
//
// There used to be one - 'replace', 'combine' or 'tiers-only' per sport -
// deciding whether a sport used its configured links, inferred matches,
// or both. The inference is gone, so the only question left was which
// sports may use their links, and the answer is all of them. Most were on
// 'tiers-only' and never consulted a configured channel at all, which is
// why an NBA game showed guesses even to somebody who had set up TNT.

// Removes entries sharing a stream URL, keeping the first (highest
// priority) occurrence.
//
// A network listed in six playlist groups is six selectable feeds rather
// than one, so the same URL can genuinely arrive from both a configured
// link and the per-sport auto search. Without this the player shows the
// identical stream twice.
function dedupeByUrl(streams) {
  const seen = new Set();
  const out = [];
  for (const stream of streams || []) {
    if (!stream || !stream.url) continue;
    if (seen.has(stream.url)) continue;
    seen.add(stream.url);
    out.push(stream);
  }
  return out;
}

// Decides the final ordered stream list for one game.
//
// Returns { streams, mode, note } where mode explains which branch ran -
// useful for logging and for the caller deciding whether to append an
// informational entry.
//
//   'links-only' - the user has channels configured for the network
//                  carrying this game. Those channels are the answer.
//   'no-links'   - nothing configured for it. The caller surfaces the
//                  network name so the user knows which slot to fill.
//
// `autoStreams` (see AUTO_SEARCH) sits immediately after the configured
// links. It is a per-sport standing search rather than generic inference
// - written deliberately, scoped to a named group - which is why it
// survived the removal of the tier system and is the one thing that can
// find a channel nobody configured.
function buildStreamList({ networkKey, linkStreams, autoStreams }) {
  const links = linkStreams || [];
  const auto = autoStreams || [];
  const streams = dedupeByUrl([...links, ...auto]);

  if (links.length > 0) {
    return { streams, mode: 'links-only', note: '' };
  }

  // A standing search found channels and no links were pinned. That is
  // not an unconfigured event, it is how a sport with no pinnable
  // channel is meant to work - a promotion whose cards appear under a
  // different name every week is searched for, not pinned. Warning
  // "not configured" above four playable streams contradicts itself.
  if (auto.length > 0) {
    return { streams, mode: 'search-only', note: '' };
  }

  // Nothing configured and nothing found. Said plainly rather than
  // returning an empty list that looks like a failure - and it names the
  // network, because the useful next action is to go and fill that slot.
  return {
    streams,
    mode: 'no-links',
    note: networkKey
      ? `No ${getNetworkLabel(networkKey)} channels configured`
      : 'No channel configured for this broadcast',
  };
}

// ---------------------------------------------------------------------
// Link ordering
// ---------------------------------------------------------------------
//
// There is deliberately no reordering. Links are served in exactly the
// order the user arranged them in the dashboard, for every sport and for
// the TV Networks catalog alike.
//
// A per-sport reorder used to live here: it scored each link on whether
// its playlist group matched the sport being watched, so an NFL game
// preferred a network's "NFL Sunday Ticket" feed over its general one.
// The logic was sound and the outcome still wrong - a hand-curated,
// deliberately ordered, quality-checked list already encodes the
// preference, and reordering it meant slot 1 in the dashboard appeared
// sixth in the stream list with no explanation. Predictability beat
// cleverness here.


// ---------------------------------------------------------------------
// Channel suggestion
// ---------------------------------------------------------------------

// Providers decorate channel names heavily, and none of the decoration is
// part of the network's identity. Stripping it lets an exact comparison
// do the work, which is far safer here than fuzzy/substring matching:
// "FOX Sports 2", "FOX Deportes" and "Fox Soccer Plus" all CONTAIN "FOX"
// but none of them is FOX, and suggesting one would send the user to the
// wrong channel with no obvious sign anything was wrong.
//
// Every pattern below is drawn from real observed names, not invented:
//   "NCAAF 06: FOX"          -> sport-bundle slot prefix
//   "US: NFL NETWORK", "GO:" -> source prefix
//   "FOX [Birmingham] 1080p" -> market + quality
//   "FS1 (720p)", "(Backup)" -> parenthetical variant
//   "FS1 ᵁᴴᴰ", "NFL NET ᴴᴰ"   -> unicode superscript quality marks
// Providers write quality markers in unicode modifier letters as often as
// ASCII - "FS1 ᵁᴴᴰ ³⁸⁴⁰ᴾ" is UHD 3840P. Folding these to plain characters
// lets one set of patterns read both forms, rather than maintaining a
// parallel set of unicode ones that would silently miss any variant not
// thought of in advance.
const SUPERSCRIPT_FOLD = {
  'ᴬ': 'A', 'ᴮ': 'B', 'ᴰ': 'D', 'ᴱ': 'E', 'ᴳ': 'G', 'ᴴ': 'H', 'ᴵ': 'I', 'ᴶ': 'J',
  'ᴷ': 'K', 'ᴸ': 'L', 'ᴹ': 'M', 'ᴺ': 'N', 'ᴼ': 'O', 'ᴾ': 'P', 'ᴿ': 'R', 'ᵀ': 'T',
  'ᵁ': 'U', 'ⱽ': 'V', 'ᵂ': 'W', 'ˢ': 'S', 'ˣ': 'X',
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
  '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
};

function foldSuperscripts(text) {
  return String(text || '').replace(/[ᴬ-ᵪ⁰-₟²³¹ⱽ]/g,
    ch => SUPERSCRIPT_FOLD[ch] !== undefined ? SUPERSCRIPT_FOLD[ch] : ' ');
}

// Stream quality, read from the channel name. Ordered best-first and the
// first match wins, so "UHD 3840P" scores as 4K rather than also matching
// a lower tier.
//
// Weighted to matter without overriding identity: a strong quality signal
// can outrank a weaker group hint, but never turns a wrong channel into
// the suggested one. If these want tuning later, this table is the only
// place to change.
// 4K is DEMOTED, not promoted, despite being the highest resolution.
// This provider's 4K feeds are World Cup leftovers that no longer run,
// and an unavailable stream at any resolution is worse than a working
// one. Most sit in the "4K Channels" group and are dropped outright by
// isDeadChannel; this penalty covers the stragglers listed elsewhere -
// they stay reachable but rank last. If live 4K feeds appear later, move
// this back above 1080p.
//
// 1080p is now the top tier, which is what "best available and actually
// up" means here.
// Bare "HD" is scored separately from, and far below, an explicit 720p.
// It reads like a resolution but carries almost no information - nearly
// every channel in the playlist is HD, and providers append it as
// decoration rather than as a spec. Treating it as equivalent to 720p
// gave it enough weight to overturn a TV Guide (USA) listing, which is a
// much stronger signal: "US: NFL NETWORK ᴴᴰ" was outranking the TV Guide
// NFL Network feed purely on the strength of two decorative characters.
//
// Checked in order, first match wins - so "FHD" resolves as 1080p rather
// than falling through to the bare-HD tier.
const QUALITY_TIERS = [
  { pattern: /\b(?:4k|uhd|2160p?|3840p?)\b/i, weight: -30, label: '4K' },
  { pattern: /\b(?:fhd|1080p?)\b/i,           weight: 25,  label: '1080p' },
  { pattern: /\b720p?\b/i,                    weight: 10,  label: '720p' },
  { pattern: /\bhd\b/i,                       weight: 2,   label: 'HD' },
  { pattern: /\b(?:sd|480p?|360p?)\b/i,       weight: -10, label: 'SD' },
];

function detectQuality(name) {
  const folded = foldSuperscripts(name);
  for (const tier of QUALITY_TIERS) {
    if (tier.pattern.test(folded)) return tier;
  }
  return { weight: 0, label: '' };
}

function stripChannelDecorations(name) {
  return String(name || '')
    .replace(/^\s*(?:NCAAF|NCAAB|NFL|NBA|MLB|NHL|CFB|CHL|WHL)\s*\d+\s*:\s*/i, '')
    .replace(/^\s*(?:US|GO|CA|UK|AU|IE|NZ)\s*[:|]\s*/i, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[ᴬ-ᵪ⁰-₟²³¹]/g, ' ')
    .replace(/\b(?:\d{3,4}p|4k|uhd|fhd|hdr|hd|sd|alt|backup|east|west|raw)\b/gi, ' ')
    .trim();
}

// tvg-ids carry a country suffix ("espn.us", "tnt.uk"). Stripping it lets
// the id itself be compared against the network's aliases - which turns
// out to identify every cable network exactly: secnetwork.us -> secnetwork
// matches the alias "SEC Network", accnetwork.us matches "ACC Network",
// and so on. Broadcast networks don't work this way (their ids are
// affiliate call signs like wnywdt.us), which is precisely why they need
// the user to choose a market and cable networks largely don't.
const COUNTRY_SUFFIX = /\.(us|uk|ca|au|nz|ie|mx|es|de|fr|it|gr|br|ar|in|pt|nl|se|no|dk|fi|pl|tr|za|jp|kr)$/i;

function normalizeTvgId(id) {
  return normalizeNetworkName(String(id || '').replace(COUNTRY_SUFFIX, ''));
}

function tvgIdCountry(id) {
  const match = String(id || '').match(COUNTRY_SUFFIX);
  return match ? match[1].toLowerCase() : null;
}

// Groups that make a channel MORE likely to be the right pick, weighted
// by how specific the signal actually is. These are hints only - a
// channel is never suggested on group alone, and never excluded for
// lacking one. They exist mainly to break ties among the hundreds of
// identical-scoring broadcast affiliates, where a feed that lives in the
// provider's own college-football bundle is a far better default than an
// arbitrary local market.
//
// A sport-specific bundle is a much stronger signal than a generic
// national listing: a channel sitting in "College Football" was put
// there to carry college football, whereas "TV Guide (USA)" says only
// that it's American.
const PREFERRED_GROUP_HINTS = [
  // The provider's main US listing, and confirmed in practice to be the
  // reliable, consistently-live, good-quality feeds - so it outranks
  // every other hint rather than acting as the weak generic signal it
  // was first treated as.
  { pattern: /tv guide \(usa\)/i,   weight: 30 },
  { pattern: /nfl sunday ticket/i,  weight: 25 },
  { pattern: /\bnfl\b/i,            weight: 20 },
  { pattern: /sport networks/i,     weight: 15 },
];

// Groups whose channels are dead in practice, whatever their names claim.
//
//   "4K Channels"      - World Cup leftovers; the feeds no longer run.
//   "College Football" - the NCAAF nn: slots, dark out of season.
//
// Applied ONLY when the channel has no strong-US group alongside them,
// because membership is not exclusive and the same URL is often listed
// in several groups at once. The provider's real ESPN feed
// (espn.us, .../605011.ts) sits in TV Guide (USA), College Football AND
// Sport Networks simultaneously - excluding on any single dead-group
// match would throw away a perfectly good channel along with the dead
// ones. Being listed somewhere live is proof enough that it is live.
//
// These are excluded from SUGGESTIONS only. Search still finds them, so
// when college football returns they can be added by hand - or moved
// back into PREFERRED_GROUP_HINTS to be suggested again.
const DEAD_GROUP_HINTS = [
  /4k channels/i,
  /college football/i,
];

// Groups that positively confirm a channel is a live US feed. Used both
// to rescue a channel from DEAD_GROUP_HINTS above and to suppress the
// soft penalties below.
const STRONG_US_GROUP_HINTS = [
  /tv guide \(usa\)/i,
  /nfl sunday ticket/i,
];

// Groups that make a channel LESS likely: foreign feeds, and the
// Spanish-language and Latin-America variants that share a network's name
// but not its commentary.
// The bare country names matter as much as the prefixed/parenthesized
// forms: a Canadian NBC feed was surfacing in suggestions because its
// group is "Canada ᴳᴬᴺᴶᴬ" (no pipe, no parentheses) and its tvg-id is a
// "dummy-" placeholder carrying no country suffix to penalize either.
// News-channel groups are excluded for a different reason - "ABC" in a
// news bundle is ABC News, not the network carrying the game.
// Wrong-country or wrong-language feeds. These always apply - no amount
// of being listed in a US group makes a Spanish-language or Canadian feed
// the right answer for an NFL game.
const HARD_PENALTY_HINTS = [
  /^(?:uk|ca|au|ie|nz)\s*\|/i, /\((?:uk|canada|australia|ireland)\)/i,
  /\b(?:canada|australia|ireland|mexico|brasil|brazil)\b/i,
  /deportes|espanol|español/i,
  // Free ad-supported streaming bundles. A channel here named for a
  // league or promotion carries highlights, replays and studio filler -
  // never the live event. Left as a penalty rather than a dead group so
  // one can still be added by hand, but they should never be suggested:
  // the UFC bucket was proposing "Ufc" from Prime, Roku and Tubi, none of
  // which ever carries a live card.
  /\b(?:prime|roku|tubi|pluto|plex|xumo|freevee)\s+channels\b/i,
];

// Lower-confidence listings rather than wrong ones. Suppressed when the
// channel also appears in a strong-US group, because that membership
// already answers the question these were guarding against.
//
// This mattered concretely: the provider's NFL Network sits in TV Guide
// (USA), NFL Sunday Ticket, DirecTV GO and Sport Networks at once, and
// an unconditional DirecTV penalty dragged it below feeds with far
// weaker credentials.
const SOFT_PENALTY_HINTS = [
  /directv go/i, /entertainment/i, /news networks/i,
];

function matchesAny(categories, patterns) {
  return (categories || []).some(group => patterns.some(re => re.test(group)));
}

// Takes the STRONGEST preferred hint rather than summing them. Summing
// let two weak generic hints outrank one strong specific one - membership
// in several generic groups says a channel is popular, not that it's the
// right one.
function scoreGroups(categories) {
  let best = 0;
  for (const group of categories || []) {
    for (const hint of PREFERRED_GROUP_HINTS) {
      if (hint.pattern.test(group)) best = Math.max(best, hint.weight);
    }
  }

  let penalty = 0;
  if (matchesAny(categories, HARD_PENALTY_HINTS)) penalty -= 20;
  if (!matchesAny(categories, STRONG_US_GROUP_HINTS) && matchesAny(categories, SOFT_PENALTY_HINTS)) {
    penalty -= 20;
  }
  return best + penalty;
}

// True when every group this channel belongs to is a dead one - see
// DEAD_GROUP_HINTS. A channel listed anywhere live is kept.
function isDeadChannel(categories) {
  if (!matchesAny(categories, DEAD_GROUP_HINTS)) return false;
  return !matchesAny(categories, STRONG_US_GROUP_HINTS);
}

// Scores one channel as a candidate for one network. Returns null when
// the channel isn't a plausible match at all, which is the common case -
// only an exact match on the cleaned name or on the tvg-id qualifies.
// The trailing id from a stream URL (".../429939.ts" -> "429939").
//
// This is what distinguishes one feed from another. A channel id is
// shared by every feed of the same channel - five CBS Sports Network
// streams all carry "cbssportsnetwork.us" - so it cannot say WHICH of
// them was chosen. The stream id can.
//
// The cost is portability: a stream id is assigned by one provider and
// means nothing to another, so pinned defaults are exact on the
// provider they were captured from and match nothing anywhere else.
//
// Not a credential. The URL is .../live/USER/PASS/429939.ts and only
// the last segment is taken.
function streamIdFromUrl(url) {
  const match = String(url || '').match(/\/([^\/?#]+?)(?:\.[a-z0-9]+)?(?:[?#].*)?$/i);
  return match ? match[1] : '';
}

// A channel whose stream the user has previously chosen for this network
// outranks everything else. Carried across IPTV providers because tvg-ids
// come from shared EPG naming ("espn.us", "secnetwork.us") rather than
// from any one provider's playlist - which is what makes them portable,
// and why they are the only thing stored as a default. No URL, no
// credentials, nothing account-specific.
const PREFERRED_STREAM_BONUS = 200;


// Which of a preset's channels this playlist actually has, for one
// network, in the order the operator arranged them.
//
// This used to guess as well - scoring every channel in the playlist on
// how much its name looked like the network's, and padding each section
// to five proposals. The guessing is gone. It was right often enough to
// be trusted and wrong often enough to matter, and for a broadcast
// network the "right" answer is whichever market somebody actually wants,
// which no amount of name-matching can reveal. What is left is the part
// that was never a guess: an operator pinned these exact ids, so they are
// looked up and returned.
//
// Order is the operator's, not a ranking. A network's first link is the
// first stream offered, so slot 1 is a decision rather than a
// coincidence, and re-sorting would quietly promote a different market to
// primary than the one that was chosen.
function presetChannelsForNetwork(networkKey, channels, preferredStreamIds) {
  const wanted = preferredStreamIds instanceof Set
    ? preferredStreamIds
    : new Set(preferredStreamIds || []);
  if (wanted.size === 0) return [];
  if (!NETWORK_BY_KEY.has(networkKey)) return [];

  const rank = new Map();
  for (const id of wanted) rank.set(id, rank.size);

  const found = [];
  for (const channel of channels || []) {
    const streamId = streamIdFromUrl(channel.streamUrl);
    if (!streamId || !wanted.has(streamId)) continue;
    found.push({ channel, streamId });
  }

  found.sort((a, b) => rank.get(a.streamId) - rank.get(b.streamId));

  return found.slice(0, MAX_LINKS_PER_NETWORK).map(({ channel }) => ({
    ...makeLinkEntry({
      url: channel.streamUrl,
      tvgId: channel.id,
      name: channel.name,
      group: channel.categories?.[0] || '',
      // Present on Xtream channels, absent on M3U ones, and makeLinkEntry
      // already types an entry off exactly that. An Xtream link then
      // stores the id and has its URL rebuilt from credentials at request
      // time, so rotating a password does not strand every saved channel.
      streamId: channel.streamId,
      providerId: channel.providerId,
    }),
    quality: detectQuality(channel.name).label,
    groups: channel.categories || [],
  }));
}

// Every network's share of a set of pinned ids.
function presetChannelsForAll(channels, defaults = {}) {
  const out = {};
  for (const network of NETWORKS) {
    out[network.key] = presetChannelsForNetwork(
      network.key, channels, new Set(defaults[network.key] || []));
  }
  return out;
}

// ---------------------------------------------------------------------
// Team search
// ---------------------------------------------------------------------

// The words worth searching a playlist for when a game has no channel.
//
// A configured network answers most games. What is left is the game on a
// channel nobody pinned - a regional feed, a one-off event listing, a
// bundle the provider spun up for one Saturday - and those are named
// after the teams, not after the network.
//
// Both halves of each team's name, because providers use both and there
// is no telling which in advance: "NCAAF 07: MIAMI vs STANFORD" uses the
// places, "US: HURRICANES SPORTS NET" the nickname. ESPN carries them as
// separate fields, so this is reading them rather than splitting a string
// and hoping.
//
// Away side first, then home, matching the order the game is named in
// ("Miami Hurricanes at Stanford Cardinal" -> Miami, Hurricanes,
// Stanford, Cardinal).
//
// Deliberately NOT the abbreviation. Search matches on substrings, and a
// three-letter token like MIA or CAR appears inside enough unrelated
// words to bury the results these are meant to surface.
const MIN_TEAM_TERM_LENGTH = 3;

function teamSearchTerms(game) {
  if (!game) return [];

  const candidates = [
    game.awayLocation, game.awayNick,
    game.homeLocation, game.homeNick,
  ];

  const seen = new Set();
  const terms = [];
  for (const raw of candidates) {
    const term = String(raw || '').trim();
    if (term.length < MIN_TEAM_TERM_LENGTH) continue;
    // Case-insensitively, because a team whose place and nickname are the
    // same word would otherwise be searched for twice and shown as two
    // identical chips - "Athletics Athletics", and most soccer clubs,
    // where ESPN repeats the club name in both fields.
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

// Splits a query into quoted phrases and loose tokens.
//
//   ESPN            -> tokens ['espn']
//   "ESPN"          -> phrases ['espn']
//   "ESPN" boston   -> phrases ['espn'], tokens ['boston']
function parseSearchQuery(query) {
  const phrases = [];
  const rest = String(query || '').replace(/"([^"]*)"/g, (_, p) => {
    const trimmed = p.trim();
    if (trimmed) phrases.push(trimmed.toLowerCase());
    return ' ';
  });
  return {
    phrases,
    tokens: rest.toLowerCase().split(/\s+/).filter(Boolean)
  };
}

// A quoted phrase means the channel IS that thing, not that it mentions
// it. Compared against the decoration-stripped name, so "ESPN" still
// matches "ESPN [Boston] 1080p" and "ESPN (720p)" - the market and
// quality are not part of the channel's identity - while excluding
// "ESPN 2", "ESPN News" and "ESPN+". The raw name is checked too, so
// quoting a full listing like "NCAAF 11: SEC NETWORK" also works.
function matchesPhrase(channel, phrase) {
  const target = normalizeNetworkName(phrase);
  if (!target) return false;
  return normalizeNetworkName(stripChannelDecorations(channel.name)) === target
    || normalizeNetworkName(channel.name) === target;
}

// Free-text channel search for the manual-override picker.
//
// Returns { channels, groups, truncated }, where `groups` counts the
// playlist groups present in the matches so the caller can offer to
// filter them out.
//
// Two things stop a common word from burying the result you want:
//
//   - Loose tokens still match group names (so "college football" finds
//     that bundle), but a channel matched ONLY through its group ranks
//     below one matched by name. Searching "espn" used to return ~1,600
//     per-event ESPN+ listings ahead of the actual ESPN channel, purely
//     because their GROUP is called "ESPN+".
//   - excludeGroups drops whole groups outright, which is the blunt
//     instrument for exactly that case.
// `wholeWord` makes each token match only where a word starts, instead of
// anywhere in the string.
//
// Off by default, because a person typing into the box is usually typing
// a fragment and expects it to behave like one. On for the automatic team
// search, where the words are generated rather than typed and a substring
// match produces results nobody asked for: searching a college team
// called the Utes returned "60 MINUTES", because "utes" is inside it.
//
// Anchored at the START of a word only, never the end - the same rule
// nameMatchesAnyTerm uses, and for the same reason. A trailing boundary
// would stop "Cardinal" matching "Cardinals", which is the one variation
// a team search most needs to keep.
function searchChannels(query, channels, options = {}) {
  const { limit = 50, excludeGroups = [], wholeWord = false } = options;
  const { phrases, tokens } = parseSearchQuery(query);
  if (phrases.length === 0 && tokens.length === 0) {
    return { channels: [], groups: [], truncated: false, total: 0 };
  }

  // Compiled once rather than per channel: this runs over every channel
  // in the playlist, which is tens of thousands of them.
  const tests = tokens.map(token => {
    if (!wholeWord) return (haystack) => haystack.includes(token);
    const re = new RegExp(`\\b${escapeRegex(token)}`);
    return (haystack) => re.test(haystack);
  });

  const excluded = new Set(excludeGroups);
  const matched = [];
  const groupCounts = new Map();

  for (const channel of channels || []) {
    if (!phrases.every(p => matchesPhrase(channel, p))) continue;

    const name = String(channel.name || '').toLowerCase();
    const groups = channel.categories || [];
    const groupText = groups.join(' ').toLowerCase();

    const inName = tests.every(t => t(name));
    if (!inName && !tests.every(t => t(`${name} ${groupText}`))) continue;

    // Counted before exclusion so a group the user has hidden still shows
    // its chip, and can be un-hidden.
    for (const g of groups) groupCounts.set(g, (groupCounts.get(g) || 0) + 1);
    if (groups.some(g => excluded.has(g))) continue;

    matched.push({
      rank: inName ? 0 : 1,
      entry: {
        ...makeLinkEntry({
          url: channel.streamUrl,
          tvgId: channel.id,
          name: channel.name,
          group: groups[0] || '',
          streamId: channel.streamId,
          providerId: channel.providerId,
        }),
        groups,
      }
    });
  }

  // Stable within a rank: Array.prototype.sort is stable in Node, so
  // playlist order is preserved among equally-ranked matches.
  matched.sort((a, b) => a.rank - b.rank);

  return {
    channels: matched.slice(0, limit).map(m => m.entry),
    groups: [...groupCounts.entries()]
      .map(([name, count]) => ({ name, count, excluded: excluded.has(name) }))
      .sort((a, b) => b.count - a.count),
    truncated: matched.length > limit,
    // How many matched, not how many are being returned. A caller that
    // labels a control with this - the team-search chips do - would
    // otherwise report the limit as the count and say "25" for a word
    // that matched five hundred channels.
    total: matched.length
  };
}

module.exports = {
  NETWORKS,
  MAX_LINKS_PER_NETWORK,
  presetChannelsForNetwork,
  presetChannelsForAll,
  normalizeNetworkName,
  isStreamingOnlyName,
  extractNationalBroadcasts,
  resolveNetworkFromBroadcasts,
  resolveNetworkFromCompetition,
  makeLinkEntry,
  validateNetworkLinks,
  resolveLinkEntry,
  resolveNetworkLinks,
  getNetworkLabel,
  MAX_SAVED_CHANNELS,
  PREFERRED_STREAM_BONUS,
  streamIdFromUrl,
  validateSavedChannels,
  resolveSavedChannels,
  isDeadChannel,
  getEventNetworkForSport,
  getPinnedNetworksForSport,
  isPinnedNetwork,
  dedupeByUrl,
  buildStreamList,
  AUTO_SEARCH,
  MAX_AUTO_SEARCH_RESULTS,
  getAutoSearch,
  isSearchNetwork,
  SEARCH_NETWORK_KEYS,
  PROMOTIONS,
  getPromotionForEvent,
  autoSearchChannels,
  groupMatchesAny,
  findMatchingGroup,
  nameMatchesAnyTerm,
  normalizeForSearch,
  stripChannelDecorations,
  foldSuperscripts,
  detectQuality,
  normalizeTvgId,
  searchChannels,
  parseSearchQuery,
  matchesPhrase,
  teamSearchTerms,
  MIN_TEAM_TERM_LENGTH,
};
