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
const quality = require('./quality.js');
const streamcheck = require('./streamcheck.js');
const autopick = require('./autopick.js');
const posters = require('./posters.js');
const wrestling = require('./wrestling.js');

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

// A provider holds exactly the credentials the legacy xtream/m3u fields
// held, so it gets exactly the same treatment - the whole point of moving
// them into an array was that the second one is no less sensitive than
// the first. label/kind/streamcheckProvider stay readable: none of them
// is a secret, and a users.json dump that still names its providers is
// far easier to diagnose without the key.
function encryptProvidersForStorage(providers) {
  if (!Array.isArray(providers)) return providers;
  return providers.map(entry => (entry.kind === 'm3u'
    ? { ...entry, playlistUrl: encrypt(entry.playlistUrl), epgUrl: entry.epgUrl ? encrypt(entry.epgUrl) : entry.epgUrl }
    : { ...entry, url: encrypt(entry.url), username: encrypt(entry.username), password: encrypt(entry.password) }));
}

function decryptProvidersFromStorage(providers) {
  if (!Array.isArray(providers)) return providers;
  return providers.map(entry => (entry.kind === 'm3u'
    ? { ...entry, playlistUrl: decrypt(entry.playlistUrl), epgUrl: entry.epgUrl ? decrypt(entry.epgUrl) : entry.epgUrl }
    : { ...entry, url: decrypt(entry.url), username: decrypt(entry.username), password: decrypt(entry.password) }));
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

// ---------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------
//
// An account is one username and password, and it can carry more than one
// IPTV service behind them.
//
// This started as a single connection per account - `connectionType` plus
// one of `xtream`/`m3u` - and that shape survives in the stored files, so
// everything here reads through `providersOf` rather than those fields.
// The reason for the change is that no single service carries everything:
// one has the good national feeds, another the regional ones, and the
// only way to have both was two accounts, two manifests, and two lists to
// keep in step by hand.
//
// Providers are homogeneous within an account. Both kinds still work, but
// an account is either Xtream or M3U throughout, which is what lets one
// `connectionType` still describe it and keeps every downstream branch
// exactly where it was.
//
// Each provider carries its own streamcheck.pro table. Stream ids are
// assigned per service and collide freely across them, so a reading
// looked up in the wrong table is not a miss - it is a confident
// description of somebody else's channel.
const XTREAM_STREAM_FORMATS = ['m3u8', 'ts'];

const MAX_PROVIDERS = 4;

function makeProviderId() {
  return `p${uuidv4().replace(/-/g, '').slice(0, 10)}`;
}

// Trimmed to what an account is actually allowed to store. Called on
// every write, so a malformed provider fails at the boundary rather than
// halfway through a scheduled auto-pick that nobody is watching.
function normaliseProvider(raw, kind, index) {
  if (!raw || typeof raw !== 'object') return null;
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const id = str(raw.id) || makeProviderId();
  const label = str(raw.label).slice(0, 40) || `Provider ${index + 1}`;
  const streamcheckProvider = str(raw.streamcheckProvider);

  if (kind === 'm3u') {
    const playlistUrl = str(raw.playlistUrl) || str(raw.m3u && raw.m3u.playlistUrl);
    if (!playlistUrl) return null;
    return {
      id, label, kind: 'm3u', streamcheckProvider,
      playlistUrl,
      epgUrl: str(raw.epgUrl) || str(raw.m3u && raw.m3u.epgUrl),
    };
  }

  const src = raw.url ? raw : (raw.xtream || {});
  const url = str(src.url).replace(/\/+$/, '');
  if (!url) return null;
  return {
    id, label, kind: 'xtream', streamcheckProvider,
    url,
    username: str(src.username),
    password: typeof src.password === 'string' ? src.password : '',
    streamFormat: XTREAM_STREAM_FORMATS.includes(src.streamFormat) ? src.streamFormat : 'm3u8',
  };
}

// Folds a stored account into the providers array, whatever shape it was
// last written in.
//
// Accounts predating this hold `xtream`/`m3u` and a single top-level
// `streamcheckProvider`, and there is no migration pass over users.json -
// this runs on read, so an account that is never touched again keeps
// working and one that is saved gets rewritten in the new shape for free.
function migrateAccountProviders(user) {
  if (!user) return user;
  const kind = user.connectionType === 'm3u' ? 'm3u' : 'xtream';

  if (Array.isArray(user.providers) && user.providers.length > 0) {
    user.providers = user.providers
      .map((raw, i) => normaliseProvider(raw, kind, i))
      .filter(Boolean)
      .slice(0, MAX_PROVIDERS);
    if (user.providers.length > 0) return dropLegacyConnection(user);
  }

  const legacy = kind === 'm3u' ? user.m3u : user.xtream;
  const provider = normaliseProvider(
    { ...(legacy || {}), label: 'Provider 1', streamcheckProvider: user.streamcheckProvider || '' },
    kind, 0
  );
  user.providers = provider ? [provider] : [];
  return provider ? dropLegacyConnection(user) : user;
}

// The old single-connection fields, removed once the array holds the same
// credentials. Leaving them would mean two copies of one password in
// users.json, with only one of them ever updated again - a stale secret
// on disk that nothing reads and nothing rotates.
function dropLegacyConnection(user) {
  delete user.xtream;
  delete user.m3u;
  return user;
}

function providersOf(user) {
  return (user && Array.isArray(user.providers)) ? user.providers : [];
}

// The provider a link, channel or reading belongs to.
//
// An empty providerId means the link was saved before the account had
// more than one provider, and the primary is the only thing it could have
// come from - so it resolves there rather than being dropped. An id that
// names a provider since deleted resolves there too: the link is stale
// either way, and pointing it at a live provider gives the healer a
// chance to find where the channel went.
function providerFor(user, providerId) {
  const list = providersOf(user);
  if (list.length === 0) return null;
  if (!providerId) return list[0];
  return list.find(entry => entry.id === providerId) || list[0];
}

function providerIdFor(user, providerId) {
  const provider = providerFor(user, providerId);
  return provider ? provider.id : '';
}

function providerLabelFor(user, providerId) {
  const provider = providerFor(user, providerId);
  return provider ? provider.label : '';
}

// The streamcheck.pro table a given provider's stream ids belong to, and
// whether it is in memory to be read.
function streamcheckTableFor(user, providerId) {
  const provider = providerFor(user, providerId);
  const table = (provider && provider.streamcheckProvider) || '';
  return (table && streamcheck.isLoaded(table)) ? table : '';
}

// Every streamcheck table this account names, deduplicated. Used by the
// panels that describe the account as a whole rather than one link.
function streamcheckTablesFor(user) {
  return [...new Set(providersOf(user)
    .map(entry => entry.streamcheckProvider)
    .filter(Boolean))];
}

// Credentials never leave the server for any provider but the account's
// own, and even then the dashboard is the only caller - so passwords ride
// along there and nowhere else.
// Three levels, because three different things ask.
//
//   default          - id and label only, for lists that merely need to
//                      say which service a row came from.
//   withConnection   - everything the Providers panel puts in a field.
//                      The password is not one of those: the panel shows
//                      it blank and means "unchanged", so it never has to
//                      travel back. For M3U this is the same as
//                      withSecrets, because the playlist URL carries the
//                      credentials in its own path and is also the thing
//                      the field displays.
//   withSecrets      - the above plus the password, for login and
//                      register, where the Edit panel prefills it.
//
// The panel MUST get withConnection on a save. It renders its fields from
// whatever comes back, and a newly added provider has no local copy to
// fall back on - it was created by that very request - so answering with
// the label-only form blanked the URL and username of the row that had
// just been saved.
function describeProvider(provider, { withConnection = false, withSecrets = false } = {}) {
  const base = {
    id: provider.id,
    label: provider.label,
    kind: provider.kind,
    streamcheckProvider: provider.streamcheckProvider || '',
  };
  if (provider.kind === 'm3u') {
    return (withConnection || withSecrets)
      ? { ...base, playlistUrl: provider.playlistUrl, epgUrl: provider.epgUrl || '' }
      : base;
  }
  base.streamFormat = provider.streamFormat || 'm3u8';
  if (!withConnection && !withSecrets) return base;
  const connection = { ...base, url: provider.url, username: provider.username };
  return withSecrets ? { ...connection, password: provider.password } : connection;
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
      userConfigs[uuid] = migrateAccountProviders({
        ...user,
        xtream: decryptXtreamFromStorage(user.xtream),
        m3u: decryptM3uFromStorage(user.m3u),
        providers: decryptProvidersFromStorage(user.providers),
        networkLinks: decryptNetworkLinksFromStorage(user.networkLinks),
        savedChannels: decryptSavedChannelsFromStorage(user.savedChannels)
      });
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
        providers: encryptProvidersForStorage(user.providers),
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
  // Every provider the account holds, because a preset saved from it can
  // pin ids from any of them - and a label naming only the first would
  // send somebody looking for a channel on a service that never had it.
  const hosts = providersOf(user).map(provider => {
    const raw = provider.kind === 'm3u' ? provider.playlistUrl : provider.url;
    try {
      return new URL(String(raw || '')).host;
    } catch (err) {
      return '';
    }
  }).filter(Boolean);
  return [...new Set(hosts)].join(', ');
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

// The leagues this app covers.
//
// Basketball, hockey, baseball and soccer were all removed once, on the
// grounds that nobody was reading them. Hockey, baseball and soccer are
// back; basketball is not. A league costs nothing to carry - every
// catalog, refresh and warm is driven by what an account actually
// selects - so this list is about what is worth offering, not about load.
//
// A key here is not automatically a browsable section. PFL and OTHER
// exist so the MMA section can fan out across promotions, and the five
// soccer competitions exist so the Soccer section can fan out across
// leagues; what an account can actually pick is SUPPORTED_SPORTS below,
// crossed with the dashboard's own list.
const ESPN_ENDPOINTS = {
  NFL: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard',
  NCAAFB: 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard',
  NHL: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard',
  MLB: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard',
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
  OTHER: 'https://site.api.espn.com/apis/site/v2/sports/mma/other/scoreboard',

  // The five soccer competitions the Soccer section fans out across - see
  // SOCCER_LEAGUES. Each is a real ESPN league with its own scoreboard,
  // its own badge and its own teams, which is why they are listed
  // individually rather than reached through ESPN's own 'soccer/all'
  // endpoint.
  //
  // That endpoint exists and was measured: 100 events, 70 of them NCAA
  // college soccer, and its `leagues` array comes back empty - so it
  // gives no competition identity, no badge, and a section three
  // quarters full of college fixtures. Naming the five costs five
  // entries and gets a real badge and a real label on every card.
  EPL: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard',
  LALIGA: 'https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard',
  SERIEA: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard',
  BUNDESLIGA: 'https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard',
  LIGUE1: 'https://site.api.espn.com/apis/site/v2/sports/soccer/fra.1/scoreboard'
};

// The Soccer section's competitions, in display order.
//
// Modelled on MMA_LEAGUES, and for the same reason: one section covering
// several ESPN leagues, so widening it is an entry here rather than a
// code path. `key` must exist in ESPN_ENDPOINTS above (for the badge),
// in SPORT_THEMES (for the poster colours) and in
// TEAM_LOGO_BUCKET_OVERRIDES (ESPN files every soccer team under the
// literal folder 'soccer', never the league's own slug) - the startup
// check below enforces all three.
//
// `label` is what the card is tagged with, and it rides in the same
// `conferences` field college football uses for its ACC/SEC chips. That
// is not a hack for want of a field: a competition is exactly the thing
// somebody wants to filter a mixed row of fifty fixtures down to, which
// is what that field already does.
const SOCCER_LEAGUES = [
  { key: 'EPL', label: 'Premier League' },
  { key: 'LALIGA', label: 'La Liga' },
  { key: 'SERIEA', label: 'Serie A' },
  { key: 'BUNDESLIGA', label: 'Bundesliga' },
  { key: 'LIGUE1', label: 'Ligue 1' }
];

// The browsable Soccer section. Not an ESPN league itself - it is the
// five above, merged - so it is named here rather than in
// ESPN_ENDPOINTS, the same way wrestling is.
const SOCCER_SPORT = 'SOCCER';

// How far ahead the Soccer section looks, in days.
//
// The third answer to the question fetchTodayGames' comment poses, and a
// deliberate one. These leagues are not daily: a club plays once or twice
// a week, so a today-only section is empty most days. They are not
// season-week either - ESPN publishes no round structure for them the way
// it does for the NFL, so there is no round to resolve.
//
// A week is the unit the competitions themselves run on, and it is what
// people mean by "what's on this week". Measured over the next 21 days it
// comes to about fifty fixtures a week across the five, which is the same
// order as a college football Saturday and filterable by competition.
const SOCCER_SCHEDULE_DAYS = 7;

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
const NCAA_GROUP_IDS = { NCAAFB: 80 };
const NCAA_SPORTS = new Set(Object.keys(NCAA_GROUP_IDS));

// The '&groups=N&limit=500' suffix for a sport, or '' if it needs none.
function getNcaaScoreboardParams(sportKey) {
  const groupId = NCAA_GROUP_IDS[sportKey.toUpperCase()];
  return groupId ? `&groups=${groupId}&limit=500` : '';
}

// Wrestling is not an ESPN sport - they carry none at all - so it has no
// entry in the tables above and cannot be recognised by looking for one.
// Every gate that used to ask "does ESPN know this" asks this instead.
const WRESTLING_SPORT = 'WRESTLING';
const SUPPORTED_SPORTS = new Set([...Object.keys(ESPN_ENDPOINTS), WRESTLING_SPORT, SOCCER_SPORT]);

const ESPN_LEAGUES = {
  NFL: 'nfl',
  NCAAFB: 'college-football',
  NHL: 'nhl',
  MLB: 'mlb',
  UFC: 'ufc',
  PFL: 'pfl',
  OTHER: 'other',
  EPL: 'eng.1',
  LALIGA: 'esp.1',
  SERIEA: 'ita.1',
  BUNDESLIGA: 'ger.1',
  LIGUE1: 'fra.1'
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
  // Confirmed live - ESPN buckets ALL NCAA team logos under the literal
  // folder 'ncaa', not each sport's own league slug (NOT
  // 'college-football', which is what the fallback would otherwise use).
  NCAAFB: 'ncaa',

  // And every soccer club under the literal folder 'soccer', whatever
  // league it plays in - so eng.1, esp.1, ita.1, ger.1 and fra.1 all need
  // this, or each would look for its badges under its own slug and find
  // nothing.
  EPL: 'soccer',
  LALIGA: 'soccer',
  SERIEA: 'soccer',
  BUNDESLIGA: 'soccer',
  LIGUE1: 'soccer',
  SOCCER: 'soccer'
};

// The trailing fallback is the key itself, which is what ESPN's own
// paths use for most leagues. It only comes up for a sport this app no
// longer knows, where the logo is going to 404 whatever is guessed - the
// point is to guess something shaped like a bucket rather than to name
// a league that has been removed.
function getTeamLogoBucket(sportKey) {
  return TEAM_LOGO_BUCKET_OVERRIDES[sportKey] || ESPN_LEAGUES[sportKey]
    || String(sportKey || '').toLowerCase();
}

// Friendly names for sports whose internal key isn't already a clean label.
// Anything not listed here just displays as its own key (e.g. NFL).
const SPORT_DISPLAY_NAMES = {
  NCAAFB: 'College Football',
  WRESTLING: 'Wrestling',
  SOCCER: 'Soccer',
  // The five competitions the Soccer section merges. They are never
  // sections of their own, but a card carries its league key, so these
  // are what a card is labelled with.
  EPL: 'Premier League',
  LALIGA: 'La Liga',
  SERIEA: 'Serie A',
  BUNDESLIGA: 'Bundesliga',
  LIGUE1: 'Ligue 1',
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

// Every image this app draws is a static ESPN asset - a team mark, a
// league mark, a fighter headshot, a flag - and none of them change
// more than once in a decade. They were nonetheless refetched on every
// poster render, so a single college football slate meant a couple of
// hundred round trips to espncdn before one image reached the screen.
//
// Cached to disk under the data directory, which is the bind-mounted
// volume, so the cache survives a container restart rather than being
// paid for again on every deploy. Stored as the finished data URI
// rather than as raw bytes: that is what every caller wants, so a hit
// costs one file read and no re-encoding. It is a third larger on disk
// than the PNG, which for a few hundred team marks is a few megabytes -
// and the set is bounded by the number of teams that exist, so there is
// nothing here to evict.
const IMAGE_CACHE_DIR = path.join(DATA_DIR, 'image-cache');
const IMAGE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Misses expire far sooner than hits. A 404 today can be a logo ESPN
// has not published yet, and remembering it for a month would leave the
// team blank long after the mark went up.
const IMAGE_MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Serving an expired copy is a stopgap, not an answer, so it is held
// for minutes rather than for the month a fresh one gets.
const IMAGE_STALE_MEMO_MS = 5 * 60 * 1000;

const imageMemo = new Map();

function imageCachePath(url, suffix) {
  return path.join(IMAGE_CACHE_DIR, crypto.createHash('sha1').update(url).digest('hex') + suffix);
}

// The cached data URI, or null when nothing on disk is younger than
// maxAgeMs. Pass Infinity to take whatever is there at any age.
function readCachedImage(url, maxAgeMs) {
  try {
    const file = imageCachePath(url, '.datauri');
    if (Date.now() - fs.statSync(file).mtimeMs > maxAgeMs) return null;
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    return null;
  }
}

function hasCachedMiss(url) {
  try {
    return (Date.now() - fs.statSync(imageCachePath(url, '.miss')).mtimeMs) <= IMAGE_MISS_TTL_MS;
  } catch (err) {
    return false;
  }
}

function writeImageCacheFile(url, suffix, body) {
  try {
    fs.mkdirSync(IMAGE_CACHE_DIR, { recursive: true });
    const target = imageCachePath(url, suffix);
    // Written under a temporary name and renamed into place. A torn
    // write would otherwise leave a truncated data URI behind, and a
    // truncated data URI is a broken image that looks cached and
    // correct for the next thirty days.
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, target);
  } catch (err) {
    console.error(`[ImageCache] Could not cache ${url}: ${err.message}`);
  }
}

function rememberImage(url, value, ttlMs = IMAGE_CACHE_TTL_MS) {
  imageMemo.set(url, { value, expires: Date.now() + ttlMs });
  return value;
}

async function getBase64Image(url) {
  const memo = imageMemo.get(url);
  if (memo && memo.expires > Date.now()) return memo.value;

  const cached = readCachedImage(url, IMAGE_CACHE_TTL_MS);
  if (cached !== null) return rememberImage(url, cached);
  if (hasCachedMiss(url)) return rememberImage(url, null, IMAGE_MISS_TTL_MS);

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
    const dataUri = `data:${contentType};base64,${base64}`;
    writeImageCacheFile(url, '.datauri', dataUri);
    return rememberImage(url, dataUri);
  } catch (err) {
    // A mark we already hold beats a mark we cannot reach: an expired
    // copy is served rather than dropping the team's logo off the
    // poster because espncdn had a bad minute.
    const stale = readCachedImage(url, Infinity);
    if (stale !== null) return rememberImage(url, stale, IMAGE_STALE_MEMO_MS);

    // Only a refusal is remembered. A timeout or a 5xx says nothing
    // about whether the image exists, and writing a miss for one would
    // blank the team for a week over a moment's trouble.
    const status = err.response && err.response.status;
    if (status >= 400 && status < 500) writeImageCacheFile(url, '.miss', '');

    console.error(`[ImageLoader] Failed to fetch image: ${url}. Error: ${err.message}`);
    return null;
  }
}

// ESPN publishes a scoreboard-cropped variant of each team mark beside
// the standard one, keyed by abbreviation rather than by id, and it is
// tried first because it is what ESPN's own scoreboard uses.
//
// The ncaa bucket has no scoreboard variant at all - measured, and both
// the abbreviation and the id 404 under it - while college football
// alone puts around 120 teams on screen at once. Asking for one there
// was a guaranteed-failed request per team per slate, which is what
// filled the log with fetch failures for images that then loaded fine
// from the standard URL a moment later.
//
// Soccer is the same, and was measured the same way: scoreboard/lyon.png,
// scoreboard/liv.png and scoreboard/rma.png all 404 while 500/167.png and
// 500/364.png return the badge. A week of five leagues is around fifty
// fixtures and a hundred crests, so leaving it in would have put a
// hundred failed requests behind every Soccer tab.
const NO_SCOREBOARD_LOGO_BUCKETS = new Set(['ncaa', 'soccer']);

function teamLogoUrls(league, abbr, id) {
  const urls = [];
  if (abbr && !NO_SCOREBOARD_LOGO_BUCKETS.has(league)) {
    urls.push(`https://a.espncdn.com/i/teamlogos/${league}/500/scoreboard/${abbr}.png`);
  }
  if (id) urls.push(`https://a.espncdn.com/i/teamlogos/${league}/500/${id}.png`);
  return urls;
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
// dateOnly is for an event whose start time has not been published.
// Its instant is midday as a placeholder, and printing that as "12:00 pm"
// would state a time nobody announced.
function formatEventWhen(utcDateStr, timeZone, { dateOnly = false } = {}) {
  if (!utcDateStr) return '';
  if (dateOnly) return formatEventDate(utcDateStr, timeZone) || '';
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

// ---------------------------------------------------------------------
// Rendered art cache
// ---------------------------------------------------------------------
//
// A poster is a 140KB SVG template carried through several rewriting
// passes with two base64 logos spliced into it, and about 250KB comes
// out the other end - roughly a megabyte of short-lived strings per
// card. A full college football slate is 77 of them, which is the whole
// of what is left of the memory spike when the watch page opens.
//
// None of that work depends on anything but the request URL. Every
// input - the teams, their colours, the kickoff, the timezone - arrives
// as a path or query parameter, so the URL names the output exactly.
// That makes the art cacheable as a plain file keyed by the URL, and a
// hit costs one read and no rendering at all.
//
// Unlike the team logos, this set is not bounded: it grows with games
// per week, week after week, so it needs a ceiling and a way to come
// back under it. Hence the budget and the sweep below.
const RENDER_CACHE_DIR = path.join(DATA_DIR, 'render-cache');
const RENDER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RENDER_CACHE_BUDGET_BYTES =
  Math.max(16, Number(process.env.SPORTIO_RENDER_CACHE_MB) || 256) * 1024 * 1024;
// Swept back to well under the ceiling rather than just under it, so a
// busy slate is not re-sweeping on every render once it first fills up.
const RENDER_CACHE_LOW_WATER = 0.8;

// key -> { size, bornAt, usedAt, maxAge }. Held in memory because the
// sweep needs every entry's size and age at once, and statting the whole
// directory to find that out would be the expensive part of a cheap
// operation.
const renderIndex = new Map();
let renderCacheBytes = 0;

// What the cache is keyed on, besides the URL.
//
// A URL says what to draw but nothing about the code that drew it, so
// when the art changed every entry already on disk became a picture of
// the old design that kept being served for its full seven days. That is
// exactly what happened when the football posters were redrawn: the
// cards nobody had loaded since came out new, and every one already held
// stayed old - which reads as the change half-working rather than as a
// stale cache.
//
// So the key carries a fingerprint of everything that decides what a
// render looks like: the drawing code and the template art. Deploy a
// change to any of it and the whole cache moves to a new generation,
// with the previous one falling out under the sweep. Computed rather
// than declared, because a version constant is only correct while
// somebody remembers to bump it.
const RENDER_FINGERPRINT = (() => {
  const hash = crypto.createHash('sha1');
  const inputs = [__filename, path.join(__dirname, 'posters.js')];
  for (const dir of ['posters', 'background']) {
    const full = path.join(__dirname, 'assets', dir);
    try {
      for (const name of fs.readdirSync(full).sort()) {
        if (name.endsWith('.svg')) inputs.push(path.join(full, name));
      }
    } catch (err) {
      // No such directory on this install; nothing to fingerprint.
    }
  }
  for (const file of inputs) {
    try {
      hash.update(fs.readFileSync(file));
    } catch (err) {
      // Unreadable counts as its own state - the name still goes in, so
      // a file appearing or disappearing changes the generation.
      hash.update(file);
    }
  }
  return hash.digest('hex').slice(0, 12);
})();

// The cache lifetime the route asked for travels in the filename, so a
// restart can rebuild the index from the directory alone - the logo art
// is good for a day where a game poster is good for an hour, and a
// served copy has to keep saying so.
function renderCacheFile(key, maxAge) {
  return path.join(RENDER_CACHE_DIR, `${key}.${maxAge}.svg`);
}

function parseRenderCacheName(name) {
  const m = /^([0-9a-f]{40})\.(\d+)\.svg$/.exec(name);
  return m ? { key: m[1], maxAge: Number(m[2]) } : null;
}

function forgetRender(key) {
  const entry = renderIndex.get(key);
  if (!entry) return;
  renderIndex.delete(key);
  renderCacheBytes -= entry.size;
  try {
    fs.rmSync(renderCacheFile(key, entry.maxAge), { force: true });
  } catch (err) {
    // Already gone, or held open by something else. The index no longer
    // points at it either way, which is what matters.
  }
}

// Expired entries first, then least recently used, until the cache is
// back under the low-water mark.
function sweepRenderCache() {
  for (const [key, entry] of renderIndex) {
    if ((Date.now() - entry.bornAt) > RENDER_CACHE_TTL_MS) forgetRender(key);
  }
  if (renderCacheBytes <= RENDER_CACHE_BUDGET_BYTES) return;

  const target = RENDER_CACHE_BUDGET_BYTES * RENDER_CACHE_LOW_WATER;
  const byAge = [...renderIndex.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt);
  let dropped = 0;
  for (const [key] of byAge) {
    if (renderCacheBytes <= target) break;
    forgetRender(key);
    dropped++;
  }
  console.log(`[Render cache] Over budget - dropped ${dropped} of the least recently used,` +
    ` now holding ${(renderCacheBytes / 1048576).toFixed(0)} MB.`);
}

function storeRender(key, maxAge, body) {
  try {
    fs.mkdirSync(RENDER_CACHE_DIR, { recursive: true });
    const target = renderCacheFile(key, maxAge);
    // Temp name and rename, so a reader never picks up half an SVG.
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, target);

    forgetRender(key);
    const size = Buffer.byteLength(body);
    renderIndex.set(key, { size, bornAt: Date.now(), usedAt: Date.now(), maxAge });
    renderCacheBytes += size;
    sweepRenderCache();
  } catch (err) {
    console.error(`[Render cache] Could not store a render: ${err.message}`);
  }
}

// Rebuilt from the directory rather than from a saved index, so a
// half-written index or a manually deleted file cannot leave the two
// disagreeing. mtime stands in for both ages: it is when the file was
// written, and after a restart nothing better is known about when it was
// last wanted.
function loadRenderCacheIndex() {
  try {
    fs.mkdirSync(RENDER_CACHE_DIR, { recursive: true });
    for (const name of fs.readdirSync(RENDER_CACHE_DIR)) {
      const parsed = parseRenderCacheName(name);
      if (!parsed) {
        // A leftover .tmp from a process that died mid-write.
        if (name.endsWith('.tmp')) fs.rmSync(path.join(RENDER_CACHE_DIR, name), { force: true });
        continue;
      }
      const stat = fs.statSync(path.join(RENDER_CACHE_DIR, name));
      renderIndex.set(parsed.key, {
        size: stat.size, bornAt: stat.mtimeMs, usedAt: stat.mtimeMs, maxAge: parsed.maxAge
      });
      renderCacheBytes += stat.size;
    }
    // Swept before it is reported, so the count is what is actually
    // being kept rather than what was found lying there.
    sweepRenderCache();
    if (renderIndex.size > 0) {
      console.log(`[Render cache] Holding ${renderIndex.size} rendered images,` +
        ` ${(renderCacheBytes / 1048576).toFixed(0)} MB (generation ${RENDER_FINGERPRINT}).`);
    }
  } catch (err) {
    console.error(`[Render cache] Could not read ${RENDER_CACHE_DIR}: ${err.message}`);
  }
}

loadRenderCacheIndex();

// Serves a stored render, or lets the route build one and keeps it.
//
// Mounted on the art prefixes rather than wired into each route: there
// are eleven of them, they all answer with an SVG built purely from the
// URL, and a rule that holds for all of them belongs in one place.
function cacheRenderedSvg(req, res, next) {
  const key = crypto.createHash('sha1')
    .update(`${RENDER_FINGERPRINT} ${req.originalUrl}`).digest('hex');
  const entry = renderIndex.get(key);

  if (entry && (Date.now() - entry.bornAt) <= RENDER_CACHE_TTL_MS) {
    try {
      const body = fs.readFileSync(renderCacheFile(key, entry.maxAge));
      entry.usedAt = Date.now();
      // charset included to match exactly what Express sends when the
      // route builds the same SVG as a string. A team name can carry an
      // accent, and a cached response must not describe itself
      // differently from a freshly rendered one.
      res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      res.setHeader('Cache-Control', `public, max-age=${entry.maxAge}`);
      return res.send(body);
    } catch (err) {
      // The file went missing under us. Fall through and rebuild it.
      forgetRender(key);
    }
  }

  const send = res.send.bind(res);
  res.send = (body) => {
    const result = send(body);
    // Only a successful SVG, and only one built as a string - the hit
    // path above answers with a Buffer, and re-storing what was just
    // read would be pure churn.
    const type = String(res.getHeader('Content-Type') || '');
    if (res.statusCode === 200 && typeof body === 'string' && type.includes('svg')) {
      const maxAge = /max-age=(\d+)/.exec(String(res.getHeader('Cache-Control') || ''));
      // Stored after the response has gone out, so nothing waits on the
      // disk write.
      storeRender(key, maxAge ? Number(maxAge[1]) : 3600, body);
    }
    return result;
  };
  next();
}

app.use(['/poster', '/landscape', '/logo', '/network'], cacheRenderedSvg);

// Registered BEFORE the generic team-based poster route below. The bare
// path has the same segment count (/poster/X/Y/Z.svg) and Express matches
// in registration order, so the more specific one has to come first or it
// would never be reached. The league-scoped path has an extra segment and
// cannot collide, but is kept here beside its twin.
// A search bucket's terms, saved on their own rather than through the
// whole-account update - the panel that edits them sits inside a network
// section and has nothing else to send.
app.post('/api/networks/search-terms/save', async (req, res) => {
  const auth = await authenticateForChannels(req, res);
  if (!auth) return;

  const key = String(req.body.key || '').toUpperCase();
  if (!networks.isSearchNetwork(key)) {
    return res.status(400).json({ error: 'That section does not hold search terms.' });
  }

  const merged = { ...readSearchTerms(auth.user), [key]: req.body.terms };
  auth.user.searchTerms = readSearchTerms({ searchTerms: merged });
  await saveUserConfigs();

  return res.json({ success: true, searchTerms: readSearchTerms(auth.user) });
});

// Auto-pick: preview it, change its settings, or run it now.
//
// One endpoint with an action rather than three, because all three need
// the same expensive setup - an authenticated account with its playlist
// resolved - and preview is what the other two are judged against.
app.post('/api/networks/autopick', async (req, res) => {
  const auth = await authenticateForChannels(req, res);
  if (!auth) return;

  const user = auth.user;
  const action = req.body.action || 'preview';
  const tables = streamcheckTablesFor(user);

  // Asked for explicitly here rather than left to whatever happens to be
  // in memory. Everything on this screen is a judgement about published
  // readings, and a page that quietly showed "no data" because nobody had
  // triggered a load yet would be telling the user something false about
  // their provider.
  await Promise.all(tables
    .filter(table => !streamcheck.isLoaded(table))
    .map(table => streamcheck.ensureProvider(table)));

  if (action === 'save') {
    user.autoPick = {
      ...readAutoPick({ autoPick: req.body }),
      lastRun: readAutoPick(user).lastRun,
      lastRunDate: readAutoPick(user).lastRunDate,
    };
    await saveUserConfigs();
  }

  // The category filter applies, the quality filter does not.
  //
  // channelsForSearch would hide anything the account's own published
  // filter rejects, and auto-pick is the tool for choosing between
  // published readings - running it over a list already narrowed by them
  // would mean a filter set to "1080p60 only" made 1080p60 the only thing
  // auto-pick could ever find, and then reported that as a finding.
  const selected = Array.isArray(user.searchCategories) ? user.searchCategories : [];
  const channels = selected.length
    ? auth.source.channels.filter(c => (c.categories || []).some(cat => selected.includes(cat)))
    : auth.source.channels;

  // The dashboard asks about every network, not only the ones already
  // enabled: "which of these should I hand over" is the question the panel
  // exists to answer, and it cannot be answered by a row reading "not
  // previewed". Affordable because a full pass over a 57,000-channel
  // playlist is under a second - it was six until the rule terms stopped
  // being re-split for every channel.
  const asked = req.body.previewAll
    ? autopick.autoPickableNetworks()
    : (Array.isArray(req.body.networks)
      ? req.body.networks.filter(k => typeof k === 'string' && autopick.DEFAULT_RULES[k])
      : []);

  let outcome;
  if (action === 'apply') {
    // No rules override. An apply writes to the account, and it writes
    // what was saved and reviewed - not whatever is half-typed in a text
    // box. The dashboard saves before it runs, so the two never disagree
    // on screen.
    outcome = applyAutoPick(user, channels, { networks: asked });
    if (outcome.applied && outcome.applied.length > 0) {
      user.autoPick = {
        ...readAutoPick(user),
        lastRun: new Date().toISOString(),
        lastRunDate: accountRunDate(user),
      };
      await saveUserConfigs();
    }
  } else {
    // An absent `rules` means "use what is saved", NOT "use no
    // overrides". The two look identical once normalised - both arrive as
    // an empty object - and reading them the same way made a preview that
    // omitted the field silently answer for the DEFAULT rules while the
    // account had its own saved. That is the one thing this endpoint must
    // never do: the preview's whole job is to show what the unattended
    // run will do.
    const sentRules = req.body.rules && typeof req.body.rules === 'object'
      && !Array.isArray(req.body.rules);

    outcome = computeAutoPick(user, channels, {
      networks: asked,
      rules: sentRules ? readAutoPick({ autoPick: req.body }).rules : undefined,
    });
  }

  const settings = readAutoPick(user);

  return res.json({
    success: true,
    // Per provider, because an account can have published data for one
    // service and none for the other, and a single "loaded" flag would
    // have to lie about one of them. `loaded` stays as the answer to "is
    // there anything at all to judge by", which is what gates the panel.
    providers: providersOf(user).map(entry => ({
      id: entry.id,
      label: entry.label,
      table: entry.streamcheckProvider || '',
      loaded: !!entry.streamcheckProvider && streamcheck.isLoaded(entry.streamcheckProvider),
      runDate: streamcheckRunDate(entry.streamcheckProvider),
    })),
    perProviderLimit: autoPickLimitFor(providersOf(user).length),
    loaded: tables.some(table => streamcheck.isLoaded(table)),
    runDate: accountRunDate(user),
    enabled: settings.networks,
    lastRun: settings.lastRun,
    lastRunDate: settings.lastRunDate,
    // The rules as they will actually be applied - defaults with the
    // account's edits already folded in - so the dashboard renders one
    // set of terms rather than two the user has to reconcile.
    rules: Object.fromEntries(autopick.autoPickableNetworks()
      .map(key => [key, autopick.rulesFor(key, settings.rules)])),
    labels: Object.fromEntries(autopick.autoPickableNetworks()
      .map(key => [key, networks.getNetworkLabel(key)])),
    bands: autopick.BANDS.map(b => b.name),
    minFps: autopick.MIN_FPS,
    ready: outcome.ready,
    results: outcome.results,
    applied: outcome.applied || [],
  });
});

// A promotion's card. Drawn from its name and number, with no artwork
// fetched: the promotion's own graphics come in mixed shapes, none of
// them 2:3, and a poster built around them was mostly letterboxing.
app.get('/poster/wrestling/:promotion.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.send(posters.buildEventPoster({
    code: req.query.code || '',
    title: req.query.title || '',
    place: req.query.place || '',
    accent: SPORT_THEMES[WRESTLING_SPORT].secondary,
  }));
});

