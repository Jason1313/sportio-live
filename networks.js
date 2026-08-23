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
];

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

// Auto-fill deliberately stops well short of the cap. The extra slots
// exist so specific feeds can be added by hand - a particular affiliate,
// a 1080p60 variant found by probing - not so the picker can fill ten
// guesses. Filling all ten automatically would also silently defeat
// COMBINE_AT_OR_BELOW below, since no network would ever sit at three or
// fewer links.
const MAX_SUGGESTIONS = 5;

// At or below this many links, a 'replace' sport ALSO shows tier results
// (after the links). The reasoning is coverage: a network with one or two
// channels configured is probably not covering every situation - a
// blacked-out affiliate, a regional split - and the search results are
// worth having as a backstop. Once there are four or more, the list is
// deliberate enough to stand on its own, and mixing in guesses would just
// bury the good entries.
const COMBINE_AT_OR_BELOW = 3;

// A saved link identifies a channel by its stream URL, because that is
// the only genuinely unique identifier a playlist offers. tvg-id is NOT
// unique - measured on a real playlist, 1,278 tvg-ids covered more than
// one distinct feed, and a single network routinely appears under several
// ids (FS1 exists as both 'fs1.us' and 'foxsports1.us').
//
// tvgId/name/group ride along purely as healing metadata: if the exact URL
// stops appearing after a playlist refresh, they're what we search by to
// find where that channel moved to. See resolveLinkEntry.
function makeLinkEntry({ url, tvgId, name, group, streamId, type, probedQuality }) {
  return {
    type: type || (streamId ? 'xtream' : 'm3u'),
    url: url || '',
    streamId: streamId || null,
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
  const seenUrls = new Set();
  for (const raw of rawLinks) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'Each link must be an object.' };
    }
    const entry = makeLinkEntry(raw);
    if (entry.type === 'xtream') {
      if (!entry.streamId || !/^\d+$/.test(String(entry.streamId))) {
        return { ok: false, error: 'Xtream links need a numeric stream id.' };
      }
    } else {
      if (!/^https?:\/\//i.test(entry.url)) {
        return { ok: false, error: 'M3U links need an http(s) stream URL.' };
      }
      // Same URL twice in one network's slots is always a mistake - it
      // would just produce a duplicate entry in the player's list.
      if (seenUrls.has(entry.url)) {
        return { ok: false, error: 'The same stream is listed twice for this network.' };
      }
      seenUrls.add(entry.url);
    }
    links.push(entry);
  }
  return { ok: true, links };
}

