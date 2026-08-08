'use strict';

const path = require('node:path');

/**
 * All tunables live here and are driven by environment variables so that
 * operators can reconfigure a deployment without editing source.
 * See .env.example for documentation of each knob.
 */

/**
 * Where data lives when DATA_DIR is not set. Every installer sets it
 * explicitly, so this only matters for someone running `node server.js` by
 * hand — but a Linux container path is a poor default on Windows or macOS.
 */
function defaultDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.platform === 'win32') {
    const base = process.env.ProgramData || process.env.LOCALAPPDATA || process.cwd();
    return path.join(base, 'PalworldRPBackend', 'data');
  }
  if (process.platform === 'darwin') return '/usr/local/var/palworld-rp-backend';
  // Linux, including the Docker image, which sets DATA_DIR anyway.
  return '/usr/src/app/data';
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return n;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function str(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

const config = {
  port: int('PORT', 3000),
  host: str('HOST', '0.0.0.0'),
  dataDir: str('DATA_DIR', defaultDataDir()),

  // Set this to lock down admin endpoints. If empty, admin routes are disabled.
  adminToken: str('ADMIN_TOKEN', ''),

  // Close registration without taking the server down. Existing players can
  // still log in; nobody new can sign up. The usual response to a wave of
  // spam accounts, and toggleable at runtime from the admin panel.
  registrationOpen: bool('REGISTRATION_OPEN', true),

  // Where the loopback-only admin panel listens. Binding to 127.0.0.1 keeps it
  // off the internet entirely: Caddy never proxies it, so the only way in is
  // from the machine itself or an SSH tunnel. Changing the bind address to
  // anything routable publishes an admin login form to the world.
  adminUiEnabled: bool('ADMIN_UI', true),
  adminUiPort: int('ADMIN_UI_PORT', 8787),
  adminUiBind: str('ADMIN_UI_BIND', '127.0.0.1'),

  // Trust X-Forwarded-For from this many reverse proxy hops. Set to 1 when
  // running behind the bundled Caddy container so per-IP limits see real IPs.
  trustProxyHops: int('TRUST_PROXY_HOPS', 1),

  // ---- Identity -----------------------------------------------------------
  // How long a login token stays valid. Clients silently re-login on expiry.
  sessionTtlMs: int('SESSION_TTL_MINUTES', 720) * 60 * 1000,
  minPasswordLength: int('MIN_PASSWORD_LENGTH', 8),
  maxPasswordLength: int('MAX_PASSWORD_LENGTH', 200),
  // Hard ceiling on accounts so a public server cannot be disk-filled.
  maxAccounts: int('MAX_ACCOUNTS', 50000),
  maxSessionsPerAccount: int('MAX_SESSIONS_PER_ACCOUNT', 5),
  // Concurrent WebSocket connections per account. This is NOT the same as the
  // session cap above: one token can open many sockets, and every extra socket
  // multiplies the cost of every global message sent to that player.
  maxSocketsPerAccount: int('MAX_SOCKETS_PER_ACCOUNT', 8),
  // How many guilds one account may own. Each is a file on disk.
  maxGuildsOwned: int('MAX_GUILDS_OWNED', 3),

  // ---- Application-layer encryption ---------------------------------------
  // When true, message content must arrive as an AES-256-GCM envelope that this
  // server relays without decrypting. It holds no key. See src/envelope.js for
  // exactly what that does and does not protect against.
  requireEncryption: bool('REQUIRE_ENCRYPTION', true),

  // ---- Chat sizing --------------------------------------------------------
  // A single message may be this large. Generous on purpose: the point of the
  // mod is to escape Palworld's tiny input cap.
  maxMessageBytes: int('MAX_MESSAGE_BYTES', 100000),
  maxProfileBytes: int('MAX_PROFILE_BYTES', 262144),
  // Guards against deeply nested JSON, which can blow the stack in
  // JSON.stringify long after the request was accepted.
  maxProfileDepth: int('MAX_PROFILE_DEPTH', 12),

  // ---- Fanout-aware rate limiting ----------------------------------------
  // Cost charged is (message bytes x number of recipients), i.e. the bytes the
  // server actually has to push. A huge emote to 4 nearby players is cheap; the
  // same text blasted to 200 people in global is not.
  chatBurstBytes: int('CHAT_BURST_BYTES', 4000000),
  chatRefillBytesPerSec: int('CHAT_REFILL_BYTES_PER_SEC', 512000),
  // Separate count-based limiter, because thousands of tiny messages barely
  // dent a byte budget but still melt clients.
  chatBurstMessages: int('CHAT_BURST_MESSAGES', 20),
  chatRefillMessagesPerSec: int('CHAT_REFILL_MESSAGES_PER_SEC', 4),

  // Cheap socket queries (/who, party management). Separate from chat because
  // they are not messages, but still need a ceiling.
  socketQueryBurst: int('SOCKET_QUERY_BURST', 30),
  socketQueryRefillPerSec: int('SOCKET_QUERY_REFILL_PER_SEC', 5),

  // ---- Proximity ----------------------------------------------------------
  localChatRadius: int('LOCAL_CHAT_RADIUS', 3000),
  positionUpdatesPerSec: int('POSITION_UPDATES_PER_SEC', 5),

  // ---- Parties & channels -------------------------------------------------
  // Parties are ephemeral in-memory groups (/p), not persisted like guilds.
  maxPartySize: int('MAX_PARTY_SIZE', 8),
  maxChannelsPerAccount: int('MAX_CHANNELS_PER_ACCOUNT', 10),
  maxMutesPerAccount: int('MAX_MUTES_PER_ACCOUNT', 500),

  // ---- HTTP limits (per IP) ----------------------------------------------
  registerPerHour: int('REGISTER_PER_HOUR', 5),
  loginPerMinute: int('LOGIN_PER_MINUTE', 20),
  profileWritesPerMinute: int('PROFILE_WRITES_PER_MINUTE', 20),
  // Other authenticated writes: mutes, channel joins, guild management. These
  // all rewrite a file on disk, so they need a ceiling of their own.
  writesPerMinute: int('WRITES_PER_MINUTE', 60),
  readsPerMinute: int('READS_PER_MINUTE', 240),

  // ---- Search -------------------------------------------------------------
  searchMaxResults: int('SEARCH_MAX_RESULTS', 25),
  searchMinQueryLength: int('SEARCH_MIN_QUERY_LENGTH', 1),

  // ---- Misc ---------------------------------------------------------------
  // CORS origin for the REST API. "*" is fine for a game client (which is not
  // a browser and sends no cookies); tighten it if you build a web front end.
  corsOrigin: str('CORS_ORIGIN', '*'),
  logLevel: str('LOG_LEVEL', 'info'),
  // Only disable in local testing; it turns off the TLS nag on startup.
  warnIfInsecure: bool('WARN_IF_INSECURE', true),
};

module.exports = config;
