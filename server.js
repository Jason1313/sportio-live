const express = require('express');
const cors = require('cors');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const m3u = require('./m3u.js');
const networks = require('./networks.js');
const probe = require('./probe.js');

// Xtream credentials are encrypted at rest in users.json using this key.
// Must be a 64-character hex string (32 bytes) for AES-256-GCM. Generate one
// with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// Deliberately does NOT crash the app if this is missing - a fresh
// install with no ENCRYPTION_KEY set yet needs to actually start up
// successfully so the first-run setup flow (admin password screen, then
// an in-app key generator) can run at all. A random, in-memory-only key
// is used as a placeholder so encrypt()/decrypt() never throw - but this
// placeholder is NEVER actually relied on for real user data, since
// registration and login are explicitly blocked elsewhere until a real,
// persistent key is configured. Using it for anything real would mean
// silently unreadable accounts the moment the container restarts and
// this random value is gone.
const ENCRYPTION_KEY_HEX = process.env.ENCRYPTION_KEY;
const ENCRYPTION_KEY_CONFIGURED = !!(ENCRYPTION_KEY_HEX && /^[0-9a-fA-F]{64}$/.test(ENCRYPTION_KEY_HEX));
if (!ENCRYPTION_KEY_CONFIGURED) {
  console.error('');
  console.error('WARNING: ENCRYPTION_KEY environment variable is missing or invalid.');
  console.error('The app will start, but account registration/login stay disabled until a real key is set.');
  console.error('Visit the homepage to generate one, or generate it directly with:');
  console.error("  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
  console.error('Then set it in compose.yaml under this service\'s environment section as:');
  console.error('  - ENCRYPTION_KEY=<the generated value>');
  console.error('...and restart the container - this is only read once, at startup.');
  console.error('');
}
const XTREAM_ENCRYPTION_KEY = Buffer.from(
  ENCRYPTION_KEY_CONFIGURED ? ENCRYPTION_KEY_HEX : crypto.randomBytes(32).toString('hex'),
  'hex'
);

// Encrypts a single string value for storage. Returns a self-contained
// 'enc:iv:authTag:ciphertext' string (all base64) so decrypt() can tell
// encrypted values apart from legacy plaintext data during migration.
function encrypt(text) {
  if (text === undefined || text === null) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', XTREAM_ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `enc:${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

// Decrypts a value produced by encrypt(). Values without the 'enc:' prefix
// are assumed to be legacy plaintext (pre-encryption data) and are passed
// through unchanged - they get encrypted automatically on the next save.
function decrypt(value) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !value.startsWith('enc:')) return value;

  try {
    const parts = value.split(':');
    const iv = Buffer.from(parts[1], 'base64');
    const authTag = Buffer.from(parts[2], 'base64');
    const encryptedData = Buffer.from(parts[3], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', XTREAM_ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    console.error('[Encryption] Failed to decrypt a stored value - wrong ENCRYPTION_KEY, or corrupted data:', err.message);
    return '';
  }
}

function encryptXtreamForStorage(xtream) {
  if (!xtream) return xtream;
  return {
    ...xtream,
    url: xtream.url !== undefined ? encrypt(xtream.url) : xtream.url,
    username: xtream.username !== undefined ? encrypt(xtream.username) : xtream.username,
    password: xtream.password !== undefined ? encrypt(xtream.password) : xtream.password
  };
}

function decryptXtreamFromStorage(xtream) {
  if (!xtream) return xtream;
  return {
    ...xtream,
    url: xtream.url !== undefined ? decrypt(xtream.url) : xtream.url,
    username: xtream.username !== undefined ? decrypt(xtream.username) : xtream.username,
    password: xtream.password !== undefined ? decrypt(xtream.password) : xtream.password
  };
}

// M3U playlist/EPG URLs frequently carry embedded credentials directly in
// the URL itself (e.g. ".../live/username/password/streamid.ts", confirmed
// against real provider output during design) - just as sensitive as
// Xtream's own username/password, so they get the same encryption-at-rest
// treatment, not treated as lesser just because they're "only URLs".
function encryptM3uForStorage(m3u) {
  if (!m3u) return m3u;
  return {
    ...m3u,
    playlistUrl: m3u.playlistUrl !== undefined ? encrypt(m3u.playlistUrl) : m3u.playlistUrl,
    epgUrl: m3u.epgUrl !== undefined ? encrypt(m3u.epgUrl) : m3u.epgUrl
  };
}

function decryptM3uFromStorage(m3u) {
  if (!m3u) return m3u;
  return {
    ...m3u,
    playlistUrl: m3u.playlistUrl !== undefined ? decrypt(m3u.playlistUrl) : m3u.playlistUrl,
    epgUrl: m3u.epgUrl !== undefined ? decrypt(m3u.epgUrl) : m3u.epgUrl
  };
}

// Saved network links carry a full M3U stream URL, and those URLs embed
// the provider credentials in the path exactly the way the playlist URL
// does (".../live/username/password/1568650.ts", confirmed against real
// provider output). So they get the same encryption-at-rest treatment -
// storing them in the clear would undo the protection on m3u.playlistUrl
// by leaking the same secret through a different field.
//
// Only the url is encrypted. tvgId/name/group are healing metadata with
// no secret in them, and leaving them readable keeps a users.json dump
// diagnosable without the key.
// Saved channels carry the same credential-bearing URLs as network
// links, so they get the same treatment. Stored as a flat array rather
// than keyed by network, hence its own pair of helpers.
function encryptSavedChannelsForStorage(savedChannels) {
  if (!Array.isArray(savedChannels)) return savedChannels;
  return savedChannels.map(c => ({ ...c, url: c.url ? encrypt(c.url) : c.url }));
}

function decryptSavedChannelsFromStorage(savedChannels) {
  if (!Array.isArray(savedChannels)) return savedChannels;
  return savedChannels.map(c => ({ ...c, url: c.url ? decrypt(c.url) : c.url }));
}

function encryptNetworkLinksForStorage(networkLinks) {
  if (!networkLinks || typeof networkLinks !== 'object') return networkLinks;
  const out = {};
  for (const [networkKey, links] of Object.entries(networkLinks)) {
    if (!Array.isArray(links)) continue;
    out[networkKey] = links.map(l => ({ ...l, url: l.url ? encrypt(l.url) : l.url }));
  }
  return out;
}

function decryptNetworkLinksFromStorage(networkLinks) {
  if (!networkLinks || typeof networkLinks !== 'object') return networkLinks;
  const out = {};
  for (const [networkKey, links] of Object.entries(networkLinks)) {
    if (!Array.isArray(links)) continue;
    out[networkKey] = links.map(l => ({ ...l, url: l.url ? decrypt(l.url) : l.url }));
  }
  return out;
}

const app = express();
// Behind Nginx Proxy Manager (or any reverse proxy), req.protocol/hostname
// need to trust X-Forwarded-* headers to correctly report https - without
// this, self-generated URLs (posters, manifest links) would incorrectly
// say http:// even when the public-facing site is https://.
app.set('trust proxy', true);
const PORT = process.env.PORT || 2323;
// Overridable so a test run can point at a throwaway directory instead of
// writing accounts into the real one. In Docker this is left unset and
// resolves to ./data, which is the path compose.yaml mounts the volume at
// - so normal deployments are unaffected.
const DATA_DIR = process.env.SPORTIO_DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'users.json');
const M3U_SETTINGS_FILE = path.join(DATA_DIR, 'm3u-settings.json');
const ADMIN_CONFIG_FILE = path.join(DATA_DIR, 'admin-config.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`[Storage] Created data directory at ${DATA_DIR}`);
}

app.use(cors());
app.use(express.json());
// Resolved against the app directory, not the working directory. A bare
// 'public' is relative to process.cwd(), so every static file - the
// configurator, the watch page, the logo - 404s if the server is ever
// started from anywhere other than its own folder. In Docker the WORKDIR
// makes those the same and hides it; outside Docker it does not.
app.use(express.static(path.join(__dirname, 'public')));

// --- Login rate limiting ---
// Tracks failed login attempts per IP address in memory.
// After LOGIN_MAX_ATTEMPTS failures within LOGIN_WINDOW_MS, that IP is locked out
// until the window passes. Resets automatically on server restart (intentional
// for a small single-instance deployment like this one).
const loginAttempts = new Map(); // ip -> { count, firstAttempt }
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// Periodically clear out stale entries so this Map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of loginAttempts.entries()) {
    if (now - record.firstAttempt > LOGIN_WINDOW_MS) {
      loginAttempts.delete(ip);
    }
  }
}, LOGIN_WINDOW_MS).unref();

// Shared by every endpoint that checks a password (login, update, delete,
// the EPG tool's endpoints, admin login) - not just /api/user/login.
// Originally only login itself enforced this, which meant the lockout was
// trivially bypassable by brute-forcing the same password through any of
// the other endpoints instead. One shared IP-keyed budget across all of
// them closes that gap.
function isRateLimited(ip) {
  const record = loginAttempts.get(ip);
  return !!(record && (Date.now() - record.firstAttempt < LOGIN_WINDOW_MS) && record.count >= LOGIN_MAX_ATTEMPTS);
}

function getRetryAfterSeconds(ip) {
  const record = loginAttempts.get(ip);
  if (!record) return 0;
  return Math.ceil((LOGIN_WINDOW_MS - (Date.now() - record.firstAttempt)) / 1000);
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (record && now - record.firstAttempt < LOGIN_WINDOW_MS) {
    record.count++;
  } else {
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
  }
}

function clearFailedAttempts(ip) {
  loginAttempts.delete(ip);
}

let userConfigs = {};
if (fs.existsSync(DATA_FILE)) {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const [uuid, user] of Object.entries(raw)) {
      userConfigs[uuid] = {
        ...user,
        xtream: decryptXtreamFromStorage(user.xtream),
        m3u: decryptM3uFromStorage(user.m3u),
        networkLinks: decryptNetworkLinksFromStorage(user.networkLinks),
        savedChannels: decryptSavedChannelsFromStorage(user.savedChannels)
      };
    }
  } catch (err) {
    console.error('[Storage] Error loading users.json:', err.message);
  }
}

function saveUserConfigs() {
  try {
    const toWrite = {};
    for (const [uuid, user] of Object.entries(userConfigs)) {
      toWrite[uuid] = {
        ...user,
        xtream: encryptXtreamForStorage(user.xtream),
        m3u: encryptM3uForStorage(user.m3u),
        networkLinks: encryptNetworkLinksForStorage(user.networkLinks),
        savedChannels: encryptSavedChannelsForStorage(user.savedChannels)
      };
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(toWrite, null, 2), 'utf8');
  } catch (err) {
    console.error('[Storage] Failed to save users.json:', err.message);
  }
}

// Any accounts loaded with legacy plaintext Xtream credentials get
// re-saved immediately, so encryption is applied automatically without
// anyone needing to re-enter their credentials.
saveUserConfigs();

// Admin-configured M3U refresh schedule - deliberately a small, separate,
// live-editable JSON file rather than a .env value, since the whole
// point is the admin can change it from the admin page itself without a
// restart. No encryption needed here (unlike users.json) - a schedule
// and a timezone name aren't sensitive the way credentials are.
const DEFAULT_M3U_SETTINGS = { daysOfWeek: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], times: ['06:00', '18:00'], timeZone: 'America/New_York' };

function loadM3uSettings() {
  if (!fs.existsSync(M3U_SETTINGS_FILE)) return { ...DEFAULT_M3U_SETTINGS };
  try {
    const raw = JSON.parse(fs.readFileSync(M3U_SETTINGS_FILE, 'utf8'));
    return {
      daysOfWeek: Array.isArray(raw.daysOfWeek) && raw.daysOfWeek.length > 0 ? raw.daysOfWeek : DEFAULT_M3U_SETTINGS.daysOfWeek,
      times: Array.isArray(raw.times) && raw.times.length > 0 ? raw.times : DEFAULT_M3U_SETTINGS.times,
      timeZone: raw.timeZone || DEFAULT_M3U_SETTINGS.timeZone
    };
  } catch (err) {
    console.error('[Storage] Error loading m3u-settings.json, using defaults:', err.message);
    return { ...DEFAULT_M3U_SETTINGS };
  }
}

function saveM3uSettings(settings) {
  try {
    fs.writeFileSync(M3U_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('[Storage] Failed to save m3u-settings.json:', err.message);
  }
}

let m3uSettings = loadM3uSettings();

// Preferred tvg-ids per network, shared by the whole instance.
//
// Stream ids only - never a URL, which for M3U carries the provider
// username and password in its path. A bare id like "429939" is not a
// credential.
//
// Keyed on stream id rather than channel id so a pin identifies the
// exact feed that was chosen: several feeds of one channel share a
// channel id and cannot be told apart by it. The trade is that stream
// ids are assigned per provider, so these are exact here and match
// nothing on a different IPTV service.
const NETWORK_DEFAULTS_FILE = path.join(DATA_DIR, 'network-defaults.json');

// Stored as a list of named presets rather than one map, because stream
// ids are per provider: a set pinned against one IPTV service identifies
// nothing on another. Keeping several named sets side by side is what
// lets one instance carry defaults for more than one provider, and
// deleting one is how a stale set stops polluting suggestions.
//
// Every preset contributes its ids to the suggestions. That works
// precisely BECAUSE the ids are provider-specific - the sets that belong
// to some other service match no channel here and are inert - and it is
// why each preset also records the host it was captured from, so a human
// can tell at a glance which one is which and remove the one that no
// longer applies.
function emptyDefaults() {
  return { presets: [] };
}

function normalisePreset(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const networks = {};
  for (const [key, ids] of Object.entries(raw.networks || {})) {
    if (!Array.isArray(ids)) continue;
    const clean = ids.filter(id => typeof id === 'string' && id);
    if (clean.length > 0) networks[key] = clean;
  }
  if (Object.keys(networks).length === 0) return null;
  return {
    id: String(raw.id || `preset-${index + 1}`),
    name: String(raw.name || `Preset ${index + 1}`).slice(0, 60),
    source: String(raw.source || '').slice(0, 120),
    createdAt: raw.createdAt || new Date().toISOString(),
    networks,
  };
}

function loadNetworkDefaults() {
  if (!fs.existsSync(NETWORK_DEFAULTS_FILE)) return emptyDefaults();
  try {
    const raw = JSON.parse(fs.readFileSync(NETWORK_DEFAULTS_FILE, 'utf8'));

    if (Array.isArray(raw.presets)) {
      return { presets: raw.presets.map(normalisePreset).filter(Boolean) };
    }

    // The old shape: one bare { NETWORK: [ids] } map with no name. Wrapped
    // rather than discarded - somebody pinned those deliberately, and the
    // only thing missing is a name for them.
    const migrated = normalisePreset({
      id: 'preset-1',
      name: 'Saved defaults',
      source: '',
      networks: raw,
    }, 0);
    if (!migrated) return emptyDefaults();
    console.log('[Defaults] Migrated the single default set into a named preset.');
    const upgraded = { presets: [migrated] };
    saveNetworkDefaults(upgraded);
    return upgraded;
  } catch (err) {
    console.error('[Storage] Error loading network-defaults.json:', err.message);
    return emptyDefaults();
  }
}

function saveNetworkDefaults(defaults) {
  try {
    fs.writeFileSync(NETWORK_DEFAULTS_FILE, JSON.stringify(defaults, null, 2), 'utf8');
  } catch (err) {
    console.error('[Storage] Failed to save network-defaults.json:', err.message);
  }
}

// The union every preset contributes to, in preset order. Ids repeat
// harmlessly; the Set keeps the first occurrence, which preserves the
// order the operator arranged them in.
function mergedNetworkDefaults() {
  const merged = {};
  for (const preset of networkDefaults.presets) {
    for (const [key, ids] of Object.entries(preset.networks)) {
      if (!merged[key]) merged[key] = [];
      for (const id of ids) {
        if (!merged[key].includes(id)) merged[key].push(id);
      }
    }
  }
  return merged;
}

// The host a preset was captured from. Host only, never the path or the
// query - an M3U playlist URL carries the account credentials in its
// path, and this string is shown in the dashboard and written to a file.
function providerHostFor(user) {
  const raw = user.connectionType === 'm3u'
    ? (user.m3u && user.m3u.playlistUrl)
    : (user.xtream && user.xtream.url);
  try {
    return new URL(String(raw || '')).host;
  } catch (err) {
    return '';
  }
}

// Metadata only. The stream ids themselves are of no use to the
// dashboard and are the one part worth not shipping around.
function describePresets() {
  return networkDefaults.presets.map(preset => ({
    id: preset.id,
    name: preset.name,
    source: preset.source,
    createdAt: preset.createdAt,
    networkCount: Object.keys(preset.networks).length,
    channelCount: Object.values(preset.networks).reduce((n, ids) => n + ids.length, 0),
  }));
}

let networkDefaults = loadNetworkDefaults();

// App-managed admin credentials - lets a fresh install set an admin
// password through the UI itself, rather than requiring a manual
// compose.yaml/.env edit and restart before the admin panel is
// usable at all. Password is bcrypt-hashed, same as regular user
// accounts - being local-only config doesn't mean it's fine to store in
// plaintext. ADMIN_USERNAME/ADMIN_PASSWORD env vars, if set, always take
// priority over this file (see isValidAdmin below) - this preserves
// exact existing behavior for any deployment that already configured
// those, so upgrading to this version changes nothing for them.
function loadAdminConfig() {
  if (!fs.existsSync(ADMIN_CONFIG_FILE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(ADMIN_CONFIG_FILE, 'utf8'));
    if (!raw.username || !raw.passwordHash) return null;
    return raw;
  } catch (err) {
    console.error('[Storage] Error loading admin-config.json:', err.message);
    return null;
  }
}

function saveAdminConfig(config) {
  try {
    fs.writeFileSync(ADMIN_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('[Storage] Failed to save admin-config.json:', err.message);
  }
}

let adminConfig = loadAdminConfig();

const ESPN_ENDPOINTS = {
  NBA: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
  NFL: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
  MLB: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard',
  NHL: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard',
  WNBA: 'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard',
  NCAAMB: 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard',
  NCAAWB: 'https://site.api.espn.com/apis/site/v2/sports/basketball/womens-college-basketball/scoreboard',
  NCAAFB: 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard',
  EPL: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard',
  MLS: 'https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard',
  LALIGA: 'https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard',
  WORLDCUP: 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard',
  UFC: 'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard',
  // Not a browsable catalog of its own - see MMA_LEAGUES. Listed here so
  // getRealLeagueLogoUrl('PFL') can find the league's artwork, which it
  // reads from whichever scoreboard endpoint the key names.
  PFL: 'https://site.api.espn.com/apis/site/v2/sports/mma/pfl/scoreboard',
  // ESPN's own catch-all league (3359, literally named "Other"), where it
  // files every promotion it has no dedicated league for. Confirmed live:
  // this is where Super RIZIN 5, Road to UFC and PFL Africa all sit,
  // even though RIZIN and PFL have leagues of their own. It is one
  // endpoint covering an open-ended set of promotions, which is exactly
  // why the section can carry "everything else" without enumerating it.
  OTHER: 'https://site.api.espn.com/apis/site/v2/sports/mma/other/scoreboard'
};

// The ESPN MMA leagues the MMA section pulls from, in display order.
//
// ESPN files each promotion under its own league slug (confirmed live
// against the leagues index: ufc is 3321, pfl is 3347), and every one of
// them serves the same scoreboard and Core API shape. So widening the
// section to a new promotion is an entry here plus, if it needs its own
// channels, a networks.PROMOTIONS entry - not a new code path.
//
// Dana White's Contender Series is deliberately absent: ESPN has no
// separate league for it, filing it under ufc. It is separated by name at
// the promotion layer instead, which is the only signal available.
//
// `key` doubles as the artwork key - it must exist in ESPN_ENDPOINTS
// above (for the league logo) and in SPORT_THEMES (for the landscape
// background's colours).
// How far ahead the MMA section looks, in days.
//
// Every other sport in this app is strictly today-only, and for a daily
// league that is right: a list of today's games is the whole question.
// MMA is not daily. A promotion runs a card every week or two, so a
// today-only section is empty almost every day of the year, which makes
// it look broken rather than quiet.
//
// 180 days covers the entire schedule ESPN currently publishes - measured
// live, its furthest announced card is inside four months - so this is
// "everything there is" rather than an arbitrary slice, while staying
// bounded if a promotion ever announces a year of dates at once.
// Confirmed the range parameter is accepted at this length, including
// across a year boundary, for all three leagues.
const MMA_SCHEDULE_DAYS = 180;

const MMA_LEAGUES = [
  { slug: 'ufc', key: 'UFC' },
  { slug: 'pfl', key: 'PFL' },
  // Last on purpose. ESPN's catch-all sweeps up every promotion without a
  // league of its own - LFA, UAE Warriors, RIZIN, Road to UFC - so this
  // single entry is what makes the section cover the whole MMA schedule
  // rather than a list someone has to keep topped up. Measured against the
  // rest of 2026: of ESPN's 48 MMA leagues only three carry any events at
  // all, and this is one of them.
  { slug: 'other', key: 'OTHER' }
];

// UFC events, unlike every other sport here, don't map to a single
// matchup - one event is a whole card of many individual fights. This
// endpoint gives the main event's own numeric id specifically, needed to
// fetch the Core API event endpoint that identifies which fight on the
// card is actually the main event (matchNumber: 1) - the scoreboard
// endpoint above doesn't expose that field at all.
const ESPN_CORE_EVENT_ENDPOINTS = {
  UFC: 'https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events',
  PFL: 'https://sports.core.api.espn.com/v2/sports/mma/leagues/pfl/events',
  OTHER: 'https://sports.core.api.espn.com/v2/sports/mma/leagues/other/events'
};

// NCAA sports have far more teams than the pro leagues, and ESPN's scoreboard
// endpoint silently truncates results unless a broad 'groups' + high 'limit'
// is passed. The pro leagues and single-table soccer leagues don't need this.
//
// The correct 'groups' id is PER SPORT, not shared. 50 is Division I for
// basketball, but for college FOOTBALL the divisions are 80 (FBS) and 81
// (FCS) - and passing 50 there does the opposite of what it was added to
// do. Verified live against 2025-10-04:
//     (no groups param)   -> 46 events
//     &groups=50          ->  5 events   <-- what this used to send
//     &groups=80          -> 46 events
// So NCAAFB was showing ~11% of the slate. Any NCAA sport added here needs
// its own verified group id; do not assume 50 generalizes.
const NCAA_GROUP_IDS = { NCAAMB: 50, NCAAWB: 50, NCAAFB: 80 };
const NCAA_SPORTS = new Set(Object.keys(NCAA_GROUP_IDS));

// The '&groups=N&limit=500' suffix for a sport, or '' if it needs none.
function getNcaaScoreboardParams(sportKey) {
  const groupId = NCAA_GROUP_IDS[sportKey.toUpperCase()];
  return groupId ? `&groups=${groupId}&limit=500` : '';
}

const ESPN_LEAGUES = {
  NBA: 'nba',
  NFL: 'nfl',
  MLB: 'mlb',
  NHL: 'nhl',
  WNBA: 'wnba',
  NCAAMB: 'mens-college-basketball',
  NCAAWB: 'womens-college-basketball',
  NCAAFB: 'college-football',
  EPL: 'eng.1',
  MLS: 'usa.1',
  LALIGA: 'esp.1',
  WORLDCUP: 'fifa.world',
  UFC: 'ufc',
  PFL: 'pfl',
  OTHER: 'other'
};

// The landscape background's decorative overlay is spliced directly into
// the outer SVG document as native markup, rather than embedded as a
// nested SVG-in-SVG via a base64 <image> data URI. Nesting a full vector
// document that way turned out not to render at all - a much less
// universally-supported technique than nesting a raster image, unlike the
// team logos below (which really are raster PNGs, so <image> works fine
// for those). This function parses the overlay file's <defs> and drawable
// elements once, prefixes its gradient IDs uniquely to avoid any future
// collision with other defs in this document, and caches the result.
let backgroundOverlayInline = null;
// Shared by every overlay that gets spliced directly into an outer SVG
// document as native markup, rather than embedded as a nested SVG-in-SVG
// via a base64 <image> data URI - nesting a full vector document that way
// turned out not to render at all (confirmed with the landscape
// background's overlay), a much less universally-supported technique than
// nesting a raster image. Parses the file's <defs> and drawable elements
// once, prefixes its gradient/filter ids uniquely (using the caller's own
// prefix, so two different overlay files spliced into two different
// routes can never collide even if their internal ids happen to match),
// and caches the result per file path.
const inlineSvgOverlayCache = {};
function getInlineSvgOverlay(filePath, idPrefix) {
  if (inlineSvgOverlayCache[filePath]) return inlineSvgOverlayCache[filePath];
  try {
    const content = fs.readFileSync(filePath, 'utf8');

    const defsMatch = content.match(/<defs>([\s\S]*?)<\/defs>/);
    let defs = defsMatch ? defsMatch[1] : '';
    let markup = defsMatch ? content.slice(defsMatch.index + defsMatch[0].length) : content;
    markup = markup.replace(/<\/?svg[^>]*>/g, '').trim();

    // Prefix every id="..." this file defines, and every url(#...)
    // reference to it, so it can never collide with ids elsewhere in the
    // outer document this gets spliced into.
    const ids = [...defs.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
    ids.forEach(id => {
      const prefixed = `${idPrefix}-${id}`;
      defs = defs.split(`id="${id}"`).join(`id="${prefixed}"`);
      defs = defs.split(`url(#${id})`).join(`url(#${prefixed})`);
      markup = markup.split(`url(#${id})`).join(`url(#${prefixed})`);
    });

    const result = { defs, markup };
    inlineSvgOverlayCache[filePath] = result;
    return result;
  } catch (err) {
    console.error(`[SVG Overlay] Failed to load ${filePath}:`, err.message);
    return { defs: '', markup: '' };
  }
}

// Replaces every fill="..." within a named group's subtree with a new
// color - the fill can live on a child element deeper in the subtree
// (confirmed directly - the group wrapper itself often has no fill of
// its own, only its inner path does, and a child's own explicit fill
// always wins over anything set on the parent), so this searches the
// whole subtree rather than assuming the fill sits on the group itself.
function recolorSvgGroup(markup, groupId, newColor) {
  const pattern = new RegExp(`(<g id="${groupId}"[^>]*>)([\\s\\S]*?)(</g>)`);
  const match = markup.match(pattern);
  if (!match) return markup;
  const recoloredInner = match[2].replace(/fill="[^"]*"/g, `fill="${newColor}"`);
  return markup.slice(0, match.index) + match[1] + recoloredInner + match[3] + markup.slice(match.index + match[0].length);
}

// display="none" on the group itself correctly cascades to every child
// (confirmed - unlike fill, which only inherits when a child doesn't
// already specify its own), so this only needs to touch the group's own
// opening tag, not search its subtree.
function hideSvgGroup(markup, groupId) {
  const pattern = new RegExp(`<g id="${groupId}"([^>]*)>`);
  return markup.replace(pattern, `<g id="${groupId}"$1 display="none">`);
}

// Removes a single self-closing element by id, marker or otherwise.
//
// hideSvgGroup and replaceSvgGroup work on <g> wrappers; this is for a
// bare element with no group of its own. Used for the poster's time
// plaque, which is real rendered art rather than a marker - with nothing
// printed on it any more, leaving it puts an empty black box across the
// bottom of every card.
function removeSvgElementById(markup, elementId) {
  const pattern = new RegExp(`<[a-zA-Z]+[^>]*\\bid="${elementId}"[^>]*/>`);
  return markup.replace(pattern, '');
}

// Extracts a named marker group's bounding box for placement purposes -
// e.g. a "home_logo" marker rect defines exactly where and how large to
// place the real, dynamic logo image instead. Looks for the first
// x/y/width/height on any element within the group's subtree.
function getSvgGroupBounds(markup, groupId) {
  const pattern = new RegExp(`<g id="${groupId}"[^>]*>([\\s\\S]*?)</g>`);
  const match = markup.match(pattern);
  if (!match) return null;
  const inner = match[1];
  const x = inner.match(/x="([^"]+)"/);
  const y = inner.match(/y="([^"]+)"/);
  const width = inner.match(/width="([^"]+)"/);
  const height = inner.match(/height="([^"]+)"/);
  if (!x || !y || !width || !height) return null;
  return { x: parseFloat(x[1]), y: parseFloat(y[1]), width: parseFloat(width[1]), height: parseFloat(height[1]) };
}