app.get('/poster/mma/:league.svg', mmaPosterHandler);
app.get('/poster/mma/:league/:fighterAId/:fighterBId.svg', mmaPosterHandler);
app.get('/poster/ufc/:fighterAId/:fighterBId.svg', mmaPosterHandler);

function getPosterTemplateInline() {
  const filePath = path.join(__dirname, 'assets', 'posters', 'poster_template.svg');
  return getInlineSvgOverlay(filePath, 'poster-template');
}

// Every team sport with two sides. Football first, then the rest once
// their own marks had been looked at the same way - which was the
// condition this list used to state.
//
// That look was an audit of every fixture these leagues are actually
// playing, run through splitColors: 201 MLB, 124 NHL and 109 across the
// five soccer competitions. Every team in all seven has a published
// colour, so none of them falls through to the sport's generic theme,
// and after the split no pair is left too close to read as two halves.
//
// The one thing that differs by sport is the rescue. MLB and soccer
// publish an alternate colour for every club, so a clash resolves to a
// real team colour. NHL publishes none at all - 124 of 124 fixtures - so
// there it is the shade step alone that separates the halves, which is
// why that step now keeps going until it works rather than taking one
// swing (see splitColors).
const DRAWN_POSTER_SPORTS = new Set([
  'NFL', 'NCAAFB', 'MLB', 'NHL',
  'EPL', 'LALIGA', 'SERIEA', 'BUNDESLIGA', 'LIGUE1',
]);

