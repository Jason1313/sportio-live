// Keeping a network's channels current, without anyone re-picking them.
//
// The channels configured for a network are chosen once and then rot.
// Providers retire feeds, re-point stream ids and let channels go dark,
// and the published sweep (streamcheck.js) says so - the 2026-08-31 run
// marked most of one provider's playlist Dead. The account carries on
// offering those links because nothing ever revisits the choice.
//
// So this revisits it. Given a playlist and the sweep that covers it, it
// works out which channels ARE a given network right now and which of
// those are worth watching, and hands back an ordered list. The caller
// decides whether to write it anywhere.
//
// Two questions, and they are genuinely separate:
//
//   1. Which channels ARE this network?  -> the rule table below.
//   2. Which of those is best?           -> the quality ladder.
//
// The first is the hard one, and it is hard in a way that has nothing to
// do with quality: "FOX" matches Fox News, Fox Sports, Fox Cricket, Fox
// Crime, a Bulgarian entertainment channel, George Fox University's
// volleyball team and The Jamie Foxx Show. Measured on a real playlist,
// a bare search for "fox" returned 549 channels, of which about a third
// were the network wanted. Getting this wrong does not degrade the pick -
// it silently sends somebody to the wrong channel, which is worse than
// the stale link it replaced.
//
// Pure logic over plain data, like networks.js and for the same reason:
// every rule here can be run against a real provider table offline.

const { foldSuperscripts } = require('./networks.js');

// ---------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------

// Lowercase, superscripts folded, everything but letters, digits and '+'
// flattened to a single space.
//
// '+' is KEPT, which is the one thing separating this from
// normalizeForSearch in networks.js. There, '+' is noise. Here it is the
// entire difference between ESPN and ESPN+ - a playlist carries hundreds
// of per-event ESPN+ listings, and a normalization that drops the plus
// makes every one of them read as the ESPN channel. Same for BTN+ and
// SECN+.
//
// Superscripts are folded first because providers write quality markers
// in modifier letters ("FS1 UHD 3840P" as unicode), and leaving them
// glued to the token beside them hides the word underneath.
function normalize(text) {
  return foldSuperscripts(text).toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim();
}

function tokenize(text) {
  const normalized = normalize(text);
  return normalized ? normalized.split(' ') : [];
}

// Whether one token satisfies one word of a term.
//
// `numbered` is what makes a broadcast rule work. Affiliates are named by
// their channel number and providers write it both ways - "US: FOX 17
// (KDSM)" and "US FOX5 (KVVU) Las Vegas", "US abc11 (WTVD)" and "US: ABC
// 7 CHICAGO". Both spellings appear on the same playlist.
//
// It is deliberately OFF for the cable networks, where a trailing digit
// is not decoration but a different channel: ESPN2 is not ESPN and FS2 is
// not FS1. A rule that let ESPN match espn2 would be wrong in the most
// expensive way this file can be wrong.
function tokenMatches(token, word, numbered) {
  if (token === word) return true;
  if (!numbered) return false;
  return token.startsWith(word) && /^\d+$/.test(token.slice(word.length));
}

// A list of terms, split into words once.
//
// Compiled per rule set rather than per channel, which is not a micro
// optimisation: a term is split by a regex, FOX carries thirty of them
// between its own exclusions and the shared ones, and doing that inside
// the channel loop meant 1.7 million regex passes for one network over
// one 57,000-channel playlist. Previewing every network took six seconds
// on that alone.
function compileTerms(terms) {
  return (terms || []).map(tokenize).filter(words => words.length > 0);
}

