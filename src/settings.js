'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// Deliberately does NOT require ./config. loadIntoEnv() has to run before
// config.js is first required, otherwise the overrides are read after the
// configuration has already been frozen from the environment and would have no
// effect at all. Resolving the data directory independently keeps that order
// possible. Same reason logging goes through console here rather than ./log.

/**
 * Runtime-editable settings.
 *
 * The env file is root-owned and mode 640: the service account can read it but
 * cannot write it. That is deliberate — a compromised service should not be
 * able to rewrite its own configuration, change ADMIN_TOKEN, or point DOMAIN
 * somewhere else.
 *
 * Rather than weaken that by granting the service write access (or a sudo rule
 * to edit the file), the admin panel writes a small overrides file inside the
 * data directory, which the service already owns. Precedence is:
 *
 *     built-in default  <  env file  <  settings.json
 *
 * Only keys in EDITABLE below can ever appear here. Anything security-critical
 * — the admin token, the domain, TLS mode, ports, the data directory — is
 * absent by design and can only be changed by an operator with root, editing
 * the env file. So the worst a stolen panel session can do is make the server
 * annoying, not hand itself the keys.
 */

function dataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.platform === 'win32') {
    const base = process.env.ProgramData || process.env.LOCALAPPDATA || process.cwd();
    return path.join(base, 'PalworldRPBackend', 'data');
  }
  if (process.platform === 'darwin') return '/usr/local/var/palworld-rp-backend';
  return '/usr/src/app/data';
}

const SETTINGS_FILE = path.join(dataDir(), 'settings.json');

const log = {
  warn: (msg, extra) =>
    console.warn(JSON.stringify({ level: 'warn', msg, ...extra })),
};

/**
 * The allowlist. Each entry declares its type and bounds so a bad value is
 * rejected at the door rather than crashing the server later. `restart: true`
 * means the running process reads the value only at startup, so the panel
 * tells the operator a restart is needed.
 */
// Null-prototype: a plain object literal would make EDITABLE['__proto__']
// return Object.prototype (truthy) and EDITABLE['constructor'] return a
// function, so a `if (!EDITABLE[key])` guard would wave both through and the
// subsequent assignment would pollute the prototype chain.
const EDITABLE = Object.assign(Object.create(null), {
  MAX_MESSAGE_BYTES: {
    type: 'int', min: 1024, max: 1_000_000, restart: true,
    label: 'Maximum message size (bytes)',
    help: 'The biggest single chat message. This is what "unlimited chat" actually means.',
  },
  CHAT_BURST_BYTES: {
    type: 'int', min: 1024, max: 100_000_000, restart: true,
    label: 'Chat burst allowance (bytes)',
    help: 'How much a player may send in one go before throttling starts.',
  },
  CHAT_REFILL_BYTES_PER_SEC: {
    type: 'int', min: 128, max: 10_000_000, restart: true,
    label: 'Chat refill rate (bytes/sec)',
    help: 'How quickly the allowance refills. Cost is charged as message bytes multiplied by the number of recipients.',
  },
  LOCAL_CHAT_RADIUS: {
    type: 'int', min: 100, max: 100_000, restart: true,
    label: 'Local chat radius',
    help: 'How far /s and /em carry, in game units.',
  },
  MAX_PARTY_SIZE: {
    type: 'int', min: 2, max: 64, restart: true,
    label: 'Maximum party size',
    help: 'Players per party, including the leader.',
  },
  MAX_CHANNELS_PER_ACCOUNT: {
    type: 'int', min: 1, max: 100, restart: true,
    label: 'Custom channels per account',
    help: 'How many custom channels one player may join at once.',
  },
  MIN_PASSWORD_LENGTH: {
    type: 'int', min: 8, max: 128, restart: true,
    label: 'Minimum password length',
    help: 'Applies to new registrations and password changes. Lowering this does not weaken existing passwords.',
  },
  REGISTRATION_OPEN: {
    type: 'bool', restart: false,
    label: 'Registration open',
    help: 'When off, existing players can still log in but nobody new can register. The usual response to a wave of spam signups.',
  },
  REQUIRE_ENCRYPTION: {
    type: 'bool', restart: true,
    label: 'Require AES-256 envelopes',
    help: 'When on, message content must arrive as an AES-256-GCM envelope. Turning this off would let an outdated mod send plaintext — leave it on.',
  },
});