// ---------------------------------------------------------------------
// Link resolution + healing
// ---------------------------------------------------------------------

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
function resolveNetworkLinks(networkLinks, networkKey, source, buildXtreamUrl) {
  const entries = (networkLinks && networkLinks[networkKey]) || [];
  const resolved = [];
  const problems = [];

  entries.forEach((entry, index) => {
    const result = resolveLinkEntry(entry, source);

    if (entry.type === 'xtream') {
      const url = buildXtreamUrl ? buildXtreamUrl(entry.streamId) : null;
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

function getNetworkLabel(networkKey) {
  return NETWORK_BY_KEY.get(networkKey)?.label || networkKey;
}

// ---------------------------------------------------------------------
// Stream policy
// ---------------------------------------------------------------------

// How a sport combines its configured links with the tier system.
//
//   'replace' - links WIN OUTRIGHT. If the game is on a network the user
//               has channels for, those channels are the entire answer
//               and the tiers are not consulted. Used for NFL and college
//               football, where ESPN tells us the exact network and a
//               known-good channel beats a name-matching guess every time.
//   'combine' - links first, then tier results after them. Used for UFC,
//               where the broadcaster is a streaming service that maps to
//               no channel, so the tiers still do real work finding
//               event-specific channels the fixed links can't cover.
//
// Any sport not listed uses the tier system alone, unchanged.
const SPORT_LINK_POLICY = {
  NFL: 'replace',
  NCAAFB: 'replace',
  UFC: 'combine',
};

function getLinkPolicy(sportKey) {
  return SPORT_LINK_POLICY[String(sportKey || '').toUpperCase()] || 'tiers-only';
}

// Removes entries sharing a stream URL, keeping the first (highest
// priority) occurrence.
//
// This matters more after the parser fix than before it: a network listed
// in six playlist groups is now six selectable feeds rather than one, so
// the same URL can genuinely arrive from both a configured link and a
// tier match. Without this the player shows the identical stream twice.
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

// Whether tier results will be used at all for this game. The stream
// route calls this BEFORE doing the tier work, which for an Xtream
// account means one EPG request per channel - all of it wasted if the
// links are going to replace it. Kept next to buildStreamList because the
// two must agree: if this says tiers aren't needed and buildStreamList
// then asks for them, the result is a silently short stream list.
function needsTiers({ sportKey, networkKey, linkCount }) {
  const policy = getLinkPolicy(sportKey);
  if (policy !== 'replace') return true;      // tiers-only and combine both use them
  if (!networkKey) return true;               // streaming-only game
  if (!linkCount) return true;                // no links: tiers are the fallback
  return linkCount <= COMBINE_AT_OR_BELOW;    // short list: tiers as backstop
}

// Decides the final ordered stream list for one game.
//
// Returns { streams, mode, note } where mode explains which branch ran -
// useful for logging and for the caller deciding whether to append an
// informational entry.
//
//   'links-only'   - replace policy, links found. Tiers deliberately unused.
//   'links-first'  - combine policy: links, then tier results.
//   'no-links'     - game IS on a configured-capable network but the user
//                    has no channels for it. Caller should surface this;
//                    tiers are included so the result is never empty.
//   'tiers-only'   - no network resolved, or sport has no link policy.
function buildStreamList({ sportKey, networkKey, linkStreams, tierStreams }) {
  const policy = getLinkPolicy(sportKey);
  const links = linkStreams || [];
  const tiers = tierStreams || [];

  if (policy === 'tiers-only') {
    return { streams: dedupeByUrl(tiers), mode: 'tiers-only', note: '' };
  }

  if (policy === 'combine') {
    // Links first, tiers after - links are a deliberate choice, tier hits
    // are inference, so the deliberate choice ranks higher.
    return { streams: dedupeByUrl([...links, ...tiers]), mode: 'links-first', note: '' };
  }

  // 'replace' from here down.
  if (!networkKey) {
    // Streaming-only broadcast, or a network with no slot defined. The
    // tiers are the right tool - providers list streaming events as
    // per-event channels carrying the matchup in the name.
    return { streams: dedupeByUrl(tiers), mode: 'tiers-only', note: '' };
  }

  if (links.length === 0) {
    // The one case that would otherwise produce a silent empty list. The
    // caller surfaces the network name so the user knows exactly which
    // slot to fill, and tiers still run so something is playable now.
    return {
      streams: dedupeByUrl(tiers),
      mode: 'no-links',
      note: `No ${getNetworkLabel(networkKey)} channels configured`
    };
  }

  // A short list gets the tier results appended as a backstop - see
  // COMBINE_AT_OR_BELOW. Links still rank first either way; the only
  // question is whether anything follows them.
  if (links.length <= COMBINE_AT_OR_BELOW) {
    return { streams: dedupeByUrl([...links, ...tiers]), mode: 'links-plus-tiers', note: '' };
  }

  return { streams: dedupeByUrl(links), mode: 'links-only', note: '' };
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
function scoreChannelForNetwork(channel, network) {
  const aliases = new Set(network.aliases.map(normalizeNetworkName));
  const coreName = normalizeNetworkName(stripChannelDecorations(channel.name));
  const idCore = normalizeTvgId(channel.id);

  const nameHit = aliases.has(coreName);
  const idHit = aliases.has(idCore);
  if (!nameHit && !idHit) return null;

  // Dead channels are never suggested, however well they otherwise match.
  if (isDeadChannel(channel.categories)) return null;

  let score = 0;
  if (nameHit) score += 100;
  // Corroboration, not a second independent identification - so weighted
  // well below the name match. It was originally 80, which made a
  // name+id match so dominant that nothing else could reorder it: a 4K
  // feed whose tvg-id happened to be a variant spelling could never
  // outrank a plain-SD feed with the canonical id, which defeats the
  // point of scoring quality at all.
  if (idHit) score += 40;

  // A US feed is what these leagues are broadcast on; a same-named feed
  // from another country is carrying different programming entirely.
  const country = tvgIdCountry(channel.id);
  if (country && country !== 'us') score -= 60;
  else score += 10;

  score += scoreGroups(channel.categories);
  score += detectQuality(channel.name).weight;

  // Backups are real fallbacks worth offering, just never as the primary
  // pick when the non-backup feed is right there beside it.
  if (/\bbackup\b/i.test(foldSuperscripts(channel.name))) score -= 8;

  return score;
}

// Below this, a channel is a technically-valid match but not one worth
// proposing: a foreign feed of the right network, or a regional variant
// buried in an unrelated group. Suggestions pad to 5 slots, and without a
// floor that padding actively misleads - Dutch ESPN (score 80) was being
// offered as the 4th and 5th ESPN suggestion purely because only three US
// feeds existed to fill the list. Three good suggestions beat five where
// two are wrong; anything below the floor is still reachable through
// search.
const MIN_SUGGESTION_SCORE = 100;

// Returns up to `limit` suggested channels for one network, best first.
//
// Deliberately returns suggestions rather than applying them: for cable
// networks the top hit is nearly always correct, but for broadcast
// networks the "right" answer is whichever market the user actually wants
// and nothing in the playlist can reveal that. So this proposes, and the
// user disposes.
function suggestChannelsForNetwork(networkKey, channels, limit = MAX_SUGGESTIONS) {
  const network = NETWORK_BY_KEY.get(networkKey);
  if (!network) return [];

  const scored = [];
  for (const channel of channels || []) {
    const score = scoreChannelForNetwork(channel, network);
    if (score === null) continue;
    if (score < MIN_SUGGESTION_SCORE) continue;
    scored.push({ channel, score });
  }

  scored.sort((a, b) => b.score - a.score || a.channel.name.localeCompare(b.channel.name));

  return scored.slice(0, limit).map(({ channel, score }) => ({
    ...makeLinkEntry({
      url: channel.streamUrl,
      tvgId: channel.id,
      name: channel.name,
      group: channel.categories?.[0] || '',
      type: 'm3u',
    }),
    score,
    quality: detectQuality(channel.name).label,
    groups: channel.categories || [],
  }));
}

function suggestAllNetworks(channels, limit = MAX_SUGGESTIONS) {
  const out = {};
  for (const network of NETWORKS) {
    out[network.key] = suggestChannelsForNetwork(network.key, channels, limit);
  }
  return out;
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
function searchChannels(query, channels, options = {}) {
  const { limit = 50, excludeGroups = [] } = options;
  const { phrases, tokens } = parseSearchQuery(query);
  if (phrases.length === 0 && tokens.length === 0) {
    return { channels: [], groups: [], truncated: false };
  }

  const excluded = new Set(excludeGroups);
  const matched = [];
  const groupCounts = new Map();

  for (const channel of channels || []) {
    if (!phrases.every(p => matchesPhrase(channel, p))) continue;

    const name = String(channel.name || '').toLowerCase();
    const groups = channel.categories || [];
    const groupText = groups.join(' ').toLowerCase();

    const inName = tokens.every(t => name.includes(t));
    if (!inName && !tokens.every(t => `${name} ${groupText}`.includes(t))) continue;

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
          type: 'm3u',
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
    truncated: matched.length > limit
  };
}

module.exports = {
  NETWORKS,
  MAX_LINKS_PER_NETWORK,
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
  MIN_SUGGESTION_SCORE,
  MAX_SUGGESTIONS,
  COMBINE_AT_OR_BELOW,
  needsTiers,
  isDeadChannel,
  getEventNetworkForSport,
  getLinkPolicy,
  dedupeByUrl,
  buildStreamList,
  stripChannelDecorations,
  foldSuperscripts,
  detectQuality,
  normalizeTvgId,
  scoreChannelForNetwork,
  suggestChannelsForNetwork,
  suggestAllNetworks,
  searchChannels,
  parseSearchQuery,
  matchesPhrase,
};