function getBackgroundOverlayInline() {
  const filePath = path.join(__dirname, 'assets', 'background', 'overlay_background.svg');
  return getInlineSvgOverlay(filePath, 'bg-overlay');
}

// For the standard (non-ESPN-provided) team logo fallback URL, most sports
// use their own league slug as the CDN folder, but ESPN buckets ALL soccer
// teams under the literal folder 'soccer' regardless of which league they
// play in - so eng.1/usa.1/esp.1/fifa.world all need this override.
const TEAM_LOGO_BUCKET_OVERRIDES = {
  EPL: 'soccer',
  MLS: 'soccer',
  LALIGA: 'soccer',
  WORLDCUP: 'soccer',
  // Confirmed live for both football and men's basketball - ESPN buckets
  // ALL NCAA team logos under the literal folder 'ncaa', not each sport's
  // own league slug (e.g. NOT 'college-football' or
  // 'mens-college-basketball', which is what the fallback would have
  // used without this override).
  NCAAFB: 'ncaa',
  NCAAMB: 'ncaa',
  NCAAWB: 'ncaa'
};

function getTeamLogoBucket(sportKey) {
  return TEAM_LOGO_BUCKET_OVERRIDES[sportKey] || ESPN_LEAGUES[sportKey] || 'mlb';
}

// Friendly names for sports whose internal key isn't already a clean label.
// Anything not listed here just displays as its own key (e.g. NBA, MLB).
const SPORT_DISPLAY_NAMES = {
  NCAAMB: 'College Basketball (Mens)',
  NCAAWB: 'College Basketball (Womens)',
  NCAAFB: 'College Football',
  EPL: 'Premier League',
  MLS: 'MLS',
  LALIGA: 'La Liga',
  WORLDCUP: 'FIFA World Cup',
  // The internal key stays UFC on purpose. It is what every saved account
  // already has in networkLinks and sportOrder, and what
  // existing catalog ids are built from - renaming it would migrate all
  // of that to change a label. The section now carries several
  // promotions (see MMA_LEAGUES), so only the label needed to widen.
  UFC: 'MMA'
};

function getSportDisplayName(sportKey) {
  const upper = String(sportKey || '').toUpperCase();
  return SPORT_DISPLAY_NAMES[upper] || upper;
}

async function getBase64Image(url) {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': 'https://www.espn.com/'
      },
      timeout: 5000
    });
    const contentType = response.headers['content-type'] || 'image/png';
    const base64 = Buffer.from(response.data, 'binary').toString('base64');
    return `data:${contentType};base64,${base64}`;
  } catch (err) {
    console.error(`[ImageLoader] Failed to fetch image: ${url}. Error: ${err.message}`);
    return null;
  }
}

// Tries each URL in order, returning the first one that successfully loads.
// Used for the scoreboard-logo -> standard-logo fallback chain.
async function getBase64ImageWithFallback(urls) {
  for (const url of urls) {
    if (!url) continue;
    const data = await getBase64Image(url);
    if (data) return data;
  }
  return null;
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Splits a name into two roughly-balanced lines at the word boundary
// closest to the middle, so longer team names wrap cleanly instead of
// being squeezed onto one line.
function splitNameForWrap(name) {
  const words = String(name || 'Team').trim().split(/\s+/);
  if (words.length <= 1) return [name || 'Team'];

  let bestIdx = 1;
  let bestDiff = Infinity;
  let cumulative = 0;
  const totalLen = name.length;

  for (let i = 0; i < words.length - 1; i++) {
    cumulative += words[i].length + 1;
    const diff = Math.abs(cumulative - totalLen / 2);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i + 1;
    }
  }

  return [words.slice(0, bestIdx).join(' '), words.slice(bestIdx).join(' ')];
}

// Renders a circle with the team's name as text, used in place of the
// team logo image whenever every logo image source fails to load.
function buildLogoFallback(x, y, size, teamName, accentColor, filterAttr = '') {
  const lines = splitNameForWrap(teamName).map(escapeXml);
  const cx = x + size / 2;
  const cy = y + size / 2;
  const r = size / 2;
  const fontSize = Math.round(size * 0.11);
  const lineWidth = Math.round(size * 0.62);
  const lineHeight = fontSize * 1.15;

  const textLines = lines
    .map((line, i) => {
      const offsetIdx = i - (lines.length - 1) / 2;
      const yPos = cy + offsetIdx * lineHeight + fontSize * 0.35;
      return `<text x="${cx}" y="${yPos}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#f8fafc" text-anchor="middle" textLength="${lineWidth}" lengthAdjust="spacingAndGlyphs">${line}</text>`;
    })
    .join('\n      ');

  return `
    <g${filterAttr}>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="#1e293b" stroke="${accentColor}" stroke-width="4" />
      ${textLines}
    </g>`;
}

function getLocalDateString(timeZone = 'America/New_York') {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'America/New_York' });
    return formatter.format(new Date()).replace(/-/g, '');
  } catch (err) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }
}

function getLocalDateDash(timeZone = 'America/New_York') {
  const dateStr = getLocalDateString(timeZone);
  return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
}

function formatTeamTime(utcDateStr, timeZone) {
  try {
    const date = new Date(utcDateStr);
    const targetTz = timeZone || 'America/New_York';
    
    const timeFormatter = new Intl.DateTimeFormat('en-US', { timeZone: targetTz, hour: 'numeric', minute: '2-digit', hour12: true });
    const tzFormatter = new Intl.DateTimeFormat('en-US', { timeZone: targetTz, timeZoneName: 'short' });

    const timeStr = timeFormatter.format(date).toLowerCase();
    const tzParts = tzFormatter.formatToParts(date);
    const tzName = tzParts.find(p => p.type === 'timeZoneName')?.value || '';

    return `${timeStr} ${tzName}`;
  } catch (err) {
    return null;
  }
}

// "Sat, Oct 17" in the user's own timezone. Companion to formatTeamTime,
// which gives the time half.
//
// Needed because the MMA section is no longer today-only: a card sitting
// in the list might be tonight or eleven weeks out, and the poster is
// where people look to tell which.
function formatEventDate(utcDateStr, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'America/New_York',
      weekday: 'short', month: 'short', day: 'numeric'
    }).format(new Date(utcDateStr));
  } catch (err) {
    return null;
  }
}

// "Sat, Oct 17 - 8:00 pm EDT", or just the time half when the event is
// today. Today needs no date: it is the one case where "8:00 pm" is
// unambiguous, and dropping it keeps the common case short.
function formatEventWhen(utcDateStr, timeZone) {
  if (!utcDateStr) return '';
  const time = formatTeamTime(utcDateStr, timeZone);
  if (isSameLocalDay(utcDateStr, timeZone)) return time || '';
  const date = formatEventDate(utcDateStr, timeZone);
  if (!date) return time || '';
  return time ? `${date} - ${time}` : date;
}

// Whether an event falls on the user's current local day. Compared as
// formatted local date strings rather than by arithmetic on timestamps,
// which is the only way to get this right across timezones and DST
// without hand-rolling the offset maths - and it reuses the exact
// formatter getLocalDateString already trusts for the same job.
function isSameLocalDay(utcDateStr, timeZone) {
  if (!utcDateStr) return false;
  try {
    const tz = timeZone || 'America/New_York';
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return formatter.format(new Date(utcDateStr)) === formatter.format(new Date());
  } catch (err) {
    return false;
  }
}

// Shifts a YYYYMMDD string by a number of days, returning the same
// format. Used to build ESPN's date-range parameter for the MMA window.
//
// Deliberately arithmetic on a UTC noon anchor: starting from midnight
// would let a DST shift push the result onto the previous day, and noon
// is far enough from either boundary that no real timezone can.
function addDaysToDateString(dateStr, days) {
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(4, 6));
  const day = Number(dateStr.slice(6, 8));
  const anchor = new Date(Date.UTC(year, month - 1, day, 12));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10).replace(/-/g, '');
}

function formatDateYYYYMMDD(dateObj, timeZone) {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'America/New_York' });
    return formatter.format(dateObj).replace(/-/g, '');
  } catch (err) {
    return '';
  }
}

// Human-readable date (e.g. "August 11, 2026") for the description's
// second line - in the user's configured timezone, same as formatTeamTime,
// so the date and time shown always agree with each other.
function formatReadableDate(utcDateStr, timeZone) {
  try {
    const date = new Date(utcDateStr);
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' });
    return formatter.format(date);
  } catch (err) {
    return null;
  }
}

function formatGameDateLabel(utcDateStr, timeZone) {
  try {
    const date = new Date(utcDateStr);
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'America/New_York',
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    });
    return formatter.format(date);
  } catch (err) {
    return '';
  }
}


// Average glyph width as a fraction of font-size, for the bold sans
// stack the posters use. Same approximation, and the same reasoning, as
// NETWORK_LABEL_CHAR_RATIO: exact text metrics are not available server
// side and only need to be close enough to keep a title in its box.
const POSTER_CHAR_RATIO = 0.62;

// Wraps text to at most `maxLines` and picks the largest font size that
// still fits `boxWidth`, returning both.
//
// The wrap width is searched rather than assumed. A fixed
// characters-per-line guess is wrong in both directions - it leaves
// "UFC 332" tiny and breaks "Dana White's Contender Series" in an ugly
// place - so this tries every wrap from narrow to wide, discards the ones
// needing too many lines, and keeps whichever arrangement renders largest.
// The search is a few dozen cheap string operations on a title, run once
// per poster.
//
// Width is estimated from an average glyph ratio, the same approximation
// buildNetworkArtSvg uses. Exact text metrics are not available server
// side, and the goal is only to keep a title inside the poster.
function fitTextBlock(text, { boxWidth, maxLines, maxFontSize }) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { lines: [], fontSize: 0 };

  let best = null;
  for (let perLine = 4; perLine <= 64; perLine++) {
    const lines = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      // `!current` keeps a single word longer than the wrap width on its
      // own line rather than dropping it.
      if (candidate.length <= perLine || !current) current = candidate;
      else { lines.push(current); current = word; }
    }
    if (current) lines.push(current);
    if (lines.length > maxLines) continue;

    const longest = lines.reduce((a, b) => (a.length >= b.length ? a : b), '');
    const fontSize = Math.min(maxFontSize, boxWidth / Math.max(1, longest.length * POSTER_CHAR_RATIO));

    // Largest text wins, and among arrangements that tie, the one using
    // fewest lines. The tie-break is what stops "UFC 332" being stacked
    // as "UFC" over "332": both fit at the maximum size, so without a
    // preference the narrower wrap won on arriving first and every short
    // title came out broken in half.
    const better = !best
      || fontSize > best.fontSize + 0.01
      || (Math.abs(fontSize - best.fontSize) <= 0.01 && lines.length < best.lines.length);
    if (better) best = { lines, fontSize };
  }

  return best || { lines: [String(text)], fontSize: maxFontSize };
}

// Splits an event name at its first colon into a headline and a detail.
//
// MMA event names are consistently "designation: matchup" - "UFC 331: Van
// vs. Pantoja 2", "PFL Chicago: Carmouche vs. Bishop 2", "Dana White's
// Contender Series: Season 10, Week 4". Setting the two apart reads far
// better than wrapping the whole string as one block, and costs nothing
// when there is no colon: the name simply becomes the headline.
function splitEventName(name) {
  const text = String(name || '').trim();
  const at = text.indexOf(':');
  if (at === -1) return { headline: text, detail: '' };
  return { headline: text.slice(0, at).trim(), detail: text.slice(at + 1).trim() };
}