app.get('/poster/:sport/:homeId/:awayId.svg', async (req, res) => {
  const { sport, homeId, awayId } = req.params;
  const gameUtcDate = req.query.date || null;
  const userTz = req.query.tz || 'America/New_York';
  const homeName = req.query.home || 'Home';
  const awayName = req.query.away || 'Away';
  const sportKey = sport.toUpperCase();
  const league = getTeamLogoBucket(sportKey);
  const theme = SPORT_THEMES[sportKey] || DEFAULT_THEME;

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

  const [homeLogoData, awayLogoData] = await Promise.all([
    getBase64ImageWithFallback(teamLogoUrls(league, homeAbbr, homeId)),
    getBase64ImageWithFallback(teamLogoUrls(league, awayAbbr, awayId))
  ]);

  if (DRAWN_POSTER_SPORTS.has(sportKey)) {
    // The raw query values, not the resolved homeColor/awayColor above:
    // that pair has already collapsed primary and alternate into one
    // colour, and the art needs them apart - the alternate is what a
    // clash between the two teams is resolved with.
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(posters.buildMatchupPoster({
      awayLogoData, homeLogoData, awayName, homeName,
      awayColor: req.query.awayColor || req.query.awayAltColor || theme.primary,
      homeColor: req.query.homeColor || req.query.homeAltColor || theme.secondary,
      homeAltColor: req.query.homeAltColor || '',
    }));
  }

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
  NFL: { primary: '#013369', secondary: '#D50A0A' },
  WRESTLING: { primary: '#0B1B2B', secondary: '#C8102E' },
  NCAAFB: { primary: '#013369', secondary: '#D50A0A' },
  NHL: { primary: '#000000', secondary: '#41B6E6' },
  MLB: { primary: '#0C2340', secondary: '#BA0C2F' },
  // Each soccer competition keeps its own colours rather than sharing one
  // "soccer" palette. A Soccer row mixes five leagues, and the accent is
  // the cheapest way to tell at a glance which one a card belongs to -
  // the same reason each card carries its own badge. SOCCER itself is the
  // section's own colour, used where the section is drawn rather than a
  // fixture.
  SOCCER: { primary: '#0B6E4F', secondary: '#8FD694' },
  EPL: { primary: '#3D195B', secondary: '#00FF85' },
  LALIGA: { primary: '#EE8707', secondary: '#000000' },
  SERIEA: { primary: '#0A2240', secondary: '#00A650' },
  BUNDESLIGA: { primary: '#D20515', secondary: '#000000' },
  LIGUE1: { primary: '#091C3E', secondary: '#DAE021' },
  UFC: { primary: '#000000', secondary: '#D20A0A' },
  PFL: { primary: '#0A0A0A', secondary: '#E4002B' },
  OTHER: { primary: '#1A1A1A', secondary: '#B31217' }
};

// Used when a sport has no theme of its own, which since the other
// leagues were removed means a stale saved selection. Neutral on
// purpose: it used to fall through to baseball's navy and red, which
// dressed an unknown sport in a specific league's colours.
const DEFAULT_THEME = { primary: '#1E293B', secondary: '#64748B' };

// Primary accent used for the subtle poster background gradient per sport.
function getSportMotif(sportKey, accentColor, opacity) {
  // Each case keeps its own tuned value as the default - they differ on
  // purpose - and a caller that needs the mark at full strength, like
  // the logo route, passes one instead.
  const o = (tuned) => (opacity === undefined ? tuned : opacity);
  switch (sportKey) {
    case 'MLB':
      return `
        <g transform="translate(1500,540)" opacity="${o(0.18)}" stroke="${accentColor}" stroke-width="6" fill="none">
          <circle r="380" />
          <path d="M -260,-280 A 380,380 0 0,1 -260,280" stroke-dasharray="14 10" />
          <path d="M 260,-280 A 380,380 0 0,0 260,280" stroke-dasharray="14 10" />
        </g>`;
    // The mat: the outer boundary, the passivity zone and the centre
    // circle. Same shapes posters.js already draws on the stock wrestling
    // card, so the section's mark and its cards agree.
    //
    // Wrestling had no motif at all, which until the logo route learned
    // to draw one only meant a plain landscape. Now it is also what the
    // section's own badge is made of, since ESPN carries no wrestling and
    // there is no badge to fetch.
    case 'WRESTLING':
      return `
        <g transform="translate(1500,540)" opacity="${o(0.16)}" stroke="${accentColor}" stroke-width="6" fill="none">
          <circle r="380" />
          <circle r="300" stroke-dasharray="18 12" />
          <circle r="120" />
          <line x1="-120" y1="0" x2="120" y2="0" />
        </g>`;
    case 'NHL':
      return `
        <g transform="translate(1500,540)" opacity="${o(0.18)}" stroke="${accentColor}" stroke-width="6" fill="none">
          <circle r="380" />
          <circle r="60" fill="${accentColor}" opacity="0.5" stroke="none" />
          <line x1="-460" y1="0" x2="-260" y2="0" stroke-width="14" />
          <line x1="260" y1="0" x2="460" y2="0" stroke-width="14" />
        </g>`;
    // A pitch seen from above, not a ball: the centre circle, the halfway
    // line and the two penalty areas. Drawn rather than fetched, like
    // every other motif here - it is a background, and a real crest at
    // this opacity would read as a smudge.
    //
    // Shared by the section and all five competitions, because they are
    // the same game. Only the accent differs, and that comes from the
    // theme.
    case 'SOCCER':
    case 'EPL':
    case 'LALIGA':
    case 'SERIEA':
    case 'BUNDESLIGA':
    case 'LIGUE1':
      return `
        <g transform="translate(1500,540)" opacity="${o(0.16)}" stroke="${accentColor}" stroke-width="6" fill="none">
          <rect x="-460" y="-330" width="920" height="660" />
          <line x1="0" y1="-330" x2="0" y2="330" />
          <circle r="130" />
          <circle r="10" fill="${accentColor}" stroke="none" />
          <rect x="-460" y="-180" width="120" height="360" />
          <rect x="340" y="-180" width="120" height="360" />
        </g>`;
    case 'NFL':
    case 'NCAAFB':
      return `
        <g transform="translate(1500,540)" opacity="${o(0.16)}" stroke="${accentColor}" stroke-width="10">
          <line x1="-420" y1="-300" x2="420" y2="-300" />
          <line x1="-420" y1="-150" x2="420" y2="-150" />
          <line x1="-420" y1="0" x2="420" y2="0" />
          <line x1="-420" y1="150" x2="420" y2="150" />
          <line x1="-420" y1="300" x2="420" y2="300" />
        </g>`;
    default:
      return '';
  }
}

app.get('/landscape/:sport.svg', (req, res) => {
  const sportKey = req.params.sport.toUpperCase();
  const theme = SPORT_THEMES[sportKey] || DEFAULT_THEME;
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
  const theme = SPORT_THEMES[sportKey] || DEFAULT_THEME;

  const homeName = req.query.home || 'Home';
  const awayName = req.query.away || 'Away';
  const homeColor = req.query.homeColor ? `#${req.query.homeColor}` : theme.secondary;
  const awayColor = req.query.awayColor ? `#${req.query.awayColor}` : theme.primary;
  const homeAbbr = (req.query.homeAbbr || '').toLowerCase();
  const awayAbbr = (req.query.awayAbbr || '').toLowerCase();

  // Same scoreboard-first, standard-logo-fallback chain as the poster.
  const [homeLogoData, awayLogoData] = await Promise.all([
    getBase64ImageWithFallback(teamLogoUrls(league, homeAbbr, homeId)),
    getBase64ImageWithFallback(teamLogoUrls(league, awayAbbr, awayId))
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
// logos mostly do. Measured back when this app carried more leagues:
// baseball's real logo lived at teamlogos/leagues/500/mlb.png, while the
// Premier League's lived at leaguelogos/soccer/500/23.png - a completely
// different base path AND a numeric id rather than the league slug. That
// directly contradicted what this route used to assume, which is why
// soccer and NCAA sports were silently getting no logo. Rather than hunting
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

  // A section that is not an ESPN league has no badge to fetch, and
  // until now got a blank square. Wrestling has been served one all
  // along, and Soccer would be the second: both are sections built from
  // something other than a single league, so there is no one mark that
  // belongs to them.
  //
  // Drawn instead, from the same motif the landscape background uses -
  // which is the app's existing answer to "there is no artwork for
  // this", and reads as a deliberate mark rather than a failed fetch.
  const theme = SPORT_THEMES[sportKey] || DEFAULT_THEME;
  // The motif draws itself around a point at (1500,540) in the 1920x1080
  // background, so it is moved to the centre of this square box and
  // scaled to sit inside it. Full strength rather than the background's
  // 0.16, which would be invisible as a mark.
  const logoMarkup = logoData
    ? `<image href="${logoData}" x="0" y="0" width="1080" height="1080" preserveAspectRatio="xMidYMid meet" />`
    : `<rect width="1080" height="1080" fill="${theme.primary}" />
       <g transform="translate(540,540) scale(0.95) translate(-1500,-540)">
         ${getSportMotif(sportKey, theme.secondary, 0.85)}
       </g>`;

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
  // There is no conference gate here any more. It used to drop every game
  // without a Power 4 team in it, which cut a 99-game September Saturday
  // to about 60 - and also meant the MAC, the Sun Belt and Conference USA
  // had no schedule in this app at all. The catalog now carries the whole
  // FBS slate tagged with rank and conference, and the narrowing happens
  // where somebody can see and change it.
  NCAAFB: { seasonTypes: [2, 3], mergedSeasonTypes: [3] }
};

// Every FBS conference, read from ESPN rather than written down here.
//
// This used to be four hardcoded ids - the P4 - and a filter that dropped
// every game without one of them in it. That cut a 99-game September
// Saturday to about 60, which was the point at the time, but it also
// meant the MAC, the Sun Belt and Conference USA simply did not exist in
// this app. The narrowing is now done by rank and by the account's own
// hidden-conference list, so the schedule itself no longer has to be
// short.
//
// ESPN publishes the list on the scoreboard's own conferences endpoint,
// with each FBS conference carrying parentGroupId 80. Reading it means
// realignment, a renamed conference or a new one all arrive on their own
// - and it is the same source the group=80 scoreboard query already uses,
// so the two cannot disagree about what FBS is.
const FBS_GROUP_ID = '80';
const CONFERENCES_URL =
  'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard/conferences';

// The Power 4, by ESPN's own conference ids: ACC, Big 12, Big Ten, SEC.
//
// Written down rather than read, because it is not a thing ESPN
// publishes - there is no flag on a conference saying it is one of the
// four, and there could not be: "Power 4" is an editorial grouping that
// changes when the sport rearranges itself, not a property of the
// competition. This is the one place it is asserted.
//
// It no longer decides which games exist - that gate is gone and the
// whole FBS slate is carried - it decides which games the watch portal
// opens on. The Pac-12 (id 9) is deliberately absent: its current
// membership is the rebuilt one, which is not what Power 4 means.
const P4_CONFERENCE_IDS = new Set(['1', '4', '5', '8']);

// A fixture list, effectively: conferences change once a year and the
// endpoint is small. Long cache, one in-flight fetch, and a failure keeps
// whatever was last read.
const CONFERENCE_CACHE_MS = 24 * 60 * 60 * 1000;
let conferenceCache = { byId: new Map(), list: [], fetchedAt: 0 };
let conferenceInFlight = null;

async function fetchConferences() {
  const res = await axios.get(CONFERENCES_URL, { timeout: 10000 });
  const raw = (res.data && res.data.conferences) || [];
  const list = raw
    .filter(c => String(c.parentGroupId || '') === FBS_GROUP_ID)
    .map(c => ({
      id: String(c.groupId || c.id || ''),
      // shortName is what fits on a chip - "Big Ten", not "Big Ten
      // Conference" - and is what ESPN itself puts on a scoreboard.
      name: String(c.shortName || c.name || '').trim(),
      fullName: String(c.name || '').trim(),
      // Sent to the portal rather than worked out there, so the grouping
      // is asserted once on the server instead of a second copy of four
      // ids drifting in a page.
      p4: P4_CONFERENCE_IDS.has(String(c.groupId || c.id || '')),
    }))
    .filter(c => c.id && c.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { byId: new Map(list.map(c => [c.id, c])), list, fetchedAt: Date.now() };
}

async function ensureConferences() {
  if (conferenceCache.list.length > 0 && Date.now() - conferenceCache.fetchedAt < CONFERENCE_CACHE_MS) {
    return conferenceCache;
  }
  if (conferenceInFlight) return conferenceInFlight;

  conferenceInFlight = (async () => {
    try {
      conferenceCache = await fetchConferences();
      console.log(`[Conferences] ${conferenceCache.list.length} FBS conferences loaded.`);
    } catch (err) {
      // Soft, like every other third-party read here. An empty list means
      // games are tagged with no conference and the filter offers nothing
      // - the schedule itself is unaffected.
      console.error('[Conferences] Could not load the FBS list:', err.message);
    } finally {
      conferenceInFlight = null;
    }
    return conferenceCache;
  })();
  return conferenceInFlight;
}

function listConferences() {
  return conferenceCache.list;
}

// Every FBS team, for the watch portal's pin picker.
//
// Two requests, because neither endpoint alone answers the question.
// ESPN's core API knows which teams are in the FBS group this season but
// returns them as bare $ref URLs with no names in them; the site API
// knows every team's name but returns all 760 across every division with
// nothing saying which are FBS. The ids in those refs are enough to
// intersect the two - 138 named FBS teams, measured.
//
// Not built from the standings, which was the obvious single-request
// answer and is wrong early: in week 1 of 2026 the Sun Belt had zero
// entries and Conference USA ten, so a picker built on it could not have
// found James Madison at all.
const FBS_TEAMS_CACHE_MS = 24 * 60 * 60 * 1000;
let fbsTeamCache = { list: [], fetchedAt: 0 };
let fbsTeamInFlight = null;

async function fetchFbsTeams() {
  // The season the calendar says we are in, not the wall-clock year - a
  // college season runs into January and asking for the wrong one returns
  // an empty group.
  const calendar = await fetchSeasonCalendar('NCAAFB');
  const year = (calendar && calendar.year) || new Date().getFullYear();

  const [group, named] = await Promise.all([
    axios.get(`https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/${year}` +
      `/types/2/groups/${FBS_GROUP_ID}/teams?limit=300`, { timeout: 15000 }),
    axios.get('https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams?limit=900',
      { timeout: 15000 }),
  ]);

  const fbsIds = new Set(((group.data && group.data.items) || [])
    .map(item => (String(item.$ref || '').match(/teams\/(\d+)/) || [])[1])
    .filter(Boolean));

  return (((named.data || {}).sports || [])[0]?.leagues?.[0]?.teams || [])
    .map(entry => entry.team)
    .filter(team => team && fbsIds.has(String(team.id)))
    .map(team => ({
      id: String(team.id),
      name: team.displayName || '',
      abbr: team.abbreviation || '',
    }))
    .filter(team => team.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function ensureFbsTeams() {
  if (fbsTeamCache.list.length > 0 && Date.now() - fbsTeamCache.fetchedAt < FBS_TEAMS_CACHE_MS) {
    return fbsTeamCache.list;
  }
  if (fbsTeamInFlight) return fbsTeamInFlight;

  fbsTeamInFlight = (async () => {
    try {
      const list = await fetchFbsTeams();
      if (list.length > 0) fbsTeamCache = { list, fetchedAt: Date.now() };
      console.log(`[Teams] ${list.length} FBS teams loaded.`);
    } catch (err) {
      console.error('[Teams] Could not load the FBS team list:', err.message);
    } finally {
      fbsTeamInFlight = null;
    }
    return fbsTeamCache.list;
  })();
  return fbsTeamInFlight;
}

// The conferences a game belongs to - one per side, deduplicated, so an
// in-conference game yields one entry and a cross-conference game two.
// This is what the watch portal's conference filter reads.
//
// Both sides are tagged rather than just one, because "show me Big Ten
// games" plainly means every game a Big Ten team is in, home or away.
//
// An FBS side playing an FCS opponent tags only the FBS conference: the
// FCS team's conference id is real but is not in the FBS list, and a
// filter offering "Big Sky" alongside the SEC would be offering a
// conference this app never shows a full schedule for.
function conferencesForEvent(competition) {
  const competitors = competition?.competitors || [];
  const seen = new Map();
  for (const competitor of competitors) {
    const id = String(competitor.team?.conferenceId ?? '');
    const conference = conferenceCache.byId.get(id);
    if (conference && !seen.has(id)) seen.set(id, { id, name: conference.name });
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

// Every event a set of scoreboard queries returns, deduplicated by event
// id - a merged round asks for two overlapping lists on purpose, so the
// same game arriving twice is expected rather than a fault.
//
// Keyed on the queries themselves rather than on what the caller was
// trying to work out. That is what makes the cache shared: resolving
// which round to show and then building that round's games ask ESPN the
// identical questions, and used to each download and parse the answer
// separately. A college football week is a large payload, so every
// visit to the watch page was paying for it twice.
async function fetchScoreboardEvents(sportKey, queries) {
  const key = `${sportKey}:${queries.join('|')}`;
  const cached = weekEventsCache.get(key);
  if (cached && (Date.now() - cached.fetchedAt) < WEEK_EVENTS_CACHE_MS) return cached.events;

  const endpoint = ESPN_ENDPOINTS[sportKey];
  if (!endpoint) return [];
  try {
    const responses = await Promise.all(queries.map(query => axios.get(
      `${endpoint}?${query}`,
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
    console.error(`[ESPN] Failed to fetch ${sportKey} (${queries.join(' | ')}):`, err.message);
    // Stale beats empty. An outage should not empty the catalog of a
    // league whose schedule we are still holding.
    return cached ? cached.events : [];
  }
}

async function fetchSeasonWeekEvents(sportKey, year, seasonType, weeks) {
  return fetchScoreboardEvents(
    sportKey, weeks.map(week => seasonWeekQuery(sportKey, year, seasonType, week)));
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

  const games = await fetchTodayGames(sport, hostUrl, userTimeZone, {
    queries: resolved.weeks.map(week => seasonWeekQuery(sportKey, resolved.year, resolved.seasonType, week)),
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
// There is no event filter here any more. It existed for the college
// Power 4 gate, which dropped two thirds of a September Saturday before
// anything was built; the whole slate is carried now and narrowed by the
// reader instead.
async function fetchTodayGames(sport, hostUrl, userTimeZone = 'America/New_York', options = {}) {
  if (!ESPN_ENDPOINTS[sport.toUpperCase()]) return [];

  try {
    const queries = options.queries
      || [`dates=${getLocalDateString(userTimeZone)}${getNcaaScoreboardParams(sport)}`];
    const events = await fetchScoreboardEvents(sport.toUpperCase(), queries);

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

      // The half of the name that is NOT the nickname - "Miami" out of
      // "Miami Hurricanes", "Kansas City" out of "Kansas City Chiefs".
      // ESPN carries it as its own field, so it is read rather than
      // sliced off the display name.
      //
      // Kept because a provider names a game channel by whichever half it
      // feels like - "NCAAF 07: MIAMI vs STANFORD" uses the places, other
      // listings use the nicknames - and the team search below needs both.
      const homeLocation = homeTeam.location || '';
      const awayLocation = awayTeam.location || '';

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
        // Who is playing, as ids rather than names.
        //
        // The watch portal needs both halves of this: the rank, to lead
        // with the top 25 rather than all ninety-nine games, and the team
        // id, because a pinned team is pinned by id and a display name is
        // not a stable key - ESPN writes "Miami" for two different
        // programmes. The rank is already computed for the title above;
        // this is the same number, kept rather than thrown away.
        teams: [
          { id: String(homeTeam.id || ''), name: homeTeam.displayName || '', abbr: homeAbbr, rank: homeRank || null },
          { id: String(awayTeam.id || ''), name: awayTeam.displayName || '', abbr: awayAbbr, rank: awayRank || null },
        ].filter(team => team.id),
        // Just the nickname (e.g. "Suns"), not the full "Phoenix Suns" -
        // needed for tier 4's city/state exclusion rule in stream ranking.
        homeNick,
        awayNick,
        homeLocation,
        awayLocation,
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
//   Daily leagues - the user's current local day and nothing else.
//   "What is on today" is the entire question. No league this app
//   carries is one today, but the path stays: it is also what an
//   unrecognised sport falls into, where it finds no endpoint and
//   answers with an empty list rather than throwing.
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
// One promotion's card is one event, the same shape MMA already uses:
// there is no home and away, the headline fight is the name, and the
// window looks months ahead because a card runs every few weeks.
//
// The poster is the promotion's own artwork for that card, which is
// better than anything that could be drawn from a matchup with no team
// marks behind it. buildWrestlingPoster falls back to a plain one when
// a card has no art yet.
async function fetchWrestlingEvents(hostUrl, userTimeZone) {
  const events = await wrestling.getEvents();

  return events.map(event => {
    const iso = event.date.toISOString();
    const art = new URLSearchParams({
      title: event.title || '',
      code: event.code || '',
      place: event.location || '',
    }).toString();

    const where = event.location ? ` - ${event.location}` : '';
    // Said out loud rather than left as a bare date. The promotion has
    // published no time for this card - confirmed, its page carries no
    // clock at all - and a date on its own reads like the app losing
    // the time rather than the time not existing yet.
    const when = event.hasTime
      ? formatEventWhen(iso, userTimeZone)
      : `${formatEventWhen(iso, userTimeZone, { dateOnly: true })} - time TBA`;

    return {
      // Prefixed so a future promotion in this section cannot collide,
      // but not doubled up when the card's own code already starts with
      // it - "RAF MOSCOW" would otherwise become raf-raf-moscow.
      id: 'raf-' + String(event.code || event.title || iso)
        .replace(/^raf[\s-]*/i, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      name: event.code && !/^raf$/i.test(event.code)
        ? `${event.code}: ${event.title}`
        : event.title,
      homeTeam: '', awayTeam: '', homeNick: '', awayNick: '', homeAbbr: '', awayAbbr: '',
      // Every card is on Fox Nation and has been since the promotion
      // launched, so there is no per-event broadcast to resolve - it is
      // a fact about the promotion, not about the fixture.
      broadcastNames: ['Fox Nation'],
      nationalBroadcasts: ['Fox Nation'],
      network: null,
      // Which bucket in the dashboard holds this card's channels. The
      // wrestling section will hold more than one promotion, so the
      // event names its own rather than the sport standing in for it.
      searchKey: 'RAF',
      poster: `${hostUrl}/poster/wrestling/raf.svg?${art}`,
      background: `${hostUrl}/landscape/wrestling.svg`,
      logo: `${hostUrl}/logo/wrestling.svg`,
      description: `Real American Freestyle${where}. Streams on Fox Nation.`
        + (event.hasTime ? '' : ' Start time not published yet.'),
      status: 'Scheduled',
      finalScore: '',
      state: 'pre',
      date: iso,
      whenLabel: when,
      isToday: isSameLocalDay(iso, userTimeZone),
      conferences: [],
    };
  });
}

// One week of fixtures across the five competitions, merged into one
// section.
//
// Each league is fetched under its OWN key rather than under 'SOCCER',
// which is what gives every card its competition's badge, its
// competition's colours, and the right team-logo folder. The section
// exists only as the thing they are merged into.
//
// Tagged with the competition in `conferences`, the field college
// football uses for its ACC/SEC chips - so a mixed row of fifty fixtures
// arrives filterable by league in the watch portal without a line of new
// UI.
//
// A league that fails is skipped rather than failing the section:
// fetchTodayGames already returns an empty list on error, and four
// competitions is a better answer than none.
async function fetchSoccerGames(hostUrl, userTimeZone) {
  const fromDateStr = getLocalDateString(userTimeZone);
  const toDateStr = addDaysToDateString(fromDateStr, SOCCER_SCHEDULE_DAYS);

  const perLeague = await Promise.all(SOCCER_LEAGUES.map(async (league) => {
    const games = await fetchTodayGames(league.key, hostUrl, userTimeZone, {
      queries: [`dates=${fromDateStr}-${toDateStr}`]
    });
    // The same { id, name } shape conferencesForEvent produces, because
    // the watch portal's filter reads both through one code path and a
    // bare string there renders a chip with no label and matches nothing.
    return games.map(game => ({
      ...game,
      conferences: [{ id: league.key.toLowerCase(), name: league.label }]
    }));
  }));

  const games = perLeague.flat();
  console.log(`[ESPN] Soccer: ${games.length} fixture(s) over ${SOCCER_SCHEDULE_DAYS} days` +
    ` (${SOCCER_LEAGUES.map((l, i) => `${l.label} ${perLeague[i].length}`).join(', ')})`);

  // Sorted across the whole section rather than league by league. A week
  // of five competitions read in league order would be five separate
  // schedules stacked; by kickoff it is one.
  return sortGamesByRelevance(games);
}

async function buildGamesForSport(sport, hostUrl, userTimeZone) {
  if (sport === 'UFC') {
    return fetchTodayMmaEvents(hostUrl, userTimeZone);
  }
  if (sport.toUpperCase() === WRESTLING_SPORT) {
    return fetchWrestlingEvents(hostUrl, userTimeZone);
  }
  if (sport.toUpperCase() === SOCCER_SPORT) {
    return fetchSoccerGames(hostUrl, userTimeZone);
  }
  // Before anything is built, because conferencesForEvent reads the list
  // synchronously while mapping events - a cold cache would tag a whole
  // round with nothing and the filter would come back empty.
  if (NCAA_SPORTS.has(sport.toUpperCase())) await ensureConferences();

  if (SEASON_WEEK_LEAGUES[sport.toUpperCase()]) {
    return fetchSeasonWeekGames(sport, hostUrl, userTimeZone);
  }
  return fetchTodayGames(sport, hostUrl, userTimeZone);
}

// The finished list, cached, because opening the watch page asks every
// configured league for one at once and then asks again the moment a
// league tab is picked. Rebuilding it meant turning ninety-nine raw ESPN
// events back into cards each time - the largest thing the server does
// on that page, and pure repetition.
//
// Cached under a placeholder host, with the real one substituted on the
// way out. A game's poster, background and logo are absolute URLs and
// are the only things in it the host affects, so keying the cache by
// host would have split it per access route - the tailnet name and the
// LAN address holding separate copies of the same schedule - and let
// anyone widen it at will, since the host is just a request header.
const GAMES_HOST_TOKEN = 'https://host.invalid';
const gamesCache = new Map();
const GAMES_CACHE_MS = 10 * 60 * 1000;

function withHost(url, hostUrl) {
  return typeof url === 'string' ? url.replace(GAMES_HOST_TOKEN, hostUrl) : url;
}

async function fetchGamesForSport(sport, hostUrl, userTimeZone = 'America/New_York') {
  const key = `${sport.toUpperCase()}|${userTimeZone}`;
  let entry = gamesCache.get(key);

  if (!entry || (Date.now() - entry.builtAt) > GAMES_CACHE_MS) {
    entry = {
      builtAt: Date.now(),
      games: await buildGamesForSport(sport, GAMES_HOST_TOKEN, userTimeZone)
    };
    gamesCache.set(key, entry);
  }

  // Copied rather than handed out directly. Callers are free to sort or
  // annotate what they get back, and the cached list has to survive
  // that untouched for the next reader.
  return entry.games.map(game => ({
    ...game,
    poster: withHost(game.poster, hostUrl),
    background: withHost(game.background, hostUrl),
    logo: withHost(game.logo, hostUrl)
  }));
}

async function fetchXtreamCategories(provider) {
  const { url, username, password } = provider;
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

async function fetchXtreamLiveStreams(provider, categoryIds = []) {
  if (!categoryIds || categoryIds.length === 0) return [];
  const { url, username, password } = provider;
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
async function fetchAllXtreamLiveStreams(provider) {
  const { url, username, password } = provider;
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
// nothing changes for anyone already working. XTREAM_STREAM_FORMATS
// itself is declared up with the provider model, because normaliseProvider
// reads it while users.json is still being loaded.

function xtreamStreamFormat(provider) {
  const configured = provider && provider.streamFormat;
  return XTREAM_STREAM_FORMATS.includes(configured) ? configured : 'm3u8';
}

// Takes a provider rather than an account. Which one a stream id belongs
// to is now a real question - ids collide across services - and passing
// the account would leave every call site silently answering it with
// whichever provider happened to be first.
function buildXtreamStreamUrl(provider, streamId) {
  const baseUrl = String(provider.url || '').replace(/\/+$/, '');
  const ext = xtreamStreamFormat(provider);
  return `${baseUrl}/live/${encodeURIComponent(provider.username)}/${encodeURIComponent(provider.password)}/${streamId}.${ext}`;
}

// The same URL, addressed the way most callers have it: an account and
// the providerId stored on a link. Returns '' when the account has no
// provider that could serve it.
function buildStreamUrlFor(user, providerId, streamId) {
  const provider = providerFor(user, providerId);
  if (!provider || provider.kind !== 'xtream' || !provider.url) return '';
  return buildXtreamStreamUrl(provider, streamId);
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

function xtreamCacheKey(provider) {
  const baseUrl = String(provider.url || '').replace(/\/+$/, '');
  return `${baseUrl}|${provider.username}`;
}

async function fetchXtreamCatalog(provider) {
  const [categories, streams] = await Promise.all([
    fetchXtreamCategories(provider),
    fetchAllXtreamLiveStreams(provider)
  ]);
  return { categories, streams, fetchedAt: Date.now() };
}

function buildXtreamChannelSource(provider, catalog) {
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
    streamUrl: buildXtreamStreamUrl(provider, s.stream_id),
    // Carried on the channel itself, because once an account holds more
    // than one service every downstream consumer - the picker, the
    // searches, auto-pick, the quality lookup - has to know which one a
    // channel came from, and the URL is not a reliable way back to it.
    providerId: provider.id,
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
async function getProviderChannelSource(provider) {
  if (!provider || provider.kind !== 'xtream' || !provider.url) return null;
  const key = xtreamCacheKey(provider);

  const cached = xtreamSourceCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < XTREAM_SOURCE_TTL_MS) {
    return buildXtreamChannelSource(provider, cached);
  }

  // Deduplicated, not just cached. The dashboard fires /suggest and
  // /status together on load, so on a cold cache both would otherwise
  // pull the entire service down in parallel for one page view.
  const inFlight = xtreamSourceInFlight.get(key);
  const pending = inFlight || (async () => {
    try {
      const startedAt = Date.now();
      const catalog = await fetchXtreamCatalog(provider);
      // An empty list means the provider answered with nothing useful -
      // down, rate limiting, credentials rejected. Serving that as the
      // truth would empty the picker and read as "your channels are
      // gone", so a previous good answer is kept instead.
      if (catalog.streams.length === 0 && cached) {
        console.error('[Xtream] Live stream list came back empty; keeping the previous one.');
        return cached;
      }
      xtreamSourceCache.set(key, catalog);
      console.log(`[Xtream] Catalog fetched: ${catalog.streams.length} stream(s),` +
        ` ${catalog.categories.length} category(ies) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
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
  return catalog ? buildXtreamChannelSource(provider, catalog) : null;
}

// Every provider on the account, as one channel list.
//
// The rest of the app asks an account for "its channels" in a dozen
// places - suggestions, search, the category picker, auto-pick, the
// team-search fallback - and none of them wants to know how many services
// are behind the answer. So the join happens here, once, and each channel
// carries the providerId that says where it came from.
//
// Categories are merged by name and their counts summed. Two services
// commonly use the same folder names, and an account's category allowlist
// is a list of names, so keeping them separate would mean ticking "USA
// SPORTS" twice to mean one thing.
//
// A provider that cannot be reached is reported rather than thrown: one
// service being down is not a reason to empty the picker of the other's
// channels, and `providers` below is what lets the dashboard say which
// half of the list is missing.
function mergeChannelSources(parts) {
  const channels = [];
  const counts = new Map();

  for (const part of parts) {
    if (!part.source) continue;
    for (const channel of part.source.channels || []) channels.push(channel);
    for (const category of part.source.categoryList || []) {
      counts.set(category.name, (counts.get(category.name) || 0) + category.channelCount);
    }
  }

  return {
    channels,
    categoryList: [...counts.entries()]
      .map(([name, channelCount]) => ({ name, channelCount }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    providers: parts.map(part => ({
      id: part.provider.id,
      label: part.provider.label,
      kind: part.provider.kind,
      ok: !!part.source,
      channelCount: part.source ? part.source.channels.length : 0,
    })),
    // Per provider, so a link is healed against the service it was saved
    // from rather than against whichever one happens to have a channel of
    // the same name. See networks.resolveNetworkLinks.
    byProvider: new Map(parts.map(part => [part.provider.id, part.source])),
  };
}

// An M3U source is parsed once on a schedule and shared by every account
// pointing at that playlist, so its channels arrive without a providerId
// and cannot simply be mutated to carry one. Stamping a copy per request
// would mean rebuilding forty thousand objects on every dashboard load,
// so the copy is memoised against the parsed source itself: it lives
// exactly as long as that parse does and is dropped the moment a refresh
// replaces it.
const stampedM3uSources = new WeakMap();

function stampProviderId(source, providerId) {
  if (!source) return null;
  let byProvider = stampedM3uSources.get(source);
  if (!byProvider) {
    byProvider = new Map();
    stampedM3uSources.set(source, byProvider);
  }
  let stamped = byProvider.get(providerId);
  if (!stamped) {
    stamped = { ...source, channels: (source.channels || []).map(c => ({ ...c, providerId })) };
    byProvider.set(providerId, stamped);
  }
  return stamped;
}

// The account's whole channel list, however many providers are behind it.
// Returns null only when nothing at all could be reached - a partial
// answer is still a usable one.
async function getAccountChannelSource(user) {
  const providers = providersOf(user);
  if (providers.length === 0) return null;

  const parts = await Promise.all(providers.map(async (provider) => ({
    provider,
    source: provider.kind === 'm3u'
      ? (provider.playlistUrl ? m3u.getCachedM3USource(provider.playlistUrl) : null)
      : await getProviderChannelSource(provider),
  })));

  for (const part of parts) {
    if (part.provider.kind !== 'm3u') continue;
    part.source = stampProviderId(part.source, part.provider.id);
  }

  if (parts.every(part => !part.source)) return null;
  return mergeChannelSources(parts);
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
// Standing searches an account has written for itself, keyed by the
// bucket they belong to rather than by sport.
//
// A promotion like RAF has no channel to pin. Its cards turn up in a
// playlist as whatever the provider felt like calling them that week -
// "RAF 14", "Real American Freestyle", or just the broadcaster's own
// channel - so a curated list of stream ids goes stale between events
// while a search for the promotion's name does not.
//
// Keyed per bucket because the wrestling section will hold college duals
// beside the promotions, and a search for one finds nothing for the
// other. An event says which bucket it belongs to; nothing is inferred
// from its sport.
//
// Shaped like the built-in AUTO_SEARCH entries so the stream route can
// use either without caring which it got.
function readSearchTerms(user) {
  const raw = (user && user.searchTerms) || {};
  const out = {};
  for (const [bucket, terms] of Object.entries(raw)) {
    if (!Array.isArray(terms)) continue;
    const cleaned = [...new Set(terms
      .filter(t => typeof t === 'string')
      .map(t => t.trim())
      .filter(t => t.length >= 2 && t.length <= 60))].slice(0, 20);
    if (cleaned.length) out[String(bucket).toUpperCase()] = cleaned;
  }

  // Terms were briefly keyed by sport rather than by bucket, so an
  // account set up in that window has its RAF terms filed under
  // WRESTLING. Carried across rather than lost - and only when the
  // bucket is empty, so it stops mattering the moment anything is saved
  // through the section itself.
  if (out.WRESTLING && !out.RAF) out.RAF = out.WRESTLING;

  return out;
}

// The account's own terms win over the built-in ones. Somebody who has
// written a list has said what they want searched, and quietly unioning
// that with a default would put back the results the list was narrowed
// to exclude.
function autoSearchFor(user, bucketKey, sportKey) {
  const own = readSearchTerms(user)[String(bucketKey || '').toUpperCase()];
  if (own && own.length) return { terms: own, groups: [] };
  // A search bucket has no built-in fallback: an empty list means the
  // account has not set it up, and running a sport-wide default in its
  // place would serve one promotion's channels for another's card.
  if (networks.isSearchNetwork(bucketKey)) return null;
  return networks.getAutoSearch(sportKey);
}

// ---------------------------------------------------------------------
// Team search
// ---------------------------------------------------------------------
//
// The last resort for a game with nothing behind it.
//
// It runs only when a game has produced no playable stream at all - a
// configured channel, a standing search and a promotion rule have all
// come back empty - and searches the playlist for each team's name. See
// networks.teamSearchTerms for which words and why.
//
// Every hit carries the terms that found it, which is what lets the watch
// portal switch a term off without asking the server again. A common
// nickname can easily match more than the other three terms combined -
// "Cardinal" reaches every cardinal-anything on the service - and turning
// it off has to be instant to be worth having.

// Per term, so one broad word cannot crowd out the other three, and
// overall, so a four-term search cannot return a page nobody will read.
const TEAM_SEARCH_PER_TERM = 25;
const TEAM_SEARCH_TOTAL = 80;

function teamSearchFor(user, game, channels) {
  const terms = networks.teamSearchTerms(game);
  if (terms.length === 0) return null;

  // Keyed by URL, because the same channel legitimately answers several
  // terms - "MIAMI HURRICANES TV" is found by both - and it should be one
  // row that survives until BOTH its terms are switched off, not two rows
  // that half-disappear.
  const byUrl = new Map();
  const counts = [];

  for (const term of terms) {
    const { channels: hits, total } = networks.searchChannels(term, channels, {
      limit: TEAM_SEARCH_PER_TERM,
      // These words were generated from the fixture, not typed, so they
      // have to match whole words. Without it a team called the Utes
      // matches "60 MINUTES".
      wholeWord: true,
    });
    // `total` is what the term actually matched; `hits` is the capped
    // slice of it that gets shown. The chip is labelled with the former,
    // so a term that matched five hundred channels does not claim 25.
    counts.push({ term, count: total, shown: hits.length });

    for (const hit of hits) {
      const existing = byUrl.get(hit.url);
      if (existing) {
        if (!existing.terms.includes(term)) existing.terms.push(term);
        continue;
      }
      byUrl.set(hit.url, {
        name: hit.name || '',
        url: hit.url,
        groups: hit.groups || [],
        terms: [term],
        providerId: providerIdFor(user, hit.providerId),
      });
    }
  }

  // Ordered before it is capped, so the cap takes the worst rather than
  // whatever came last.
  //
  // Most terms first, and this is the whole ranking. A channel that
  // answers BOTH teams is nearly always the game itself - "Football: UAB
  // at Illinois Postgame Press Conference", "Indiana State at Purdue" -
  // while a channel that answers one is usually the word doing something
  // else entirely, as "Colorado" finding CBS News Colorado and the
  // Avalanche. Measured on a real slate, the two-term hits were the only
  // genuinely relevant results in the list and were being buried under
  // twenty single-word ones.
  //
  // Then the published quality, which sorts dead and blackscreen
  // channels below working ones.
  const ranked = enrichWithStreamcheck(user, [...byUrl.values()])
    .sort((a, b) =>
      b.terms.length - a.terms.length
      || (b.probedScore || 0) - (a.probedScore || 0));

  // Counted over everything that matched, not over the capped slice, for
  // the same reason the term chips are: a chip labelled with the slice
  // would report the cap rather than what switching the provider off
  // would actually remove.
  const providerCounts = new Map();
  for (const entry of ranked) {
    providerCounts.set(entry.providerId, (providerCounts.get(entry.providerId) || 0) + 1);
  }

  const results = ranked
    .slice(0, TEAM_SEARCH_TOTAL)
    .map(entry => ({
      name: entry.name,
      url: entry.url,
      terms: entry.terms,
      providerId: entry.providerId,
      title: `\u{1F50D} ${entry.terms.join(', ')}  \u{1F4C1} ${(entry.groups || []).join(' | ')}`
        + providerSuffix(user, entry.providerId),
      // The published reading rides along, which matters more here than
      // anywhere else in the panel: these are guesses, there can be
      // eighty of them, and "which of these is alive and watchable" is
      // the only way to make that list usable at a glance.
      probedQuality: entry.probedQuality || '',
      probedTier: entry.probedTier || null,
      probedScore: entry.probedScore,
      probedDetail: entry.probedDetail || '',
      streamStatus: entry.streamStatus || null,
    }));

  // Every provider the account holds, not only the ones that matched.
  // A chip reading "Provider B · 0" is the answer to "why is nothing from
  // B in here"; omitting it leaves that looking like a bug in the search.
  const providers = providersOf(user).map(provider => ({
    id: provider.id,
    label: provider.label,
    count: providerCounts.get(provider.id) || 0,
  }));

  return { terms: counts, providers, results };
}

async function fetchAutoSearchChannelsFrom(provider, config, m3uSource) {
  if (provider.kind === 'm3u') {
    const channels = (m3uSource?.channels || []);
    return networks.autoSearchChannels(channels, config);
  }

  if (!provider.url) return [];

  const categories = await fetchXtreamCategories(provider);
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
    streams = await fetchXtreamLiveStreams(provider, wantedIds);
  } else {
    streams = await fetchAllXtreamLiveStreams(provider);
  }

  // Normalised into the M3U parser's own channel shape, so the matching
  // itself has one implementation shared by both connection types.
  const getCategoryName = buildCategoryNameLookup(categories);
  const channels = streams.map(s => ({
    name: s.name,
    streamUrl: buildXtreamStreamUrl(provider, s.stream_id),
    providerId: provider.id,
    categories: [getCategoryName(s)]
  }));

  return networks.autoSearchChannels(channels, config);
}

// The standing search, run once per provider and concatenated.
//
// Every provider is asked, and the results stay in provider order rather
// than being interleaved or re-ranked. This search exists for events that
// only ever appear as a throwaway per-card channel, where there is no
// published reading to rank by and no basis for preferring one service's
// listing to another's - so the account's own provider order is the
// order, and it is at least predictable.
async function fetchAutoSearchChannels(user, config, sourceFor) {
  if (!config) return [];

  const perProvider = await Promise.all(providersOf(user)
    .map(provider => fetchAutoSearchChannelsFrom(
      provider, config, typeof sourceFor === 'function' ? sourceFor(provider.id) : sourceFor)));

  return perProvider.flat().slice(0, networks.MAX_AUTO_SEARCH_RESULTS);
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
  for (const provider of providersOf(user)) {
    if (provider.kind === 'm3u') warmM3uPlaylistInBackground(provider);
  }
}

function warmM3uPlaylistInBackground(provider) {
  const playlistUrl = provider && provider.playlistUrl;
  const epgUrl = provider && provider.epgUrl;
  // The playlist is the only thing required. This used to refuse to warm
  // without an EPG URL as well, which made an account that had none sit
  // on "your playlist is still loading" permanently - the cache could
  // never fill, so every channel search, suggestion and category lookup
  // failed forever with a message promising it was nearly there. Nothing
  // reads the EPG at all since the tier matcher was removed, so requiring
  // one to fetch a playlist was guarding nothing.
  if (!playlistUrl) return;

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
// The credential half on its own, for the endpoints that only need to
// know whose account this is.
//
// Split out of authenticateForChannels because that one also resolves the
// account's whole channel list - right for anything reading the playlist,
// and pure waste for a request asking which conferences are hidden.
async function authenticateAccount(req, res) {
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
  return { user };
}

async function authenticateForChannels(req, res) {
  const account = await authenticateAccount(req, res);
  if (!account) return null;
  const { user } = account;

  // Xtream reaches the same features through its own channel list rather
  // than a parsed playlist. Both arrive here in the same shape, and so do
  // all of an account's providers, so everything downstream -
  // suggestions, search, probing, link healing - is one implementation
  // serving every combination.
  const providers = providersOf(user);
  if (providers.length === 0) {
    res.status(400).json({
      error: user.connectionType === 'm3u'
        ? 'No M3U playlist is configured on this account.'
        : 'No Xtream connection is configured on this account.'
    });
    return null;
  }

  const source = await getAccountChannelSource(user);
  if (!source) {
    if (user.connectionType === 'm3u') warmM3uSourceInBackground(user);
    // notReady distinguishes "still loading" from a real failure, so the
    // dashboard can say which and offer a retry rather than rendering an
    // empty picker that looks broken.
    res.status(503).json({
      error: user.connectionType === 'm3u'
        ? 'Your playlist is still loading. This can take a minute after a restart.'
        : 'Could not reach your provider. This usually clears on its own - try again in a moment.',
      notReady: true
    });
    return null;
  }

  return { user, source };
}

// What the watch portal's league filters are built from: the conferences
// that exist, and what this account has done with them.
//
// Small and called once on boot, so it carries the conference list
// itself rather than making the page ask twice. The team list is NOT
// here - it is 138 entries the portal only needs when somebody opens the
// pin picker, and sending it to every visitor on every load to save one
// request when they open a panel is the wrong trade.
app.post('/api/leagues/preferences', async (req, res) => {
  const auth = await authenticateAccount(req, res);
  if (!auth) return;

  await ensureConferences();
  return res.json({
    success: true,
    conferences: { NCAAFB: listConferences() },
    pinnedTeams: readPinnedTeams(auth.user),
    hiddenConferences: readHiddenConferences(auth.user),
  });
});

// Every team that can be pinned. Loaded when the picker opens, cached on
// the server for a day.
app.post('/api/leagues/teams', async (req, res) => {
  const auth = await authenticateAccount(req, res);
  if (!auth) return;

  const sport = String(req.body.sport || '').toUpperCase();
  if (sport !== 'NCAAFB') {
    return res.status(400).json({ error: 'No team list is published for that league.' });
  }
  return res.json({ success: true, teams: await ensureFbsTeams() });
});

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
// The account's category allowlist, applied to everything that SEARCHES
// the playlist - the network suggestions and the channel search, on both
// the dashboard and the watch portal.
//
// Deliberately not applied to the source itself. A saved channel has to
// keep resolving, and the quality probe validates a URL against the
// channel list before opening it; filtering there would make a channel
// the user had already chosen look missing, and make probing it fail,
// purely because its group is not one they browse. The filter belongs on
// the question "what should I offer you", never on "is this thing you
// already picked still real".
//
// Empty means no filter rather than no channels. Somebody who unticks
// everything has made a mistake, not expressed a preference, and a
// search that silently returns nothing forever is a bad way to find that
// out.
// How a published reading is named as a format, e.g. "1080p60". The one
// spelling shared by the filter, the counts the picker shows and the
// labels on the badges, so a format can never be offered under one name
// and matched under another.
function formatKey(record) {
  if (!record || !record.height || !record.fps) return null;
  return `${record.height}p${Math.round(record.fps)}`;
}

// Teams the account has pinned, and conferences it has hidden, both
// keyed by sport.
//
// Keyed by sport rather than assumed to be college football because the
// conference tag already is: soccer tags every game with its competition,
// so hiding La Liga is the same operation as hiding the MAC and needs no
// second implementation when somebody asks for it.
//
// The pin carries the team's name and abbreviation as well as its id. The
// id is the key - display names are not unique, ESPN writes "Miami" for
// two different programmes - but the portal has to draw the pin list
// before any game with that team in it has loaded, and a bare id is not
// something anyone recognises.
const MAX_PINNED_TEAMS = 40;
const MAX_HIDDEN_CONFERENCES = 40;

function readPinnedTeams(user) {
  const raw = (user && user.pinnedTeams) || {};
  const out = {};
  for (const [sport, teams] of Object.entries(raw)) {
    if (!Array.isArray(teams)) continue;
    const seen = new Set();
    const cleaned = [];
    for (const team of teams) {
      if (!team || typeof team !== 'object') continue;
      const id = String(team.id || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      cleaned.push({
        id,
        name: String(team.name || '').trim().slice(0, 80),
        abbr: String(team.abbr || '').trim().slice(0, 10),
      });
      if (cleaned.length >= MAX_PINNED_TEAMS) break;
    }
    if (cleaned.length > 0) out[String(sport).toUpperCase()] = cleaned;
  }
  return out;
}

function readHiddenConferences(user) {
  const raw = (user && user.hiddenConferences) || {};
  const out = {};
  for (const [sport, ids] of Object.entries(raw)) {
    if (!Array.isArray(ids)) continue;
    const cleaned = [...new Set(ids
      .filter(id => typeof id === 'string' && id.trim())
      .map(id => id.trim()))].slice(0, MAX_HIDDEN_CONFERENCES);
    if (cleaned.length > 0) out[String(sport).toUpperCase()] = cleaned;
  }
  return out;
}

const QUALITY_TIERS = ['good', 'okay', 'low'];

// Tiers that existed under the old four-band rating, mapped onto the
// three that replaced them. A saved filter says what somebody wanted to
// see, and dropping an unrecognised tier silently would not narrow their
// filter - it would WIDEN it, because an empty list means no restriction.
// Great became the upper half of Good, and Bad became Low Quality.
const RETIRED_TIERS = { great: 'good', bad: 'low' };

function readQualityFilter(user) {
  const raw = (user && user.qualityFilter) || {};
  const list = (v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : []);
  const minBpp = Number(raw.minBpp);
  return {
    statuses: list(raw.statuses),
    tiers: [...new Set(list(raw.tiers)
      .map(t => RETIRED_TIERS[t] || t)
      .filter(t => QUALITY_TIERS.includes(t)))],
    formats: list(raw.formats),
    minBpp: Number.isFinite(minBpp) && minBpp > 0 ? minBpp : 0,
    requireData: raw.requireData === true,
  };
}

// The published-quality filter as a predicate, or null when there is
// nothing to apply - so the ordinary case does no work at all rather
// than walking the playlist to keep every channel in it.
//
// An empty list means "no restriction on this", not "allow nothing".
// The two readings only differ when every box is unticked, and of the
// two, the one that cannot silently empty an account's playlist is the
// one worth having.
//
// Nothing is filtered while the provider's table is not loaded either.
// The alternative is judging every channel on an absence of data and
// hiding the lot, which looks exactly like the playlist having broken.
// A reading for one channel, link or search hit, from the published
// table belonging to ITS provider.
//
// This is the whole reason a link carries a providerId. streamcheck.pro
// publishes one table per service and stream ids are assigned per
// service, so id 1568650 exists in several of them and describes a
// different channel in each. Looking one up in the wrong table does not
// come back empty - it comes back confidently wrong, which is the failure
// mode worth spending a field to avoid.
//
// Returns null when NO provider on the account has a table in memory, so
// the ordinary case - published data switched off - costs one call rather
// than a closure per channel.
function streamcheckLookup(user) {
  const providers = providersOf(user);
  const tables = new Map(providers.map(provider => [
    provider.id,
    (provider.streamcheckProvider && streamcheck.isLoaded(provider.streamcheckProvider))
      ? provider.streamcheckProvider : '',
  ]));
  if (![...tables.values()].some(Boolean)) return null;

  // Links saved before the account had a second provider carry no
  // providerId, and the primary is the only service they could have come
  // from. An id naming a provider since deleted lands here too, which is
  // the same guess and the only one available.
  const fallback = providers.length > 0 ? tables.get(providers[0].id) : '';

  return (entry) => {
    // streamUrl on a catalog channel, url on an entry that has already
    // been through makeLinkEntry. This runs over both, and reading only
    // one of them fails silently: every channel comes back unjudged and
    // whatever is built on it looks switched off.
    const url = entry && (entry.streamUrl || entry.url);
    if (!url) return null;
    const table = entry.providerId ? tables.get(entry.providerId) : fallback;
    if (!table) return null;
    return streamcheck.lookupCached(table, networks.streamIdFromUrl(url));
  };
}

function publishedQualityFilter(user) {
  const f = readQualityFilter(user);
  const active = f.statuses.length || f.tiers.length || f.formats.length
    || f.minBpp || f.requireData;
  if (!active) return null;

  const lookup = streamcheckLookup(user);
  if (!lookup) return null;

  const statuses = new Set(f.statuses);
  const tiers = new Set(f.tiers);
  const formats = new Set(f.formats);
  // Scoring a record is the expensive half, so it is only reached when
  // a facet actually needs it. Hiding dead links - the common case -
  // costs a map lookup and a string compare.
  const needsScore = tiers.size > 0 || f.minBpp > 0;

  return (channel) => {
    const record = lookup(channel);
    if (!record) return !f.requireData;

    if (statuses.size && !statuses.has(record.status || '')) return false;

    if (formats.size) {
      const key = formatKey(record);
      // A reading with no resolution or frame rate in it cannot match a
      // format, so it does not - the same answer as any other mismatch.
      if (!key || !formats.has(key)) return false;
    }

    if (!needsScore) return true;

    const measured = qualityFromStreamcheck(record);
    if (!measured) return !f.requireData;
    if (tiers.size && !tiers.has(measured.tier)) return false;
    if (f.minBpp && !(measured.bpp >= f.minBpp)) return false;
    return true;
  };
}

function channelsForSearch(user, channels) {
  let result = channels;

  const selected = Array.isArray(user.searchCategories) ? user.searchCategories : [];
  if (selected.length > 0) {
    const wanted = new Set(selected);
    result = result.filter(channel =>
      (channel.categories || []).some(category => wanted.has(category)));
  }

  const passesQuality = publishedQualityFilter(user);
  if (passesQuality) result = result.filter(passesQuality);

  return result;
}

// What a set of standing search terms would actually find, so the
// dashboard can show it before it is saved rather than after an event
// has already gone out with the wrong channels behind it.
app.post('/api/networks/search-terms', async (req, res) => {
  const auth = await authenticateForChannels(req, res);
  if (!auth) return;

  const terms = Array.isArray(req.body.terms) ? req.body.terms : [];
  const cleaned = terms.filter(t => typeof t === 'string' && t.trim().length >= 2)
    .map(t => t.trim()).slice(0, 20);
  if (cleaned.length === 0) return res.json({ success: true, terms: [], matches: [] });

  // Through the same resolver the stream route uses, so what is
  // previewed here is what an event will actually be given.
  const channels = networks.autoSearchChannels(
    channelsForSearch(auth.user, auth.source.channels),
    { terms: cleaned, groups: [] },
    { limit: 40 }
  );

  return res.json({
    success: true,
    terms: cleaned,
    matches: enrichWithStreamcheck(auth.user, channels).map(c => ({
      name: c.name, url: c.url, group: c.group || '',
      probedQuality: c.probedQuality || '', probedTier: c.probedTier || '',
      probedDetail: c.probedDetail || '', streamStatus: c.streamStatus || null,
    })),
  });
});

// Every category the account can see, with how many channels each holds,
// alongside the ones currently chosen. Feeds the dashboard's picker.
app.post('/api/networks/categories', async (req, res) => {
  const auth = await authenticateForChannels(req, res);
  if (!auth) return;

  return res.json({
    success: true,
    categories: auth.source.categoryList || [],
    selected: Array.isArray(auth.user.searchCategories) ? auth.user.searchCategories : [],
  });
});

// What the account can filter on, counted over its own channels rather
// than over the provider's whole table - the useful question is "how
// many of MY channels are 1080p60", not how many exist anywhere.
//
// Counted after the category filter, because that is the set searches
// actually run on, and before the quality filter, because a picker that
// only counted what the current filter already allows could never show
// you what turning something back on would give you.
app.post('/api/networks/quality-filter', async (req, res) => {
  const auth = await authenticateForChannels(req, res);
  if (!auth) return;

  const user = auth.user;
  const saved = readQualityFilter(user);
  const lookup = streamcheckLookup(user);
  const provider = accountTables(user);

  if (!lookup) {
    return res.json({
      success: true, provider, loaded: false, selected: saved,
      statuses: [], formats: [], tiers: [], total: 0, unknown: 0,
    });
  }

  const wanted = Array.isArray(user.searchCategories) ? new Set(user.searchCategories) : null;
  const inCategories = (wanted && wanted.size)
    ? auth.source.channels.filter(c => (c.categories || []).some(cat => wanted.has(cat)))
    : auth.source.channels;

  const statuses = new Map();
  const formats = new Map();
  const tiers = new Map();
  let unknown = 0;
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

  for (const channel of inCategories) {
    const record = lookup(channel);
    if (!record) { unknown++; continue; }
    bump(statuses, record.status || 'Unknown');
    const key = formatKey(record);
    if (key) bump(formats, key);
    const measured = qualityFromStreamcheck(record);
    if (measured) bump(tiers, measured.tier);
  }

  // Formats sort by resolution then frame rate, both descending, so the
  // list reads best-first rather than by however many happen to exist.
  const formatRank = (key) => {
    const m = /^(\d+)p(\d+)$/.exec(key);
    return m ? Number(m[1]) * 1000 + Number(m[2]) : 0;
  };

  return res.json({
    success: true,
    provider,
    loaded: true,
    total: inCategories.length,
    unknown,
    selected: saved,
    statuses: [...statuses.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    formats: [...formats.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => formatRank(b.name) - formatRank(a.name)),
    tiers: QUALITY_TIERS.map(name => ({ name, count: tiers.get(name) || 0 })),
  });
});

// Turns a published streamcheck record into the same shape a probe
// produces, so everything downstream - the badge, the rating, the
// persisted label, the Stremio title - cannot tell where a reading came
// from and needs no branch for it.
//
// A dead or blackscreen channel has no bitrate to rate, but "it does not
// work" is the most useful thing anyone can be told about a channel, so
// it is reported in the same place a quality would have been.
function qualityFromStreamcheck(record) {
  if (!record) return null;

  const bpp = quality.bitsPerPixel({
    bitrate: record.bitrate, width: record.width, height: record.height, fps: record.fps,
  });
  const scored = bpp ? quality.scoreQuality({ height: record.height, fps: record.fps, bpp }) : null;

  // A channel that does not work is reported as not working, whatever
  // numbers came back with it. A blackscreen feed still carries a
  // resolution and a trickle of bitrate, so it rates as merely poor when
  // rated on those - "Blackscreen" is the fact worth having, and the
  // format is kept beside it because it is still true.
  if (record.status && record.status !== 'Alive') {
    const format = record.height ? ` · ${record.height}p${record.fps || ''}` : '';
    return {
      ok: true,
      source: 'streamcheck',
      status: record.status,
      height: record.height,
      fps: record.fps,
      codec: record.codec,
      bitrate: record.bitrate,
      bpp,
      runDate: record.runDate,
      score: 0,
      tier: 'low',
      label: `${record.status}${format}`,
    };
  }

  if (scored) {
    return {
      ok: true,
      source: 'streamcheck',
      status: record.status,
      width: record.width,
      height: record.height,
      fps: record.fps,
      codec: record.codec,
      bitrate: record.bitrate,
      bpp,
      audioCodec: record.audioCodec,
      audioBitrate: record.audioBitrate,
      runDate: record.runDate,
      score: scored.score,
      tier: scored.tier,
      tooSlow: scored.tooSlow,
      label: quality.formatQualityLabel({
        height: record.height, fps: record.fps, bpp, tier: scored.tier,
      }),
    };
  }

  return null;
}

// Stamps a published reading onto entries that carry a URL. Used on the
// suggestions, the search results and the saved channels, which is what
// "enrich the whole playlist" amounts to in practice - every list the
// user looks at arrives already measured, with nothing probed.
//
// Only reads what is already in memory. The one place that pays to load
// a provider is the suggestions endpoint below, so a search cannot
// stall for twenty megabytes.
// What a badge shows on hover: the verdict, the format it is a verdict
// about, the number it was read off, and the bitrate behind that number.
// Written here rather than in each page so the two cannot describe the
// same reading differently.
function describeQuality(quality) {
  if (!quality) return '';
  if (quality.status && quality.status !== 'Alive') {
    return `${quality.status} - as of the ${quality.runDate || 'last'} sweep`;
  }
  const parts = [];
  if (quality.tier) parts.push(quality.tier.charAt(0).toUpperCase() + quality.tier.slice(1));
  if (quality.height) parts.push(`${quality.height}p${quality.fps || ''}`);
  if (quality.bpp) parts.push(`${Number(quality.bpp).toFixed(3)} bpp`);
  if (quality.bitrate) parts.push(`${(quality.bitrate / 1e6).toFixed(2)} Mbps video`);
  return parts.join(' · ');
}

function enrichWithStreamcheck(user, entries) {
  const lookup = streamcheckLookup(user);
  if (!lookup) return entries;

  return entries.map(entry => {
    if (!entry || !entry.url) return entry;
    const quality = qualityFromStreamcheck(lookup(entry));
    if (!quality) return entry;
    return {
      ...entry,
      probedQuality: quality.label,
      probedScore: quality.score,
      probedTier: quality.tier,
      probedDetail: describeQuality(quality),
      streamStatus: quality.status || null,
    };
  });
}

// Published quality for channels the account has ALREADY chosen.
//
// The enrichment above rides on entries the server is about to return -
// suggestions, search hits, saved channels. Configured network links are
// not in any of those: they came back with the account at login, before
// a provider table was necessarily loaded, and they are what the
// dashboard actually draws. Without this, picking a provider appeared to
// do nothing until a channel was checked by hand, because every badge on
// screen was drawn from a link that nobody had enriched.
//
// Keyed by URL, which is what the dashboard has in hand when it draws a
// badge. Two providers cannot produce the same URL - the host and the
// credentials in the path differ - so the key stays unambiguous even
// though the readings behind it now come from different tables.
function publishedQualityFor(user, entries) {
  const lookup = streamcheckLookup(user);
  if (!lookup) return {};

  const out = {};
  for (const entry of entries) {
    if (!entry || !entry.url || out[entry.url]) continue;
    const quality = qualityFromStreamcheck(lookup(entry));
    if (quality) out[entry.url] = { ...quality, detail: describeQuality(quality) };
  }
  return out;
}

// Every configured link and saved channel, as { url, providerId } - the
// pair a published lookup needs. It used to be a bare list of URLs, which
// stopped being enough the moment an account could hold two services
// numbering their channels independently.
function configuredEntriesFor(user) {
  const entries = [];
  for (const links of Object.values(user.networkLinks || {})) {
    if (Array.isArray(links)) {
      for (const link of links) if (link && link.url) entries.push(link);
    }
  }
  for (const channel of user.savedChannels || []) {
    if (channel && channel.url) entries.push(channel);
  }
  return entries;
}

// ---------------------------------------------------------------------
// Auto-pick
// ---------------------------------------------------------------------
//
// Re-choosing a network's channels from the newest published sweep.
//
// The rules and the ladder live in autopick.js, which knows nothing about
// accounts, caches or HTTP. This is the part that joins them to one
// user's playlist and one provider's readings, and decides what is
// allowed to be written where.

const AUTO_PICK_LIMIT = 5;

// How many slots each provider gets to fill.
//
// Five each is the whole point of picking per provider: one service's
// worth of links is one service's worth of outage, and a network with
// five from each still has half a list when one of them goes down. A
// single-provider account keeps the five it always had rather than
// suddenly filling all ten - nothing about that account changed.
//
// Above two providers the network ceiling is what gives, not the
// redundancy: three providers get three slots each rather than one of
// them being left out.
function autoPickLimitFor(providerCount) {
  if (providerCount <= 1) return AUTO_PICK_LIMIT;
  return Math.max(1, Math.min(
    AUTO_PICK_LIMIT,
    Math.floor(networks.MAX_LINKS_PER_NETWORK / providerCount)));
}

// The account's channel list, split back into one list per provider.
//
// Everything upstream works on the merged list, which is right for
// searching - the user is looking for a channel, not for a service. Auto-
// pick is the one place that needs the split back, because its answer is
// explicitly "the best few from each".
function channelsByProvider(user, channels) {
  const groups = providersOf(user).map(provider => ({ providerId: provider.id, channels: [] }));
  if (groups.length === 0) return [];
  const byId = new Map(groups.map(group => [group.providerId, group]));

  for (const channel of channels) {
    // A channel with no providerId predates the split, or came from a
    // source that could not be stamped; it belongs to the primary, which
    // is the only provider such an account ever had.
    const group = byId.get(channel.providerId) || groups[0];
    group.channels.push(channel);
  }
  return groups;
}

// Which networks an account has handed over, and any rule text it has
// edited. Normalised on read rather than trusted, like every other stored
// preference here: this drives what gets WRITTEN into an account's links,
// so a bad shape must fail at the boundary and not halfway through a
// scheduled run that nobody is watching.
function readAutoPick(user) {
  const raw = (user && user.autoPick) || {};
  const pickable = new Set(autopick.autoPickableNetworks());

  // An absent list means the account has never been near this panel, and
  // the default there is every network on. Auto-pick exists because the
  // alternative is an account quietly serving channels a sweep has
  // already marked dead, and that is not a state to opt in to. An empty
  // ARRAY is different: somebody unticked everything and saved it, and
  // that choice is kept.
  const networksOn = Array.isArray(raw.networks)
    ? [...new Set(raw.networks.filter(k => typeof k === 'string' && pickable.has(k)))]
    : [...pickable];

  const rules = {};
  if (raw.rules && typeof raw.rules === 'object' && !Array.isArray(raw.rules)) {
    const terms = (v) => (Array.isArray(v)
      ? v.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim()).slice(0, 60)
      : undefined);
    for (const [key, rule] of Object.entries(raw.rules)) {
      if (!pickable.has(key) || !rule || typeof rule !== 'object') continue;
      const entry = {};
      // undefined means "not overridden", which is different from an
      // empty array meaning "deliberately none" - CW ships with no
      // exclusions and has to be able to stay that way.
      if (terms(rule.include) !== undefined) entry.include = terms(rule.include);
      if (terms(rule.exclude) !== undefined) entry.exclude = terms(rule.exclude);
      if (terms(rule.groups) !== undefined) entry.groups = terms(rule.groups);
      if (Object.keys(entry).length > 0) rules[key] = entry;
    }
  }

  return {
    networks: networksOn,
    rules,
    lastRun: typeof raw.lastRun === 'string' ? raw.lastRun : '',
    lastRunDate: typeof raw.lastRunDate === 'string' ? raw.lastRunDate : '',
  };
}

// Which sweep the readings in memory came from. Shown beside a pick so a
// surprising result can be traced to the run that produced it, and stored
// after a run so a later one can tell whether anything is new.
function streamcheckRunDate(provider) {
  if (!provider) return '';
  const entry = streamcheck.describeCache().find(c => c.provider === provider);
  return entry ? (entry.runDate || '') : '';
}

// The account's published tables as one label, for panels with a single
// line to name them in. Reads "provider-a + provider-b" when there are
// two, and stays exactly as it was for an account with one.
function accountTables(user) {
  return streamcheckTablesFor(user).join(' + ');
}

// One sweep date for a whole account, for the places that have room to
// print exactly one - the auto-pick panel's header, and the stamp stored
// after a run.
//
// The OLDEST of the account's sweeps, not the newest. It answers "how
// stale might any of this be", and the newest would let a service swept
// this morning speak for one last swept in March.
function accountRunDate(user) {
  const dates = streamcheckTablesFor(user).map(streamcheckRunDate).filter(Boolean);
  if (dates.length === 0) return '';
  return dates.sort()[0];
}

// Readings for one account's provider, in the shape autopick.js expects.
//
// Returns null when there is nothing to read from, and every caller
// treats that as "do not touch anything". Auto-picking without published
// data would mean replacing links that are known to work with links
// nothing has ever measured.
function autoPickReader(user) {
  const lookup = streamcheckLookup(user);
  if (!lookup) return null;

  return (channel) => {
    const record = lookup(channel);
    if (!record) return null;
    const measured = qualityFromStreamcheck(record);
    return {
      status: record.status || null,
      height: record.height,
      fps: record.fps,
      bpp: measured ? measured.bpp : null,
      label: measured ? measured.label : '',
      tier: measured ? measured.tier : null,
      detail: measured ? describeQuality(measured) : '',
      runDate: record.runDate || null,
    };
  };
}

// One pick as a stored link, carrying its reading with it.
//
// probedQuality is filled in here rather than left for the dashboard to
// discover, because these links are written by a scheduled run that no
// one is watching: without it, an account woken up the next morning would
// show a set of freshly chosen channels with no indication of why any of
// them was chosen.
function autoPickEntry(pick) {
  const channel = pick.channel;
  return {
    ...networks.makeLinkEntry({
      url: channel.streamUrl || channel.url,
      tvgId: channel.id,
      name: channel.name,
      group: (channel.categories || [])[0] || '',
      streamId: channel.streamId,
      providerId: pick.providerId || channel.providerId,
      probedQuality: pick.reading.label || '',
    }),
    band: autopick.BANDS[pick.band].name,
    matchedBy: pick.matchedBy,
    detail: pick.reading.detail || '',
    tier: pick.reading.tier || null,
  };
}

// What auto-pick would choose for an account, network by network.
//
// Nothing is written here. The same function backs the dashboard preview
// and the scheduled run, so what somebody reviews on screen is what the
// overnight job will do - there is no second code path that could drift
// away from the one that was checked.
function computeAutoPick(user, channels, options = {}) {
  const settings = readAutoPick(user);
  const read = autoPickReader(user);
  const keys = options.networks && options.networks.length
    ? options.networks.filter(k => autopick.DEFAULT_RULES[k])
    : settings.networks;

  // Rules being edited but not yet saved. The preview passes them so the
  // panel answers for the terms on screen; a run never does, because what
  // runs unattended has to be what was stored and reviewed.
  const rules = options.rules || settings.rules;

  if (!read) {
    return { ready: false, reason: 'no-published-data', settings, results: [] };
  }

  const groups = channelsByProvider(user, channels);
  const limit = options.limit || autoPickLimitFor(groups.length);
  const labels = Object.fromEntries(providersOf(user).map(pr => [pr.id, pr.label]));

  const results = keys.map((key) => {
    const outcome = autopick.pickAcrossProviders(key, groups, read, { rules, limit });
    const current = (user.networkLinks || {})[key] || [];
    const entries = outcome.picks.map(autoPickEntry);

    // Whether this would actually change anything, compared on stream
    // identity rather than on the objects. A run that picks the same
    // channels in the same order is a no-op, and saying so is what stops
    // a weekly job from looking like it churns an account's links every
    // time it runs.
    //
    // The provider is part of that identity now. Two services numbering
    // their channels independently can both hold a stream 1568650, and
    // without this a pick that moved a network from one provider to the
    // other would compare equal and never be written.
    const identity = (l) => `${l.providerId || ''}:${l.streamId || l.url}`;
    const before = current.map(identity).join('|');
    const after = entries.map(identity).join('|');

    return {
      networkKey: key,
      label: networks.getNetworkLabel(key),
      picks: entries,
      considered: outcome.considered,
      rejected: outcome.rejected,
      usedSlow: outcome.usedSlow,
      perProvider: outcome.perProvider.map(entry => ({
        ...entry, label: labels[entry.providerId] || '',
      })),
      currentCount: current.length,
      changed: before !== after,
    };
  });

  return { ready: true, settings, results };
}

// Writes the picks into the account. Returns what changed.
//
// Two refusals worth stating, because both are cases where doing nothing
// is the correct behaviour and an empty result would otherwise look like
// a bug:
//
//   - A network that found nothing keeps what it has. The stale link
//     might be dead, but a dead link is still a lead - it names the
//     channel the account wanted - and an empty section offers nothing at
//     all. This matters most in exactly the situation that triggers a
//     run: a sweep that marked half a provider Dead.
//   - Networks the account has not enabled are never touched, even when
//     a preview asked about them.
function applyAutoPick(user, channels, options = {}) {
  const computed = computeAutoPick(user, channels, options);
  if (!computed.ready) return { ...computed, applied: [] };

  const enabled = new Set(readAutoPick(user).networks);
  if (!user.networkLinks) user.networkLinks = {};

  const applied = [];
  for (const result of computed.results) {
    if (!enabled.has(result.networkKey)) continue;
    if (result.picks.length === 0) continue;
    if (!result.changed) continue;

    const validated = networks.validateNetworkLinks(result.networkKey, result.picks);
    if (!validated.ok) {
      console.error(`[Auto-pick] ${result.networkKey}: ${validated.error}`);
      continue;
    }
    user.networkLinks[result.networkKey] = validated.links;
    applied.push({
      networkKey: result.networkKey,
      label: result.label,
      count: validated.links.length,
      was: result.currentCount,
      // The links themselves, not just a count. A caller that has just
      // had an account's links rewritten under it is holding a stale
      // copy, and a count cannot repair one - the dashboard used to
      // redraw from its own pre-run state and show nothing new.
      links: validated.links.map(withQualityTier),
    });
  }

  return { ...computed, applied };
}

// The providers the dashboard can choose between, and what this instance
// currently holds for each.
app.post('/api/streamcheck/providers', async (req, res) => {
  const auth = await authenticateForChannels(req, res);
  if (!auth) return;

  return res.json({
    success: true,
    // What streamcheck.pro publishes tables for.
    providers: await streamcheck.listProviders(),
    // What this account has chosen, one table per provider it holds.
    // `selected` remains as the primary provider's choice so a dashboard
    // that has not been updated still shows something true.
    accountProviders: providersOf(auth.user).map(entry => describeProvider(entry, { withConnection: true })),
    selected: (providersOf(auth.user)[0] || {}).streamcheckProvider || '',
    cached: streamcheck.describeCache(),
  });
});

// Points one of the account's providers at a published table.
//
// Separate from /api/user/update because it has to WAIT for the table to
// download before answering: the dashboard redraws its badges from the
// response, and answering early meant every badge came back blank and
// the choice looked like it had not taken.
app.post('/api/streamcheck/select', async (req, res) => {
  const auth = await authenticateForChannels(req, res);
  if (!auth) return;

  const { providerId, table } = req.body;
  const provider = providersOf(auth.user).find(entry => entry.id === providerId);
  if (!provider) return res.status(400).json({ error: 'No such provider on this account.' });
  if (typeof table !== 'string') {
    return res.status(400).json({ error: 'A published table name is required.' });
  }

  provider.streamcheckProvider = table.trim();
  await saveUserConfigs();

  if (provider.streamcheckProvider) {
    await streamcheck.ensureProvider(provider.streamcheckProvider);
  }

  return res.json({
    success: true,
    providers: providersOf(auth.user).map(entry => describeProvider(entry, { withConnection: true })),
    loaded: !!provider.streamcheckProvider && streamcheck.isLoaded(provider.streamcheckProvider),
    runDate: streamcheckRunDate(provider.streamcheckProvider),
    linkQuality: publishedQualityFor(auth.user, configuredEntriesFor(auth.user)),
  });
});

app.post('/api/networks/suggest', async (req, res) => {
  const auth = await authenticateForChannels(req, res);
  if (!auth) return;

  // The one place that waits for a provider table to load. It is the
  // dashboard's own first request, it happens at most once every few
  // hours, and paying it here is what lets every other endpoint enrich
  // from memory without stalling.
  await Promise.all(streamcheckTablesFor(auth.user)
    .map(table => streamcheck.ensureProvider(table)));

  // What every saved preset pins, resolved against this playlist. Not
  // proposals any more - the guessing is gone - so this is only ever the
  // channels an operator chose by hand, and the dashboard offers them
  // through Apply on a named preset rather than filling anything in on
  // its own.
  const presetChannels = networks.presetChannelsForAll(
    channelsForSearch(auth.user, auth.source.channels), mergedNetworkDefaults());
  for (const key of Object.keys(presetChannels)) {
    presetChannels[key] = enrichWithStreamcheck(auth.user, presetChannels[key]);
  }
  return res.json({
    success: true,
    presetChannels,
    presets: describePresets(),
    // Everything already configured, measured. Keyed by URL because that
    // is what the dashboard draws its badges against.
    linkQuality: publishedQualityFor(auth.user, configuredEntriesFor(auth.user)),
  });
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

  // Two filters, and they are not the same thing. The account's category
  // allowlist decides what is searchable at all; excludeGroups is the
  // caller narrowing one particular set of results.
  const { channels, groups, truncated } = networks.searchChannels(
    query, channelsForSearch(auth.user, auth.source.channels), { limit: 50, excludeGroups }
  );
  return res.json({
    success: true,
    channels: enrichWithStreamcheck(auth.user, channels),
    // So a result list drawn from several services can say which one each
    // channel is on. Sent with every search rather than fetched once,
    // because it is four short strings and the alternative is a second
    // endpoint the page has to remember to call.
    providers: providersOf(auth.user).map(entry => describeProvider(entry)),
    groups,
    truncated,
  });
});

// The user's saved channels, resolved against the current playlist so a
// rotated URL is healed rather than silently dead. This is what the watch
// page plays from.
app.post('/api/networks/saved', async (req, res) => {
  const auth = await authenticateForChannels(req, res);
  if (!auth) return;

  const { resolved, problems } = networks.resolveSavedChannels(
    auth.user.savedChannels, linkResolvers(auth.user, auth.source).sourceFor
  );
  return res.json({
    success: true,
    channels: enrichWithStreamcheck(auth.user, resolved).map(withQualityTier),
    providers: providersOf(auth.user).map(entry => describeProvider(entry)),
    problems,
  });
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

  // One preset's channels, resolved against this account's playlist, so
  // the dashboard can apply it. Resolved here rather than shipped as raw
  // ids because only the server can turn an id into a channel with a
  // name, a group and a URL - and a preset saved against another
  // provider resolves to nothing here, which is the honest answer.
  if (action === 'resolve') {
    const preset = networkDefaults.presets.find(p => p.id === req.body.id);
    if (!preset) return res.status(404).json({ error: 'That preset no longer exists.' });

    const channels = channelsForSearch(auth.user, auth.source.channels);
    const resolved = {};
    let found = 0;
    let pinned = 0;
    for (const [networkKey, ids] of Object.entries(preset.networks)) {
      pinned += ids.length;
      const list = enrichWithStreamcheck(auth.user,
        networks.presetChannelsForNetwork(networkKey, channels, new Set(ids)));
      if (list.length > 0) { resolved[networkKey] = list; found += list.length; }
    }

    return res.json({ success: true, name: preset.name, networks: resolved, found, pinned });
  }

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

// The two things networks.resolveNetworkLinks needs from an account that
// holds several providers: which playlist to heal a link against, and
// whose credentials to rebuild an Xtream URL from. Both keyed by the
// link's own providerId, because getting either wrong produces a URL that
// looks fine and plays somebody else's channel.
function linkResolvers(user, source) {
  const byProvider = (source && source.byProvider) || new Map();
  return {
    sourceFor: (providerId) => {
      if (byProvider.size === 0) return source || null;
      const provider = providerFor(user, providerId);
      return provider ? (byProvider.get(provider.id) || null) : null;
    },
    buildUrl: (streamId, providerId) => buildStreamUrlFor(user, providerId, streamId) || null,
  };
}

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
  const { sourceFor, buildUrl } = linkResolvers(auth.user, auth.source);

  const status = {};
  for (const network of networks.NETWORKS) {
    const { resolved, problems } = networks.resolveNetworkLinks(
      auth.user.networkLinks, network.key, sourceFor, buildUrl
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
  const { xtream, m3u, connectionType, selectedSports, password, timeZone, sportOrder, networkLinks, savedChannels, searchCategories, streamcheckProvider, providers } = req.body;
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
    // Which playlist categories any search may look in. Empty means all
    // of them - see channelsForSearch.
    searchCategories: Array.isArray(searchCategories) ? searchCategories : [],
    // Which provider on streamcheck.pro this account's stream ids belong
    // to. Ids are not unique across providers, so without this a lookup
    // would sometimes describe a different service's channel. Kept for
    // the setup wizard, which configures one service; a second is added
    // from the dashboard and lands in `providers` below.
    streamcheckProvider: typeof streamcheckProvider === 'string' ? streamcheckProvider : '',
    providers: Array.isArray(providers) ? providers : undefined,
    createdAt: new Date().toISOString()
  };
  migrateAccountProviders(userConfigs[uuid]);
  saveUserConfigs();

  return res.json({
    success: true,
    uuid,
    // The wizard sent one connection; this is it with an id, which the
    // dashboard needs before it can offer to add a second.
    providers: providersOf(userConfigs[uuid]).map(entry => describeProvider(entry, { withSecrets: true })),
    maxProviders: MAX_PROVIDERS,
    manifestUrl: `/user/${uuid}/manifest.json`
  });
});

// The first provider in the pre-providers shape, for the parts of the
// dashboard that still speak it. Derived rather than stored, so the two
// cannot drift: there is one place an account's credentials live now, and
// this is a view of it.
function legacyConnectionFields(user, kind) {
  const provider = providersOf(user).find(entry => entry.kind === kind);
  if (!provider) return undefined;
  return kind === 'm3u'
    ? { playlistUrl: provider.playlistUrl, epgUrl: provider.epgUrl || '' }
    : { url: provider.url, username: provider.username, password: provider.password,
        streamFormat: provider.streamFormat || 'm3u8' };
}

// Attaches a tier to a quality that was measured in an earlier session.
//
// The score is recovered from the stored label rather than persisted
// beside it - scoreQualityLabel reads back everything the model needs -
// so a channel checked weeks ago colours exactly like one checked a
// moment ago, and no saved account had to gain a field for it.
function withQualityTier(entry) {
  if (!entry || !entry.probedQuality) return entry;
  const scored = quality.scoreQualityLabel(entry.probedQuality);
  if (!scored) return entry;
  return {
    ...entry,
    // Restated as well as re-rated. The stored string was written when
    // the rating had four bands, so a link saved months ago still spells
    // out a verdict this system no longer has - and a badge reading
    // "Great" next to one reading "Good" invites the reader to believe
    // there is a difference between them.
    probedQuality: quality.restateQualityLabel(entry.probedQuality),
    probedScore: scored.score,
    probedTier: scored.tier,
  };
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
    // Both shapes. `providers` is the real one; `xtream`/`m3u` describe
    // the first of them and exist so the setup wizard, which knows about
    // exactly one connection, keeps working unchanged.
    providers: providersOf(user).map(entry => describeProvider(entry, { withSecrets: true })),
    maxProviders: MAX_PROVIDERS,
    xtream: legacyConnectionFields(user, 'xtream'),
    m3u: legacyConnectionFields(user, 'm3u'),
    selectedSports: user.selectedSports, 
    timeZone: user.timeZone || 'America/New_York',
    sportOrder: user.sportOrder || [],
    searchCategories: user.searchCategories || [],
    streamcheckProvider: user.streamcheckProvider || '',
    qualityFilter: readQualityFilter(user),
    searchTerms: readSearchTerms(user),
    pinnedTeams: readPinnedTeams(user),
    hiddenConferences: readHiddenConferences(user),
    autoPick: readAutoPick(user),
    networkLinks: tierNetworkLinks(user.networkLinks),
    savedChannels: (user.savedChannels || []).map(withQualityTier),
    manifestUrl: `/user/${uuid}/manifest.json` 
  });
});

app.post('/api/user/update', async (req, res) => {
  const { uuid, password, xtream, m3u, selectedSports, timeZone, sportOrder, networkLinks, savedChannels, searchCategories, streamcheckProvider, qualityFilter, searchTerms, providers, pinnedTeams, hiddenConferences } = req.body;
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
  // The whole provider list, replaced at once.
  //
  // Not a set of add/remove/rename endpoints, because the order is itself
  // a setting - it decides which service's block of auto-picked links
  // goes first when two are indistinguishable - and there is no way to
  // express a reorder as a series of single-item edits without the list
  // being briefly wrong in between.
  //
  // Credentials are optional per entry: the dashboard sends a provider
  // back with an empty password when the user did not retype it, and
  // blanking a working connection because a form field was left alone is
  // not something to make anyone recover from.
  if (providers !== undefined) {
    if (!Array.isArray(providers) || providers.length === 0) {
      return res.status(400).json({ error: 'An account needs at least one provider.' });
    }
    if (providers.length > MAX_PROVIDERS) {
      return res.status(400).json({ error: `At most ${MAX_PROVIDERS} providers per account.` });
    }
    const kind = user.connectionType === 'm3u' ? 'm3u' : 'xtream';
    const existing = new Map(providersOf(user).map(entry => [entry.id, entry]));
    const next = [];
    for (const [index, raw] of providers.entries()) {
      const previous = existing.get(raw && raw.id);
      const merged = previous ? { ...previous, ...raw } : raw;
      if (previous && kind === 'xtream' && !raw.password) merged.password = previous.password;
      const normalised = normaliseProvider(merged, kind, index);
      if (!normalised) {
        return res.status(400).json({
          error: kind === 'm3u'
            ? `Provider ${index + 1} needs a playlist URL.`
            : `Provider ${index + 1} needs a server URL.`
        });
      }
      next.push(normalised);
    }
    if (new Set(next.map(entry => entry.id)).size !== next.length) {
      return res.status(400).json({ error: 'Two providers cannot share an id.' });
    }
    user.providers = next;
  }

  // The pre-providers fields, still accepted so the setup wizard keeps
  // working. They edit the FIRST provider rather than a parallel copy of
  // it - two places holding one account's credentials is exactly the
  // drift this array was meant to end.
  if (xtream !== undefined || m3u !== undefined) {
    const kind = m3u !== undefined ? 'm3u' : 'xtream';
    const list = providersOf(user);
    const updated = normaliseProvider(
      { ...(list[0] || {}), ...(kind === 'm3u' ? m3u : xtream), id: list[0] && list[0].id },
      kind, 0);
    if (updated) user.providers = [updated, ...list.slice(1)];
    user.connectionType = kind;
  }
  if (selectedSports !== undefined) user.selectedSports = selectedSports;
  if (streamcheckProvider !== undefined) {
    // Names the FIRST provider's table. The per-provider control is
    // /api/streamcheck/select; this is the setup wizard's single-service
    // version of the same choice.
    const first = providersOf(user)[0];
    const table = typeof streamcheckProvider === 'string' ? streamcheckProvider : '';
    user.streamcheckProvider = table;
    if (first) first.streamcheckProvider = table;
  }
  if (searchTerms !== undefined) {
    user.searchTerms = readSearchTerms({ searchTerms });
  }
  if (pinnedTeams !== undefined) {
    user.pinnedTeams = readPinnedTeams({ pinnedTeams });
  }
  if (hiddenConferences !== undefined) {
    user.hiddenConferences = readHiddenConferences({ hiddenConferences });
  }

  if (qualityFilter !== undefined) {
    // Normalised on the way in rather than trusted: this is read on
    // every search, and a bad shape here would be a filter that throws
    // per keystroke rather than one that simply matches nothing.
    user.qualityFilter = readQualityFilter({ qualityFilter });
  }

  if (searchCategories !== undefined) {
    user.searchCategories = Array.isArray(searchCategories)
      ? searchCategories.filter(c => typeof c === 'string' && c)
      : [];
  }
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

  return res.json({
    success: true,
    uuid: user.uuid,
    // Echoed back in full - ids, and the fields the panel puts on screen.
    // A provider added by this very request has no local copy to fall
    // back on, so anything left out here comes back blank in the form the
    // user just filled in.
    providers: providersOf(user).map(entry => describeProvider(entry, { withConnection: true })),
    manifestUrl: `/user/${uuid}/manifest.json`
  });
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
    // How many services the account carries. A count, not the services
    // themselves: the same reasoning that keeps credentials out of this
    // list keeps their hostnames out of it too.
    providerCount: providersOf(user).length,
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
// Never opens a connection. This runs on every stream request and only
// ever reads what is already in memory.
function qualityLabelForLink(user, link) {
  // The published reading first, then whatever was last stored on the
  // link. The stored one is written from the same source, so this is
  // really "the freshest copy" rather than two competing opinions - it
  // matters after a restart, when the provider table has not been
  // pulled yet and the stored label is all there is.
  const published = publishedLabelFor(user, link);
  return published || quality.restateQualityLabel(link.probedQuality) || '';
}

// One channel's published label, from whatever is already in memory.
// Never loads a provider table: this runs on every stream request, and
// a catalog click is not the place to wait twenty megabytes.
function publishedLabelFor(user, link) {
  const table = streamcheckTableFor(user, link && link.providerId);
  const url = link && (link.url || link.streamUrl);
  if (!table || !url) return '';
  const record = streamcheck.lookupCached(table, networks.streamIdFromUrl(url));
  const reading = qualityFromStreamcheck(record);
  return reading ? reading.label : '';
}

// "📡 FOX · 1080p60  📁 TV Guide (USA)". The channel's own name stays in
// the stream's `name`, which is where the market ("[Birmingham]") shows.
function buildLinkTitle(user, networkKey, link) {
  const label = qualityLabelForLink(user, link);
  const networkPart = `📡 ${networks.getNetworkLabel(networkKey)}${label ? ` · ${label}` : ''}`;
  const groupPart = link.group ? `  📁 ${link.group}` : '';
  return `${networkPart}${groupPart}${providerSuffix(user, link.providerId)}`;
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
function buildAutoSearchTitle(user, channel) {
  const label = publishedLabelFor(user, channel);
  const searchPart = `🔎 Auto${label ? ` · ${label}` : ''}`;
  const groupPart = channel.group ? `  📁 ${channel.group}` : '';
  return `${searchPart}${groupPart}${providerSuffix(user, channel.providerId)}`;
}

// Which service a stream came from, appended to its title - but only for
// an account that has more than one.
//
// Once ten slots hold five channels from each of two services, "the first
// two did not play, try further down" needs a way to tell whether further
// down is even a different service. A single-provider account already
// knows the answer and does not need it taking up room in the row.
function providerSuffix(user, providerId) {
  const list = providersOf(user);
  if (list.length < 2) return '';
  const label = providerLabelFor(user, providerId);
  return label ? `  🛰️ ${label}` : '';
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
  //
  // Filtered against what this build actually covers, too. An account
  // saved before basketball, hockey, baseball and soccer were removed
  // still lists them, and without this each one becomes a tab that can
  // only ever say "nothing scheduled" - the selection is stale, not the
  // schedule. The stored list is left alone rather than rewritten, so
  // restoring a league brings that account's tab back with it.
  const activeSports = (user.selectedSports || [])
    .filter(sport => sport && sport !== 'GLOBAL')
    .filter(sport => SUPPORTED_SPORTS.has(String(sport).toUpperCase()));

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
  // otherwise find no sport in it and silently fall back to the default.
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
  // exactly what caused several leagues to silently draw another sport's
  // art before this fix.
  const sport = (req.params.id.split('_')[1] || 'nfl').toUpperCase();

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
    // Read by the portal's ranked-only default and its pinned teams. Only
    // the leagues that build a game from ESPN competitors carry it; every
    // other card is simply never ranked and never pinned.
    teams: game.teams || [],
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
    const source = await getAccountChannelSource(user);
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
      netSource = await getAccountChannelSource(user);
      if (!netSource) {
        return res.json({ streams: [{
          name: '\u26A0\uFE0F Playlist not loaded',
          title: providersOf(user).length > 0
            ? 'Your playlist is still being fetched - try again in a moment.'
            : 'No playlist configured - add one in the Sportio dashboard.',
          url: ''
        }] });
      }
    }

    const netResolvers = linkResolvers(user, netSource);
    const { resolved, problems } = networks.resolveNetworkLinks(
      user.networkLinks, networkKey, netResolvers.sourceFor, netResolvers.buildUrl
    );

    const netStreams = resolved.map(link => ({
      name: link.name,
      title: buildLinkTitle(user, networkKey, link),
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
      const label = networks.getNetworkLabel(networkKey);
      netStreams.push(problems.length > 0
        ? {
            name: '\u26A0\uFE0F Broken links',
            title: `All ${problems.length} saved ${label} channel(s) are missing from your playlist.`,
            url: ''
          }
        : {
            name: `\u26A0\uFE0F No ${label} channels configured`,
            title: 'Add one in the Sportio dashboard.',
            url: ''
          });
    }

    console.log(`[Stream] NETWORK ${networkKey} links=${resolved.length} missing=${problems.length}`);
    res.setHeader('Content-Type', 'application/json');
    return res.json({ streams: netStreams });
  }

  const hostUrl = `${req.protocol}://${req.get('host')}`;
  const isM3u = user.connectionType === 'm3u';

  if (providersOf(user).length === 0) return res.json({ streams: [] });

  // Resolved once and reused by the link lookup, the standing search and
  // the team-search fallback below. All three need every provider's
  // channels, and fetching them three times over would turn one catalog
  // click into three full passes of each service.
  let accountSource = null;
  if (isM3u) {
    accountSource = await getAccountChannelSource(user);
    if (!accountSource) return res.json({ streams: [] });
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
    // Xtream links rebuild their URL from the account's credentials
    // rather than storing it, and which provider's credentials is what
    // the link's providerId answers - only this route has them in hand.
    const { sourceFor, buildUrl } = linkResolvers(user, accountSource);
    const { resolved, problems } = networks.resolveNetworkLinks(
      user.networkLinks, networkKey, sourceFor, buildUrl
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
      title: buildLinkTitle(user, networkKey, link),
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
  // An event can name the bucket its channels live in - a promotion
  // within a section that holds several. Only that bucket's terms run,
  // so one promotion's card never reaches for another's channels.
  const searchKey = game.searchKey || sportKey;
  const autoSearch = promotion ? promotion.autoSearch : autoSearchFor(user, searchKey, sportKey);
  let autoStreams = [];
  if (autoSearch) {
    const autoChannels = await fetchAutoSearchChannels(
      user, autoSearch, linkResolvers(user, accountSource).sourceFor);
    autoStreams = autoChannels.map(channel => ({
      name: channel.name,
      title: buildAutoSearchTitle(user, channel),
      url: channel.url
    }));
  }

  const { streams, mode, headline, note } = networks.buildStreamList({
    networkKey, linkStreams, autoStreams,
    // So a game with no slot can say what it IS on. ESPN files a lot of
    // college football on SECN+ and ESPN+, which are streaming tiers with
    // no channel to pin, and "not configured" sent people to the
    // dashboard looking for a slot that could not exist.
    nationalBroadcasts: game.nationalBroadcasts,
  });

  // The only channel available for telling the user something is wrong -
  // once a URL reaches the player, this app never learns whether it
  // worked. An entry here is not playable, so it says so plainly rather
  // than looking like a stream that simply failed.
  const finalStreams = [...streams];

  // --- Team search ---
  //
  // Only when everything above has come back with nothing playable. A
  // game that already has a channel does not need forty guesses appended
  // to it, and a term as broad as a team nickname is only worth showing
  // when the alternative is an empty panel.
  //
  // Runs BEFORE the warning row is written, because the warning says
  // whether there is a team search below it - and a line promising one
  // that found nothing is worse than no line at all.
  //
  // Returned in its own field rather than mixed into `streams`. The two
  // are not the same kind of answer - one is a channel someone chose, the
  // other is whatever the team's name matched - and Stremio, which reads
  // `streams` and has nowhere to put a filter, should not be handed
  // eighty unfiltered rows it cannot narrow.
  let teamSearch = null;
  if (!finalStreams.some(s => s.url)) {
    const source = accountSource || await getAccountChannelSource(user);
    if (source) {
      // Through the account's own category and quality filters, exactly
      // as the manual search box in the watch portal is - a channel
      // filtered out of every other search should not reappear here.
      teamSearch = teamSearchFor(user, game, channelsForSearch(user, source.channels));
    }
  }

  // A network whose every saved link has gone missing is not an
  // unconfigured one. Showing both warnings would be two rows for one
  // situation, and only the broken-link one names what actually happened.
  if (mode === 'no-links' && linkProblems.length === 0) {
    const guesses = (teamSearch && teamSearch.results.length > 0)
      ? ' - Automatic team name search below.'
      : '';
    finalStreams.unshift({ name: `\u26A0\uFE0F ${headline}`, title: `${note}${guesses}`, url: '' });
  }
  if (linkProblems.length > 0) {
    finalStreams.unshift({
      name: '\u26A0\uFE0F Broken links',
      title: `${linkProblems.length} saved ${networks.getNetworkLabel(networkKey)} channel(s) are missing from your playlist.`,
      url: ''
    });
  }

  console.log(`[Stream] ${sportKey}${promotion ? `/${promotion.key}` : ''} ${idVal} network=${networkKey || 'none'} mode=${mode} links=${linkStreams.length} auto=${autoStreams.length} -> ${finalStreams.length}` +
    (teamSearch ? ` teamSearch=${teamSearch.results.length} (${teamSearch.terms.map(t => `${t.term}:${t.count}`).join(' ')})` : ''));

  res.setHeader('Content-Type', 'application/json');
  res.json({ streams: finalStreams, teamSearch });
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

// The same check for the Soccer section, and it earns its keep for a
// reason MMA does not have: soccer team badges live under the literal
// folder 'soccer' rather than the league's own slug, so a competition
// added here without that override would draw every card with two blank
// crests - and blank crests look like a slow network, not a missing
// table entry.
for (const league of SOCCER_LEAGUES) {
  if (!ESPN_ENDPOINTS[league.key] || !SPORT_THEMES[league.key]) {
    throw new Error(`[Soccer] '${league.label}' is missing an ESPN endpoint or theme for key '${league.key}'.`);
  }
  if (TEAM_LOGO_BUCKET_OVERRIDES[league.key] !== 'soccer') {
    throw new Error(`[Soccer] '${league.label}' needs TEAM_LOGO_BUCKET_OVERRIDES.${league.key} = 'soccer' - ESPN files every club's badge there, not under the league slug.`);
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
    .flatMap(user => providersOf(user))
    .filter(provider => provider.kind === 'm3u' && provider.playlistUrl)
    .map(provider => ({ playlistUrl: provider.playlistUrl, epgUrl: provider.epgUrl }));
}

m3u.startM3uScheduler(getActiveM3uSources, () => m3uSettings);

// ---------------------------------------------------------------------
// Published quality data: a daily check
// ---------------------------------------------------------------------
//
// Asks once a day whether each provider in use has been swept since the
// copy in memory, and re-pulls only the ones where it has. The asking is
// about 7KB and the pulling about 20MB, so on most days this downloads
// nothing at all - the sweeps are weekly and the check is daily
// deliberately, because the point is to notice the day one lands rather
// than to poll for it.
//
// Seven in the morning by default, in New York, which is after the
// sweeps have landed and before anybody is looking for a game. Both the
// hour and the zone are overridable, so moving it does not need a
// rebuild.
const STREAMCHECK_REFRESH_TIME = process.env.STREAMCHECK_REFRESH_TIME || '07:00';
const STREAMCHECK_REFRESH_TZ = process.env.STREAMCHECK_REFRESH_TZ || 'America/New_York';
const EVERY_DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Only providers an account actually names. Nothing is fetched for the
// other fifteen on that dashboard.
function providersInUse() {
  return [...new Set(Object.values(userConfigs)
    .flatMap(user => streamcheckTablesFor(user)))];
}

// Which leagues anyone actually watches, and in which timezone. Both
// matter: the timezone is part of the day-at-a-time scoreboard query, so
// two accounts in different zones are asking ESPN different questions.
function sportsInUse() {
  const pairs = new Map();
  for (const user of Object.values(userConfigs)) {
    const timeZone = user.timeZone || 'America/New_York';
    for (const sport of user.selectedSports || []) {
      pairs.set(`${sport}:${timeZone}`, { sport, timeZone });
    }
  }
  return [...pairs.values()];
}

// Opening the watch page asks for every configured league at once, and
// each of those catalogs used to go out to ESPN and parse a full
// scoreboard payload before it could answer. That is the work behind the
// memory spike on first load: transient, collected a few minutes later,
// but paid again on the next visit.
//
// So it is done here instead, on a timer, and a visit finds the answer
// already in hand. The interval is deliberately shorter than the cache
// lifetime - an entry that expired between warms would put the fetch
// back on the visitor's request, which is the thing being avoided.
const GAME_CACHE_WARM_MS = 5 * 60 * 1000;

async function warmGameCaches() {
  const pairs = sportsInUse();
  if (pairs.length === 0) return;

  // Sequential on purpose. There is no deadline here, and doing them all
  // at once would recreate in the background exactly the spike this is
  // meant to take off the request path.
  let warmed = 0;
  for (const { sport, timeZone } of pairs) {
    try {
      // Through the same entry point every catalog request uses, which
      // is what guarantees it warms exactly what they will ask for. The
      // host passed here does not matter: the cache holds the
      // placeholder and each request substitutes its own.
      await fetchGamesForSport(sport, GAMES_HOST_TOKEN, timeZone);
      warmed++;
    } catch (err) {
      console.error(`[Games] Could not warm ${sport} (${timeZone}): ${err.message}`);
    }
  }
  console.log(`[Games] Warmed ${warmed}/${pairs.length} league schedules.`);
}

// The provider's channel list, kept warm.
//
// It is cached for half an hour and nothing was refreshing it, so the
// first visit after a quiet spell paid for the whole catalog - tens of
// thousands of channels over two API calls - before the page could
// answer. Every device afterwards was fast, which is what made it look
// like a client-side warm-up rather than one cold fetch on the server.
//
// Warmed a little inside the lifetime rather than on it, so an entry is
// replaced before it can expire under somebody's request.
const CHANNEL_SOURCE_WARM_MS = 25 * 60 * 1000;

// One entry per distinct service, across every account.
//
// Deduplicated because the cache is keyed by the service rather than by
// the account holding it: several accounts commonly share one, and an
// account can now list the same service twice by accident. Warming each
// occurrence separately would pull the same catalog down several times
// for one cached copy.
function providersToWarm() {
  const seen = new Map();
  for (const user of Object.values(userConfigs)) {
    for (const provider of providersOf(user)) {
      const key = provider.kind === 'm3u'
        ? `m3u|${provider.playlistUrl}`
        : `xtream|${xtreamCacheKey(provider)}`;
      if (provider.kind === 'm3u' ? !provider.playlistUrl : !provider.url) continue;
      if (!seen.has(key)) seen.set(key, provider);
    }
  }
  return [...seen.values()];
}

async function warmChannelSources() {
  const providers = providersToWarm();
  if (providers.length === 0) return;

  let warmed = 0;
  for (const provider of providers) {
    try {
      if (provider.kind === 'm3u') {
        // M3U already has its own refresh schedule; this only covers the
        // case where that has not run yet, and it declines to refetch
        // something recent on its own.
        warmM3uPlaylistInBackground(provider);
        warmed++;
        continue;
      }
      const source = await getProviderChannelSource(provider);
      if (source) warmed++;
    } catch (err) {
      console.error(`[Warm] Could not warm a channel source: ${err.message}`);
    }
  }
  console.log(`[Warm] Channel source ready for ${warmed}/${providers.length} provider(s).`);
}

// The published tables, pulled before anybody asks for one.
//
// This is the slowest thing the dashboard waits on and the only one a
// restart empties: streamcheck's cache is in memory, so a reboot means
// the first person to open Network Links pays for the whole table. It is
// about 20MB and 27,000 channels per provider - measured at 9.1s each on
// a warm connection, and an account with two providers waits for both
// before a single link is drawn.
//
// Nothing was warming it. The daily refresh runs at 07:00 and the
// channel-source warmer covers playlists, so this fell between the two.
//
// One at a time, matching refreshProviders: this is somebody else's
// public dashboard and a pair of 20MB queries fired at once is not a
// reasonable way to treat it. A request that arrives mid-warm joins the
// in-flight fetch rather than starting a second one.
async function warmStreamcheckTables() {
  const tables = providersInUse();
  if (tables.length === 0) return;

  let warmed = 0;
  for (const table of tables) {
    try {
      if (await streamcheck.ensureProvider(table)) warmed++;
    } catch (err) {
      console.error(`[Warm] Could not warm published data for ${table}: ${err.message}`);
    }
  }
  console.log(`[Warm] Published quality data ready for ${warmed}/${tables.length} provider table(s).`);
}

// After the channel sources are under way rather than before. Both are
// wanted by the same first page load, but the channel list gates every
// endpoint on it - a dashboard that cannot authenticate yet has nothing
// to draw badges on. Overridable the same way SPORTIO_DATA_DIR is, so a
// test run does not have to wait half a minute to watch this happen.
const STREAMCHECK_WARM_DELAY_MS = Number(process.env.SPORTIO_WARM_STREAMCHECK_MS) || 30 * 1000;

function scheduleStreamcheckWarm() {
  setTimeout(() => { warmStreamcheckTables(); }, STREAMCHECK_WARM_DELAY_MS).unref();
}

function scheduleChannelSourceWarm() {
  setInterval(() => { warmChannelSources(); }, CHANNEL_SOURCE_WARM_MS).unref();
  // Shortly after boot, not at it: a restart should have the catalog in
  // hand before the first visitor rather than because of them, but the
  // process should finish starting first.
  setTimeout(() => { warmChannelSources(); }, 20 * 1000).unref();
}

function scheduleGameCacheWarm() {
  setInterval(() => { warmGameCaches(); }, GAME_CACHE_WARM_MS).unref();
  // Not at the moment of boot: the first request in is usually the
  // dashboard loading a playlist, and there is no reason to make it
  // queue behind a round of ESPN fetches.
  setTimeout(() => { warmGameCaches(); }, 15 * 1000).unref();
}

// Re-pick every account's channels after a provider publishes a new
// sweep.
//
// This is the point of the whole feature. A sweep is the only event that
// changes the answer - it is when links that worked last week become
// known-dead - so the work happens then rather than on a timer of its
// own, and an account that has handed a network over wakes up to channels
// chosen from readings taken hours earlier.
//
// Deliberately silent when nothing changed. The common case is a run that
// re-picks the same channels, and a job that announced itself weekly for
// doing nothing would train its log line to be ignored.
// Enough of an account's uuid to tell two apart in a log, and not enough
// to be one. Nothing else here logs a uuid at all - the warmers and the
// streamcheck scheduler report counts - and a full uuid is half of what
// signs in to an account and the whole of what addresses its manifest.
// These lines exist to be pasted into a chat when something looks wrong.
function accountTag(user) {
  return String(user.uuid || '').slice(0, 8);
}

// Every account with a provider pointed at this table, not only those
// pointed at it exclusively. An account holding two services gets re-
// picked when either one publishes: the other's readings are still in
// memory, so the run produces a complete answer rather than half of one.
async function autoPickAfterSweep(provider, runDate) {
  const accounts = Object.values(userConfigs).filter(user =>
    streamcheckTablesFor(user).includes(provider) && readAutoPick(user).networks.length > 0);
  if (accounts.length === 0) return;

  let touched = 0;
  for (const user of accounts) {
    try {
      // The same channel list authenticateForChannels builds, reached
      // without a request to authenticate. An M3U playlist comes from
      // cache only and is never fetched here: the playlist refresher owns
      // that schedule, and a second thing pulling playlists on its own
      // timer is how a provider starts rate-limiting an account.
      const source = await getAccountChannelSource(user);
      if (!source) {
        console.error(`[Auto-pick] ${accountTag(user)}: no playlist available, leaving links alone.`);
        continue;
      }

      // The account's category filter applies here exactly as it does in
      // the preview, so a scheduled run cannot reach into parts of the
      // playlist the account has chosen not to browse.
      const selected = Array.isArray(user.searchCategories) ? user.searchCategories : [];
      const channels = selected.length
        ? source.channels.filter(c => (c.categories || []).some(cat => selected.includes(cat)))
        : source.channels;

      const outcome = applyAutoPick(user, channels);
      if (!outcome.ready || outcome.applied.length === 0) continue;

      // The account's own oldest sweep, not the run that triggered this.
      // For an account holding two services the triggering run describes
      // half the picks, and the stamp is read as "how old is this set".
      user.autoPick = {
        ...readAutoPick(user),
        lastRun: new Date().toISOString(),
        lastRunDate: accountRunDate(user) || runDate || '',
      };
      touched++;
      for (const change of outcome.applied) {
        console.log(`[Auto-pick] ${accountTag(user)}: ${change.label} now ${change.count} channel(s) (was ${change.was}).`);
      }
    } catch (err) {
      console.error(`[Auto-pick] ${accountTag(user)}: ${err.message}`);
    }
  }

  if (touched > 0) {
    await saveUserConfigs();
    console.log(`[Auto-pick] ${provider}: updated ${touched} account(s) from run ${runDate || 'unknown'}.`);
  }
}

function scheduleStreamcheckRefresh() {
  const nextRun = m3u.computeNextScheduledRun(
    EVERY_DAY, [STREAMCHECK_REFRESH_TIME], STREAMCHECK_REFRESH_TZ);

  if (!nextRun) {
    console.error('[Streamcheck scheduler] Could not work out the next run - check' +
      ` STREAMCHECK_REFRESH_TIME ("${STREAMCHECK_REFRESH_TIME}") and STREAMCHECK_REFRESH_TZ` +
      ` ("${STREAMCHECK_REFRESH_TZ}"). Trying again in an hour.`);
    setTimeout(scheduleStreamcheckRefresh, 60 * 60 * 1000);
    return;
  }

  const delay = nextRun.getTime() - Date.now();
  console.log(`[Streamcheck scheduler] Next check at ${nextRun.toISOString()}` +
    ` (${STREAMCHECK_REFRESH_TIME} ${STREAMCHECK_REFRESH_TZ}, in ${(delay / 3600000).toFixed(1)} hours)`);

  setTimeout(async () => {
    const providers = providersInUse();
    if (providers.length === 0) {
      console.log('[Streamcheck scheduler] No account names a provider - nothing to check.');
    } else {
      try {
        for (const result of await streamcheck.refreshProviders(providers)) {
          if (!result.ok) {
            console.error(`[Streamcheck scheduler] ${result.provider}: could not be reached, keeping what is held.`);
          } else if (result.firstLoad) {
            console.log(`[Streamcheck scheduler] ${result.provider}: loaded ${result.channels} channels for run ${result.runDate}.`);
            await autoPickAfterSweep(result.provider, result.runDate);
          } else if (result.updated) {
            console.log(`[Streamcheck scheduler] ${result.provider}: new run ${result.runDate}` +
              ` (was ${result.previousRun}), ${result.channels} channels.`);
            await autoPickAfterSweep(result.provider, result.runDate);
          } else {
            console.log(`[Streamcheck scheduler] ${result.provider}: still on run ${result.runDate}, nothing downloaded.`);
          }
        }
      } catch (err) {
        console.error('[Streamcheck scheduler] Check failed:', err.message);
      }
    }
    // Rescheduled from here rather than on an interval, so the run stays
    // pinned to the wall clock across a DST change instead of drifting
    // an hour twice a year.
    scheduleStreamcheckRefresh();
  }, delay);
}

scheduleStreamcheckRefresh();
scheduleGameCacheWarm();
scheduleChannelSourceWarm();
scheduleStreamcheckWarm();