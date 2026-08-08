'use strict';

/**
 * Dependency-free unit tests.
 *
 * Run with:  npm run test:unit    (or: node test/unit.js)
 *
 * These cover validation, storage, sessions, guilds and rate limiting using
 * only Node built-ins, so they run before `npm install` and in any environment
 * without registry access. The full end-to-end suite (test/run.js) additionally
 * exercises the HTTP and WebSocket layers and needs express + socket.io.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palrp-unit-'));
process.env.DATA_DIR = dataDir;
process.env.LOG_LEVEL = 'error';
process.env.MIN_PASSWORD_LENGTH = '8';

const validate = require('../src/validate');
const store = require('../src/store');
const auth = require('../src/auth');
const guilds = require('../src/guilds');
const { BucketSet } = require('../src/ratelimit');
const envelope = require('../src/envelope');
const crypto = require('node:crypto');

let passed = 0;
const failures = [];
let section = '';

function sec(name) {
  section = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

async function t(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`\x1b[32m  PASS\x1b[0m  ${label}`);
  } catch (err) {
    failures.push({ section, label, err });
    console.log(`\x1b[31m  FAIL\x1b[0m  ${label}\n        ${err.message}`);
  }
}

async function main() {
  // =========================================================================
  // =========================================================================
  sec('settings — the admin panel must never be able to escalate');
  // =========================================================================
  const settings = require('../src/settings');

  await t('Only allowlisted keys are editable', () => {
    // The panel writes this file as the unprivileged service user. If a key
    // outside the allowlist could be written, a stolen panel session could
    // rewrite the admin token or repoint the data directory.
    for (const forbidden of [
      'ADMIN_TOKEN', 'DOMAIN', 'DATA_DIR', 'PORT', 'HOST', 'TLS_MODE',
      'ADMIN_UI_BIND', 'TRUST_PROXY_HOPS', '__proto__', 'constructor',
    ]) {
      assert.throws(
        () => settings.coerce(forbidden, 'anything'),
        /not an editable setting/,
        `${forbidden} must not be editable from the panel`
      );
    }
  });

  await t('Numeric settings are bounded, not merely parsed', () => {
    assert.throws(() => settings.coerce('MAX_PARTY_SIZE', 0), /between/);
    assert.throws(() => settings.coerce('MAX_PARTY_SIZE', 99999), /between/);
    assert.throws(() => settings.coerce('MAX_PARTY_SIZE', 'abc'), /whole number/);
    assert.equal(settings.coerce('MAX_PARTY_SIZE', '8'), 8);
  });

  await t('Boolean settings accept the usual spellings and reject nonsense', () => {
    for (const yes of [true, 'true', 'yes', 'on', '1']) {
      assert.equal(settings.coerce('REGISTRATION_OPEN', yes), true);
    }
    for (const no of [false, 'false', 'no', 'off', '0']) {
      assert.equal(settings.coerce('REGISTRATION_OPEN', no), false);
    }
    assert.throws(() => settings.coerce('REGISTRATION_OPEN', 'maybe'), /true or false/);
  });

  await t('Every editable key is one config.js actually reads', () => {
    // A setting the panel can change but nothing consumes is a lie to the
    // operator: the toggle moves and nothing happens.
    const configSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.js'), 'utf8');
    for (const key of Object.keys(settings.EDITABLE)) {
      assert.ok(
        configSrc.includes(`'${key}'`),
        `${key} is editable in the panel but config.js never reads it`
      );
    }
  });

  // =========================================================================
  sec('admin panel — authentication');
  // =========================================================================

  await t('Token comparison is length-safe and constant-time', () => {
    process.env.ADMIN_TOKEN = 'correct-horse-battery-staple';
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/admin')];
    const { _internals } = require('../src/admin');
    assert.equal(_internals.tokenMatches('correct-horse-battery-staple'), true);
    assert.equal(_internals.tokenMatches('wrong'), false);
    assert.equal(_internals.tokenMatches(''), false);
    assert.equal(_internals.tokenMatches(null), false);
    assert.equal(_internals.tokenMatches(undefined), false);
    // A longer guess must not throw inside timingSafeEqual.
    assert.equal(_internals.tokenMatches('correct-horse-battery-stapleX'), false);
  });

  await t('A malformed request is a 400, not a 500', () => {
    // ValidationError carries no statusCode, so an unguarded `err.statusCode ||
    // 500` reported every rejected player name as a server error — complete
    // with a stack trace in the logs for what is really a client mistake.
    const { ValidationError } = require('../src/validate');
    const status = (err) => err.statusCode || (err.name === 'ValidationError' ? 400 : 500);
    assert.equal(status(new ValidationError('bad name')), 400);
    assert.equal(status(Object.assign(new Error('too big'), { statusCode: 413 })), 413);
    assert.equal(status(new Error('genuinely broken')), 500);
  });

  await t('Repeated failures lock the login out', () => {
    delete require.cache[require.resolve('../src/admin')];
    const { _internals } = require('../src/admin');
    _internals.attempts.clear();
    assert.equal(_internals.throttled('1.2.3.4'), false);
    for (let i = 0; i < 8; i += 1) _internals.noteFailure('1.2.3.4');
    assert.equal(_internals.throttled('1.2.3.4'), true, 'should lock out after 8 tries');
    assert.equal(_internals.throttled('5.6.7.8'), false, 'other addresses unaffected');
  });

  await t('Sessions expire and unknown ids are rejected', () => {
    delete require.cache[require.resolve('../src/admin')];
    const { _internals } = require('../src/admin');
    const id = _internals.newSession();
    assert.equal(_internals.validSession(id), true);
    assert.equal(_internals.validSession('made-up'), false);
    assert.equal(_internals.validSession(''), false);
    assert.equal(_internals.validSession(undefined), false);
    _internals.sessions.get(id).expires = Date.now() - 1;
    assert.equal(_internals.validSession(id), false, 'expired session must be refused');
  });

  sec('validate — name handling (the path traversal fix)');
  // =========================================================================
  await t('Accepts ordinary names, normalising case', () => {
    assert.equal(validate.normalizeName('Aely'), 'aely');
    assert.equal(validate.normalizeName('  AIDEN  '), 'aiden');
    assert.equal(validate.normalizeName('pal_tamer-99'), 'pal_tamer-99');
  });

  await t('Rejects Windows reserved device names on every platform', () => {
    // These are reserved even with an extension appended, so `con.json` cannot
    // be created on a Windows host. The backend supports Windows natively and
    // writes one file per account, so accepting them would make that player's
    // profile unwritable there — and would break a data directory copied from
    // Linux to Windows.
    for (const p of ['con', 'CON', 'Prn', 'aux', 'nul', 'com1', 'com9', 'lpt1', 'lpt9']) {
      assert.throws(
        () => validate.normalizeName(p),
        validate.ValidationError,
        `should have rejected reserved name: ${p}`
      );
    }
    // Names that merely contain a reserved word are legitimate and must pass.
    for (const p of ['conrad', 'console', 'com', 'lpt', 'nully', 'aux1']) {
      assert.equal(validate.normalizeName(p), p);
    }
  });

  await t('Rejects every traversal and injection payload', () => {
    const payloads = [
      '../../etc/passwd',
      '..\\..\\windows\\system32',
      '../server',
      'a/b',
      'a\\b',
      'aely\x00',
      '.',
      '..',
      '',
      'a',
      'x'.repeat(25),
      '-leading-hyphen',
      'has space',
      'quote"name',
      'semi;colon',
      '$(whoami)',
      'nul\x00.profile',
    ];
    for (const p of payloads) {
      assert.throws(
        () => validate.normalizeName(p),
        validate.ValidationError,
        `should have rejected: ${JSON.stringify(p)}`
      );
    }
  });

  await t('safeJoin keeps every result inside the base directory', () => {
    const base = path.join(dataDir, 'profiles');
    const p = validate.safeJoin(base, 'aely', '.profile');
    assert.ok(p.startsWith(path.resolve(base) + path.sep));
    assert.equal(path.basename(p), 'aely.profile');
    // Even if a caller skipped normalizeName, containment still holds.
    assert.throws(() => validate.safeJoin(base, '../escape', '.profile'));
  });

  await t('Message sanitiser strips control characters but keeps newlines', () => {
    const dirty = 'line one\nline two\ttabbed \x07 \x1b[31m and \x00 nul';
    const clean = validate.sanitizeMessage(dirty);
    assert.ok(clean.includes('\n'), 'newlines preserved for multi-paragraph emotes');
    assert.ok(clean.includes('\t'), 'tabs preserved');
    assert.ok(!clean.includes('\x07'), 'bell character stripped');
    assert.ok(!clean.includes('\x00'), 'null byte stripped');
    assert.ok(!clean.includes('\x1b'), 'no ANSI escapes reach other players UI');
  });

  await t('Message sanitiser enforces the byte ceiling', () => {
    assert.throws(() => validate.sanitizeMessage('x'.repeat(200000)), /limit is/);
    assert.throws(() => validate.sanitizeMessage(''), /empty/);
    assert.throws(() => validate.sanitizeMessage(null), /string/);
  });

  await t('Position normaliser rejects NaN and clamps absurd coordinates', () => {
    assert.deepEqual(validate.normalizePosition({ x: 'abc', y: NaN, z: Infinity }), {
      x: 0,
      y: 0,
      z: 0,
    });
    assert.deepEqual(validate.normalizePosition(null), { x: 0, y: 0, z: 0 });
    assert.equal(validate.normalizePosition({ x: 1e30, y: 0, z: 0 }).x, 1e9);
  });

  // =========================================================================
  sec('store — accounts and password hashing');
  // =========================================================================
  await store.init();

  await t('Creates an account and stores no plaintext password', async () => {
    await store.createAccount('aely', 'correct-horse-battery');
    const raw = await fsp.readFile(path.join(dataDir, 'accounts', 'aely.account'), 'utf8');
    assert.ok(!raw.includes('correct-horse-battery'), 'plaintext password must not be on disk');
    const parsed = JSON.parse(raw);
    assert.ok(parsed.salt && parsed.hash, 'salt and hash are stored');
    assert.notEqual(parsed.hash, parsed.salt);
  });

  await t('Verifies the correct password and rejects a wrong one', async () => {
    const account = store.getAccount('aely');
    assert.equal(await store.verifyPassword('correct-horse-battery', account), true);
    assert.equal(await store.verifyPassword('wrong-password', account), false);
    assert.equal(await store.verifyPassword('', account), false);
  });

  await t('Verifying a non-existent account returns false without throwing', async () => {
    assert.equal(await store.verifyPassword('anything', null), false);
  });

  await t('Two accounts with the same password get different hashes (unique salts)', async () => {
    await store.createAccount('twin-a', 'identical-password');
    await store.createAccount('twin-b', 'identical-password');
    assert.notEqual(store.getAccount('twin-a').hash, store.getAccount('twin-b').hash);
  });

  await t('Duplicate registration is refused', async () => {
    await assert.rejects(() => store.createAccount('aely', 'another-password'), /already registered/);
  });

  await t('Password change invalidates the old password', async () => {
    await store.changePassword(store.getAccount('twin-a'), 'brand-new-password');
    const account = store.getAccount('twin-a');
    assert.equal(await store.verifyPassword('identical-password', account), false);
    assert.equal(await store.verifyPassword('brand-new-password', account), true);
  });

  // =========================================================================
  sec('store — profiles');
  // =========================================================================
  await t('Profile round-trips and contains no credential material', async () => {
    await store.writeProfile('aely', { title: 'Wandering Tamer', age: 24 });
    const profile = await store.readProfile('aely');
    assert.equal(profile.fields.title, 'Wandering Tamer');
    const onDisk = await fsp.readFile(path.join(dataDir, 'profiles', 'aely.profile'), 'utf8');
    assert.ok(!/password|salt|hash/i.test(onDisk), 'profile file holds no secrets');
  });

  await t('Reading a missing profile returns null rather than throwing', async () => {
    assert.equal(await store.readProfile('nobody-here'), null);
  });

  await t('Oversized profiles are refused', async () => {
    await assert.rejects(
      () => store.writeProfile('aely', { bio: 'x'.repeat(400000) }),
      /limit/
    );
  });

  await t('25 concurrent writes leave valid, parseable JSON (atomic + locked)', async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => store.writeProfile('aely', { index: i, bio: `rev ${i}` }))
    );
    const raw = await fsp.readFile(path.join(dataDir, 'profiles', 'aely.profile'), 'utf8');
    const parsed = JSON.parse(raw); // throws if a write was torn
    assert.equal(typeof parsed.fields.index, 'number');
  });

  await t('No temp files are left behind by atomic writes', async () => {
    const files = await fsp.readdir(path.join(dataDir, 'profiles'));
    assert.deepEqual(files.filter((f) => f.includes('.tmp')), []);
  });

  // =========================================================================
  sec('store — search index (powers /who)');
  // =========================================================================
  await t('Prefix search returns all matches, sorted', async () => {
    for (const n of ['aiden', 'aaron', 'aerith', 'brant', 'zed']) {
      await store.createAccount(n, `${n}-password-123`);
      await store.writeProfile(n, { bio: n });
    }
    assert.deepEqual(store.search('a'), ['aaron', 'aely', 'aerith', 'aiden']);
    assert.deepEqual(store.search('ae'), ['aely', 'aerith']);
    assert.deepEqual(store.search('ael'), ['aely']);
    assert.deepEqual(store.search('aely'), ['aely']);
  });

  await t('Search returns an empty list when nothing matches', () => {
    assert.deepEqual(store.search('q'), []);
    assert.deepEqual(store.search('zzz'), []);
  });

  await t('Substring matches are included after prefix matches', () => {
    const results = store.search('er');
    assert.ok(results.includes('aerith'), 'finds a mid-name match');
  });

  await t('Results are capped so one query cannot return the whole database', async () => {
    for (let i = 0; i < 60; i++) {
      await store.writeProfile(`bulk${String(i).padStart(3, '0')}`, { bio: 'x' });
    }
    assert.ok(store.search('bulk').length <= 25, 'respects SEARCH_MAX_RESULTS');
  });

  await t('Deleting a profile removes it from the index', async () => {
    await store.deleteProfile('zed');
    assert.deepEqual(store.search('zed'), []);
  });

  await t('Index is rebuilt from disk on restart', async () => {
    const before = store.search('ae');
    store._accounts.clear();
    await store.init();
    assert.deepEqual(store.search('ae'), before);
    assert.ok(store.getAccount('aely'), 'accounts reload too');
    assert.equal(
      await store.verifyPassword('correct-horse-battery', store.getAccount('aely')),
      true,
      'reloaded hash still verifies'
    );
  });

  // =========================================================================
  sec('auth — session tokens');
  // =========================================================================
  await t('Issued token resolves to the right account', () => {
    const { token } = auth.issue('aely');
    assert.equal(auth.resolve(token)?.name, 'aely');
  });

  await t('Garbage tokens resolve to nothing', () => {
    assert.equal(auth.resolve('nonsense'), null);
    assert.equal(auth.resolve(''), null);
    assert.equal(auth.resolve(null), null);
    assert.equal(auth.resolve(undefined), null);
    assert.equal(auth.resolve({}), null);
  });

  await t('Tokens are long and unpredictable', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const { token } = auth.issue('aely');
      assert.ok(token.length >= 40, 'token has at least 240 bits of entropy');
      assert.ok(!seen.has(token), 'no collisions');
      seen.add(token);
      auth.revoke(token);
    }
  });

  await t('Revocation is immediate', () => {
    const { token } = auth.issue('aely');
    assert.ok(auth.resolve(token));
    auth.revoke(token);
    assert.equal(auth.resolve(token), null);
  });

  await t('Concurrent sessions per account are capped, evicting the oldest', () => {
    const tokens = [];
    for (let i = 0; i < 12; i++) tokens.push(auth.issue('aiden').token);
    const live = tokens.filter((tok) => auth.resolve(tok));
    assert.ok(live.length <= 5, `expected <= 5 live sessions, got ${live.length}`);
    assert.ok(auth.resolve(tokens[tokens.length - 1]), 'the newest session survives');
    assert.equal(auth.resolve(tokens[0]), null, 'the oldest was evicted');
  });

  await t('revokeAllFor kills every session for one account only', () => {
    const a = auth.issue('aely').token;
    const b = auth.issue('aerith').token;
    auth.revokeAllFor('aely');
    assert.equal(auth.resolve(a), null);
    assert.ok(auth.resolve(b), 'other accounts are unaffected');
  });

  await t('A banned account’s token stops working immediately', async () => {
    const { token } = auth.issue('aerith');
    assert.ok(auth.resolve(token));
    await store.updateAccount(store.getAccount('aerith'), (acc) => {
      acc.banned = true;
    });
    assert.equal(auth.resolve(token), null, 'ban is enforced at token resolution');
    await store.updateAccount(store.getAccount('aerith'), (acc) => {
      acc.banned = false;
    });
  });

  await t('A deleted account’s token stops working', async () => {
    await store.createAccount('temp-user', 'temp-password-123');
    const { token } = auth.issue('temp-user');
    assert.ok(auth.resolve(token));
    await store.deleteAccount('temp-user');
    assert.equal(auth.resolve(token), null);
  });

  // =========================================================================
  sec('guilds');
  // =========================================================================
  await guilds.init();

  await t('Guild creation stores a hashed passcode', async () => {
    await guilds.create('moonlight', 'guild-passcode-1', 'aely');
    const raw = await fsp.readFile(path.join(dataDir, 'guilds', 'moonlight.guild'), 'utf8');
    assert.ok(!raw.includes('guild-passcode-1'), 'passcode is not stored in plaintext');
  });

  await t('Correct passcode joins, wrong passcode does not', async () => {
    assert.equal(await guilds.verifyPasscode('moonlight', 'guild-passcode-1'), true);
    assert.equal(await guilds.verifyPasscode('moonlight', 'wrong-passcode'), false);
  });

  await t('An unknown guild fails the same way a wrong passcode does', async () => {
    assert.equal(await guilds.verifyPasscode('does-not-exist', 'anything-here'), false);
  });

  await t('Duplicate guild names are refused', async () => {
    await assert.rejects(() => guilds.create('moonlight', 'other-passcode', 'aiden'), /already exists/);
  });

  // =========================================================================
  sec('ratelimit — buckets, refill, and fanout accounting');
  // =========================================================================
  await t('Consumes down to empty then refuses', () => {
    const bucket = new BucketSet({ capacity: 100, refillPerSec: 10 });
    const now = Date.now();
    assert.equal(bucket.consume('k', 60, now), true);
    assert.equal(bucket.consume('k', 40, now), true);
    assert.equal(bucket.consume('k', 1, now), false);
  });

  await t('Refills over time at the configured rate', () => {
    const bucket = new BucketSet({ capacity: 100, refillPerSec: 10 });
    const t0 = Date.now();
    bucket.consume('k', 100, t0);
    assert.equal(bucket.consume('k', 50, t0 + 1000), false, '10 tokens after 1s is not enough');
    assert.equal(bucket.consume('k', 50, t0 + 6000), true, '60 tokens after 6s is enough');
  });

  await t('Never refills above capacity', () => {
    const bucket = new BucketSet({ capacity: 100, refillPerSec: 1000 });
    const t0 = Date.now();
    bucket.consume('k', 100, t0);
    assert.equal(bucket.consume('k', 100, t0 + 60000), true);
    assert.equal(bucket.consume('k', 1, t0 + 60000), false, 'capacity is the hard ceiling');
  });

  await t('THE RECONNECT BUG — bucket state is keyed by account, not by socket', () => {
    const bucket = new BucketSet({ capacity: 100, refillPerSec: 0.001 });
    const now = Date.now();
    bucket.consume('aely', 100, now);
    // Simulate a client dropping its socket and reconnecting: same account,
    // brand new connection. In the old design the bucket lived on the socket
    // object and this call would succeed.
    assert.equal(bucket.consume('aely', 50, now), false, 'still throttled after "reconnect"');
    assert.equal(bucket.consume('aiden', 50, now), true, 'a different player is unaffected');
  });

  await t('FANOUT ACCOUNTING — audience size determines the cost', () => {
    const bucket = new BucketSet({ capacity: 300000, refillPerSec: 0 });
    const now = Date.now();
    const messageBytes = 50000;

    // 50 KB emote heard by 3 nearby players: 150 KB. This is the roleplay case
    // and it must stay allowed.
    assert.equal(bucket.consume('aely', messageBytes * 3, now), true, 'big local emote passes');

    // The same 50 KB pushed to 100 people in global would be 5 MB of egress.
    assert.equal(
      bucket.consume('aely', messageBytes * 100, now),
      false,
      'the same text blasted server-wide is refused'
    );
  });

  await t('retryAfter reports a sensible wait', () => {
    const bucket = new BucketSet({ capacity: 100, refillPerSec: 10 });
    const now = Date.now();
    bucket.consume('k', 100, now);
    assert.equal(bucket.retryAfter('k', 50, now), 5);
    assert.equal(bucket.retryAfter('k', 0, now), 0);
  });

  await t('Idle buckets are swept so memory does not grow forever', () => {
    const bucket = new BucketSet({ capacity: 10, refillPerSec: 1, idleMs: 1000 });
    const t0 = Date.now();
    bucket.consume('a', 1, t0);
    bucket.consume('b', 1, t0);
    assert.equal(bucket.size, 2);
    bucket.sweep(t0 + 5000);
    assert.equal(bucket.size, 0, 'idle entries released');
  });

  // =========================================================================
  sec('envelope — AES-256-GCM validation (server never decrypts)');
  // =========================================================================
  const KEY = crypto.randomBytes(32);
  const seal = (text) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    const ct = Buffer.concat([c.update(text, 'utf8'), c.final(), c.getAuthTag()]);
    return { v: 1, iv: iv.toString('base64'), ct: ct.toString('base64') };
  };
  const open_ = (env, key = KEY) => {
    const raw = Buffer.from(env.ct, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8');
  };

  await t('A real AES-256-GCM envelope round-trips through validation untouched', () => {
    const env = seal('Aely kisses Aiden.');
    const { bytes } = envelope.validateEnvelope(env);
    assert.ok(bytes > 16, 'reports the ciphertext size for rate limiting');
    // The critical property: validation must not mutate the payload, or the
    // receiver's auth tag check would fail.
    assert.equal(open_(env), 'Aely kisses Aiden.');
  });

  await t('Tampering with one ciphertext byte is caught by the auth tag', () => {
    const env = seal('transfer 1000 gold');
    const raw = Buffer.from(env.ct, 'base64');
    raw[0] ^= 0x01;
    const tampered = { ...env, ct: raw.toString('base64') };
    envelope.validateEnvelope(tampered); // server still accepts: it cannot tell
    assert.throws(() => open_(tampered), /unable to authenticate|Unsupported state/i);
  });

  await t('A wrong key cannot decrypt', () => {
    const env = seal('secret');
    assert.throws(() => open_(env, crypto.randomBytes(32)), /unable to authenticate|Unsupported state/i);
  });

  await t('Every message gets a fresh IV', () => {
    const ivs = new Set();
    for (let i = 0; i < 200; i++) ivs.add(seal('same text every time').iv);
    assert.equal(ivs.size, 200, 'IV reuse would be catastrophic for GCM');
  });

  await t('Malformed envelopes are rejected', () => {
    const good = seal('hello');
    const bad = [
      null, 'a string', 42, [],
      { v: 2, iv: good.iv, ct: good.ct },
      { v: 1, ct: good.ct },
      { v: 1, iv: good.iv },
      { v: 1, iv: 'not base64!!', ct: good.ct },
      { v: 1, iv: good.iv, ct: 'not base64!!' },
      { v: 1, iv: Buffer.alloc(8).toString('base64'), ct: good.ct },   // short IV
      { v: 1, iv: Buffer.alloc(16).toString('base64'), ct: good.ct },  // long IV
      { v: 1, iv: good.iv, ct: Buffer.alloc(4).toString('base64') },   // shorter than the tag
    ];
    for (const b of bad) {
      assert.throws(() => envelope.validateEnvelope(b), /./, `should reject ${JSON.stringify(b)}`);
    }
  });

  await t('Oversized ciphertext is rejected', () => {
    const huge = { v: 1, iv: Buffer.alloc(12).toString('base64'), ct: Buffer.alloc(200000).toString('base64') };
    assert.throws(() => envelope.validateEnvelope(huge), /limit is/);
  });

  await t('base64 length maths is exact', () => {
    for (const n of [1, 2, 3, 12, 16, 17, 100, 1023]) {
      assert.equal(envelope.decodedLength(Buffer.alloc(n).toString('base64')), n, `n=${n}`);
    }
  });

  // =========================================================================
  const total = passed + failures.length;
  console.log(`\n${'='.repeat(64)}`);
  console.log(`  ${passed} passed, ${failures.length} failed  (${total} assertions groups)`);
  console.log('='.repeat(64));
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  [${f.section}] ${f.label}\n    ${f.err.stack}`);
  }
  return failures.length;
}

main()
  .then(async (code) => {
    await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('Unit run crashed:', err);
    await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    process.exit(1);
  });