// The MMA event poster: the promotion's logo over the event's name.
//
// It used to composite each fighter's stance photo from ESPN. That worked
// for headline UFC cards and steadily worse for everything else - ESPN
// simply has no stance image for most fighters outside the UFC's main
// roster (measured: one of the two on the next PFL card, neither on
// several others), so the poster fell back to a name plate for one side
// and looked broken rather than sparse. A promotion mark and the event's
// own name is information the app always has, for every promotion, and it
// is what the card is actually recognised by in a grid.
//
// One handler, three paths (registered below). The two older forms carry
// fighter ids that nothing reads any more; they stay because Stremio
// caches artwork URLs and an existing install must keep rendering. They
// are still useful as a cache key - a distinct URL per event - which is
// why the current form keeps a query string rather than collapsing to one
// URL per promotion.
const mmaPosterHandler = async (req, res) => {
  const leagueKey = String(req.params.league || 'ufc').toUpperCase();
  const theme = SPORT_THEMES[leagueKey] || SPORT_THEMES.UFC;

  // `name` is what the catalog sends. The home/away fallback covers a URL
  // cached before this route took a name, so an old poster still says
  // something rather than going blank.
  const fallbackName = [req.query.home, req.query.away].filter(Boolean).join(' vs ');
  const eventName = String(req.query.name || fallbackName || 'MMA Event').trim();
  const { headline, detail } = splitEventName(eventName);

  const leagueLogoUrl = await getRealLeagueLogoUrl(leagueKey);
  const leagueLogoData = leagueLogoUrl ? await getBase64Image(leagueLogoUrl) : null;

  // The logo sits in the upper half, scaled proportionately inside its
  // box rather than filling it - league marks are wildly different shapes
  // (the UFC's is wide, the generic MMA icon is square) and stretching
  // any of them to a fixed box would be worse than leaving air.
  const LOGO = { x: 90, y: 150, width: 420, height: 300 };
  const logoMarkup = leagueLogoData
    ? `<image href="${leagueLogoData}" x="${LOGO.x}" y="${LOGO.y}" width="${LOGO.width}" height="${LOGO.height}" preserveAspectRatio="xMidYMid meet" />`
    : buildLogoFallback(LOGO.x, LOGO.y, LOGO.width, leagueKey, theme.secondary);

  // Text occupies the lower half, as one block centred within it, so a
  // one-line name and a four-line one both sit level rather than one
  // hugging the logo and the other the poster's foot.
  const TEXT = { top: 520, bottom: 830, width: 480 };
  const head = fitTextBlock(headline, { boxWidth: TEXT.width, maxLines: 2, maxFontSize: 78 });
  const sub = detail
    ? fitTextBlock(detail, { boxWidth: TEXT.width, maxLines: 2, maxFontSize: 40 })
    : { lines: [], fontSize: 0 };

  const headLine = head.fontSize * 1.12;
  const subLine = sub.fontSize * 1.2;
  const gap = sub.lines.length > 0 ? head.fontSize * 0.45 : 0;
  const blockHeight = head.lines.length * headLine + gap + sub.lines.length * subLine;
  let cursor = (TEXT.top + TEXT.bottom) / 2 - blockHeight / 2 + head.fontSize * 0.82;

  const headMarkup = head.lines.map((line, i) =>
    `<text x="300" y="${cursor + i * headLine}" font-family="'Trebuchet MS', Verdana, sans-serif" font-size="${head.fontSize.toFixed(1)}" font-weight="800" fill="#f8fafc" text-anchor="middle" letter-spacing="1">${escapeXml(line)}</text>`
  ).join('');

  cursor += (head.lines.length - 1) * headLine + gap + subLine;
  const subMarkup = sub.lines.map((line, i) =>
    `<text x="300" y="${cursor + i * subLine}" font-family="'Trebuchet MS', Verdana, sans-serif" font-size="${sub.fontSize.toFixed(1)}" font-weight="600" fill="#e6e6e6" fill-opacity="0.82" text-anchor="middle">${escapeXml(line)}</text>`
  ).join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 600 900" width="600" height="900">
    <defs>
      <radialGradient id="mmaBg" cx="50%" cy="38%" r="78%">
        <stop offset="0%" stop-color="${theme.primary}" />
        <stop offset="100%" stop-color="#000000" />
      </radialGradient>
    </defs>
    <rect width="600" height="900" fill="url(#mmaBg)" />
    <rect x="0" y="0" width="600" height="8" fill="${theme.secondary}" />
    <rect x="0" y="892" width="600" height="8" fill="${theme.secondary}" />
    ${logoMarkup}
    <rect x="240" y="486" width="120" height="3" fill="${theme.secondary}" fill-opacity="0.85" />
    ${headMarkup}
    ${subMarkup}
  </svg>`;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(svg);
};

// Registered BEFORE the generic team-based poster route below. The bare
// path has the same segment count (/poster/X/Y/Z.svg) and Express matches
// in registration order, so the more specific one has to come first or it
// would never be reached. The league-scoped path has an extra segment and
// cannot collide, but is kept here beside its twin.
app.get('/poster/mma/:league.svg', mmaPosterHandler);
app.get('/poster/mma/:league/:fighterAId/:fighterBId.svg', mmaPosterHandler);
app.get('/poster/ufc/:fighterAId/:fighterBId.svg', mmaPosterHandler);

function getPosterTemplateInline() {
  const filePath = path.join(__dirname, 'assets', 'posters', 'poster_template.svg');
  return getInlineSvgOverlay(filePath, 'poster-template');
}

app.get('/poster/:sport/:homeId/:awayId.svg', async (req, res) => {
  const { sport, homeId, awayId } = req.params;
  const gameUtcDate = req.query.date || null;
  const userTz = req.query.tz || 'America/New_York';
  const homeName = req.query.home || 'Home';
  const awayName = req.query.away || 'Away';
  const sportKey = sport.toUpperCase();
  const league = getTeamLogoBucket(sportKey);
  const theme = SPORT_THEMES[sportKey] || SPORT_THEMES.MLB;

  // Using each team's primary color - alternate color was tried and
  // reverted. Falls back to alternate, then the sport's generic theme
  // color, if a team is missing a primary color.
  const homeColor = req.query.homeColor ? `#${req.query.homeColor}`
    : req.query.homeAltColor ? `#${req.query.homeAltColor}`
    : theme.secondary;
  const awayColor = req.query.awayColor ? `#${req.query.awayColor}`
    : req.query.awayAltColor ? `#${req.query.awayAltColor}`
    : theme.primary;
  const homeAbbr = (req.query.homeAbbr || '').toLowerCase();
  const awayAbbr = (req.query.awayAbbr || '').toLowerCase();

  // Scoreboard-optimized logo first, full standard logo as fallback if the
  // scoreboard variant isn't available.
  const homeScoreboardUrl = homeAbbr ? `https://a.espncdn.com/i/teamlogos/${league}/500/scoreboard/${homeAbbr}.png` : '';
  const awayScoreboardUrl = awayAbbr ? `https://a.espncdn.com/i/teamlogos/${league}/500/scoreboard/${awayAbbr}.png` : '';
  const homeStandardUrl = `https://a.espncdn.com/i/teamlogos/${league}/500/${homeId}.png`;
  const awayStandardUrl = `https://a.espncdn.com/i/teamlogos/${league}/500/${awayId}.png`;

  const [homeLogoData, awayLogoData] = await Promise.all([
    getBase64ImageWithFallback([homeScoreboardUrl, homeStandardUrl]),
    getBase64ImageWithFallback([awayScoreboardUrl, awayStandardUrl])
  ]);

  const template = getPosterTemplateInline();

  // away_logo/home_logo are placement markers only, never meant to
  // actually render - their rects just define exactly where and how
  // large to place the real, dynamic content instead. Bounds extracted
  // from the original markup before any modifications, since hiding a
  // group doesn't touch its inner coordinates either way.
  //
  // 'time' is a marker too, and is still hidden below, but nothing is
  // drawn in its place any more - the time now lives under the poster
  // rather than on it, so only the hiding matters.
  const homeLogoBounds = getSvgGroupBounds(template.markup, 'home_logo');
  const awayLogoBounds = getSvgGroupBounds(template.markup, 'away_logo');

  let markup = template.markup;
  markup = recolorSvgGroup(markup, 'away_color', awayColor);
  markup = recolorSvgGroup(markup, 'home_color', homeColor);
  markup = hideSvgGroup(markup, 'away_logo');
  markup = hideSvgGroup(markup, 'home_logo');
  markup = hideSvgGroup(markup, 'time');
  // The plaque that used to sit behind the game time. The time moved out
  // from under the poster to beneath the card, and an empty plaque is a
  // black box across the foot of every card - the same removal the MMA
  // template already needed.
  markup = removeSvgElementById(markup, 'time_plaque');

  const homeLogoMarkup = homeLogoBounds
    ? (homeLogoData
        ? `<image href="${homeLogoData}" x="${homeLogoBounds.x}" y="${homeLogoBounds.y}" width="${homeLogoBounds.width}" height="${homeLogoBounds.height}" preserveAspectRatio="xMidYMid meet" />`
        : buildLogoFallback(homeLogoBounds.x, homeLogoBounds.y, homeLogoBounds.width, homeName, homeColor))
    : '';
  const awayLogoMarkup = awayLogoBounds
    ? (awayLogoData
        ? `<image href="${awayLogoData}" x="${awayLogoBounds.x}" y="${awayLogoBounds.y}" width="${awayLogoBounds.width}" height="${awayLogoBounds.height}" preserveAspectRatio="xMidYMid meet" />`
        : buildLogoFallback(awayLogoBounds.x, awayLogoBounds.y, awayLogoBounds.width, awayName, awayColor))
    : '';

  // No time is printed here any more - it lives under the poster now,
  // the same way it does for every other sport. The 'time' marker group
  // stays hidden below, exactly as it was; nothing is drawn over it.

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 600 900" width="600" height="900">
    <defs>${template.defs}</defs>
    ${markup}
    ${homeLogoMarkup}
    ${awayLogoMarkup}
  </svg>`;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(svg);
});

const SPORT_THEMES = {
  NBA: { primary: '#1D428A', secondary: '#C8102E' },
  WNBA: { primary: '#FF6900', secondary: '#1D1160' },
  NFL: { primary: '#013369', secondary: '#D50A0A' },
  MLB: { primary: '#0C2340', secondary: '#BA0C2F' },
  NHL: { primary: '#000000', secondary: '#41B6E6' },
  NCAAMB: { primary: '#041E42', secondary: '#C8102E' },
  NCAAWB: { primary: '#041E42', secondary: '#C8102E' },
  NCAAFB: { primary: '#013369', secondary: '#D50A0A' },
  EPL: { primary: '#3D195B', secondary: '#00FF85' },
  MLS: { primary: '#0B1F41', secondary: '#EE3524' },
  LALIGA: { primary: '#EE8707', secondary: '#000000' },
  WORLDCUP: { primary: '#326295', secondary: '#C8A951' },
  UFC: { primary: '#000000', secondary: '#D20A0A' },
  PFL: { primary: '#0A0A0A', secondary: '#E4002B' },
  OTHER: { primary: '#1A1A1A', secondary: '#B31217' }
};

// Primary accent used for the subtle poster background gradient per sport.
function getSportMotif(sportKey, accentColor) {
  switch (sportKey) {
    case 'NBA':
    case 'WNBA':
    case 'NCAAMB':
    case 'NCAAWB':
      return `
        <g transform="translate(1500,540)" opacity="0.16" stroke="${accentColor}" stroke-width="6" fill="none">
          <circle r="380" />
          <path d="M -380,0 A 380,380 0 0,1 380,0" />
          <path d="M -380,0 A 380,380 0 0,0 380,0" />
          <line x1="0" y1="-380" x2="0" y2="380" />
        </g>`;
    case 'NFL':
    case 'NCAAFB':
      return `
        <g transform="translate(1500,540)" opacity="0.16" stroke="${accentColor}" stroke-width="10">
          <line x1="-420" y1="-300" x2="420" y2="-300" />
          <line x1="-420" y1="-150" x2="420" y2="-150" />
          <line x1="-420" y1="0" x2="420" y2="0" />
          <line x1="-420" y1="150" x2="420" y2="150" />
          <line x1="-420" y1="300" x2="420" y2="300" />
        </g>`;
    case 'MLB':
      return `
        <g transform="translate(1500,540)" opacity="0.18" stroke="${accentColor}" stroke-width="6" fill="none">
          <circle r="380" />
          <path d="M -260,-280 A 380,380 0 0,1 -260,280" stroke-dasharray="14 10" />
          <path d="M 260,-280 A 380,380 0 0,0 260,280" stroke-dasharray="14 10" />
        </g>`;
    case 'NHL':
      return `
        <g transform="translate(1500,540)" opacity="0.18" stroke="${accentColor}" stroke-width="6" fill="none">
          <circle r="380" />
          <circle r="60" fill="${accentColor}" opacity="0.5" stroke="none" />
          <line x1="-460" y1="0" x2="-260" y2="0" stroke-width="14" />
          <line x1="260" y1="0" x2="460" y2="0" stroke-width="14" />
        </g>`;
    default:
      return '';
  }
}

app.get('/landscape/:sport.svg', (req, res) => {
  const sportKey = req.params.sport.toUpperCase();
  const theme = SPORT_THEMES[sportKey] || SPORT_THEMES.MLB;
  const motif = getSportMotif(sportKey, theme.secondary);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080">
    <defs>
      <linearGradient id="baseGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#020617" />
        <stop offset="50%" stop-color="#1e293b" />
        <stop offset="100%" stop-color="#0f172a" />
      </linearGradient>
      <linearGradient id="sweepGrad" x1="100%" y1="0%" x2="35%" y2="100%">
        <stop offset="0%" stop-color="${theme.primary}" stop-opacity="0.85" />
        <stop offset="55%" stop-color="${theme.secondary}" stop-opacity="0.45" />
        <stop offset="100%" stop-color="${theme.secondary}" stop-opacity="0" />
      </linearGradient>
    </defs>
    <rect width="1920" height="1080" fill="url(#baseGrad)" />
    <rect width="1920" height="1080" fill="url(#sweepGrad)" />
    ${motif}
  </svg>`;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

// The curved diagonal boundary between the home and away color regions,
// extracted directly from color_ref.png (a 3840x2160 placement guide, not
// shipped with the app) via pixel-by-pixel boundary sampling rather than
// hand-drawn - a dense 109-point polyline, pixel-accurate to the source
// rather than an approximation.
const LANDSCAPE_BOUNDARY_PATH = "M 2393 0 L 2313 20 L 2279 40 L 2256 60 L 2238 80 L 2224 100 L 2213 120 L 2205 140 L 2199 160 L 2193 180 L 2187 200 L 2181 220 L 2175 240 L 2169 260 L 2163 280 L 2156 300 L 2150 320 L 2144 340 L 2138 360 L 2132 380 L 2126 400 L 2120 420 L 2114 440 L 2108 460 L 2102 480 L 2096 500 L 2090 520 L 2083 540 L 2077 560 L 2071 580 L 2065 600 L 2059 620 L 2053 640 L 2047 660 L 2041 680 L 2035 700 L 2029 720 L 2023 740 L 2017 760 L 2010 780 L 2004 800 L 1998 820 L 1992 840 L 1986 860 L 1980 880 L 1974 900 L 1968 920 L 1962 940 L 1956 960 L 1950 980 L 1944 1000 L 1937 1020 L 1931 1040 L 1925 1060 L 1919 1080 L 1913 1100 L 1907 1120 L 1901 1140 L 1895 1160 L 1889 1180 L 1883 1200 L 1877 1220 L 1871 1240 L 1864 1260 L 1858 1280 L 1852 1300 L 1846 1320 L 1840 1340 L 1834 1360 L 1828 1380 L 1822 1400 L 1816 1420 L 1810 1440 L 1804 1460 L 1798 1480 L 1791 1500 L 1785 1520 L 1779 1540 L 1773 1560 L 1767 1580 L 1761 1600 L 1755 1620 L 1749 1640 L 1743 1660 L 1737 1680 L 1731 1700 L 1725 1720 L 1718 1740 L 1712 1760 L 1706 1780 L 1700 1800 L 1694 1820 L 1688 1840 L 1682 1860 L 1676 1880 L 1670 1900 L 1664 1920 L 1658 1940 L 1652 1960 L 1645 1980 L 1640 2000 L 1634 2020 L 1626 2040 L 1615 2060 L 1601 2080 L 1583 2100 L 1560 2120 L 1526 2140 L 1456 2159";

// Registered BEFORE the generic team-based landscape route below, for the
// same routing-order reason as the UFC poster route above.
// One handler, two paths - see mmaPosterHandler for why the bare /ufc/
// form is kept alongside the league-scoped one.
const mmaLandscapeHandler = async (req, res) => {
  const fighterAName = req.query.home || 'Fighter A';
  const fighterBName = req.query.away || 'Fighter B';
  const fighterAFlagUrl = req.query.homeFlagUrl || '';
  const fighterBFlagUrl = req.query.awayFlagUrl || '';
  const { fighterAId, fighterBId } = req.params;
  const leagueKey = String(req.params.league || 'ufc').toUpperCase();
  // Only reached when a fighter has no country flag on file, which is the
  // one case these solid fills cover. Taking them from the league's own
  // theme rather than hardcoding UFC's black/red means a PFL card that
  // falls back still looks like PFL.
  const theme = SPORT_THEMES[leagueKey] || SPORT_THEMES.UFC;

  const [fighterAPhoto, fighterBPhoto, fighterAFlag, fighterBFlag] = await Promise.all([
    getBase64Image(`https://a.espncdn.com/i/headshots/mma/players/full/${fighterAId}.png`),
    getBase64Image(`https://a.espncdn.com/i/headshots/mma/players/full/${fighterBId}.png`),
    fighterAFlagUrl ? getBase64Image(fighterAFlagUrl) : null,
    fighterBFlagUrl ? getBase64Image(fighterBFlagUrl) : null
  ]);

  const fighterAMarkup = fighterAPhoto
    ? `<image href="${fighterAPhoto}" x="360" y="480" width="1200" height="1200" preserveAspectRatio="xMidYMid slice" />`
    : buildLogoFallback(360, 480, 1200, fighterAName, '#c0392b');
  const fighterBMarkup = fighterBPhoto
    ? `<image href="${fighterBPhoto}" x="2280" y="480" width="1200" height="1200" preserveAspectRatio="xMidYMid slice" />`
    : buildLogoFallback(2280, 480, 1200, fighterBName, '#2a2a2a');

  // Fighter A (home) on the left, Fighter B (away) on the right -
  // deliberately flipped from the team-sport version's away-left/home-right
  // convention, per an explicit decision to reconsider what reads more
  // naturally for two fighters rather than just reusing the team layout
  // unchanged. Reuses the exact same diagonal boundary geometry either way.
  // Each region is filled with that fighter's actual country flag, scaled
  // to cover the whole region (preserveAspectRatio="xMidYMid slice"), 
  // rather than a plain team-style color - falls back to a solid theme
  // color if a flag image is unavailable for any reason.
  const fighterAFillMarkup = fighterAFlag
    ? `<image href="${fighterAFlag}" x="0" y="0" width="3840" height="2160" preserveAspectRatio="xMidYMid slice" />`
    : `<rect width="3840" height="2160" fill="${theme.primary}" />`;
  const fighterBFillMarkup = fighterBFlag
    ? `<image href="${fighterBFlag}" x="0" y="0" width="3840" height="2160" preserveAspectRatio="xMidYMid slice" />`
    : `<rect width="3840" height="2160" fill="${theme.secondary}" />`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 3840 2160" width="3840" height="2160">
    <defs>
      <clipPath id="ufcFighterAFillClip"><path d="${LANDSCAPE_BOUNDARY_PATH} L 0 2160 L 0 0 Z" /></clipPath>
      <clipPath id="ufcFighterBFillClip"><path d="${LANDSCAPE_BOUNDARY_PATH} L 3840 2160 L 3840 0 Z" /></clipPath>
      <clipPath id="ufcFighterAClip"><rect x="360" y="480" width="1200" height="1200" rx="32" /></clipPath>
      <clipPath id="ufcFighterBClip"><rect x="2280" y="480" width="1200" height="1200" rx="32" /></clipPath>
    </defs>
    <g clip-path="url(#ufcFighterAFillClip)">${fighterAFillMarkup}</g>
    <g clip-path="url(#ufcFighterBFillClip)">${fighterBFillMarkup}</g>
    <g clip-path="url(#ufcFighterAClip)">${fighterAMarkup}</g>
    <g clip-path="url(#ufcFighterBClip)">${fighterBMarkup}</g>
    <rect x="1770" y="1040" width="300" height="80" rx="12" fill="#c0392b" />
    <text x="1920" y="1094" font-family="'Trebuchet MS', Verdana, sans-serif" font-size="48" font-weight="800" fill="#ffffff" text-anchor="middle" letter-spacing="2">VS</text>
    <text x="1920" y="1900" font-family="'Trebuchet MS', Verdana, sans-serif" font-size="72" font-weight="700" fill="#ffffff" text-anchor="middle">${escapeXml(fighterAName)} vs ${escapeXml(fighterBName)}</text>
  </svg>`;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(svg);
};

app.get('/landscape/mma/:league/:fighterAId/:fighterBId.svg', mmaLandscapeHandler);
app.get('/landscape/ufc/:fighterAId/:fighterBId.svg', mmaLandscapeHandler);

app.get('/landscape/:sport/:homeId/:awayId.svg', async (req, res) => {
  const { sport, homeId, awayId } = req.params;
  const sportKey = sport.toUpperCase();
  const league = getTeamLogoBucket(sportKey);
  const theme = SPORT_THEMES[sportKey] || SPORT_THEMES.MLB;

  const homeName = req.query.home || 'Home';
  const awayName = req.query.away || 'Away';
  const homeColor = req.query.homeColor ? `#${req.query.homeColor}` : theme.secondary;
  const awayColor = req.query.awayColor ? `#${req.query.awayColor}` : theme.primary;
  const homeAbbr = (req.query.homeAbbr || '').toLowerCase();
  const awayAbbr = (req.query.awayAbbr || '').toLowerCase();

  // Same scoreboard-first, standard-logo-fallback pattern as the poster.
  const homeScoreboardUrl = homeAbbr ? `https://a.espncdn.com/i/teamlogos/${league}/500/scoreboard/${homeAbbr}.png` : '';
  const awayScoreboardUrl = awayAbbr ? `https://a.espncdn.com/i/teamlogos/${league}/500/scoreboard/${awayAbbr}.png` : '';
  const homeStandardUrl = `https://a.espncdn.com/i/teamlogos/${league}/500/${homeId}.png`;
  const awayStandardUrl = `https://a.espncdn.com/i/teamlogos/${league}/500/${awayId}.png`;

  const [homeLogoData, awayLogoData] = await Promise.all([
    getBase64ImageWithFallback([homeScoreboardUrl, homeStandardUrl]),
    getBase64ImageWithFallback([awayScoreboardUrl, awayStandardUrl])
  ]);

  const overlayInline = getBackgroundOverlayInline();

  // Logo placement, extracted directly from logo_ref.png: away in the
  // left (red) square, home in the right (yellow) square, both 1200x1200,
  // scaled to fit and centered via preserveAspectRatio rather than custom
  // per-orientation sizing math.
  const awayLogoBox = { x: 360, y: 480, size: 1200 };
  const homeLogoBox = { x: 2280, y: 480, size: 1200 };

  const awayLogoMarkup = awayLogoData
    ? `<image href="${awayLogoData}" x="${awayLogoBox.x}" y="${awayLogoBox.y}" width="${awayLogoBox.size}" height="${awayLogoBox.size}" preserveAspectRatio="xMidYMid meet" />`
    : buildLogoFallback(awayLogoBox.x, awayLogoBox.y, awayLogoBox.size, awayName, awayColor);
  const homeLogoMarkup = homeLogoData
    ? `<image href="${homeLogoData}" x="${homeLogoBox.x}" y="${homeLogoBox.y}" width="${homeLogoBox.size}" height="${homeLogoBox.size}" preserveAspectRatio="xMidYMid meet" />`
    : buildLogoFallback(homeLogoBox.x, homeLogoBox.y, homeLogoBox.size, homeName, homeColor);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 3840 2160" width="3840" height="2160">
    <defs>${overlayInline.defs}</defs>
    <path d="${LANDSCAPE_BOUNDARY_PATH} L 0 2160 L 0 0 Z" fill="${awayColor}" />
    <path d="${LANDSCAPE_BOUNDARY_PATH} L 3840 2160 L 3840 0 Z" fill="${homeColor}" />
    ${overlayInline.markup}
    ${awayLogoMarkup}
    ${homeLogoMarkup}
  </svg>`;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(svg);
});

// League logos don't follow one consistent CDN URL pattern the way team
// logos mostly do - MLB's real logo lives at
// teamlogos/leagues/500/mlb.png, but EPL's real logo lives at
// leaguelogos/soccer/500/23.png, a completely different base path AND a
// numeric id rather than the league slug. Confirmed live - directly
// contradicted what this route used to assume, which is why soccer and
// NCAA sports were silently getting no logo at all. Rather than hunting
// down and hardcoding the correct pattern per sport (fragile, and would
// need redoing for every sport we ever add), the real logo URL is
// extracted directly from the same live scoreboard data fetchTodayGames
// already uses, for every sport uniformly. Cached long-term since league
// logos essentially never change (full-rebrand territory).
const realLeagueLogoCache = {};
const REAL_LEAGUE_LOGO_CACHE_MS = 14 * 24 * 60 * 60 * 1000;

async function getRealLeagueLogoUrl(sportKey) {
  const cached = realLeagueLogoCache[sportKey];
  if (cached && (Date.now() - cached.fetchedAt) < REAL_LEAGUE_LOGO_CACHE_MS) {
    return cached.url;
  }

  const endpoint = ESPN_ENDPOINTS[sportKey];
  if (!endpoint) return null;

  try {
    const res = await axios.get(endpoint, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 7000
    });
    const logos = res.data?.leagues?.[0]?.logos || [];
    const defaultLogo = logos.find(l => l.rel?.includes('default')) || logos[0];
    const url = defaultLogo?.href || null;
    realLeagueLogoCache[sportKey] = { fetchedAt: Date.now(), url };
    return url;
  } catch (err) {
    console.error(`[Logo] Failed to fetch real league logo URL for ${sportKey}:`, err.message);
    // A stale cached URL is still far better than none.
    return cached ? cached.url : null;
  }
}

app.get('/logo/:sport.svg', async (req, res) => {
  const sportKey = req.params.sport.toUpperCase();
  const leagueLogoUrl = await getRealLeagueLogoUrl(sportKey);

  const logoData = leagueLogoUrl ? await getBase64Image(leagueLogoUrl) : null;
  const logoMarkup = logoData
    ? `<image href="${logoData}" x="0" y="0" width="1080" height="1080" preserveAspectRatio="xMidYMid meet" />`
    : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1080 1080" width="1080" height="1080">
    ${logoMarkup}
  </svg>`;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

// ---------------------------------------------------------------------
// Season weeks
// ---------------------------------------------------------------------
//
// Football is not a daily sport. A league plays one round a week, so a
// today-only catalog is empty six days in seven, and on the seventh it
// answers a narrower question than anyone is asking - nobody plans around
// "the games happening today" when the whole slate lands over one weekend.
//
// These leagues therefore show one ESPN round at a time, whole.
//
// Which round is decided by the games themselves, not by ESPN's calendar
// window: the window for a week runs on for a day or two past the final
// whistle (NFL Week 1's window ends Wednesday; its last game is Monday),
// and continuing to show a finished round is exactly what this is meant
// to avoid. The rule is the plain one - the current round is the first
// whose last game has not already finished before today, so the morning
// after a round ends the next one takes over.
//
// Verified against the real 2026 NFL calendar: on Sep 14, Week 1's
// Monday-night game, it still shows Week 1; on Sep 15 it moves to Week 2;
// on Sep 21 it shows Week 2 and on Sep 22 Week 3.
//
// `seasonTypes` lists which of ESPN's season types the league runs
// through, in the order it plays them. 1 is preseason, 2 the regular
// season, 3 the postseason. They are listed rather than assumed because
// each has its own week numbering restarting at 1 - "Week 1" only means
// anything paired with a type - and because which of them are worth
// showing is a judgement per league, not a fact about the data.
const SEASON_WEEK_LEAGUES = {
  // Preseason, regular season, postseason. The NFL's postseason really is
  // a sequence of rounds - Wild Card, Divisional, Conference
  // Championship, Pro Bowl, Super Bowl - so it needs nothing special.
  NFL: { seasonTypes: [1, 2, 3] },
  // College football's calendar has no preseason segment at all.
  //
  // Its postseason is not a sequence. ESPN files it as two entries that
  // cover the same six weeks: "Bowls" and "CFP". Treated as rounds they
  // would deadlock - both end on the same day, so the second could never
  // come round - and there is nothing to sequence anyway, since the CFP
  // games are a strict subset of the bowls (verified against the
  // completed 2025 season: 11 CFP games, all 11 already in the 46-game
  // bowl list, none unique to it). mergedSeasonTypes collapses them into
  // one round covering both, which also means the CFP is still shown if
  // ESPN ever stops double-listing it.
  //
  // p4OnlyIn lists the season types the P4 filter applies to, which is
  // the regular season and not the postseason. A bowl is a bowl: the
  // filter exists to cut a 99-game September Saturday down to the games
  // worth a row, and a postseason has already done that cutting itself.
  NCAAFB: { seasonTypes: [2, 3], mergedSeasonTypes: [3], p4OnlyIn: [2] }
};

// ACC, Big Ten, Big 12, SEC. Ids come from ESPN's own FBS conference
// list rather than a guess, and membership is read per team per game, so
// realignment needs no change here - Stanford counts as ACC and USC as
// Big Ten because ESPN says so.
//
// The Pac-12 (id 9) is deliberately absent. Its 2026 membership is the
// rebuilt one - Boise State, Fresno State, Texas State, Washington State
// - which is not what Power 4 means.
const P4_CONFERENCE_IDS = new Set(['1', '4', '5', '8']);

// Any game with at least one P4 team in it, not only P4-on-P4. A P4 side
// hosting an FCS opponent is still that side's game that week, and
// dropping it would hide most of September.
//
// This bounds the result tightly: there are exactly 67 P4 teams (ACC 17,
// Big Ten 18, Big 12 16, SEC 16), so a week can never exceed 67 games
// and in practice runs well under, because P4 teams play each other and
// take byes. Measured across 2026: 60 in week 1, 48 in week 3, 28 in
// week 6, 36 in week 12 - against 99, 75, 58 and 70 FBS games.
function involvesP4Team(event) {
  const competitors = (event.competitions || [])[0]?.competitors || [];
  return competitors.some(c => P4_CONFERENCE_IDS.has(String(c.team?.conferenceId ?? '')));
}

// The P4 conferences, by ESPN's own ids. Only the id-to-name mapping
// lives here: which teams are IN a conference comes per team per game
// from ESPN, so realignment never touches this.
//
// Deliberately only these four. Tagging every conference meant a bowl
// round offered eleven chips, most of them one game each, which is a
// worse way to find anything than no filter at all. Everything else is
// left untagged and reachable under All.
const CONFERENCE_NAMES = {
  '1': 'ACC',
  '4': 'Big 12',
  '5': 'Big Ten',
  '8': 'SEC'
};

// The P4 conferences a game belongs to - one per side, deduplicated, so
// an all-P4 conference game yields one entry and a P4 cross-conference
// game two. This is what the watch portal's conference filter reads.
//
// Both sides are tagged rather than just one, because "show me Big Ten
// games" plainly means every game a Big Ten team is in, home or away. A
// game with no P4 team at all is tagged with nothing and shows only
// under All, which is the right answer for a filter offering P4 chips.
function conferencesForEvent(competition) {
  const competitors = competition?.competitors || [];
  const seen = new Map();
  for (const competitor of competitors) {
    const id = String(competitor.team?.conferenceId ?? '');
    const name = CONFERENCE_NAMES[id];
    if (name && !seen.has(id)) seen.set(id, { id, name });
  }
  return [...seen.values()];
}

// A team's position in the poll, or null when it has none.
//
// ESPN reports unranked as curatedRank.current === 99 - a sentinel, not a
// 99th place. Every NFL competitor carries it (confirmed live across a
// full slate), so a truthiness check here would put "#99" beside every
// professional team in the app. The upper bound is 25 because that is how
// far the AP and CFP polls go; anything else is not a ranking.
//
// Written generically rather than as a college-football special case
// precisely because of that sentinel: a league without polls reports 99
// for everyone and so opts itself out, which means no sport is named here
// and there is nothing to keep in sync when a league is added.
function curatedRankOf(competitor) {
  const rank = competitor?.curatedRank?.current;
  return Number.isFinite(rank) && rank >= 1 && rank <= 25 ? rank : null;
}

function withRank(teamName, rank) {
  return rank ? `#${rank} ${teamName}` : teamName;
}

// A competitor's score as a number, or null when there isn't one yet.
//
// ESPN sends scores as strings ("34"), and an empty string before a game
// has started. Null rather than 0 is the whole point: a real 0-0 final
// happens, and a cast would make it indistinguishable from a game nobody
// has played.
function parseTeamScore(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const score = Number(value);
  return Number.isFinite(score) ? score : null;
}

// How long after kickoff a game is assumed finished, when ESPN has not
// said so itself. Only a fallback: `state` is authoritative and present
// on everything ESPN returns. Four hours comfortably covers a football
// game including overtime.
const ASSUME_FINISHED_AFTER_MS = 4 * 60 * 60 * 1000;

// Nearest-first ordering, used for every list of games in the app.
//
//   0  on now
//   1  still to come, soonest first
//   2  finished, most recently first
//
// Plain ascending time was wrong once a list covered more than a day: on
// a Saturday afternoon it led with games that had already finished that
// morning, so the thing you actually wanted was somewhere down the page.
// Sorting purely by distance from now is worse still - it interleaves a
// finished noon game between the 3:30 and the 7:00, which reads as
// broken. Bucketing keeps what is on now at the top, what is next after
// it, and what has just ended within reach at the bottom.
function gamePhase(game, nowMs) {
  if (game.state === 'in') return 0;
  if (game.state === 'post') return 2;
  const start = game.date ? Date.parse(game.date) : NaN;
  if (Number.isFinite(start) && start < nowMs - ASSUME_FINISHED_AFTER_MS) return 2;
  return 1;
}

function compareGamesByRelevance(a, b, nowMs = Date.now()) {
  const phaseA = gamePhase(a, nowMs);
  const phaseB = gamePhase(b, nowMs);
  if (phaseA !== phaseB) return phaseA - phaseB;
  const startA = a.date ? Date.parse(a.date) : Infinity;
  const startB = b.date ? Date.parse(b.date) : Infinity;
  // Finished games run backwards, so the one that just ended is nearest
  // the top of its group rather than the one from three days ago.
  return phaseA === 2 ? startB - startA : startA - startB;
}

function sortGamesByRelevance(games) {
  const now = Date.now();
  return games.sort((a, b) => compareGamesByRelevance(a, b, now));
}

// A date as YYYY-MM-DD in a given timezone. Directly comparable as a
// string, which is the whole point: "has this day passed" is a question
// about calendar days in the user's own zone, not about elapsed hours.
function localDayISO(utcMs, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'America/New_York' })
    .format(new Date(utcMs));
}

