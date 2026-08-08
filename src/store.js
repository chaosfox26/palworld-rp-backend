'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const config = require('./config');
const log = require('./log');
const { safeJoin, ValidationError } = require('./validate');

/**
 * Storage layout under DATA_DIR:
 *
 *   accounts/<name>.account   secret material: password hash, mutes, guild
 *   profiles/<name>.profile   public roleplay profile, served verbatim
 *
 * Splitting these two is deliberate. The old design stored the password inside
 * the profile and relied on `delete profile._password` before every response.
 * That is one forgotten line away from leaking every password on the server.
 * Here the public file simply never contains a secret, so a read path cannot
 * leak one even if it is written carelessly.
 */

const accountsDir = path.join(config.dataDir, 'accounts');
const profilesDir = path.join(config.dataDir, 'profiles');

/** name -> { name, salt, hash, createdAt, guild, mutes:Set, channels:[], banned } */
const accounts = new Map();
/** Sorted array of names, kept in sync, so /search never hits the disk. */
let nameIndex = [];

// ---------------------------------------------------------------------------
// Password hashing (scrypt from node:crypto — no native build step required)
// ---------------------------------------------------------------------------

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS, (err, dk) =>
      err ? reject(err) : resolve(dk)
    );
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(password, salt);
  return { salt: salt.toString('base64'), hash: dk.toString('base64') };
}

async function verifyPassword(password, account) {
  // A missing account still runs a full scrypt against a dummy salt so that
  // "no such user" and "wrong password" take the same time. Without this an
  // attacker can enumerate which character names exist by timing alone.
  const salt = account ? Buffer.from(account.salt, 'base64') : Buffer.alloc(16);
  const expected = account
    ? Buffer.from(account.hash, 'base64')
    : Buffer.alloc(SCRYPT_PARAMS.keylen);
  const actual = await scrypt(password, salt);
  const ok = crypto.timingSafeEqual(actual, expected);
  return Boolean(account) && ok;
}

// ---------------------------------------------------------------------------
// Atomic file writes
// ---------------------------------------------------------------------------

/**
 * Write to a temp file in the same directory, fsync, then rename over the
 * target. rename() is atomic within a filesystem, so a crash or a power cut
 * mid-write leaves the old file intact instead of a truncated one. The old
 * design used a bare fs.writeFile, which can and does leave half-written JSON
 * that then fails to parse forever.
 */