/** In-memory overrides, loaded once at startup and mutated by the panel. */
let overrides = Object.create(null);

function isEditable(key) {
  return Object.prototype.hasOwnProperty.call(EDITABLE, key);
}

function coerce(key, raw) {
  if (!isEditable(key)) {
    const err = new Error(`"${key}" is not an editable setting.`);
    err.statusCode = 400;
    throw err;
  }
  const spec = EDITABLE[key];
  if (!spec) {
    const err = new Error(`"${key}" is not an editable setting.`);
    err.statusCode = 400;
    throw err;
  }

  if (spec.type === 'bool') {
    if (typeof raw === 'boolean') return raw;
    if (/^(1|true|yes|on)$/i.test(String(raw))) return true;
    if (/^(0|false|no|off)$/i.test(String(raw))) return false;
    const err = new Error(`${key} must be true or false.`);
    err.statusCode = 400;
    throw err;
  }

  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) {
    const err = new Error(`${key} must be a whole number.`);
    err.statusCode = 400;
    throw err;
  }
  if (n < spec.min || n > spec.max) {
    const err = new Error(`${key} must be between ${spec.min} and ${spec.max}.`);
    err.statusCode = 400;
    throw err;
  }
  return n;
}

/**
 * Read overrides from disk and apply them to process.env BEFORE config.js is
 * required, so the running configuration reflects them. Callers that need this
 * must invoke it first thing at startup.
 */
function loadIntoEnv() {
  let raw;
  try {
    raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.warn('Could not read settings overrides; using the env file alone.', {
        file: SETTINGS_FILE, err: err.message,
      });
    }
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // A corrupt overrides file must not stop the server from booting. Ignoring
    // it falls back to the env file, which is the safe configuration.
    log.warn('Settings overrides file is not valid JSON; ignoring it.', {
      file: SETTINGS_FILE, err: err.message,
    });
    return {};
  }

  const applied = Object.create(null);
  for (const [key, value] of Object.entries(parsed)) {
    if (!isEditable(key)) continue;        // silently drop anything not allowlisted
    try {
      const clean = coerce(key, value);
      process.env[key] = String(clean);
      applied[key] = clean;
    } catch {
      log.warn('Ignoring out-of-range setting override', { key, value });
    }
  }
  overrides = applied;
  return applied;
}

async function save(patch) {
  const next = Object.assign(Object.create(null), overrides);
  for (const [key, value] of Object.entries(patch)) {
    next[key] = coerce(key, value);          // throws on anything not allowlisted
  }

  await fsp.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });

  // Same atomic write discipline as the rest of the store: a half-written
  // settings file would be silently ignored at next boot, quietly reverting
  // the operator's changes.
  const tmp = `${SETTINGS_FILE}.${process.pid}.tmp`;
  const handle = await fsp.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, SETTINGS_FILE);

  overrides = next;
  return next;
}

/** What the panel renders: current value, bounds, and where it came from. */
function describe() {
  return Object.entries(EDITABLE).map(([key, spec]) => {
    const current = process.env[key];
    return {
      key,
      label: spec.label,
      help: spec.help,
      type: spec.type,
      min: spec.min,
      max: spec.max,
      restart: Boolean(spec.restart),
      value: spec.type === 'bool'
        ? /^(1|true|yes|on)$/i.test(String(current ?? ''))
        : (current === undefined ? null : Number.parseInt(current, 10)),
      overridden: Object.prototype.hasOwnProperty.call(overrides, key),
    };
  });
}

async function reset(key) {
  if (!isEditable(key)) {
    const err = new Error(`"${key}" is not an editable setting.`);
    err.statusCode = 400;
    throw err;
  }
  const next = Object.assign(Object.create(null), overrides);
  delete next[key];

  await fsp.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
  const tmp = `${SETTINGS_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(tmp, SETTINGS_FILE);

  overrides = next;
  return next;
}

module.exports = {
  EDITABLE,
  isEditable,
  SETTINGS_FILE,
  loadIntoEnv,
  save,
  reset,
  describe,
  coerce,
  current: () => ({ ...overrides }),
};