// The league's rounds in playing order, plus where ESPN currently thinks
// we are.
//
// Cached for hours because it is a fixture list: the week boundaries for
// a season are set before it starts and do not move. Without this every
// catalog request would spend a round trip re-reading the same schedule.
const seasonCalendarCache = new Map();
const SEASON_CALENDAR_CACHE_MS = 6 * 60 * 60 * 1000;

async function fetchSeasonCalendar(sportKey) {
  const cached = seasonCalendarCache.get(sportKey);
  if (cached && (Date.now() - cached.fetchedAt) < SEASON_CALENDAR_CACHE_MS) return cached.value;

  const endpoint = ESPN_ENDPOINTS[sportKey];
  const config = SEASON_WEEK_LEAGUES[sportKey];
  if (!endpoint || !config) return null;

  try {
    const res = await axios.get(endpoint, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 10000
    });
    const league = res.data?.leagues?.[0] || {};

    // Flattened into one ordered list of rounds, so walking from the
    // preseason into the regular season is the same operation as walking
    // from one week to the next. Segments are taken in the order the
    // league declares them rather than sorted, since that order is the
    // order they are played.
    const rounds = [];
    for (const seasonType of config.seasonTypes) {
      const segment = (league.calendar || []).find(s => Number(s.value) === seasonType);
      if (!segment) continue;
      const entries = segment.entries || [];

      // A round normally maps to one ESPN week. A merged season type maps
      // to all of them at once - see NCAAFB above.
      if ((config.mergedSeasonTypes || []).includes(seasonType)) {
        const weeks = entries.map(e => Number(e.value)).filter(Number.isFinite);
        if (weeks.length > 0) rounds.push({ seasonType, weeks, label: segment.label || 'Postseason' });
        continue;
      }
      for (const entry of entries) {
        const week = Number(entry.value);
        if (Number.isFinite(week)) rounds.push({ seasonType, weeks: [week], label: entry.label || `Week ${week}` });
      }
    }
    if (rounds.length === 0) return null;

    const value = {
      year: res.data?.season?.year || league.season?.year,
      rounds,
      currentType: Number(res.data?.season?.type),
      currentWeek: Number(res.data?.week?.number)
    };
    seasonCalendarCache.set(sportKey, { fetchedAt: Date.now(), value });
    return value;
  } catch (err) {
    console.error(`[ESPN] Failed to fetch the season calendar for ${sportKey}:`, err.message);
    return cached ? cached.value : null;
  }
}

// The raw events of one round. Kept separate from fetchTodayGames
// because resolving which round to show only needs the dates, and the
// result is cached so the chosen round is not fetched twice for one
// request.
const weekEventsCache = new Map();
const WEEK_EVENTS_CACHE_MS = 10 * 60 * 1000;

function seasonWeekQuery(sportKey, year, seasonType, week) {
  // limit stays at 500 - see getNcaaScoreboardParams. Measured: a college
  // week returns 75 games at limit=500 and 25 at limit=1000, so raising
  // it silently truncates.
  return `dates=${year}&seasontype=${seasonType}&week=${week}${getNcaaScoreboardParams(sportKey)}`;
}