async function writeFileAtomic(filePath, contents) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let handle;
  try {
    handle = await fsp.open(tmp, 'w', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(tmp, filePath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Per-name write serialisation
// ---------------------------------------------------------------------------

/**
 * Node is single-threaded but await points interleave. Two concurrent POSTs for
 * the same profile could previously read-modify-write over each other and lose
 * an update. Each name gets a promise chain so its writes run strictly in order.
 */
const writeLocks = new Map();

function withLock(name, fn) {
  const prev = writeLocks.get(name) || Promise.resolve();
  const next = prev.then(fn, fn);
  writeLocks.set(
    name,
    next.then(
      () => {
        if (writeLocks.get(name) === next) writeLocks.delete(name);
      },
      () => {
        if (writeLocks.get(name) === next) writeLocks.delete(name);
      }
    )
  );
  return next;
}

// ---------------------------------------------------------------------------
// Index maintenance
// ---------------------------------------------------------------------------

function indexInsert(name) {
  const pos = lowerBound(nameIndex, name);
  if (nameIndex[pos] !== name) nameIndex.splice(pos, 0, name);
}

function indexRemove(name) {
  const pos = lowerBound(nameIndex, name);
  if (nameIndex[pos] === name) nameIndex.splice(pos, 1);
}

function lowerBound(arr, target) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Prefix matches first (binary search over the sorted index), then substring
 * matches to fill the remainder. The old implementation ran a full readdir()
 * of the profiles directory on every single /who — O(files) syscalls per
 * keystroke, and a free denial of service once the directory got large.
 */
function search(query, limit = config.searchMaxResults) {
  const q = String(query || '').toLowerCase();
  if (q.length < config.searchMinQueryLength) return [];

  const results = [];
  const seen = new Set();

  for (let i = lowerBound(nameIndex, q); i < nameIndex.length; i++) {
    if (!nameIndex[i].startsWith(q)) break;
    if (results.length >= limit) break;
    results.push(nameIndex[i]);
    seen.add(nameIndex[i]);
  }

  if (results.length < limit && q.length >= 2) {
    for (const name of nameIndex) {
      if (results.length >= limit) break;
      if (!seen.has(name) && name.includes(q)) results.push(name);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

function accountPath(name) {
  return safeJoin(accountsDir, name, '.account');
}

function profilePath(name) {
  return safeJoin(profilesDir, name, '.profile');
}

function getAccount(name) {
  return accounts.get(name) || null;
}

function accountCount() {
  return accounts.size;
}

async function persistAccount(account) {
  const serialised = JSON.stringify(
    {
      name: account.name,
      salt: account.salt,
      hash: account.hash,
      createdAt: account.createdAt,
      updatedAt: Date.now(),
      guild: account.guild,
      channels: account.channels,
      mutes: [...account.mutes],
      banned: account.banned,
      banReason: account.banReason,
    },
    null,
    2
  );
  await writeFileAtomic(accountPath(account.name), serialised);
}

async function createAccount(name, password) {
  if (accounts.has(name)) {
    throw new ValidationError('That name is already registered.', 409);
  }
  if (accounts.size >= config.maxAccounts) {
    throw new ValidationError('This server has reached its account limit.', 507);
  }
  const { salt, hash } = await hashPassword(password);
  const account = {
    name,
    salt,
    hash,
    createdAt: Date.now(),
    guild: null,
    channels: [],
    mutes: new Set(),
    banned: false,
    banReason: null,
  };
  return withLock(name, async () => {
    if (accounts.has(name)) {
      throw new ValidationError('That name is already registered.', 409);
    }
    accounts.set(name, account);
    try {
      await persistAccount(account);
    } catch (err) {
      accounts.delete(name);
      throw err;
    }
    return account;
  });
}

async function changePassword(account, newPassword) {
  const { salt, hash } = await hashPassword(newPassword);
  return withLock(account.name, async () => {
    account.salt = salt;
    account.hash = hash;
    await persistAccount(account);
  });
}

async function updateAccount(account, mutate) {
  return withLock(account.name, async () => {
    mutate(account);
    await persistAccount(account);
    return account;
  });
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

async function readProfile(name) {
  try {
    const raw = await fsp.readFile(profilePath(name), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err instanceof SyntaxError) {
      log.error('Corrupt profile on disk', { name });
      return null;
    }
    throw err;
  }
}

async function writeProfile(name, fields) {
  const payload = {
    name,
    updatedAt: Date.now(),
    fields,
  };
  const serialised = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(serialised, 'utf8') > config.maxProfileBytes) {
    throw new ValidationError(
      `Profile exceeds the ${config.maxProfileBytes} byte limit.`,
      413
    );
  }
  return withLock(name, async () => {
    await writeFileAtomic(profilePath(name), serialised);
    indexInsert(name);
    return payload;
  });
}

async function deleteProfile(name) {
  return withLock(name, async () => {
    await fsp.rm(profilePath(name), { force: true });
    indexRemove(name);
  });
}

async function deleteAccount(name) {
  const account = accounts.get(name);
  if (!account) return false;
  await withLock(name, async () => {
    accounts.delete(name);
    indexRemove(name);
    await fsp.rm(accountPath(name), { force: true }).catch(() => {});
    await fsp.rm(profilePath(name), { force: true }).catch(() => {});
  });
  return true;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function init() {
  await fsp.mkdir(accountsDir, { recursive: true, mode: 0o700 });
  await fsp.mkdir(profilesDir, { recursive: true, mode: 0o700 });

  const accountFiles = await fsp.readdir(accountsDir).catch(() => []);
  for (const file of accountFiles) {
    if (!file.endsWith('.account')) continue;
    try {
      const raw = await fsp.readFile(path.join(accountsDir, file), 'utf8');
      const data = JSON.parse(raw);
      accounts.set(data.name, {
        name: data.name,
        salt: data.salt,
        hash: data.hash,
        createdAt: data.createdAt || Date.now(),
        guild: data.guild ?? null,
        channels: Array.isArray(data.channels) ? data.channels : [],
        mutes: new Set(Array.isArray(data.mutes) ? data.mutes : []),
        banned: Boolean(data.banned),
        banReason: data.banReason ?? null,
      });
    } catch (err) {
      log.error('Skipping unreadable account file', { file, err: err.message });
    }
  }

  const profileFiles = await fsp.readdir(profilesDir).catch(() => []);
  const names = new Set();
  for (const file of profileFiles) {
    if (!file.endsWith('.profile')) continue;
    names.add(file.slice(0, -'.profile'.length));
  }
  nameIndex = [...names].sort();

  log.info('Storage ready', {
    accounts: accounts.size,
    profiles: nameIndex.length,
    dataDir: config.dataDir,
  });
}

module.exports = {
  init,
  accountsDir,
  profilesDir,
  hashPassword,
  verifyPassword,
  createAccount,
  changePassword,
  updateAccount,
  persistAccount,
  getAccount,
  accountCount,
  deleteAccount,
  readProfile,
  writeProfile,
  deleteProfile,
  search,
  indexInsert,
  indexRemove,
  writeFileAtomic,
  // exposed for tests
  _accounts: accounts,
  _nameIndex: () => nameIndex,
};