// Whether a term's words appear as consecutive tokens in a name.
//
// Consecutive, not "all present somewhere". "Fox Sports" has to mean
// those words in that order and next to each other, or the exclusion
// would also fire on "FOX 28 - SPORTS TONIGHT" and take a genuine
// affiliate out with it.
function hasWords(tokens, words, numbered) {
  for (let i = 0; i + words.length <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < words.length; j++) {
      // Only the LAST word of a term may carry a channel number: "fox 17"
      // is FOX plus a number, but in "fox sports 1" the "fox" is exact
      // and it is the "1" that identifies the feed.
      const last = j === words.length - 1;
      if (!tokenMatches(tokens[i + j], words[j], numbered && last)) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function hasAnyTerm(tokens, compiled, numbered) {
  return compiled.some(words => hasWords(tokens, words, numbered));
}

// The single-term form, for checking one rule against a real provider
// table offline. Nothing in the app calls it - the app compiles its terms
// once and uses hasAnyTerm - but this is how a rule gets tried out
// against 57,000 real channel names before it is written down here.
function hasTerm(tokens, term, numbered) {
  const words = tokenize(term);
  return words.length > 0 && hasWords(tokens, words, numbered);
}

// A streaming tier's per-event listing, rather than a channel.
//
// Providers file ESPN+, BTN+ and TSN+ coverage as one listing per event,
// named for the event, and those names mention the network freely:
// "US (ESPN+ 404) | Baseball: ESPN Beisbol", "(US) (BTN+ 043) | Field
// Hockey: Big Ten/ACC Challenge". Every one of them carries a bare
// network token somewhere and matched the include rules.
//
// The tell is the '+' itself. A linear American network never has a
// plus-suffixed token in its name, and every streaming tier does - so one
// rule removes the whole family from every network at once, instead of an
// exclusion per event name that would need adding to forever.
//
// This is the same line networks.js draws with STREAMING_ONLY: a game on
// ESPN+ is not a game on ESPN, and offering one for the other sends the
// user somewhere the game is not.
function isStreamingTier(tokens) {
  return tokens.some(token => token.length > 1 && token.endsWith('+'));
}

// Feeds that carry a network's name and never its main programme.
//
// These are excluded from every network rather than listed on each,
// because they are all the same mistake in different clothes: a channel
// that IS the network, by name, and is showing something else.
//
//   Overflow / Alternate  a second feed carrying a DIFFERENT game.
//                         "US Big Ten Network Overflow 4 HD" is real,
//                         alive and 720p60, and it is not what is on BTN.
//   College Extra         ESPN's overflow tier. On one provider its seven
//                         feeds swept better than the ESPN channel itself
//                         and took every one of the top five picks.
//   Digital Network       ACC Digital Network is web content.
//   Localish              an ABC-owned lifestyle channel, not ABC.
//   ESPN Play             a foreign streaming product that a provider had
//                         mislabelled "(US)".
//
// "Backup" is deliberately NOT here. A backup feed is the same programme
// on a second stream, which is exactly what a second slot is for.
const SHARED_EXCLUDE = [
  'OVERFLOW', 'ALTERNATE', 'EVENT ONLY', 'COLLEGE EXTRA',
  'DIGITAL NETWORK', 'LOCALISH', 'ESPN PLAY',
];
const SHARED_EXCLUDE_WORDS = compileTerms(SHARED_EXCLUDE);

// ---------------------------------------------------------------------
// Is this an American channel?
// ---------------------------------------------------------------------

// The rules below identify a network by name, and network names are not
// national. Fox, ESPN and TNT all exist in a dozen countries on the same
// playlist, and a Bulgarian Fox at 1080p60 will out-rate every US
// affiliate on the ladder and be picked. Nothing about "which FOX is
// best" can catch that; it has to be excluded before the question is
// asked.
//
// There is no country field to read, so this reads the signals that are
// there. Two providers name their US channels completely differently -
// one prefixes "US:", the other prefixes the STATE ("LA KARD FOX 14",
// "MO KTVI FOX 2") - and a rule built on either alone works on one
// service and finds nothing on the other.
//
// State prefixes are unusable by themselves: AL, AR, CA, DE, IN, LA and
// PA are all US states AND ISO country codes on the same playlist, so
// "AL WALA FOX 10" (Alabama) and "AL: FOX Crime HD" (Albania) cannot be
// told apart by prefix.
//
// What does separate them is the call sign. Every US broadcast station
// has one, they all begin K or W, and no other country's channels carry
// them. Together with an explicit US marker and the tvg-id's own country
// suffix, that covers both naming conventions without having to know
// which one a provider uses.
const US_MARKERS = new Set(['us', 'usa']);

// A US call sign: K or W then two or three letters. Digital subchannels
// are written KRQEDT2 / WSYX-D3 / WEVV2, and normalization has already
// split the punctuation, so a single trailing digit is allowed on the
// base token.
//
// Anchored whole-token and case-folded, which is why the false positives
// worth worrying about are English words of the same shape - WEST, KIDS,
// WITH. They are listed rather than reasoned about: this gate only ever
// runs over channels that have ALREADY matched a network name, so the
// population is small and inspectable.
const CALL_SIGN = /^[kw][a-z]{2,3}\d?$/;

// English words of call-sign shape that turn up next to a network name.
//
// Kept SHORT on purpose, and every entry checked against the stations
// that actually exist. The obvious-looking additions are the dangerous
// ones: KING, WAVE, WISH and WILL all read as ordinary words and are all
// real call signs - KING-TV Seattle and WAVE-TV Louisville are NBC
// affiliates, WISH-TV is a CW affiliate - so blocking them would drop
// four genuine stations to catch nothing.
//
// What was actually leaking in was Australian ("AU: ABC KIDS NATIONAL"),
// and the country prefix below deals with that at the source, which is
// why this list does not have to grow to cover it.
const NOT_CALL_SIGNS = new Set([
  'west', 'kids', 'with', 'what', 'when', 'week', 'wire', 'work', 'word',
  'wwe', 'wnba', 'kick',
]);

// Country and region codes providers use as a leading tag, where the code
// is NOT also a US state abbreviation.
//
// The distinction matters because one provider tags US channels with the
// state - "LA KARD FOX 14", "MO KTVI FOX 2" - so AL, AR, CA, DE, IN, LA,
// MO and PA cannot be read as countries even though they are all ISO
// codes too. Those stay ambiguous and are decided by the call sign
// instead; these are unambiguous, and a channel that leads with one is
// not American whatever else its name contains.
// Every entry here was checked against the list of US state
// abbreviations, and the ones that collide are deliberately absent: AZ,
// ID, IL, MA, NE, SD and TN are all ISO country codes AND states, so
// treating them as foreign would drop Arizona, Idaho, Illinois,
// Massachusetts, Nebraska, South Dakota and Tennessee. PR is left out for
// the same reason - it is a US territory. All of those fall through to
// the call sign, which is what settles them.
const FOREIGN_PREFIX = new Set([
  'au', 'nz', 'uk', 'gb', 'ie', 'bg', 'br', 'gr', 'nl', 'no', 'se', 'dk',
  'fi', 'pl', 'pt', 'es', 'it', 'ru', 'ro', 'hu', 'cz', 'tr', 'za', 'jp',
  'kr', 'ph', 'th', 'vn', 'sg', 'my', 'af', 'at', 'ch', 'be', 'bd', 'pk',
  'lk', 'np', 'sa', 'ae', 'eg', 'dz', 'ng', 'ke', 'gh', 'mx', 'py', 'uy',
  'cl', 'chl', 'arg', 'per', 'col', 'ven', 'ec', 'bo', 'cr', 'gt', 'hn',
  'sv', 'cu', 'jm', 'carib', 'dstv', 'latam', 'hr', 'rs', 'si', 'sk',
  'ee', 'lv', 'lt', 'ua', 'by', 'ge', 'am', 'kz', 'uz', 'ir', 'iq', 'sy',
  'lb', 'jo', 'kw', 'qa', 'bh', 'om', 'ye', 'ly', 'et', 'tz', 'ug', 'zm',
  'zw', 'mz', 'ao', 'cm', 'ci', 'sn', 'ml', 'bf', 'td',
]);

// tvg-ids carry a country suffix - "espn.us", "wnywdt.us", "fox.uk" - and
// where one exists it is the most direct statement of nationality on the
// channel. networks.js reads the same suffix for its own purposes.
const TVG_COUNTRY = /\.([a-z]{2})$/i;

function tvgCountry(tvgId) {
  const match = String(tvgId || '').match(TVG_COUNTRY);
  return match ? match[1].toLowerCase() : null;
}

function looksAmerican(channel) {
  // A tvg-id that states a country is believed over the name, because it
  // is the one field here that was written to say what it says.
  const country = tvgCountry(channel && (channel.id || channel.tvgId));
  if (country) return country === 'us';

  const tokens = tokenize(channel && channel.name);
  if (tokens.length === 0) return false;

  // A leading foreign tag settles it, and is checked FIRST - ahead of
  // both the US marker and the call sign.
  //
  // Ahead of the US marker because a network can have "USA" in its own
  // name: "Carib USA Network" is a Caribbean feed and "(MX) (IZ)
  // Telemundo Arizona USA (Nogales)" a Mexican one, and both were
  // reading as American purely because the channel is called USA.
  //
  // Ahead of the call sign because "AU: ABC KIDS NATIONAL" has a token of
  // call-sign shape and is Australian. A Caribbean relay of a US station
  // - "Carib (AMP) WSVN FOX" - is not the US station either.
  if (FOREIGN_PREFIX.has(tokens[0])) return false;

  // An explicit US tag settles it wherever it appears - one provider
  // writes "US:" at the front, another "NFL NETWORK USA (DZ)".
  if (tokens.some(token => US_MARKERS.has(token))) return true;

  return tokens.some(token => CALL_SIGN.test(token) && !NOT_CALL_SIGNS.has(token));
}

// ---------------------------------------------------------------------
// The rule table
// ---------------------------------------------------------------------

// One entry per network slot, and the whole of question 1.
//
//   include   name terms that make a channel a candidate
//   exclude   name terms that disqualify it, checked first
//   groups    playlist groups whose channels are candidates regardless
//             of name
//   numbered  the network is named with a channel number (see
//             tokenMatches) - true for broadcast affiliates only
//
// include and groups are a union, which is the point of having both.
// Group names are exact and unambiguous where they exist ("US | ABC"
// holds ABC and nothing else) but they do not cover everything: there are
// ABC affiliates filed outside that group, and other channels sit in a
// catch-all like "US | Sports" that says nothing about which network they
// are. Names cover those; groups cover the ones a name rule would have to
// guess at. Neither alone is enough and each backs up the other's
// weakness.
//
// exclude beats both. A channel in "US | Fox" named Fox Sports 1 is Fox
// Sports 1.
//
// Group names belong to the provider and can be renamed by whoever runs
// the service, so these are defaults rather than facts and the account
// can edit them. A group that no longer exists contributes nothing and
// the name rules still work - which is the reason for not resting on
// groups alone.
const DEFAULT_RULES = {
  // --- Broadcast ----------------------------------------------------
  //
  // The exclusions here are longer than the includes, and all of them
  // were counted on a real playlist rather than imagined. A bare "FOX"
  // matched 549 channels across two providers; these are the families
  // that made up the difference.
  FOX: {
    numbered: true,
    include: ['FOX'],
    groups: ['US | Fox'],
    exclude: [
      // What was asked for.
      'FOX NEWS', 'FOX SPORTS', 'FOX BUSINESS', 'FOX BUSINESS NETWORK',
      'FS1', 'FS2', 'FS 1', 'FS 2',
      // Fox-branded channels that are not the broadcast network. Every
      // one of these is on the playlist and every one of them answers a
      // bare search for "fox".
      'FOX CRIME', 'FOX LIFE', 'FOX MOVIES', 'FOX COMEDY', 'FOX PREMIUM',
      'FOX CRICKET', 'FOX LEAGUE', 'FOX FOOTY', 'FOX RACING', 'FOX SOCCER',
      'FOX DEPORTES', 'FOX WEATHER', 'FOX NATION', 'FOX AIRE', 'FOX SP',
      'FOXTEL', 'FOXI', 'FOX FIRE', 'FOX ACTION',
    ],
  },
  CBS: {
    numbered: true,
    include: ['CBS'],
    groups: ['US | CBS'],
    exclude: ['CBSSN', 'CBS SPORTS NETWORK', 'CBS SPORTS'],
  },
  NBC: {
    numbered: true,
    include: ['NBC'],
    groups: ['US | NBC'],
    // NBC Sports is what was asked for. The news and golf feeds are added
    // on the same reasoning as ABC News below: they carry the network's
    // name and never carry its games.
    //
    // Telemundo and USA Network are here because providers file them
    // under their OWNER's name: "US NBC (KVEA) Telemundo", "US: NBC USA
    // NETWORK (EAST)". Both are NBCUniversal, neither is NBC, and without
    // these two lines each provider offered fourteen Spanish-language
    // Telemundo stations and a USA Network feed as NBC - measured, 16
    // wrong candidates apiece. They now have sections of their own.
    exclude: ['NBC SPORTS', 'NBCSN', 'NBC NEWS', 'NBC GOLF',
      'TELEMUNDO', 'USA NETWORK', 'USA NET'],
  },
  TELEMUNDO: {
    // Affiliates carry a channel number the same way the English-language
    // broadcast networks do - "TELEMUNDO 47 (WNJU)", "TELEMUNDO 42 NEW
    // ORLEANS".
    numbered: true,
    include: ['TELEMUNDO'],
    groups: ['US | Telemundo'],
    // Telemundo-branded channels that are not the broadcast station: the
    // 24/7 news and highlights feeds, the entertainment spin-offs, and
    // the international service, which does not hold the US rights.
    // All of these are on the playlists and all answer to "Telemundo".
    exclude: [
      'NOTICIAS TELEMUNDO', 'TELEMUNDO INTERNACIONAL', 'TELEMUNDO AL DIA',
      'TELEMUNDO AHORA', 'TELEMUNDO DEPORTES', 'TELEMUNDO ACTION',
      'TELEMUNDO ROMANCE', 'TELEMUNDO CINE', 'TELEMUNDO NOVELAS',
    ],
  },
  ABC: {
    numbered: true,
    include: ['ABC'],
    groups: ['US | ABC'],
    exclude: ['ABC NEWS'],
  },
  CW: {
    numbered: true,
    include: ['CW'],
    groups: ['US | CW'],
    exclude: [],
  },

  // --- Cable --------------------------------------------------------
  //
  // numbered is false throughout. A trailing digit is a different channel
  // here, not a market.
  ESPN: {
    include: ['ESPN', 'ESPN 1', 'ESPN1'],
    groups: ['US | ESPN'],
    // "ESPN" alone is the main feed, so everything else carrying the name
    // has to be named here. ESPN+ needs no entry: '+' survives
    // normalization, so espn+ is simply a different token from espn.
    exclude: [
      'ESPN 2', 'ESPN2', 'ESPN U', 'ESPNU', 'ESPN NEWS', 'ESPNEWS',
      'ESPN DEPORTES', 'ESPN EXTRA', 'ESPN PPV', 'ESPN SPORT',
      'ESPN 3', 'ESPN3', 'ESPN CLASSIC', 'ESPN BET', 'ESPN LATAM',
      'ESPN PREMIUM', 'ESPN 4', 'ESPN 5', 'ESPN 6', 'ESPN 7',
      // Providers file the ESPN-operated conference channels under the
      // ESPN name too - "US ESPN ACC Network", "US ESPN SEC (X)". Those
      // are ACCN and SECN, and they have their own slots.
      'ACC NETWORK', 'SEC NETWORK', 'ESPN ACC', 'ESPN SEC', 'BIG TEN',
    ],
  },
  ESPN2: {
    include: ['ESPN 2', 'ESPN2'],
    groups: ['US | ESPN'],
    exclude: ['ESPN 2 LATAM', 'ESPN2 LATAM'],
  },
  ESPNU: {
    include: ['ESPN U', 'ESPNU'],
    groups: ['US | ESPN'],
    exclude: [],
  },
  FS1: {
    // Already exact. "Fox" is NOT excluded here even though it was
    // listed: the include terms are the specific ones, and excluding
    // "Fox" would throw out "Fox Sports 1" - the very channel being
    // looked for - along with the affiliates it was meant to stop.
    include: ['FS1', 'FS 1', 'FOX SPORTS 1'],
    groups: ['US | Fox Sports'],
    exclude: ['FOX SPORTS 10', 'FS1 LATAM', 'FOX SPORTS 1 LATAM'],
  },
  CBSSN: {
    include: ['CBSSN', 'CBS SPORTS NETWORK', 'CBS SPORTS NET'],
    groups: ['US | CBS Sports'],
    exclude: [],
  },
  BTN: {
    include: ['BTN', 'BIG TEN NETWORK', 'BIG TEN'],
    groups: ['US | Big Ten Network'],
    // BTN+ is a streaming tier. '+' survives normalization so 'btn+' is
    // already a different token, but providers also write it in full.
    exclude: ['BIG TEN PLUS', 'BTN PLUS'],
  },
  SECN: {
    include: ['SEC', 'SEC NETWORK', 'SECN'],
    groups: ['US | SEC Network'],
    exclude: ['SEC PLUS', 'SECN PLUS', 'SEC NETWORK PLUS'],
  },
  ACCN: {
    include: ['ACC', 'ACC NETWORK', 'ACCN'],
    groups: ['US | ACC Network'],
    // ACC Network Extra is a streaming overflow tier, not ACC Network -
    // near-identical names, different products. networks.js keeps the
    // same distinction on the broadcast side.
    exclude: ['ACCNX', 'ACC NETWORK EXTRA', 'ACC EXTRA', 'ACC PLUS'],
  },
  NFLN: {
    include: ['NFL NETWORK', 'NFL NET'],
    groups: ['US | NFL Network'],
    exclude: [],
  },
  REDZONE: {
    include: ['REDZONE', 'RED ZONE', 'NFL RZ'],
    groups: [],
    // A different product that shares the name.
    exclude: ['FANTASY REDZONE'],
  },
  USANET: {
    // "USA" on its own is NOT an include term. It is a country tag on
    // half the playlist - "US: USA NETWORK" is fine, but a bare "USA"
    // would match every American channel there is.
    include: ['USA NETWORK', 'USA NET'],
    groups: ['US | USA Network'],
    exclude: ['USA TODAY'],
  },
  TNT: {
    include: ['TNT'],
    groups: ['US | TNT'],
    exclude: ['TNT SPORTS', 'TNT SERIES', 'TNT NOVELAS', 'TNT COMEDY'],
  },
  TRUTV: {
    include: ['TRUTV', 'TRU TV'],
    groups: ['US | truTV'],
    exclude: [],
  },
};

// UFC and RAF are deliberately absent.
//
// Both are event buckets rather than channels: a provider spins up a
// listing per card, named for the event, and it exists for a few days.
// There is no standing channel to keep fresh, no sweep old enough to
// have measured one, and the account picks them by hand for exactly that
// reason. Auto-picking here would mean inventing a rule for a channel
// that does not exist yet.
function rulesFor(networkKey, overrides) {
  const base = DEFAULT_RULES[networkKey];
  if (!base) return null;
  const custom = (overrides || {})[networkKey] || {};
  const list = (v, fallback) =>
    (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()) : fallback);
  return {
    numbered: !!base.numbered,
    include: list(custom.include, base.include),
    exclude: list(custom.exclude, base.exclude),
    groups: list(custom.groups, base.groups),
  };
}

function autoPickableNetworks() {
  return Object.keys(DEFAULT_RULES);
}

// Whether a rule's group filter accepts this channel.
//
// Every word of the configured group name must appear in the channel's
// own group, in any order - the same comparison networks.js uses for
// search groups, and for the same reason: providers decorate group names
// with country prefixes and separators, so a rule written as "US | Fox"
// has to match a group actually named "US | FOX HD".
function inConfiguredGroup(groupTokens, groups) {
  if (groups.length === 0 || groupTokens.length === 0) return false;
  return groups.some(words =>
    groupTokens.some(tokens => words.every(word => tokens.includes(word))));
}

// Splitting a name and deciding its nationality are per-channel facts,
// and neither depends on which network is being asked about - so doing
// them once per channel rather than once per channel per network is worth
// having. Previewing all seventeen networks over a 57,000-channel
// playlist ran in 5.6 seconds before this and well under one after, which
// is the difference between a panel that redraws as you tick a box and
// one you wait on.
//
// A WeakMap keyed on the channel object, so it costs nothing to invalidate:
// a refreshed catalog builds new channel objects and the old entries go
// with them.
const channelFacts = new WeakMap();

function factsFor(channel) {
  let facts = channelFacts.get(channel);
  if (!facts) {
    facts = {
      tokens: tokenize(channel.name),
      american: looksAmerican(channel),
      groupTokens: (channel.categories || []).map(tokenize).filter(t => t.length > 0),
    };
    channelFacts.set(channel, facts);
  }
  return facts;
}

// Every OTHER network's include terms, for the group guard below.
function rivalTerms(networkKey, overrides) {
  const out = [];
  for (const key of Object.keys(DEFAULT_RULES)) {
    if (key === networkKey) continue;
    const rules = rulesFor(key, overrides);
    out.push({ words: compileTerms(rules.include), numbered: rules.numbered });
  }
  return out;
}

// Every channel in a playlist that IS this network. Quality is not
// considered here at all - this is question 1 on its own, so it can be
// checked on its own.
function candidatesFor(networkKey, channels, options = {}) {
  const rules = rulesFor(networkKey, options.rules);
  if (!rules) return [];

  // Once per network, not once per channel.
  const include = compileTerms(rules.include);
  const exclude = compileTerms(rules.exclude);
  const groups = compileTerms(rules.groups);
  const rivals = rivalTerms(networkKey, options.rules);

  const out = [];
  for (const channel of channels || []) {
    if (!channel || !(channel.streamUrl || channel.url)) continue;
    const { tokens, american, groupTokens } = factsFor(channel);

    // Exclusions first and unconditionally. A channel named Fox Sports 1
    // is Fox Sports 1 however it is filed.
    if (isStreamingTier(tokens)) continue;
    if (hasAnyTerm(tokens, SHARED_EXCLUDE_WORDS, false)) continue;
    if (hasAnyTerm(tokens, exclude, false)) continue;

    const byName = hasAnyTerm(tokens, include, rules.numbered);
    const byGroup = inConfiguredGroup(groupTokens, groups);
    if (!byName && !byGroup) continue;

    // A channel let in by its GROUP alone must not be some other
    // network by name.
    //
    // Groups are families as often as they are channels. "US | ABC"
    // holds ABC affiliates and nothing else, which is what makes the
    // group path worth having - but "US | ESPN" holds ESPN, ESPN2,
    // ESPNU and ESPNews together, and without this the plain ESPN feed
    // became a candidate for the ESPN2 slot purely by sharing a folder
    // with it. That is the Fox-versus-Fox-Sports mistake arriving
    // through the group door instead of the name one.
    //
    // Only for group-only matches. A channel that matched this network
    // BY NAME has already been judged on its name, and its own
    // exclusions are what settle it.
    if (!byName && rivals.some(r => hasAnyTerm(tokens, r.words, r.numbered))) continue;

    if (!american) continue;

    out.push({ channel, matchedBy: byName ? (byGroup ? 'name+group' : 'name') : 'group' });
  }
  return out;
}

// ---------------------------------------------------------------------
// The quality ladder
// ---------------------------------------------------------------------

// Question 2, and much the simpler of the two.
//
// Resolution first, then how much bitrate is being spent on it. A 1080p
// feed given enough bits to hold up is worth more than any 720p one; a
// 1080p feed starved of them is not, and drops below a well-fed 720p. The
// thresholds are where those two swap over. They are not the same number
// because the same bpp is harder to reach at 1080p - it is 2.25x the
// pixels - so 0.060 there is the equivalent standard to 0.080 at 720p.
const BANDS = [
  { name: '1080p over 0.060 bpp', minHeight: 1080, minBpp: 0.060 },
  { name: '720p over 0.080 bpp',  minHeight: 720,  minBpp: 0.080, maxHeight: 1079 },
  { name: 'remaining 1080p',      minHeight: 1080, minBpp: 0 },
  { name: 'remaining 720p',       minHeight: 720,  minBpp: 0, maxHeight: 1079 },
  { name: 'below 720p',           minHeight: 0,    minBpp: 0 },
];

// Sport is motion, and half the frames of it is not something a generous
// bitrate buys back. Published readings come back as clean integers - 60,
// 50, 30, 25 - so this is the literal test it looks like rather than a
// threshold with rounding headroom in it. 50 is a PAL feed, which is
// another way of saying it is not the American channel being looked for.
const MIN_FPS = 60;

function bandFor(reading) {
  const height = reading.height || 0;
  for (let i = 0; i < BANDS.length; i++) {
    const band = BANDS[i];
    if (height < band.minHeight) continue;
    if (band.maxHeight && height > band.maxHeight) continue;
    if ((reading.bpp || 0) < band.minBpp) continue;
    return i;
  }
  return BANDS.length - 1;
}

// Orders the candidates, best first.
//
// `read(channel)` returns { status, height, fps, bpp } for a channel, or
// null when the sweep does not cover it. Injected rather than imported so
// this file stays free of the streamcheck cache and can be run against a
// saved table.
//
// Three things are dropped outright rather than ranked last:
//
//   - Anything the sweep did not measure. There is no way to tell a
//     working channel from a dead one without a reading, and replacing a
//     known-good link with an unknown is not an improvement.
//   - Anything not Alive. Dead and Blackscreen are the entire reason this
//     exists.
//   - Anything below 60fps, which is a hard requirement - but see
//     `allowSlow`.
//
// Frame rate is the one gate with a way back. If every candidate for a
// network is 30fps then the choice is a 30fps channel or no channel, and
// no channel is worse. The caller is told which happened.
function rankCandidates(candidates, read, options = {}) {
  const ranked = [];
  const rejected = { unmeasured: 0, notAlive: 0, slow: 0 };

  for (const candidate of candidates) {
    const reading = read(candidate.channel);
    if (!reading) { rejected.unmeasured++; continue; }
    if (reading.status && reading.status !== 'Alive') { rejected.notAlive++; continue; }

    const slow = (reading.fps || 0) < MIN_FPS;
    if (slow && !options.allowSlow) { rejected.slow++; continue; }

    ranked.push({ ...candidate, reading, slow, band: bandFor(reading) });
  }

  // Band first, then bpp within it. Ties broken by resolution so the
  // larger picture wins, and then left in playlist order so the result is
  // stable between runs - two identical readings must not swap places and
  // look like the pick changed.
  ranked.sort((a, b) =>
    a.band - b.band
    || (b.reading.bpp || 0) - (a.reading.bpp || 0)
    || (b.reading.height || 0) - (a.reading.height || 0));

  return { ranked, rejected };
}

// The whole job for one network: which channels are it, which of those
// work, and the best few in order.
//
// Returns the picks alongside what was considered and what was thrown
// out, because the counts are what make a surprising result explainable -
// "nothing was picked" reads very differently when it is 200 candidates
// all Dead than when it is no candidates at all.
function pickForNetwork(networkKey, channels, read, options = {}) {
  const limit = options.limit || 5;
  const candidates = candidatesFor(networkKey, channels, options);

  let { ranked, rejected } = rankCandidates(candidates, read, options);

  // The 30fps fallback, and only ever as a fallback: it runs when the
  // hard requirement left nothing at all, never to pad a short list.
  let usedSlow = false;
  if (ranked.length === 0 && rejected.slow > 0) {
    ({ ranked } = rankCandidates(candidates, read, { ...options, allowSlow: true }));
    usedSlow = ranked.length > 0;
  }

  return {
    networkKey,
    picks: ranked.slice(0, limit),
    considered: candidates.length,
    rejected,
    usedSlow,
  };
}

// Which of two picks is the better one, by the same ladder rankCandidates
// orders a single provider's candidates with. Pulled out because the
// multi-provider version below has to compare across two already-sorted
// lists, and the two orderings must not be allowed to drift apart.
function comparePicks(a, b) {
  if (!a) return b ? 1 : 0;
  if (!b) return -1;
  return a.band - b.band
    || (b.reading.bpp || 0) - (a.reading.bpp || 0)
    || (b.reading.height || 0) - (a.reading.height || 0);
}

// The same job across an account's providers, keeping each one's share
// separate.
//
// An account can hold several IPTV services, and the useful answer is not
// simply the ten best channels overall - that regularly means ten from
// one service, which is ten links that all go dark together when it has a
// bad night. So each provider contributes its own best few, and the
// account ends up with real redundancy rather than a well-ranked single
// point of failure.
//
// The provider holding the single best channel goes first, and takes the
// whole first block with it. Ordering the blocks rather than interleaving
// them is deliberate: slot order is the order a player tries them in, and
// somebody who reaches for slot 2 after slot 1 stutters is far better
// served by the same service's next-best feed than by a hop to the other
// one - if slot 1 was the best link either provider had, its stablemates
// are the next most likely thing to work.
//
// `channelsByProvider` is [{ providerId, channels }] in the account's own
// provider order, which is the tie-break when two providers' best picks
// are indistinguishable.
function pickAcrossProviders(networkKey, channelsByProvider, read, options = {}) {
  const groups = (channelsByProvider || []).filter(g => g && g.channels);
  if (groups.length === 0) {
    return { networkKey, picks: [], considered: 0, rejected: { unmeasured: 0, notAlive: 0, slow: 0 }, usedSlow: false, perProvider: [] };
  }

  const blocks = groups.map(group => ({
    providerId: group.providerId,
    outcome: pickForNetwork(networkKey, group.channels, read, options),
  }));

  // Stable within a tie, so two providers whose best channels read
  // identically stay in the order the account lists them and a re-run
  // does not shuffle every slot for no reason.
  const ordered = [...blocks].sort((a, b) =>
    comparePicks(a.outcome.picks[0], b.outcome.picks[0]));

  const rejected = { unmeasured: 0, notAlive: 0, slow: 0 };
  for (const block of blocks) {
    rejected.unmeasured += block.outcome.rejected.unmeasured;
    rejected.notAlive += block.outcome.rejected.notAlive;
    rejected.slow += block.outcome.rejected.slow;
  }

  return {
    networkKey,
    picks: ordered.flatMap(block =>
      block.outcome.picks.map(pick => ({ ...pick, providerId: block.providerId }))),
    considered: blocks.reduce((sum, b) => sum + b.outcome.considered, 0),
    rejected,
    usedSlow: blocks.some(b => b.outcome.usedSlow),
    // Per provider, in the order the blocks were laid out, so a panel can
    // say "5 from A, 2 from B" and explain a short list as one service
    // having nothing to offer rather than the whole pick having failed.
    perProvider: ordered.map(block => ({
      providerId: block.providerId,
      picked: block.outcome.picks.length,
      considered: block.outcome.considered,
      rejected: block.outcome.rejected,
      usedSlow: block.outcome.usedSlow,
    })),
  };
}

module.exports = {
  DEFAULT_RULES,
  BANDS,
  MIN_FPS,
  autoPickableNetworks,
  rulesFor,
  candidatesFor,
  rankCandidates,
  pickForNetwork,
  pickAcrossProviders,
  looksAmerican,
  normalize,
  tokenize,
  hasTerm,
};