// Every event in a round, across all the ESPN weeks it spans, deduplicated
// by event id - a merged round asks for two overlapping lists on purpose,
// so the same game arriving twice is expected rather than a fault.
async function fetchSeasonWeekEvents(sportKey, year, seasonType, weeks) {
  const key = `${sportKey}:${year}:${seasonType}:${weeks.join(',')}`;
  const cached = weekEventsCache.get(key);
  if (cached && (Date.now() - cached.fetchedAt) < WEEK_EVENTS_CACHE_MS) return cached.events;

  const endpoint = ESPN_ENDPOINTS[sportKey];
  if (!endpoint) return [];
  try {
    const responses = await Promise.all(weeks.map(week => axios.get(
      `${endpoint}?${seasonWeekQuery(sportKey, year, seasonType, week)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, timeout: 15000 }
    )));
    const seen = new Set();
    const events = [];
    for (const res of responses) {
      for (const event of res.data?.events || []) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        events.push(event);
      }
    }
    weekEventsCache.set(key, { fetchedAt: Date.now(), events });
    return events;
  } catch (err) {
    console.error(`[ESPN] Failed to fetch ${sportKey} type ${seasonType} week(s) ${weeks.join(',')}:`, err.message);
    return cached ? cached.events : [];
  }
}

// Where in the round list to begin looking.
//
// Normally ESPN's own pointer, which makes this one lookup rather than a
// scan from the start of the season. When that pointer sits outside the
// rounds this league shows - the postseason, say, or the off season -
// the answer depends on which side it falls: before them, start at the
// first; after them, there is nothing left to show this season.
function findStartingRound(rounds, currentType, currentWeek) {
  // Matched against the round's week LIST, not a single week: a merged
  // round covers several. Getting this wrong does not fail loudly - it
  // silently falls through to the next branch and starts at the wrong
  // round, which is how an in-season league briefly began answering with
  // its postseason.
  const exact = rounds.findIndex(r =>
    r.seasonType === currentType && (r.weeks || []).includes(currentWeek));
  if (exact !== -1) return exact;
  if (!Number.isFinite(currentType)) return 0;
  const types = rounds.map(r => r.seasonType);
  if (currentType < Math.min(...types)) return 0;
  if (currentType > Math.max(...types)) return -1;
  // The right type but an unrecognised week within it - start at that
  // type's first round and let the date walk sort it out, rather than
  // skipping the type entirely.
  const sameType = rounds.findIndex(r => r.seasonType === currentType);
  if (sameType !== -1) return sameType;
  // A type this league skips: the next round it does show is the first
  // one of a later type.
  const next = rounds.findIndex(r => r.seasonType > currentType);
  return next === -1 ? -1 : next;
}

// Which round to show, or null when there is none left this season.
async function resolveSeasonWeek(sportKey, userTimeZone) {
  const calendar = await fetchSeasonCalendar(sportKey);
  if (!calendar) return null;

  let index = findStartingRound(calendar.rounds, calendar.currentType, calendar.currentWeek);
  if (index === -1) return null;

  const today = localDayISO(Date.now(), userTimeZone);

  for (; index < calendar.rounds.length; index++) {
    const round = calendar.rounds[index];
    const events = await fetchSeasonWeekEvents(sportKey, calendar.year, round.seasonType, round.weeks);
    if (events.length === 0) continue;
    const lastDay = events
      .map(e => localDayISO(Date.parse(e.date), userTimeZone))
      .sort()
      .pop();
    // Still the current round right up to and including the day of its
    // final game. Only the day after does the next one take over.
    if (today <= lastDay) return { year: calendar.year, ...round, events };
  }
  return null;
}

// One whole round's games, soonest first.
async function fetchSeasonWeekGames(sport, hostUrl, userTimeZone) {
  const sportKey = sport.toUpperCase();
  const resolved = await resolveSeasonWeek(sportKey, userTimeZone);
  if (!resolved) {
    console.log(`[ESPN] ${sportKey}: no round left to show this season`);
    return [];
  }

  const config = SEASON_WEEK_LEAGUES[sportKey] || {};
  const p4Applies = (config.p4OnlyIn || []).includes(resolved.seasonType);
  const games = await fetchTodayGames(sport, hostUrl, userTimeZone, {
    queries: resolved.weeks.map(week => seasonWeekQuery(sportKey, resolved.year, resolved.seasonType, week)),
    eventFilter: p4Applies ? involvesP4Team : null
  });

  console.log(`[ESPN] ${sportKey} ${resolved.label}: ${resolved.events.length} scheduled -> ${games.length} shown`);
  return sortGamesByRelevance(games);
}

// `options.queries` replaces the default single-day filter, which is how
// the season-week leagues ask for a whole round instead. It is a list
// because one round can span several ESPN weeks; results are merged and
// deduplicated by event id. Each query carries its own league params, so
// nothing is appended here.
//
// `options.eventFilter` drops events before they are mapped, which is
// where the college P4 filter runs - it needs each team's conference id,
// and that only exists on the raw ESPN event.
async function fetchTodayGames(sport, hostUrl, userTimeZone = 'America/New_York', options = {}) {
  const endpoint = ESPN_ENDPOINTS[sport.toUpperCase()];
  if (!endpoint) return [];

  try {
    const queries = options.queries
      || [`dates=${getLocalDateString(userTimeZone)}${getNcaaScoreboardParams(sport)}`];
    const responses = await Promise.all(queries.map(query => axios.get(`${endpoint}?${query}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 15000
    })));

    const seen = new Set();
    const allEvents = [];
    for (const res of responses) {
      for (const event of res.data?.events || []) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        allEvents.push(event);
      }
    }
    const events = options.eventFilter ? allEvents.filter(options.eventFilter) : allEvents;

    // Callers that fetch a whole round sort the result themselves; this
    // covers the day-at-a-time leagues, which took ESPN's order as given.
    return sortGamesByRelevance(events.map(event => {
      const competition = event.competitions?.[0] || {};
      const competitors = competition.competitors || [];

      const home = competitors.find(c => c.homeAway === 'home') || {};
      const away = competitors.find(c => c.homeAway === 'away') || {};

      const homeTeam = home.team || {};
      const awayTeam = away.team || {};

      const homeId = homeTeam.id || '0';
      const awayId = awayTeam.id || '0';

      const homeNick = homeTeam.name || homeTeam.shortDisplayName || homeTeam.displayName || 'Home';
      const awayNick = awayTeam.name || awayTeam.shortDisplayName || awayTeam.displayName || 'Away';
      
      const homeFull = homeTeam.displayName || 'Home';
      const awayFull = awayTeam.displayName || 'Away';

      const homeLogoUrl = homeTeam.logo || '';
      const awayLogoUrl = awayTeam.logo || '';
      const homeColor = homeTeam.color || '';
      const awayColor = awayTeam.color || '';
      const homeAltColor = homeTeam.alternateColor || '';
      const awayAltColor = awayTeam.alternateColor || '';
      const homeAbbr = homeTeam.abbreviation || '';
      const awayAbbr = awayTeam.abbreviation || '';

      // Flattened, deduplicated list of every broadcast name ESPN lists for
      // this game across all markets (national/home/away) - a match against
      // any of these counts, per how broadcast rights actually work (a
      // single national feed can carry the game on multiple channels at
      // once, e.g. ["MLB.TV", "FS1"]).
      const broadcastNames = [...new Set(
        (competition.broadcasts || []).flatMap(b => b.names || [])
      )];

      // National-only, type-aware view of the same data, plus the network
      // slot it resolves to. Kept separate from broadcastNames above
      // rather than replacing it: that field mixes in local affiliates,
      // which is wrong for picking a channel but is exactly the broad
      // net the tier system would want if broadcast matching is ever
      // revisited there. `network` is null for streaming-only games and
      // for networks with no slot defined - both mean "use the tiers".
      const { nationalBroadcasts, network } = networks.resolveNetworkFromCompetition(competition);

      const gameUtcDate = event.date || '';
      const artParams = new URLSearchParams({
        home: homeFull,
        away: awayFull,
        homeLogoUrl,
        awayLogoUrl,
        homeColor,
        awayColor,
        homeAltColor,
        awayAltColor,
        homeAbbr,
        awayAbbr
      }).toString();
      const dateParam = gameUtcDate
        ? `?date=${encodeURIComponent(gameUtcDate)}&tz=${encodeURIComponent(userTimeZone)}&${artParams}`
        : `?tz=${encodeURIComponent(userTimeZone)}&${artParams}`;

      const poster = `${hostUrl}/poster/${sport.toLowerCase()}/${homeId}/${awayId}.svg${dateParam}`;
      const background = `${hostUrl}/landscape/${sport.toLowerCase()}/${homeId}/${awayId}.svg${dateParam}`;
      const logo = `${hostUrl}/logo/${sport.toLowerCase()}.svg`;

      const homeWinLoss = home.records?.[0]?.summary || '0-0';
      const awayWinLoss = away.records?.[0]?.summary || '0-0';
      const statusDetail = event.status?.type?.detail || 'Scheduled';

      // The matchup name, with poll positions where they exist.
      //
      // Rebuilt from the competitors ONLY when a rank actually applies, so
      // every unranked game keeps ESPN's own string untouched. That is
      // safe to do: across 113 sampled NFL and college games - regular
      // season and bowls, neutral sites included, which ESPN still writes
      // with "at" rather than "vs" - event.name was exactly
      // "{away displayName} at {home displayName}" every time. The rebuilt
      // form is that same sentence with the ranks added.
      const homeRank = curatedRankOf(home);
      const awayRank = curatedRankOf(away);
      const displayName = (homeRank || awayRank)
        ? `${withRank(awayFull, awayRank)} at ${withRank(homeFull, homeRank)}`
        : (event.name || `${awayFull} vs ${homeFull}`);

      // The final score, away team first so it reads in the same order as
      // the name above it.
      //
      // FINAL ONLY, deliberately. The score of a game in progress is right
      // there in the same payload, but it would be served from a cache up
      // to WEEK_EVENTS_CACHE_MS old - and a ten-minute-stale score
      // presented as the live one is worse than showing no score at all.
      //
      // ESPN's own `completed` flag decides, not the 'post' state: state
      // turns over slightly ahead of the final whistle on some feeds,
      // while `completed` is the league's verdict that the game is done.
      const homeScore = parseTeamScore(home.score);
      const awayScore = parseTeamScore(away.score);
      const finalScore = (event.status?.type?.completed === true && homeScore !== null && awayScore !== null)
        ? `${awayAbbr || awayNick} ${awayScore}, ${homeAbbr || homeNick} ${homeScore}`
        : '';

      const venueName = competition.venue?.fullName || 'the arena';

      let formattedTime = 'TBD';
      let formattedDate = '';
      if (gameUtcDate) {
        formattedTime = formatTeamTime(gameUtcDate, userTimeZone) || 'TBD';
        formattedDate = formatReadableDate(gameUtcDate, userTimeZone) || '';
      }

      const line1 = `${awayNick.toUpperCase()} VS. ${homeNick.toUpperCase()}`;
      const line2 = [formattedDate, venueName, formattedTime].filter(Boolean).join('    ');

      // Home/road split, matched by explicit type rather than array index -
      // already present in the same records array used for the overall
      // record above, so this is free (no extra API call). Folded into the
      // same sentence as the overall record (rather than a separate one)
      // so it doesn't read as two back-to-back sentences both starting
      // with the same team name. Only added if both splits are actually
      // present, so a missing/unusual records shape just falls back to the
      // plain overall-record sentence.
      const homeSplit = home.records?.find(r => r.type === 'home')?.summary;
      const awaySplit = away.records?.find(r => r.type === 'road')?.summary;
      let line3 = (homeSplit && awaySplit)
        ? `${homeNick} enter the matchup at ${homeWinLoss} on the season (${homeSplit} at home), while ${awayNick} come in at ${awayWinLoss} (${awaySplit} on the road).`
        : `${homeNick} enter the matchup at ${homeWinLoss} on the season, while ${awayNick} come in at ${awayWinLoss}.`;

      // Statistical leaders, using whichever categories the sport's own API
      // naturally provides (passing/rushing/receiving for football, points
      // for basketball, etc.) rather than hard-coded per-sport categories,
      // so this works uniformly across every sport without special-casing.
      // Capped at the first 2 categories to stay bite-size. Silently
      // omitted entirely if the game hasn't started and leaders aren't
      // populated yet, or the athlete/team can't be resolved - no partial
      // or malformed sentences.
      const leaderLines = (competition.leaders || []).slice(0, 2).map(category => {
        const top = category.leaders?.[0];
        const athleteName = top?.athlete?.displayName;
        const statLine = top?.displayValue;
        const leaderTeamId = top?.team?.id;
        if (!athleteName || !statLine || !leaderTeamId) return null;
        const teamShortName = leaderTeamId === homeTeam.id ? homeNick : (leaderTeamId === awayTeam.id ? awayNick : null);
        if (!teamShortName) return null;
        const categoryLabel = (category.displayName || category.shortDisplayName || 'stat leader').replace(/\s*leader\s*$/i, '').toLowerCase();
        return `${athleteName} leads in ${categoryLabel} for ${teamShortName} (${statLine})`;
      }).filter(Boolean);

      if (leaderLines.length > 0) {
        line3 += ` ${leaderLines.join('; ')}.`;
      }

      // The final score gets its own line between the matchup and the
      // prose, where someone looking for it does not have to read a
      // sentence to find it. Dropped entirely before a game is over, which
      // leaves the description exactly as it was.
      const description = [
        line1,
        line2,
        ...(finalScore ? [`FINAL    ${finalScore}`] : []),
        '',
        line3
      ].join('\n');

      // The same two fields MMA produces, so the watch portal can label
      // every card the same way regardless of sport - which is the whole
      // point of them living under the poster rather than on it. These
      // games are today by definition (fetchTodayGames filters to the
      // user's local day), but isToday is computed rather than hardcoded
      // true so it stays honest if that ever changes.
      const whenLabel = formatEventWhen(gameUtcDate, userTimeZone);

      return {
        id: String(event.id),
        name: displayName,
        homeTeam: homeTeam.displayName || '',
        awayTeam: awayTeam.displayName || '',
        // Just the nickname (e.g. "Suns"), not the full "Phoenix Suns" -
        // needed for tier 4's city/state exclusion rule in stream ranking.
        homeNick,
        awayNick,
        homeAbbr,
        awayAbbr,
        broadcastNames,
        nationalBroadcasts,
        network,
        poster,
        background,
        logo,
        description,
        status: statusDetail,
        // Pre-formatted rather than sent as two numbers, because the
        // abbreviation-to-nickname fallback belongs with the data that
        // needs it - not repeated in every client that renders a card.
        // '' means "not over yet", which is what the watch portal keys off.
        finalScore,
        // ESPN's own verdict on whether a game is upcoming, on now, or
        // over: 'pre', 'in' or 'post'. Used for ordering.
        state: event.status?.type?.state || '',
        date: event.date,
        whenLabel,
        isToday: isSameLocalDay(gameUtcDate, userTimeZone),
        // Empty for leagues without conferences, which is what the watch
        // portal keys off to decide whether to offer the filter at all.
        conferences: conferencesForEvent(competition)
      };
    }));
  } catch (err) {
    console.error(`[ESPN] Error fetching scoreboard for ${sport}:`, err.message);
    return [];
  }
}

// MMA events don't map to a single matchup the way every other sport here
// does - one ESPN "event" is a whole fight card of many individual
// fights. This identifies the main event specifically (confirmed live
// against real data: the Core API's matchNumber field marks it as
// matchNumber: 1, corroborated independently by cardSegment and the
// 5-round format used only for main events/title fights) and builds a
// single game-equivalent object around that one fight - that's what
// people will actually recognize the event by when browsing posters.
// Deliberately reuses the homeTeam/awayTeam/homeAbbr/awayAbbr field names
// from fetchTodayGames, even though "home"/"away" isn't semantically
// accurate for two fighters - this lets the existing stream-matching tier
// system and poster route work without needing MMA-specific branches.
//
// Identifying the main event is not cosmetic here. Confirmed live on the
// PFL card: the scoreboard's first-listed competition is "TBA vs
// Opponent TBA", and only the Core API's matchNumber picks out the real
// headline fight the event is actually named after.
//
// One league per call. fetchTodayMmaEvents below fans this out across
// every promotion in MMA_LEAGUES.
async function fetchTodayLeagueEvents(league, hostUrl, userTimeZone = 'America/New_York') {
  const endpoint = ESPN_ENDPOINTS[league.key];
  const coreEndpoint = ESPN_CORE_EVENT_ENDPOINTS[league.key];
  if (!endpoint || !coreEndpoint) return [];
  try {
    // An explicit range is required, not optional. Left unfiltered,
    // ESPN's scoreboard was confirmed live to return the NEXT upcoming
    // event regardless of how far away it is - so "no dates parameter"
    // does not mean "everything", it means "one arbitrary event".
    //
    // The window starts today rather than at this moment, so a card that
    // began a couple of hours ago is still listed. It is very much still
    // watchable, and dropping it the instant it starts would be the
    // opposite of useful.
    const fromDateStr = getLocalDateString(userTimeZone);
    const toDateStr = addDaysToDateString(fromDateStr, MMA_SCHEDULE_DAYS);
    const res = await axios.get(`${endpoint}?dates=${fromDateStr}-${toDateStr}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 10000
    });
    const events = res.data?.events || [];

    const games = await Promise.all(events.map(async (event) => {
      // The scoreboard's own competitions array doesn't reliably identify
      // the main event on its own (several fights can share the same
      // broadcast-segment start time), so the Core API's per-event
      // endpoint is fetched specifically for its matchNumber field.
      let mainCompetitionId = null;
      try {
        const coreRes = await axios.get(`${coreEndpoint}/${event.id}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
          timeout: 10000
        });
        const competitions = coreRes.data?.competitions || [];
        const mainCompetition = competitions.find(c => c.matchNumber === 1);
        mainCompetitionId = mainCompetition ? mainCompetition.id : null;
      } catch (err) {
        console.error(`[ESPN] Failed to fetch Core API event data for ${league.key} event ${event.id}:`, err.message);
      }

      // Falls back to the scoreboard's own first-listed competition if the
      // Core API call fails or matchNumber isn't found, so a partial
      // outage doesn't drop the whole event - just loses main-event
      // precision for that one event specifically.
      const competition = (mainCompetitionId && event.competitions?.find(c => c.id === mainCompetitionId))
        || event.competitions?.[0];
      if (!competition) return null;

      const [competitorA, competitorB] = competition.competitors || [];
      if (!competitorA || !competitorB) return null;

      const fighterAName = competitorA.athlete?.displayName || 'Fighter A';
      const fighterBName = competitorB.athlete?.displayName || 'Fighter B';
      const fighterAId = competitorA.athlete?.id || competitorA.id || '';
      const fighterBId = competitorB.athlete?.id || competitorB.id || '';
      const fighterAFlagUrl = competitorA.athlete?.flag?.href || '';
      const fighterBFlagUrl = competitorB.athlete?.flag?.href || '';

      const broadcastNames = [...new Set(
        (competition.broadcasts || []).flatMap(b => b.names || [])
      )];

      // UFC resolves a network the same way every other sport does, even
      // though its answer is usually a streaming service (Paramount+ for
      // Fight Nights, confirmed live) and therefore usually null. That's
      // fine: UFC combines links with tiers rather than replacing them,
      // so a null network costs nothing here.
      const { nationalBroadcasts, network } = networks.resolveNetworkFromCompetition(competition);

      // `name` is what the poster prints now. home/away/flags stay for the
      // landscape background, which still composites the two fighters.
      const artParams = new URLSearchParams({
        name: event.name || `${fighterAName} vs ${fighterBName}`,
        home: fighterAName,
        away: fighterBName,
        homeFlagUrl: fighterAFlagUrl,
        awayFlagUrl: fighterBFlagUrl
      }).toString();
      const eventUtcDate = competition.date || event.date || '';
      // No timezone in the artwork URL. It was added when the poster
      // printed a date, which is far more timezone-sensitive than a time;
      // with the timestamp gone the artwork is identical for every
      // viewer, and passing a tz would only fragment the cache. `date`
      // stays purely as a cache key, so artwork re-renders if an event
      // gets rescheduled.
      const dateParam = eventUtcDate
        ? `?date=${encodeURIComponent(eventUtcDate)}&${artParams}`
        : `?${artParams}`;

      // League-scoped artwork paths, so a PFL card carries the PFL logo
      // on its poster and its own colours on the landscape background
      // rather than inheriting UFC's.
      //
      // A promotion may override which league's artwork is used. This is
      // for events ESPN files under its catch-all, whose artwork is a
      // generic ESPN icon: "PFL Africa" is recognisably PFL and should
      // look it, even though ESPN does not file it under the PFL league.
      // Channels and artwork are resolved from the same promotion, so a
      // card cannot show one promotion and play another's.
      const artworkPromotion = networks.getPromotionForEvent('UFC', event.name || '', league.key);
      const artworkSlug = (artworkPromotion && artworkPromotion.artworkKey)
        ? ESPN_LEAGUES[artworkPromotion.artworkKey] || league.slug
        : league.slug;
      const leagueSlug = artworkSlug;
      const whenLabel = formatEventWhen(eventUtcDate, userTimeZone);

      const poster = `${hostUrl}/poster/mma/${leagueSlug}.svg${dateParam}`;
      const background = `${hostUrl}/landscape/mma/${leagueSlug}/${fighterAId}/${fighterBId}.svg${dateParam}`;
      const logo = `${hostUrl}/logo/${leagueSlug}.svg`;

      return {
        id: String(event.id),
        // The promotion this event came from. The stream route needs it
        // to pick the right channels: ESPN's own league is the strongest
        // signal available, and far better than guessing from the name.
        league: league.key,
        name: event.name || `${fighterAName} vs ${fighterBName}`,
        homeTeam: fighterAName,
        awayTeam: fighterBName,
        homeNick: fighterAName,
        awayNick: fighterBName,
        homeAbbr: '',
        awayAbbr: '',
        broadcastNames,
        nationalBroadcasts,
        network,
        poster,
        background,
        logo,
        // Prefixed with when it is on. The section now spans months, so
        // "which of these is tonight" is the first thing anyone needs
        // from a card, and the description is the one field every client
        // renders as text.
        description: whenLabel
          ? `${whenLabel}\n\n${event.name || `${fighterAName} vs ${fighterBName}`}`
          : (event.name || `${fighterAName} vs ${fighterBName}`),
        status: competition.status?.type?.shortDetail || '',
        state: competition.status?.type?.state || event.status?.type?.state || '',
        date: eventUtcDate,
        // Presentation fields, computed here because this is where the
        // user's timezone is in hand.
        whenLabel,
        isToday: isSameLocalDay(eventUtcDate, userTimeZone)
      };
    }));

    return games.filter(Boolean);
  } catch (err) {
    console.error(`[ESPN] Error fetching ${league.key} scoreboard:`, err.message);
    return [];
  }
}

// Every MMA promotion's events for the user's current local day, pooled
// into one list.
//
// Fanned out in parallel rather than in sequence: these are independent
// endpoints, and a section covering a dozen promotions should not take a
// dozen round trips' worth of waiting.
//
// allSettled, not all: one promotion's endpoint failing must not empty
// the whole section. A failure is already logged by the fetcher itself
// and simply contributes no events.
async function fetchTodayMmaEvents(hostUrl, userTimeZone = 'America/New_York') {
  const results = await Promise.allSettled(
    MMA_LEAGUES.map(league => fetchTodayLeagueEvents(league, hostUrl, userTimeZone))
  );
  const events = results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));

  // Nearest first. Without this the list arrives grouped by promotion -
  // every UFC card, then every PFL one - which for a months-long window
  // buries tonight's event somewhere in the middle.
  return sortGamesByRelevance(events);
}

// Single entry point used by the catalog, meta, and stream routes -
// branches to sport-specific fetchers with a fundamentally different data
// shape than fetchTodayGames (e.g. UFC: one event is a whole fight card,
// not a single matchup) rather than having each of the three call sites
// duplicate this branching logic themselves.
//
// CORE REQUIREMENT, NOT OPTIONAL: every branch here must filter results
// by an EXPLICIT date range built from the user's own timeZone. Never
// call a scoreboard endpoint unfiltered: ESPN does not return "today" by
// default for a sparse, non-daily sport - it was confirmed live to return
// the next upcoming event regardless of how far away it is, so an
// unfiltered call silently presents a card three weeks out as tonight's.
//
// What that range should be differs by sport, and the distinction is
// about the sport, not about convenience. There are three answers:
//
//   Daily leagues (NBA, MLB, NHL) - the user's current local day and
//   nothing else. "What is on today" is the entire question.
//
//   Season-week leagues (NFL, college football) - one whole ESPN round,
//   the current one, preseason included where the league has one. A
//   league that plays a single round a week is empty six days in seven
//   under a day filter, and the round is the unit people actually think
//   in. See SEASON_WEEK_LEAGUES.
//
//   MMA - a forward window of MMA_SCHEDULE_DAYS. A promotion runs a card
//   every week or two, so even a week is usually empty.
//
// The hazard the original of this comment warned about - a future game
// looking like tonight's - is handled directly rather than by hiding the
// schedule: every game carries its own date, in the description and on
// the card in the watch portal, and isToday marks the ones actually on
// now, which is what Home filters by.
//
// A new sport added here needs a deliberate answer to which of the three
// it is. Do not assume.
async function fetchGamesForSport(sport, hostUrl, userTimeZone = 'America/New_York') {
  if (sport === 'UFC') {
    return fetchTodayMmaEvents(hostUrl, userTimeZone);
  }
  if (SEASON_WEEK_LEAGUES[sport.toUpperCase()]) {
    return fetchSeasonWeekGames(sport, hostUrl, userTimeZone);
  }
  return fetchTodayGames(sport, hostUrl, userTimeZone);
}

async function fetchXtreamCategories(user) {
  const { url, username, password } = user.xtream;
  const baseUrl = url.replace(/\/+$/, '');
  const apiUrl = `${baseUrl}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_live_categories`;
  try {
    const res = await axios.get(apiUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 10000
    });
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    console.error('[Xtream] Failed to fetch categories for stream naming:', err.message);
    return [];
  }
}

// Builds a category_id -> category_name lookup, then returns a function that
// resolves a given stream's folder name (handling both the older single
// category_id field and the newer category_ids array some providers use).
function buildCategoryNameLookup(categories) {
  const byId = {};
  categories.forEach(c => {
    byId[String(c.category_id)] = c.category_name;
  });

  return (stream) => {
    const catId = stream.category_id ?? stream.category_ids?.[0];
    return byId[String(catId)] || 'Live TV';
  };
}

async function fetchXtreamLiveStreams(user, categoryIds = []) {
  if (!categoryIds || categoryIds.length === 0) return [];
  const { url, username, password } = user.xtream;
  const baseUrl = url.replace(/\/+$/, '');

  let allStreams = [];
  for (const catId of categoryIds) {
    const apiUrl = `${baseUrl}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_live_streams&category_id=${catId}`;
    try {
      const res = await axios.get(apiUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 8000
      });
      if (Array.isArray(res.data)) {
        allStreams = allStreams.concat(res.data);
      }
    } catch (e) {
      console.error(`[Xtream] Failed to fetch category ${catId}:`, e.message);
    }
  }
  return allStreams;
}

// Every live channel the Xtream account can see, in one request.
//
// fetchXtreamLiveStreams above deliberately refuses an empty category
// list, so that a missing configuration can never turn into an accidental
// full-service fetch. This is the case where a full-service fetch is the
// point: an automatic search with no group filter is asking about the
// whole service by definition. Omitting category_id is how Xtream serves
// that - one response, not one request per category.
async function fetchAllXtreamLiveStreams(user) {
  const { url, username, password } = user.xtream;
  const baseUrl = url.replace(/\/+$/, '');
  const apiUrl = `${baseUrl}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_live_streams`;
  try {
    const res = await axios.get(apiUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 15000
    });
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    console.error('[Xtream] Failed to fetch the full live stream list:', err.message);
    return [];
  }
}

// Every Xtream stream URL in the app is built here, and the extension is
// the reason it is worth having one place.
//
// Xtream Codes serves a live stream two ways: .m3u8 (HLS) and .ts (raw
// MPEG-TS). Both are standard and this app has always asked for .m3u8,
// but HLS output is the one providers commonly leave disabled or serve
// badly - and the failure is silent in exactly the way that is hardest
// to read. The player launches, connects, gets nothing playable, and
// sits there looking like the app handed it an empty address.
//
// So it is per account rather than per instance: it describes the
// provider, and every account here brings its own. Defaults to m3u8, so
// nothing changes for anyone already working.
const XTREAM_STREAM_FORMATS = ['m3u8', 'ts'];

function xtreamStreamFormat(user) {
  const configured = user && user.xtream && user.xtream.streamFormat;
  return XTREAM_STREAM_FORMATS.includes(configured) ? configured : 'm3u8';
}

function buildXtreamStreamUrl(user, streamId) {
  const baseUrl = user.xtream.url.replace(/\/+$/, '');
  const ext = xtreamStreamFormat(user);
  return `${baseUrl}/live/${encodeURIComponent(user.xtream.username)}/${encodeURIComponent(user.xtream.password)}/${streamId}.${ext}`;
}

// ---------------------------------------------------------------------
// Xtream channel source
// ---------------------------------------------------------------------
//
// The network picker, channel search, saved channels and the quality
// probe were all M3U-only for one reason: they take a parsed playlist,
// and an Xtream account has none. They do not actually need a playlist
// though - they need a list of channels, and Xtream can produce one.
//
// So this builds the same { channels, categoryList } an M3U parse
// produces, from the same two calls fetchAutoSearchChannels already
// makes, and every one of those features then runs the identical code
// for both connection types rather than growing a second implementation.
//
// Channels carry a streamId here, which M3U channels do not. That is
// what lets a saved link be stored as { type: 'xtream', streamId } and
// have its URL rebuilt from credentials at request time - so rotating an
// Xtream password does not strand every configured channel.
const XTREAM_SOURCE_TTL_MS = 30 * 60 * 1000;

// Keyed by service + account, never by password - two accounts on one
// provider genuinely see different channel lists, and the key has no
// business carrying a secret.
// What is cached is the provider's own answer - the raw stream and
// category lists - and NOT the channel objects built from it. Those carry
// a streamUrl with the account password in its path, so caching them
// would serve URLs built from the old password for the rest of the TTL
// after a rotation: suggestions handing out dead links, and the probe
// rejecting good ones because the URL no longer matched anything in the
// list it was checking against. Rebuilding per request costs a few
// thousand string joins and is always right.
const xtreamSourceCache = new Map();   // key -> { streams, categories, fetchedAt }
const xtreamSourceInFlight = new Map(); // key -> Promise

function xtreamCacheKey(user) {
  const baseUrl = String(user.xtream.url || '').replace(/\/+$/, '');
  return `${baseUrl}|${user.xtream.username}`;
}

async function fetchXtreamCatalog(user) {
  const [categories, streams] = await Promise.all([
    fetchXtreamCategories(user),
    fetchAllXtreamLiveStreams(user)
  ]);
  return { categories, streams, fetchedAt: Date.now() };
}

function buildXtreamChannelSource(user, catalog) {
  const { categories, streams } = catalog;

  const getCategoryName = buildCategoryNameLookup(categories);
  const channels = streams.map(s => ({
    // epg_channel_id is Xtream's equivalent of tvg-id, and carries the
    // same shared EPG naming ("espn.us"), which is what the network
    // matcher and the link healer both key off.
    id: s.epg_channel_id || '',
    name: s.name || '',
    logo: s.stream_icon || '',
    streamId: String(s.stream_id),
    streamUrl: buildXtreamStreamUrl(user, s.stream_id),
    categories: [getCategoryName(s)]
  })).filter(c => c.name && c.streamId);

  const counts = new Map();
  for (const channel of channels) {
    for (const category of channel.categories) {
      counts.set(category, (counts.get(category) || 0) + 1);
    }
  }

  return {
    channels,
    categoryList: [...counts.entries()]
      .map(([name, channelCount]) => ({ name, channelCount }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    fetchedAt: catalog.fetchedAt
  };
}

// Cached, because unlike an M3U playlist - parsed once on a schedule and
// held in memory - every one of these is a live round trip to the
// provider. The dashboard alone fires /suggest and /status together on
// load, so without the in-flight map below one page view would fetch the
// entire service twice, in parallel, for no gain.
async function getXtreamChannelSource(user) {
  if (!user.xtream || !user.xtream.url) return null;
  const key = xtreamCacheKey(user);

  const cached = xtreamSourceCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < XTREAM_SOURCE_TTL_MS) {
    return buildXtreamChannelSource(user, cached);
  }

  // Deduplicated, not just cached. The dashboard fires /suggest and
  // /status together on load, so on a cold cache both would otherwise
  // pull the entire service down in parallel for one page view.
  const inFlight = xtreamSourceInFlight.get(key);
  const pending = inFlight || (async () => {
    try {
      const catalog = await fetchXtreamCatalog(user);
      // An empty list means the provider answered with nothing useful -
      // down, rate limiting, credentials rejected. Serving that as the
      // truth would empty the picker and read as "your channels are
      // gone", so a previous good answer is kept instead.
      if (catalog.streams.length === 0 && cached) {
        console.error('[Xtream] Live stream list came back empty; keeping the previous one.');
        return cached;
      }
      xtreamSourceCache.set(key, catalog);
      console.log(`[Xtream] Catalog fetched: ${catalog.streams.length} stream(s), ${catalog.categories.length} category(ies)`);
      return catalog;
    } catch (err) {
      console.error('[Xtream] Failed to fetch the catalog:', err.message);
      return cached || null;
    } finally {
      xtreamSourceInFlight.delete(key);
    }
  })();

  if (!inFlight) xtreamSourceInFlight.set(key, pending);

  const catalog = await pending;
  return catalog ? buildXtreamChannelSource(user, catalog) : null;
}

// Runs a sport's standing search (networks.AUTO_SEARCH) against whichever
// source the account uses, returning { name, url, group } matches.
//
// The two connection types reach the same channel list very differently.
// An M3U account already has the entire playlist parsed and cached, so
// this is a filter over memory and costs nothing. An Xtream account has
// no such list, so the search's own group filter is reused to decide
// which categories to ask for - which for UFC means one small request
// covering the Paramount+ PPV group, rather than pulling the whole
// service down to find a handful of channels in it.
async function fetchAutoSearchChannels(user, config, m3uSource) {
  if (!config) return [];

  if (user.connectionType === 'm3u') {
    return networks.autoSearchChannels(m3uSource?.channels || [], config);
  }

  if (!user.xtream || !user.xtream.url) return [];

  const categories = await fetchXtreamCategories(user);
  const hasGroupFilter = Array.isArray(config.groups) && config.groups.length > 0;

  let streams;
  if (hasGroupFilter) {
    const wantedIds = categories
      .filter(c => networks.groupMatchesAny([c.category_name], config.groups))
      .map(c => String(c.category_id));
    // No category matched the filter at all. Deliberately returns nothing
    // rather than falling back to a full-service search: the filter exists
    // precisely to keep unrelated channels out, so ignoring it when it
    // matches nothing would produce exactly the results it was written to
    // prevent.
    if (wantedIds.length === 0) return [];
    streams = await fetchXtreamLiveStreams(user, wantedIds);
  } else {
    streams = await fetchAllXtreamLiveStreams(user);
  }

  // Normalised into the M3U parser's own channel shape, so the matching
  // itself has one implementation shared by both connection types.
  const getCategoryName = buildCategoryNameLookup(categories);
  const channels = streams.map(s => ({
    name: s.name,
    streamUrl: buildXtreamStreamUrl(user, s.stream_id),
    categories: [getCategoryName(s)]
  }));

  return networks.autoSearchChannels(channels, config);
}

app.post('/api/xtream/categories', async (req, res) => {
  const { url, username, password } = req.body;
  if (!url || !username || !password) return res.status(400).json({ error: 'Missing credentials' });

  const baseUrl = url.replace(/\/+$/, '');
  const apiUrl = `${baseUrl}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=get_live_categories`;

  try {
    const response = await axios.get(apiUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 10000
    });
    if (Array.isArray(response.data)) {
      return res.json({ success: true, categories: response.data });
    }
    console.error(`[Xtream] get_live_categories for ${baseUrl} returned non-array data:`, JSON.stringify(response.data).slice(0, 300));
    return res.status(401).json({ error: 'Invalid Xtream credentials.' });
  } catch (err) {
    const status = err.response?.status;
    const code = err.code;
    console.error(`[Xtream] Failed to fetch categories from ${baseUrl}. HTTP status: ${status || 'n/a'}, error code: ${code || 'n/a'}, message: ${err.message}`);
    return res.status(500).json({ error: 'Unable to connect to IPTV server.' });
  }
});

// M3U's equivalent of /api/xtream/categories above - the wizard calls this
// once, with both URLs, showing "Importing. Please wait." while it runs.
// Unlike Xtream there's no separate auth to test - this fetch+parse IS the
// test. On success, also seeds the shared source cache immediately (rather
// than waiting for the next scheduled background refresh), so the very
// first user of a brand-new source doesn't hit an empty cache right after
// finishing setup.
app.post('/api/m3u/import', async (req, res) => {
  const { playlistUrl, epgUrl } = req.body;
  if (!playlistUrl || !epgUrl) {
    return res.status(400).json({ error: 'Both a playlist URL and an EPG URL are required.' });
  }

  try {
    const parsed = await m3u.refreshM3USource(playlistUrl, epgUrl);
    return res.json({ success: true, categories: parsed.categoryList });
  } catch (err) {
    console.error(`[M3U] Failed to import from playlistUrl=${playlistUrl}, epgUrl=${epgUrl}:`, err.message);
    // Distinguish which URL was the problem where possible, so the wizard
    // can point the user at the right one rather than a generic failure.
    if (err.playlistFailed && err.epgFailed) {
      return res.status(400).json({ error: 'Both URLs failed to load. Please double-check them.', playlistFailed: true, epgFailed: true });
    }
    if (err.playlistFailed) {
      return res.status(400).json({ error: 'The playlist URL failed to load or contained no usable channels.', playlistFailed: true, epgFailed: false });
    }
    if (err.epgFailed) {
      return res.status(400).json({ error: 'The EPG URL failed to load.', playlistFailed: false, epgFailed: true });
    }
    return res.status(500).json({ error: 'Unable to import from the provided URLs.' });
  }
});

// Kicks off a refresh when something needed a source and found the cache
// empty, rather than leaving the account broken until the next scheduled
// slot - which, on a twice-daily cadence, can be twelve hours away. A
// failed startup fetch used to mean exactly that: categories, the
// network-link picker and stream matching all dead until 06:00 came
// round again.
//
// Fire-and-forget: the caller still gets an immediate "not ready"
// response rather than being held for a multi-second parse. The cooldown
// stops a dashboard that retries, or several tabs, from stacking up
// concurrent fetches of the same 150MB file.
const m3uWarmAttempts = new Map(); // playlistUrl -> last attempt timestamp
const M3U_WARM_COOLDOWN_MS = 2 * 60 * 1000;

function warmM3uSourceInBackground(user) {
  const playlistUrl = user && user.m3u && user.m3u.playlistUrl;
  const epgUrl = user && user.m3u && user.m3u.epgUrl;
  if (!playlistUrl || !epgUrl) return;

  const lastAttempt = m3uWarmAttempts.get(playlistUrl) || 0;
  if (Date.now() - lastAttempt < M3U_WARM_COOLDOWN_MS) return;
  m3uWarmAttempts.set(playlistUrl, Date.now());

  console.log(`[M3U] Cache empty for ${playlistUrl} - starting an on-demand refresh.`);
  m3u.refreshM3USource(playlistUrl, epgUrl, { allowEpgFailure: true })
    .then(source => {
      console.log(`[M3U] On-demand refresh done: ${source.channels.length} channels, EPG ${source.epgAvailable ? 'ok' : 'UNAVAILABLE'}`);
    })
    .catch(err => {
      console.error(`[M3U] On-demand refresh FAILED for ${playlistUrl}: ${err.message}` +
        (err.playlistFailed ? ` (playlist: ${err.playlistError})` : '') +
        (err.epgFailed ? ` (epg: ${err.epgError})` : ''));
    });
}

// Shared front half of every network-links endpoint: rate limit, verify
// credentials, and hand back the user's parsed playlist. Factored out
// because three endpoints need exactly this and duplicating it is how the
// login-lockout bypass happened the first time.
//
// Returns null after having already sent a response, so callers just
// check for null and return.
async function authenticateForChannels(req, res) {
  const { uuid, password } = req.body;
  const ip = req.ip;

  if (isRateLimited(ip)) {
    const retryAfterSec = getRetryAfterSeconds(ip);
    res.setHeader('Retry-After', retryAfterSec);
    res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).` });
    return null;
  }

  const user = userConfigs[uuid];
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    recordFailedAttempt(ip);
    res.status(401).json({ error: 'Invalid UUID or password.' });
    return null;
  }
  clearFailedAttempts(ip);

  // Xtream reaches the same features through its own channel list rather
  // than a parsed playlist. Both arrive here in the same shape, so
  // everything downstream - suggestions, search, probing, link healing -
  // is one implementation serving both.
  if (user.connectionType !== 'm3u') {
    if (!user.xtream || !user.xtream.url) {
      res.status(400).json({ error: 'No Xtream connection is configured on this account.' });
      return null;
    }
    const xtreamSource = await getXtreamChannelSource(user);
    if (!xtreamSource) {
      res.status(503).json({
        error: 'Could not reach your Xtream provider. This usually clears on its own - try again in a moment.',
        notReady: true
      });
      return null;
    }
    return { user, source: xtreamSource };
  }

  if (!user.m3u || !user.m3u.playlistUrl) {
    res.status(400).json({ error: 'No M3U playlist is configured on this account.' });
    return null;
  }

  const source = m3u.getCachedM3USource(user.m3u.playlistUrl);
  if (!source) {
    warmM3uSourceInBackground(user);
    // notReady distinguishes "still loading" from a real failure, so the
    // dashboard can say which and offer a retry rather than rendering an
    // empty picker that looks broken.
    res.status(503).json({
      error: 'Your playlist is still loading. This can take a minute after a restart.',
      notReady: true
    });
    return null;
  }

  return { user, source };
}

// The full network registry, so the dashboard renders its sections from
// the server's list rather than keeping a second copy in the page that
// could drift out of sync when a network is added.
app.get('/api/networks', (req, res) => {
  res.json({
    networks: networks.NETWORKS.map(({ key, label, kind }) => ({ key, label, kind })),
    maxLinksPerNetwork: networks.MAX_LINKS_PER_NETWORK
  });
});

// Suggested channels for every network at once. One pass over the
// playlist serves the whole registry, which is far cheaper than one round
// trip per network and means the dashboard can populate the entire
// section in a single request.
app.post('/api/networks/suggest', async (req, res) => {
  const auth = await authenticateForChannels(req, res);
  if (!auth) return;

  const suggestions = networks.suggestAllNetworks(auth.source.channels, {
    defaults: mergedNetworkDefaults()
  });
  return res.json({ success: true, suggestions, presets: describePresets() });
});

// Free-text search over the whole playlist, for overriding a suggestion
// with a specific channel. Capped server-side: a bare query like "fox"
// legitimately matches hundreds of channels and there's no value in
// shipping all of them to a picker the user is scrolling by hand.
app.post('/api/networks/search', async (req, res) => {
  const auth = await authenticateForChannels(req, res);
  if (!auth) return;

  const { query } = req.body;
  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    return res.status(400).json({ error: 'Enter at least 2 characters to search.' });
  }

  // excludeGroups lets the page hide whole playlist groups from the
  // results - the practical answer to a provider that files 1,600
  // per-event listings under a group named after a real channel.
  const excludeGroups = Array.isArray(req.body.excludeGroups)
    ? req.body.excludeGroups.filter(g => typeof g === 'string').slice(0, 50)
    : [];

  const { channels, groups, truncated } = networks.searchChannels(
    query, auth.source.channels, { limit: 50, excludeGroups }
  );
  return res.json({ success: true, channels, groups, truncated });
});

// The user's saved channels, resolved against the current playlist so a
// rotated URL is healed rather than silently dead. This is what the watch
// page plays from.
app.post('/api/networks/saved', async (req, res) => {
  const auth = await authenticateForChannels(req, res);
  if (!auth) return;

  const { resolved, problems } = networks.resolveSavedChannels(
    auth.user.savedChannels, auth.source
  );
  return res.json({ success: true, channels: resolved.map(withQualityTier), problems });
});

// Reads and writes the instance-wide preferred tvg-ids.
//
// A POST with `fromNetworkLinks` derives them from whatever the caller
// currently has configured - which is the "make these my defaults"
// button. Only ids are kept; the URLs those links carry are account
// credentials and never leave the account record.
app.post('/api/networks/defaults', async (req, res) => {
  const auth = await authenticateForChannels(req, res);
  if (!auth) return;

  const action = req.body.action || 'list';

  if (action === 'save') {
    const name = String(req.body.name || '').trim().slice(0, 60);
    if (!name) {
      return res.status(400).json({ error: 'Give the preset a name.' });
    }

    const derived = {};
    for (const [networkKey, links] of Object.entries(auth.user.networkLinks || {})) {
      if (!Array.isArray(links)) continue;
      const ids = [...new Set(links.map(l => networks.streamIdFromUrl(l.url)).filter(Boolean))];
      if (ids.length > 0) derived[networkKey] = ids;
    }
    if (Object.keys(derived).length === 0) {
      return res.status(400).json({ error: 'No channels are configured, so there is nothing to save.' });
    }

    // Saving over a name replaces that preset in place rather than
    // leaving two of the same name behind - re-pinning after adding a
    // channel is the common case, and it should not accumulate.
    const preset = {
      id: `preset-${Date.now().toString(36)}`,
      name,
      source: providerHostFor(auth.user),
      createdAt: new Date().toISOString(),
      networks: derived,
    };
    const existing = networkDefaults.presets.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing >= 0) {
      preset.id = networkDefaults.presets[existing].id;
      networkDefaults.presets[existing] = preset;
    } else {
      networkDefaults.presets.push(preset);
    }

    saveNetworkDefaults(networkDefaults);
    const total = Object.values(derived).reduce((n, ids) => n + ids.length, 0);
    console.log(`[Defaults] ${existing >= 0 ? 'Replaced' : 'Saved'} preset "${name}"` +
      ` (${preset.source || 'unknown host'}): ${total} stream id(s) across ${Object.keys(derived).length} network(s)`);
  }

  if (action === 'delete') {
    const id = String(req.body.id || '');
    const before = networkDefaults.presets.length;
    networkDefaults.presets = networkDefaults.presets.filter(p => p.id !== id);
    if (networkDefaults.presets.length === before) {
      return res.status(404).json({ error: 'That preset no longer exists.' });
    }
    saveNetworkDefaults(networkDefaults);
    console.log(`[Defaults] Deleted preset ${id}`);
  }

  return res.json({ success: true, presets: describePresets() });
});

// Probes ONE stream for its resolution and frame rate. One URL per
// request, not a batch: a batch of eight at ~3s apart would hold an HTTP
// request open for the better part of a minute, which reverse proxies cut
// off by default, and it would give the page nothing to show until every
// probe finished. Per-URL lets results fill in as they arrive.
//
// The URL must be one the user's own playlist actually contains. This is
// the security boundary, not a convenience check: without it the endpoint
// would fetch any URL a client named, turning the server into a proxy for
// scanning whatever it can reach on its own network.
app.post('/api/networks/probe', async (req, res) => {
  const auth = await authenticateForChannels(req, res);
  if (!auth) return;

  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'A stream URL is required.' });
  }

  const channel = auth.source.channels.find(c => c.streamUrl === url);
  if (!channel) {
    return res.status(400).json({ error: 'That stream is not in your playlist.' });
  }

  // force re-probes a stream whose cached result was a failure - see
  // probeStream. Still subject to the same server-side throttle, so it
  // cannot be used to bypass the rate limiting.
  const result = await probe.probeStream(url, {
    force: req.body.force === true,
    // Throws away everything measured of this stream before re-measuring.
    // Averaging is right until the provider re-encodes a channel, at
    // which point the old samples are describing a stream that no longer
    // exists.
    reset: req.body.reset === true,
  });

  // Logged because there is otherwise no way to tell a real measurement
  // from a cache hit, or a full sample from a truncated one - "it went as
  // fast as before" is a reasonable thing to wonder and was impossible to
  // answer. Only the stream id, never the URL, which carries the
  // provider password.
  const streamId = networks.streamIdFromUrl(url);
  if (result.cached) {
    console.log(`[Probe] #${streamId} served from cache (${result.label || result.error})`);
  } else if (result.ok) {
    // Says both numbers when they differ: what this check measured, and
    // the average it has been folded into. Without that, a run that read
    // low looks like the channel having changed.
    const thisRun = result.lastBitrate ? `${(result.lastBitrate / 1e6).toFixed(1)}Mbps this check` : '';
    const across = result.samples > 1
      ? `avg of ${result.samples} checks over ${result.totalSampleSeconds}s`
      : `sampled ${result.sampleSeconds != null ? result.sampleSeconds : '?'}s of media`;
    console.log(
      `[Probe] #${streamId} ${result.label}` +
      ` - ${across}` +
      (result.samples > 1 && thisRun ? `, ${thisRun}` : '') +
      (result.bitrateVariation ? `, swinging ${result.bitrateVariation}x` : '') +
      (result.bitrateConfident === false ? ' (SHORT SAMPLE)' : ''));
  } else {
    console.log(`[Probe] #${streamId} failed: ${result.error}`);
  }

  return res.json({ success: true, url, ...result });
});

// Resolves the user's SAVED links against the current playlist, so the
// dashboard can show which ones still point at a live channel, which
// silently moved and got healed, and which are gone. This is the only
// place a broken link can realistically be surfaced - once a URL is
// handed to Stremio the app never learns whether it played.
app.post('/api/networks/status', async (req, res) => {
  const auth = await authenticateForChannels(req, res);
  if (!auth) return;

  // An xtream-typed link stores an id, not a URL, so without a builder
  // resolveNetworkLinks has nothing to resolve it to and reports every
  // one of them as "no Xtream credentials configured" - the whole picker
  // showing broken while being perfectly healthy.
  const buildXtreamUrl = (auth.user.xtream && auth.user.xtream.url)
    ? (streamId) => buildXtreamStreamUrl(auth.user, streamId)
    : null;

  const status = {};
  for (const network of networks.NETWORKS) {
    const { resolved, problems } = networks.resolveNetworkLinks(
      auth.user.networkLinks, network.key, auth.source, buildXtreamUrl
    );
    if (resolved.length === 0 && problems.length === 0) continue;
    status[network.key] = {
      ok: resolved.filter(r => r.status === 'ok').length,
      healed: resolved.filter(r => r.status === 'healed').map(r => ({ slot: r.slot, name: r.name, note: r.note })),
      problems
    };
  }

  return res.json({ success: true, status });
});

app.post('/api/user/register', async (req, res) => {
  if (!ENCRYPTION_KEY_CONFIGURED) {
    return res.status(503).json({ error: 'Encryption key not configured yet. See the homepage for setup instructions.' });
  }
  const { xtream, m3u, connectionType, selectedSports, password, timeZone, sportOrder, networkLinks, savedChannels } = req.body;
  if (!password || typeof password !== 'string' || password.length === 0) {
    return res.status(400).json({ error: 'A password is required.' });
  }
  const uuid = uuidv4();
  const passwordHash = await bcrypt.hash(password, 10);

  userConfigs[uuid] = { 
    uuid, 
    passwordHash, 
    // Explicitly stored rather than inferred from which of xtream/m3u is
    // present - an account should only ever have exactly one populated,
    // and every downstream route (catalog/meta/stream) needs a reliable,
    // unambiguous field to branch on, the same way sport itself is used
    // to branch fetchGamesForSport.
    connectionType: connectionType || 'xtream',
    xtream, 
    m3u,
    selectedSports, 
    timeZone: timeZone || 'America/New_York',
    sportOrder,
    networkLinks: networkLinks || {},
    savedChannels: savedChannels || [],
    createdAt: new Date().toISOString()
  };
  saveUserConfigs();

  return res.json({ success: true, uuid, manifestUrl: `/user/${uuid}/manifest.json` });
});

// Attaches a tier to a quality that was measured in an earlier session.
//
// The score is recovered from the stored label rather than persisted
// beside it - scoreQualityLabel reads back everything the model needs -
// so a channel checked weeks ago colours exactly like one checked a
// moment ago, and no saved account had to gain a field for it.
function withQualityTier(entry) {
  if (!entry || !entry.probedQuality) return entry;
  const scored = probe.scoreQualityLabel(entry.probedQuality);
  return scored ? { ...entry, probedScore: scored.score, probedTier: scored.tier } : entry;
}

function tierNetworkLinks(networkLinks) {
  const out = {};
  for (const [key, links] of Object.entries(networkLinks || {})) {
    out[key] = Array.isArray(links) ? links.map(withQualityTier) : links;
  }
  return out;
}

app.post('/api/user/login', async (req, res) => {
  if (!ENCRYPTION_KEY_CONFIGURED) {
    return res.status(503).json({ error: 'Encryption key not configured yet. See the homepage for setup instructions.' });
  }
  const { uuid, password } = req.body;
  const ip = req.ip;

  if (isRateLimited(ip)) {
    const retryAfterSec = getRetryAfterSeconds(ip);
    res.setHeader('Retry-After', retryAfterSec);
    return res.status(429).json({ error: `Too many login attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).` });
  }

  const user = userConfigs[uuid];
  const passwordOk = user && (await bcrypt.compare(password, user.passwordHash));

  if (!passwordOk) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: 'Invalid UUID or password.' });
  }

  clearFailedAttempts(ip);
  return res.json({ 
    success: true, 
    uuid: user.uuid, 
    connectionType: user.connectionType || 'xtream',
    xtream: user.xtream, 
    m3u: user.m3u,
    selectedSports: user.selectedSports, 
    timeZone: user.timeZone || 'America/New_York',
    sportOrder: user.sportOrder || [],
    networkLinks: tierNetworkLinks(user.networkLinks),
    savedChannels: (user.savedChannels || []).map(withQualityTier),
    manifestUrl: `/user/${uuid}/manifest.json` 
  });
});

app.post('/api/user/update', async (req, res) => {
  const { uuid, password, xtream, m3u, selectedSports, timeZone, sportOrder, networkLinks, savedChannels } = req.body;
  const ip = req.ip;

  if (isRateLimited(ip)) {
    const retryAfterSec = getRetryAfterSeconds(ip);
    res.setHeader('Retry-After', retryAfterSec);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).` });
  }

  const user = userConfigs[uuid];
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: 'Invalid UUID or password.' });
  }
  clearFailedAttempts(ip);
  if (xtream !== undefined) user.xtream = xtream;
  if (m3u !== undefined) user.m3u = m3u;
  if (selectedSports !== undefined) user.selectedSports = selectedSports;
  if (timeZone) user.timeZone = timeZone;
  if (sportOrder !== undefined) user.sportOrder = sportOrder;

  // Validated before assignment, not after - a malformed link that gets
  // stored resolves to nothing later, at which point the failure surfaces
  // in Stremio as a missing stream with no explanation of why. Rejecting
  // it here means the dashboard can say what's actually wrong while the
  // user is still looking at the field they typed it into.
  if (networkLinks !== undefined) {
    if (!networkLinks || typeof networkLinks !== 'object' || Array.isArray(networkLinks)) {
      return res.status(400).json({ error: 'networkLinks must be an object keyed by network.' });
    }
    const validated = {};
    for (const [networkKey, links] of Object.entries(networkLinks)) {
      const result = networks.validateNetworkLinks(networkKey, links);
      if (!result.ok) {
        return res.status(400).json({ error: `${networks.getNetworkLabel(networkKey)}: ${result.error}` });
      }
      // Empty arrays are KEPT, not dropped. An absent key and an empty
      // array mean different things now that suggestions auto-fill:
      // absent is "never configured", so suggestions may populate it,
      // while empty is "the user deliberately cleared this" and must
      // stay cleared. Dropping empties would make a cleared network
      // refill itself on the next dashboard load.
      validated[networkKey] = result.links;
    }
    user.networkLinks = validated;
  }

  if (savedChannels !== undefined) {
    const result = networks.validateSavedChannels(savedChannels);
    if (!result.ok) return res.status(400).json({ error: result.error });
    user.savedChannels = result.channels;
  }

  saveUserConfigs();

  return res.json({ success: true, uuid: user.uuid, manifestUrl: `/user/${uuid}/manifest.json` });
});

// Permanently removes a user's entire record - their Xtream credentials,
// selected leagues, category mappings, timezone, and manifest UUID all
// live under this one object, so deleting it is a complete, irreversible
// wipe with nothing left behind elsewhere to separately clean up.
app.post('/api/user/delete', async (req, res) => {
  const { uuid, password } = req.body;
  const ip = req.ip;

  if (isRateLimited(ip)) {
    const retryAfterSec = getRetryAfterSeconds(ip);
    res.setHeader('Retry-After', retryAfterSec);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).` });
  }

  const user = userConfigs[uuid];
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: 'Invalid UUID or password.' });
  }
  clearFailedAttempts(ip);
  delete userConfigs[uuid];
  saveUserConfigs();

  return res.json({ success: true });
});

// Admin credentials can live in two places, checked in this order:
// 1. .env (ADMIN_USERNAME/ADMIN_PASSWORD) - the original, still-supported
//    approach. Same trust boundary as ENCRYPTION_KEY. Always takes
//    priority if set, so any existing deployment that already configured
//    these keeps working exactly as before - this addition changes
//    nothing for them.
// 2. The app-managed store (admin-config.json) - lets a fresh install,
//    with no env vars set yet, configure an admin password through the
//    UI itself instead of requiring a manual file edit and restart
//    before the admin panel is usable at all.
// This app is a single-operator, self-hosted tool, not a multi-admin
// platform, so a simple operator credential (whichever source is active)
// is the right fit, not a full database-backed admin account system.
async function isValidAdmin(username, password) {
  if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
    return username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD;
  }
  if (adminConfig) {
    return username === adminConfig.username && (await bcrypt.compare(password, adminConfig.passwordHash));
  }
  return false;
}

function isAdminConfigured() {
  return !!(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) || !!adminConfig;
}

// Lets the landing page know whether to show the Admin button at all,
// without exposing the actual credential values to the client.
app.get('/api/admin/enabled', (req, res) => {
  return res.json({ enabled: isAdminConfigured() });
});

// Drives the first-run setup flow on the homepage - lets the frontend
// know which of the two setup screens (if any) to show before the
// normal landing page.
app.get('/api/setup/status', (req, res) => {
  return res.json({
    adminConfigured: isAdminConfigured(),
    encryptionKeyConfigured: ENCRYPTION_KEY_CONFIGURED
  });
});

// Only allowed when NO admin credentials are configured anywhere yet
// (neither env vars nor a previous app-managed setup) - this is
// deliberately a one-time, unauthenticated bootstrap action for a truly
// fresh install, not a way to reset an already-configured admin account.
// Once real credentials exist, this endpoint refuses to do anything at
// all, admin or not.
app.post('/api/setup/admin', async (req, res) => {
  if (isAdminConfigured()) {
    return res.status(403).json({ error: 'Admin credentials are already configured.' });
  }
  const { username, password } = req.body;
  if (!username || typeof username !== 'string' || username.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters.' });
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  adminConfig = { username, passwordHash };
  saveAdminConfig(adminConfig);

  return res.json({ success: true });
});

// A random key generator, not tied to any particular request's
// eventual use - deliberately not gated behind admin auth, since
// generating a random value and displaying it isn't itself a security
// action (the key only matters once actually placed into the real
// environment config and used). Still refuses once a real key is already
// configured, though - there's no legitimate reason to expose a
// key-generator once the app is already properly set up, and no reason
// to invite confusion about whether generating a new one here would
// somehow replace the active one (it doesn't - env vars are only ever
// read once, at container startup).
app.get('/api/setup/generate-encryption-key', (req, res) => {
  if (ENCRYPTION_KEY_CONFIGURED) {
    return res.status(403).json({ error: 'An encryption key is already configured.' });
  }
  return res.json({ key: crypto.randomBytes(32).toString('hex') });
});

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const ip = req.ip;

  if (isRateLimited(ip)) {
    const retryAfterSec = getRetryAfterSeconds(ip);
    res.setHeader('Retry-After', retryAfterSec);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).` });
  }

  if (!(await isValidAdmin(username, password))) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: 'Invalid admin credentials.' });
  }
  clearFailedAttempts(ip);
  return res.json({ success: true });
});

// No server-side sessions anywhere else in this app either - the regular
// dashboard passes credentials on every save rather than using a session
// cookie, so the admin page follows the same stateless pattern: every
// admin request re-validates the credentials it's sent, rather than
// trusting a token from an earlier login.
app.post('/api/admin/users', async (req, res) => {
  const { username, password } = req.body;
  const ip = req.ip;

  if (isRateLimited(ip)) {
    const retryAfterSec = getRetryAfterSeconds(ip);
    res.setHeader('Retry-After', retryAfterSec);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).` });
  }
  if (!(await isValidAdmin(username, password))) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: 'Invalid admin credentials.' });
  }
  clearFailedAttempts(ip);

  // Deliberately excludes passwordHash and xtream/m3u credentials - the
  // admin page only needs enough to identify, sort, and delete accounts,
  // not a reason to expose every user's stored secrets in one list.
  // connectionType itself isn't a secret, just tells the admin which kind
  // of account this is.
  const users = Object.values(userConfigs).map(user => ({
    uuid: user.uuid,
    connectionType: user.connectionType || 'xtream',
    createdAt: user.createdAt || null,
    lastAccessedAt: user.lastAccessedAt || null
  }));

  return res.json({ success: true, users });
});

app.post('/api/admin/m3u-settings', async (req, res) => {
  const { username, password } = req.body;
  const ip = req.ip;

  if (isRateLimited(ip)) {
    const retryAfterSec = getRetryAfterSeconds(ip);
    res.setHeader('Retry-After', retryAfterSec);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).` });
  }
  if (!(await isValidAdmin(username, password))) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: 'Invalid admin credentials.' });
  }
  clearFailedAttempts(ip);

  return res.json({ success: true, settings: m3uSettings });
});

// Takes effect on the scheduler's very next cycle, not requiring a
// restart - the scheduler re-reads m3uSettings live each time it
// reschedules itself, rather than capturing a snapshot once at startup.
app.post('/api/admin/m3u-settings/update', async (req, res) => {
  const { username, password, daysOfWeek, times, timeZone } = req.body;
  const ip = req.ip;

  if (isRateLimited(ip)) {
    const retryAfterSec = getRetryAfterSeconds(ip);
    res.setHeader('Retry-After', retryAfterSec);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).` });
  }
  if (!(await isValidAdmin(username, password))) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: 'Invalid admin credentials.' });
  }
  clearFailedAttempts(ip);

  const validDayNames = new Set(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
  if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0 || !daysOfWeek.every(d => validDayNames.has(d))) {
    return res.status(400).json({ error: 'At least one valid day of the week is required.' });
  }
  const validTimePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
  if (!Array.isArray(times) || times.length === 0 || !times.every(t => validTimePattern.test(t))) {
    return res.status(400).json({ error: 'At least one valid time (HH:MM, 24-hour) is required.' });
  }
  if (!timeZone || typeof timeZone !== 'string') {
    return res.status(400).json({ error: 'A timezone is required.' });
  }

  m3uSettings = { daysOfWeek, times: [...new Set(times)], timeZone };
  saveM3uSettings(m3uSettings);

  return res.json({ success: true, settings: m3uSettings });
});

app.post('/api/admin/user/delete', async (req, res) => {
  const { username, password, targetUuid } = req.body;
  const ip = req.ip;

  if (isRateLimited(ip)) {
    const retryAfterSec = getRetryAfterSeconds(ip);
    res.setHeader('Retry-After', retryAfterSec);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).` });
  }
  if (!(await isValidAdmin(username, password))) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: 'Invalid admin credentials.' });
  }
  clearFailedAttempts(ip);
  if (!userConfigs[targetUuid]) {
    return res.status(404).json({ error: 'No account found with that UUID.' });
  }

  delete userConfigs[targetUuid];
  saveUserConfigs();

  return res.json({ success: true });
});

// ---------------------------------------------------------------------
// TV Networks catalog
// ---------------------------------------------------------------------
//
// A browsable row of the networks the user has configured channels for,
// independent of whether a game is on. The link lists already exist for
// game matching; this exposes them directly, so "put ESPN on" doesn't
// require finding a game that happens to be showing there.
//
// Networks with no links are omitted rather than shown empty - an entry
// that opens to nothing is worse than no entry at all.
function getConfiguredNetworks(user) {
  const links = user.networkLinks || {};
  return networks.NETWORKS
    .filter(n => Array.isArray(links[n.key]) && links[n.key].length > 0)
    .map(n => ({ ...n, linkCount: links[n.key].length }));
}

const NETWORKS_CATALOG_ID = 'networks';

// The quality label to show against a link in Stremio, or '' if unknown.
//
// Prefers a live reading from the probe cache, falling back to whatever
// was recorded on the link when it was last checked in the dashboard. The
// cache is memory-only and expires, so after a restart the stored value is
// all there is - without it, quality labels would silently vanish from
// Stremio until the user happened to re-check every channel.
//
// Never probes. This runs on every stream request, and opening a
// connection to the provider just to decorate a title would compete with
// the playback the user is about to start.
function qualityLabelForLink(link) {
  return probe.getCachedProbeLabel(link.url) || link.probedQuality || '';
}

// "📡 FOX · 1080p60  📁 TV Guide (USA)". The channel's own name stays in
// the stream's `name`, which is where the market ("[Birmingham]") shows.
function buildLinkTitle(networkKey, link) {
  const quality = qualityLabelForLink(link);
  const networkPart = `📡 ${networks.getNetworkLabel(networkKey)}${quality ? ` · ${quality}` : ''}`;
  return link.group ? `${networkPart}  📁 ${link.group}` : networkPart;
}

// The same shape as buildLinkTitle, with a different lead icon because
// the provenance genuinely differs and the user has to be able to tell:
// a 📡 entry is a channel they picked and quality-checked themselves, a
// 🔎 entry is one a standing search turned up this minute and nobody has
// ever looked at. Both are playable; only one has been vouched for.
//
// Quality comes from the probe cache alone - an auto-found channel has no
// stored reading to fall back on, because it was never saved anywhere to
// store one against. It fills in once the channel is checked in the watch
// portal.
function buildAutoSearchTitle(channel) {
  const quality = probe.getCachedProbeLabel(channel.url) || '';
  const searchPart = `🔎 Auto${quality ? ` · ${quality}` : ''}`;
  return channel.group ? `${searchPart}  📁 ${channel.group}` : searchPart;
}

// Poster/background for a network block. Deliberately generated rather
// than taken from the playlist's tvg-logo: those point at arbitrary
// third-party image hosts that may be dead, rate-limited or simply wrong,
// and a broken poster in a catalog row reads as a broken addon.
// Average glyph width as a fraction of font-size for the bold sans stack
// used here. An approximation, not real text measurement - good enough to
// keep a label inside its box, which is all that's needed. A single ratio
// rather than a per-character table, because network names use the whole
// alphabet and any table narrow enough to be accurate would be mostly
// misses.
const NETWORK_LABEL_CHAR_RATIO = 0.62;

function buildNetworkArtSvg(label, width, height) {
  const text = String(label || '').trim() || 'Network';

  // Long names get wrapped rather than shrunk to nothing. "CBS Sports
  // Network" on one line at a readable size is far wider than the poster,
  // which is what was clipping the ends off.
  const lines = text.length > 9 ? splitNameForWrap(text) : [text];
  const longest = lines.reduce((a, b) => (a.length >= b.length ? a : b), '');

  // Two competing limits: the box, and the text. Take whichever is
  // smaller so a long name shrinks to fit while a short one doesn't
  // balloon to fill the poster.
  const maxByBox = lines.length > 1
    ? Math.min(width * 0.17, height * 0.11)
    : Math.min(width * 0.20, height * 0.13);
  const maxByWidth = (width * 0.82) / Math.max(1, longest.length * NETWORK_LABEL_CHAR_RATIO);
  const fontSize = Math.round(Math.max(14, Math.min(maxByBox, maxByWidth)));

  const lineHeight = fontSize * 1.12;
  // Vertically centre the block of lines on the poster's midpoint.
  const firstBaseline = height / 2 - ((lines.length - 1) * lineHeight) / 2 + fontSize * 0.34;

  const labelMarkup = lines.map((line, i) =>
    `<text x="${width / 2}" y="${firstBaseline + i * lineHeight}"
           font-family="'Trebuchet MS', Verdana, sans-serif" font-size="${fontSize}"
           font-weight="800" fill="#f8fafc" text-anchor="middle">${escapeXml(line)}</text>`
  ).join('');

  const subtitleY = firstBaseline + (lines.length - 1) * lineHeight + fontSize * 0.95;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    <defs>
      <radialGradient id="netBg" cx="50%" cy="45%" r="75%">
        <stop offset="0%" stop-color="#2b3a44" />
        <stop offset="100%" stop-color="#0b1114" />
      </radialGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#netBg)" />
    ${labelMarkup}
    <text x="${width / 2}" y="${subtitleY}"
          font-family="'Trebuchet MS', Verdana, sans-serif" font-size="${Math.round(fontSize * 0.26)}"
          font-weight="600" fill="#5aa8d1" text-anchor="middle" letter-spacing="3">LIVE CHANNEL</text>
  </svg>`;
}

// Cache-buster for the network artwork URLs.
//
// The art is served with a long max-age because it genuinely never
// changes for a given network - but that meant a fix to the RENDERING
// was invisible: clients kept showing the cached image at the unchanged
// URL for a day. Observed exactly that, where a wrapping fix deployed
// correctly but every poster still rendered clipped.
//
// Derived from the source of the render function rather than a manual
// version constant, so it changes automatically whenever the artwork
// logic does and there is nothing to remember to bump.
const NETWORK_ART_VERSION = crypto
  .createHash('sha1')
  .update(buildNetworkArtSvg.toString())
  .digest('hex')
  .slice(0, 8);

function networkArtUrls(hostUrl, key) {
  return {
    poster: `${hostUrl}/network/${key}/poster.svg?v=${NETWORK_ART_VERSION}`,
    background: `${hostUrl}/network/${key}/background.svg?v=${NETWORK_ART_VERSION}`
  };
}

// The browser watch UI. A convenience alias - express.static already
// serves the file at /watch.html - so the address people actually type is
// the short one.
app.get('/watch', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'watch.html'));
});

app.get('/network/:key/poster.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(buildNetworkArtSvg(networks.getNetworkLabel(req.params.key), 600, 900));
});

app.get('/network/:key/background.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(buildNetworkArtSvg(networks.getNetworkLabel(req.params.key), 1920, 1080));
});

app.get('/user/:uuid/manifest.json', (req, res) => {
  const user = userConfigs[req.params.uuid];
  if (!user) return res.status(404).json({ error: 'Invalid manifest UUID' });

  // Used by the admin page to show which accounts are actually in active
  // use. Nuvio re-fetches the manifest periodically (not just once at
  // install), so this is a reasonable proxy for real activity without
  // needing to instrument every catalog/stream route too.
  user.lastAccessedAt = new Date().toISOString();
  saveUserConfigs();

  const targetDateStr = getLocalDateDash(user.timeZone);

  // A sport appears as a catalog if the user picked that league.
  //
  // It used to be gated on having mapped at least one category folder to
  // the sport, which was a proxy for "configured" back when categories
  // decided what got searched. Nothing searches by category any more, so
  // the proxy had become a trap: an account could choose a league and
  // still not see it. GLOBAL was never a browsable catalog and is not a
  // league, so it cannot appear here at all now.
  const activeSports = (user.selectedSports || []).filter(sport => sport && sport !== 'GLOBAL');

  // Catalog order reflects the user's own drag-and-drop ordering of the
  // league sections. Anything not yet given an
  // explicit position (e.g. a league added after the order was last set)
  // falls back to alphabetical, sorting after everything explicitly ordered.
  const sportOrder = user.sportOrder || [];
  const orderedActiveSports = [...activeSports].sort((a, b) => {
    const idxA = sportOrder.indexOf(a);
    const idxB = sportOrder.indexOf(b);
    if (idxA === -1 && idxB === -1) return getSportDisplayName(a).localeCompare(getSportDisplayName(b));
    if (idxA === -1) return 1;
    if (idxB === -1) return -1;
    return idxA - idxB;
  });

  const catalogs = orderedActiveSports.map(sport => ({
    type: 'sports',
    id: `sb_${sport.toLowerCase()}_${targetDateStr}`,
    name: `${getSportDisplayName(sport)} Live Games`
  }));

  // Listed last so it sits below the live-game rows, which are the
  // time-sensitive ones. Omitted entirely when nothing is configured,
  // rather than installing a row that never fills in.
  if (getConfiguredNetworks(user).length > 0) {
    catalogs.push({
      type: 'sports',
      id: NETWORKS_CATALOG_ID,
      name: 'TV Networks'
    });
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  res.json({
    id: `org.sportballio.${user.uuid}`,
    version: '2.2.8',
    name: 'Sportio Live',
    description: 'Live sports addon for Stremio/Nuvio. Powered by your IPTV.',
    resources: ['catalog', 'meta', 'stream'],
    types: ['sports'],
    catalogs
  });
});

app.get('/user/:uuid/catalog/sports/:id.json', async (req, res) => {
  const user = userConfigs[req.params.uuid];
  if (!user) return res.json({ metas: [] });

  const hostUrl = `${req.protocol}://${req.get('host')}`;

  // The networks catalog is not a sport and carries no date, so it has to
  // be handled before the sb_{sport}_{date} parsing below - which would
  // otherwise find no sport in it and silently fall back to MLB.
  if (req.params.id === NETWORKS_CATALOG_ID) {
    const metas = getConfiguredNetworks(user).map(network => ({
      id: `net:${network.key}`,
      type: 'sports',
      name: network.label,
      ...networkArtUrls(hostUrl, network.key)
    }));

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.json({ metas });
  }

  // Catalog ids are always constructed as sb_{sport}_{date} (see the
  // manifest route), and the date portion uses dashes rather than
  // underscores, so splitting on "_" and taking the second segment
  // reliably extracts the sport for every league - no need to maintain a
  // hardcoded, easily-incomplete list of substring checks here, which is
  // exactly what caused several leagues to silently fall back to MLB
  // before this fix.
  const sport = (req.params.id.split('_')[1] || 'mlb').toUpperCase();

  const userTz = user.timeZone || 'America/New_York';
  const games = await fetchGamesForSport(sport, hostUrl, userTz);

  const metas = games.map(game => ({
    id: `sb:${sport.toLowerCase()}:${game.id}`,
    type: 'sports',
    name: game.name,
    poster: game.poster,
    background: game.background,
    logo: game.logo,
    description: game.description,
    // releaseInfo is a field Stremio already renders beside a title, so
    // the date shows up there without the client needing to know
    // anything new. The two fields after it are our own: the watch portal
    // reads them to label each card and to work out what is on TODAY,
    // which it cannot compute itself because the user's timezone lives
    // on the server.
    releaseInfo: game.whenLabel || '',
    whenLabel: game.whenLabel || '',
    finalScore: game.finalScore || '',
    isToday: game.isToday !== false,
    conferences: game.conferences || [],
    // Home pools several leagues and re-sorts them into one list, which
    // needs the same inputs the server sorts by.
    startsAt: game.date || '',
    state: game.state || ''
  }));

  // Pinned network cards lead the row, ahead of every game and whatever
  // the week holds - that is what "pinned" means (see
  // getPinnedNetworksForSport). Today this is NFL RedZone.
  //
  // `pinned` is on the meta rather than inferred from the id because the
  // watch portal has to act on it: Home pools every league's catalog into
  // one "what is on right now" page, and a card that is deliberately not
  // an event has no place there. It stays in its own league's tab, which
  // is where someone is already looking for it.
  const pinnedMetas = networks.getPinnedNetworksForSport(sport).map(network => ({
    id: `net:${network.key}`,
    type: 'sports',
    name: network.label,
    ...networkArtUrls(hostUrl, network.key),
    pinned: true,
    // Present so the card carries the same fields as a game and no
    // consumer has to special-case a missing one. There is no kickoff to
    // report, so they are deliberately empty rather than invented.
    releaseInfo: '',
    whenLabel: '',
    isToday: true,
    conferences: [],
    startsAt: '',
    state: ''
  }));

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.json({ metas: [...pinnedMetas, ...metas] });
});

app.get('/user/:uuid/meta/sports/:id.json', async (req, res) => {
  const user = userConfigs[req.params.uuid];
  if (!user) return res.json({ meta: {} });

  const hostUrl = `${req.protocol}://${req.get('host')}`;
  const [prefix, sport, idVal] = req.params.id.split(':');

  // net:{NETWORK} - a TV Networks block. Two segments, not three, so it
  // must be handled before the branches below try to read idVal.
  if (prefix === 'net') {
    const network = networks.NETWORKS.find(n => n.key === sport);
    if (!network) return res.json({ meta: {} });

    // Empty means stale, EXCEPT for a pinned card. The TV Networks
    // catalog only ever lists networks that have links, so an id for one
    // that has none is a client holding an old catalog and there is
    // nothing to show it. A pinned card is in its league's row whether or
    // not channels have been added yet, so refusing here would open it
    // onto a panel with no name on it - which reads as broken rather than
    // as unconfigured, and the stream route already says which it is.
    const links = (user.networkLinks || {})[sport] || [];
    if (links.length === 0 && !networks.isPinnedNetwork(sport)) return res.json({ meta: {} });

    return res.json({
      meta: {
        id: req.params.id,
        type: 'sports',
        name: network.label,
        ...networkArtUrls(hostUrl, network.key)
        // No description. It listed every channel, but the client renders
        // the field as one paragraph - newlines are collapsed - so ten
        // channels became an unreadable run-on. The stream list directly
        // below already names them all, each with its own row, so this was
        // duplicating that badly rather than adding anything.
      }
    });
  }

  if (prefix === 'sb') {
    const userTz = user.timeZone || 'America/New_York';
    const games = await fetchGamesForSport(sport.toUpperCase(), hostUrl, userTz);
    const game = games.find(g => g.id === idVal);
    if (!game) return res.json({ meta: {} });

    return res.json({
      meta: {
        id: req.params.id,
        type: 'sports',
        name: game.name,
        poster: game.poster,
        background: game.background,
        logo: game.logo,
        description: game.description
      }
    });
  } else {
    // Looked up in the cached channel source rather than by fetching the
    // categories this sport was mapped to - there are no such mappings
    // now, and the cache already holds every channel the account can see.
    const source = await getXtreamChannelSource(user);
    const channel = (source ? source.channels : []).find(c => c.streamId === String(idVal));

    return res.json({
      meta: {
        id: req.params.id,
        type: 'sports',
        name: channel ? channel.name : 'Live Stream',
        poster: (channel && channel.logo) || 'https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?auto=format&fit=crop&w=600&q=80',
        background: `${hostUrl}/landscape/${sport.toLowerCase()}.svg`,
        description: `Direct Channel ID: ${idVal}`
      }
    });
  }
});

app.get('/user/:uuid/stream/sports/:id.json', async (req, res) => {
  const user = userConfigs[req.params.uuid];
  if (!user) return res.json({ streams: [] });

  // Every id this route ever receives is shaped sb:{sport}:{gameId} - the
  // first segment no longer needs to be captured now that the dead
  // sbstream-prefixed branch (unreachable - nothing in the app ever
  // constructed that shape of id) has been removed.
  const [idPrefix, sport, idVal] = req.params.id.split(':');
  // A client still holding a cached catalog can ask for the retired
  // Upcoming Schedule card. Nothing to play, and answering here avoids an
  // ESPN lookup for an id that will never match.
  if (idVal === 'none') return res.json({ streams: [] });

  // net:{NETWORK} - the user asked for a network directly rather than for
  // a game. No ESPN lookup and no tier matching: just that network's own
  // channels, in the order they were arranged in the dashboard.
  if (idPrefix === 'net') {
    const networkKey = sport;
    if (!networks.NETWORKS.some(n => n.key === networkKey)) return res.json({ streams: [] });

    // A cold playlist cache used to return an empty list here. That was
    // fine while every network card came from the TV Networks catalog,
    // which only lists configured networks and is browsed after setup -
    // but a pinned card sits in its league's row permanently and can be
    // opened moments after a restart, where a blank panel reads as a
    // broken card rather than as a cache that has not warmed up yet.
    let netSource = null;
    if (user.connectionType === 'm3u') {
      const playlistUrl = user.m3u && user.m3u.playlistUrl;
      netSource = playlistUrl ? m3u.getCachedM3USource(playlistUrl) : null;
      if (!netSource) {
        return res.json({ streams: [{
          name: '\u26A0\uFE0F Playlist not loaded',
          title: playlistUrl
            ? 'Your playlist is still being fetched - try again in a moment.'
            : 'No playlist configured - add one in the Sportio dashboard.',
          url: ''
        }] });
      }
    }

    const { resolved, problems } = networks.resolveNetworkLinks(
      user.networkLinks, networkKey, netSource,
      (streamId) => (user.xtream && user.xtream.url)
        ? buildXtreamStreamUrl(user, streamId)
        : null
    );

    const netStreams = resolved.map(link => ({
      name: link.name,
      title: buildLinkTitle(networkKey, link),
      url: link.url
    }));

    // Same non-playable informational entry the game route uses. A
    // pinned card is always in the row, so it can be opened before any
    // channel has been added to it, and an empty list on its own reads as
    // a failure rather than as something still to set up.
    //
    // The two empty cases are genuinely different and get different
    // wording: nothing was ever configured, or what was configured has
    // gone missing from the playlist. Only the second is a problem.
    if (netStreams.length === 0) {
      netStreams.push(problems.length > 0
        ? {
            name: '\u26A0\uFE0F Broken links',
            title: `All ${problems.length} saved ${networks.getNetworkLabel(networkKey)} channel(s) are missing from your playlist - check the dashboard.`,
            url: ''
          }
        : {
            name: '\u26A0\uFE0F Not configured',
            title: `No ${networks.getNetworkLabel(networkKey)} channels saved yet - add one in the Sportio dashboard.`,
            url: ''
          });
    }

    console.log(`[Stream] NETWORK ${networkKey} links=${resolved.length} missing=${problems.length}`);
    res.setHeader('Content-Type', 'application/json');
    return res.json({ streams: netStreams });
  }

  const hostUrl = `${req.protocol}://${req.get('host')}`;
  const isM3u = user.connectionType === 'm3u';

  let m3uSource = null;
  if (isM3u) {
    if (!user.m3u || !user.m3u.playlistUrl) return res.json({ streams: [] });
    m3uSource = m3u.getCachedM3USource(user.m3u.playlistUrl);
    if (!m3uSource) return res.json({ streams: [] });
  } else {
    if (!user.xtream || !user.xtream.url) return res.json({ streams: [] });
  }

  const userTz = user.timeZone || 'America/New_York';
  const games = await fetchGamesForSport(sport.toUpperCase(), hostUrl, userTz);
  const game = games.find(g => g.id === idVal);

  if (!game) return res.json({ streams: [] });

  // --- Network links ---
  //
  // Which slot applies: for UFC it's the sport's own event bucket (its
  // broadcaster is a streaming service that resolves to no network), for
  // everything else it's whatever network ESPN says carries the game.
  // Either can be null, which buildStreamList handles.
  const sportKey = sport.toUpperCase();

  // ESPN files some shows under a bigger league's scoreboard - Dana
  // White's Contender Series arrives as a UFC event, under the UFC league
  // id, with no field distinguishing it. When a promotion claims this
  // event it overrides both which link slot applies and which standing
  // search runs, because those are precisely the two things that do NOT
  // carry over from the parent league. See networks.PROMOTIONS.
  const promotion = networks.getPromotionForEvent(sportKey, game.name, game.league);
  const networkKey = promotion
    ? promotion.networkKey
    : (networks.getEventNetworkForSport(sportKey) || game.network);

  let linkStreams = [];
  let linkProblems = [];
  if (networkKey) {
    const { resolved, problems } = networks.resolveNetworkLinks(
      user.networkLinks, networkKey, m3uSource,
      // Xtream links rebuild their URL from the account's credentials
      // rather than storing it, so the builder is passed in - only this
      // route has the credentials in hand.
      (streamId) => (user.xtream && user.xtream.url)
        ? buildXtreamStreamUrl(user, streamId)
        : null
    );
    linkProblems = problems;

    // Reordered for this specific sport, so a college-football game
    // prefers the CFB bundle feed and an NFL game prefers the Sunday
    // Ticket one - from the same single saved list.
    // The user's own slot order, unchanged. There used to be a per-sport
    // reorder here that floated a network's sport-specific feeds to the
    // top - an NFL game preferring the Sunday Ticket copy of FOX over the
    // TV Guide one. It worked as designed and was still wrong: once the
    // list is curated by hand, ordered deliberately and quality-checked,
    // the order IS the preference, and silently overriding it meant the
    // channel sitting at slot 1 in the dashboard showed up sixth for a
    // game. Same list, same order, everywhere.
    linkStreams = resolved.map(link => ({
      name: link.name,
      title: buildLinkTitle(networkKey, link),
      url: link.url
    }));
  }

  // --- Automatic search ---
  //
  // A standing, per-sport search over the provider's own channel list -
  // see networks.AUTO_SEARCH. Independent of the network slots above: it
  // exists for events the provider only ever lists as a throwaway
  // per-card channel, which a curated link list cannot keep up with.
  //
  // Resolved here, alongside the links, so buildStreamList receives both
  // sources at once and decides the order in one place.
  const autoSearch = promotion ? promotion.autoSearch : networks.getAutoSearch(sportKey);
  let autoStreams = [];
  if (autoSearch) {
    const autoChannels = await fetchAutoSearchChannels(user, autoSearch, m3uSource);
    autoStreams = autoChannels.map(channel => ({
      name: channel.name,
      title: buildAutoSearchTitle(channel),
      url: channel.url
    }));
  }

  const { streams, mode, note } = networks.buildStreamList({
    networkKey, linkStreams, autoStreams
  });

  // The only channel available for telling the user something is wrong -
  // once a URL reaches the player, this app never learns whether it
  // worked. An entry here is not playable, so it says so plainly rather
  // than looking like a stream that simply failed.
  const finalStreams = [...streams];
  if (mode === 'no-links') {
    finalStreams.unshift({
      name: '\u26A0\uFE0F Not configured',
      title: `${note} - add one in the Sportio dashboard, or search for a channel in the watch portal.`,
      url: ''
    });
  }
  if (linkProblems.length > 0) {
    finalStreams.unshift({
      name: '\u26A0\uFE0F Broken link',
      title: `${linkProblems.length} saved ${networks.getNetworkLabel(networkKey)} channel(s) are missing from your playlist - check the dashboard.`,
      url: ''
    });
  }

  console.log(`[Stream] ${sportKey}${promotion ? `/${promotion.key}` : ''} ${idVal} network=${networkKey || 'none'} mode=${mode} links=${linkStreams.length} auto=${autoStreams.length} -> ${finalStreams.length}`);

  res.setHeader('Content-Type', 'application/json');
  res.json({ streams: finalStreams });
});

// Every MMA league must be fully wired before serving anything.
//
// Artwork URLs are built from a league's ESPN slug, and the poster,
// landscape and logo routes uppercase that slug to look up the league's
// endpoint and colours - so a league whose key is not simply its slug in
// uppercase renders blank artwork with nothing logged at all. That is
// exactly what the catch-all did when it was keyed MMA against the slug
// 'other'. Failing at startup is the point: a silently blank poster is
// far harder to notice than a container that refuses to boot.
//
// Runs here rather than beside MMA_LEAGUES because SPORT_THEMES and the
// Core endpoint map are both declared further down the file.
for (const league of MMA_LEAGUES) {
  if (league.key !== league.slug.toUpperCase()) {
    throw new Error(`[MMA] League '${league.slug}' must use key '${league.slug.toUpperCase()}', not '${league.key}' - artwork lookups derive the key from the slug.`);
  }
  if (!ESPN_ENDPOINTS[league.key] || !ESPN_CORE_EVENT_ENDPOINTS[league.key] || !SPORT_THEMES[league.key]) {
    throw new Error(`[MMA] League '${league.slug}' is missing an ESPN endpoint, Core event endpoint or theme for key '${league.key}'.`);
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Sportio Live running at http://0.0.0.0:${PORT}`);
});

// Collects every M3U user's {playlistUrl, epgUrl} pair - deduplication
// across users who happen to share the same provider is handled inside
// refreshAllM3USources itself, not here.
function getActiveM3uSources() {
  return Object.values(userConfigs)
    .filter(u => u.connectionType === 'm3u' && u.m3u)
    .map(u => ({ playlistUrl: u.m3u.playlistUrl, epgUrl: u.m3u.epgUrl }));
}

m3u.startM3uScheduler(getActiveM3uSources, () => m3uSettings);