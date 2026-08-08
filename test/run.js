'use strict';

/**
 * Comprehensive backend test suite.
 *
 * Run with:  npm test
 *
 * This does more than confirm the happy path works. Every section marked
 * ATTACK reproduces something that succeeds against the previous version of
 * this backend and must now fail. If you change the server, these are the tests
 * that stop you from quietly reintroducing a hole.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 34117);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'test-admin-token-please-change';

let dataDir;
let child;

// ---------------------------------------------------------------------------
// Tiny assertion harness
// ---------------------------------------------------------------------------

const results = [];
let currentSection = '';

function section(name) {
  currentSection = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

function record(ok, label, detail) {
  results.push({ ok, section: currentSection, label, detail });
  const mark = ok ? '\x1b[32m  PASS\x1b[0m' : '\x1b[31m  FAIL\x1b[0m';
  console.log(`${mark}  ${label}${!ok && detail ? `\n        ${detail}` : ''}`);
}

function check(ok, label, detail) {
  record(Boolean(ok), label, detail);
  return Boolean(ok);
}

function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  record(ok, label, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function api(method, urlPath, { body, token, raw } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON response */
  }
  return { status: res.status, json, text, raw: raw ? res : undefined };
}

// ---------------------------------------------------------------------------
// Socket helper
// ---------------------------------------------------------------------------

function connect(token, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      timeout,
    });
    const inbox = [];
    const errors = [];
    socket.on('chat_receive', (d) => inbox.push(d));
    socket.on('chat_error', (d) => errors.push(d));
    socket.on('connect', () =>
      resolve({
        socket,
        inbox,
        errors,
        name: null,
        send: (packet) => socket.emit('send_chat', packet),
        move: (pos) => socket.emit('update_position', pos),
        clear: () => {
          inbox.length = 0;
          errors.length = 0;
        },
        close: () => socket.close(),
      })
    );
    socket.on('connect_error', (err) => {
      socket.close();
      reject(err);
    });
  });
}

/** Wait for the event loop to flush deliveries. */
const settle = () => sleep(250);

/**
 * Emit an event that takes an acknowledgement callback and await the reply.
 * Resolves with an error object on timeout rather than hanging the suite.
 */
function rpc(client, event, payload = {}, timeout = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'timed out' }), timeout);
    client.socket.emit(event, payload, (res) => {
      clearTimeout(timer);
      resolve(res ?? {});
    });
  });
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

function startServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        DATA_DIR: dataDir,
        ADMIN_TOKEN,
        LOG_LEVEL: 'error',
        // Most sections exercise routing with plaintext for readability; the
        // encrypted mode gets its own section below, which restarts the server.
        REQUIRE_ENCRYPTION: 'false',
        WARN_IF_INSECURE: 'false',
        MIN_PASSWORD_LENGTH: '8',
        // Tuned small so fanout accounting is observable in a few seconds.
        MAX_MESSAGE_BYTES: '100000',
        CHAT_BURST_BYTES: '300000',
        CHAT_REFILL_BYTES_PER_SEC: '1000',
        CHAT_BURST_MESSAGES: '200',
        CHAT_REFILL_MESSAGES_PER_SEC: '50',
        REGISTER_PER_HOUR: '100',
        LOGIN_PER_MINUTE: '200',
        PROFILE_WRITES_PER_MINUTE: '200',
        READS_PER_MINUTE: '2000',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Server exited with ${code}\n${stderr}`));
      }
    });

    (async () => {
      for (let i = 0; i < 100; i++) {
        try {
          const res = await fetch(`${BASE}/health`);
          if (res.ok) return resolve();
        } catch {
          /* not up yet */
        }
        await sleep(100);
      }
      return reject(new Error(`Server did not become healthy.\n${stderr}`));
    })();
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 5000);
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function run() {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palrp-test-'));
  console.log(`Data dir: ${dataDir}`);
  await startServer();

  const tokens = {};

  // =========================================================================
  section('1. Service discovery');
  // =========================================================================
  {
    const health = await api('GET', '/health');
    check(health.status === 200 && health.json.ok === true, 'GET /health returns ok');

    const info = await api('GET', '/info');
    check(info.status === 200 && info.json.apiVersion === 1, 'GET /info advertises apiVersion');
    check(
      typeof info.json.limits.maxMessageBytes === 'number',
      'GET /info advertises limits so the mod can size its input box'
    );
  }

  // =========================================================================
  section('2. Registration and login');
  // =========================================================================
  {
    const reg = await api('POST', '/auth/register', {
      body: { name: 'Aely', password: 'correct-horse-battery' },
    });
    check(reg.status === 201 && Boolean(reg.json.token), 'Register aely returns a session token');
    check(reg.json.name === 'aely', 'Name is normalised to lowercase');
    tokens.aely = reg.json.token;

    for (const who of ['aiden', 'carol']) {
      const r = await api('POST', '/auth/register', {
        body: { name: who, password: `${who}-password-123` },
      });
      tokens[who] = r.json?.token;
      check(r.status === 201, `Register ${who}`);
    }

    const dup = await api('POST', '/auth/register', {
      body: { name: 'aely', password: 'another-password-99' },
    });
    check(dup.status === 409, 'Duplicate registration is rejected with 409');

    const weak = await api('POST', '/auth/register', {
      body: { name: 'shorty', password: 'abc' },
    });
    check(weak.status === 400, 'Password below the minimum length is rejected');

    const badLogin = await api('POST', '/auth/login', {
      body: { name: 'aely', password: 'wrong-password-here' },
    });
    check(badLogin.status === 401, 'Login with the wrong password fails');

    const noUser = await api('POST', '/auth/login', {
      body: { name: 'ghost', password: 'wrong-password-here' },
    });
    check(
      noUser.status === 401 && noUser.json.error === badLogin.json.error,
      'Unknown account and wrong password return an identical error (no user enumeration)'
    );

    const goodLogin = await api('POST', '/auth/login', {
      body: { name: 'AELY', password: 'correct-horse-battery' },
    });
    check(goodLogin.status === 200 && Boolean(goodLogin.json.token), 'Login succeeds, case-insensitively');
  }

  // =========================================================================
  section('3. ATTACK — path traversal on the profile routes');
  // =========================================================================
  {
    // The old server did path.join(profilesDir, `${req.params.name}.profile`).
    // Express decodes %2F after route matching, so these escape the directory.
    const payloads = [
      '..%2F..%2F..%2Fetc%2Fpasswd',
      '..%2f..%2fpackage',
      '%2e%2e%2f%2e%2e%2fserver',
      '....%2F%2E%2E%2Fserver',
      'aely%00',
    ];
    for (const p of payloads) {
      const res = await api('GET', `/profile/${p}`);
      check(
        res.status === 400 || res.status === 404,
        `Traversal payload rejected: ${decodeURIComponent(p).slice(0, 40)}`,
        `got ${res.status}: ${res.text.slice(0, 120)}`
      );
      check(
        !/root:x:/.test(res.text) && !/"dependencies"/.test(res.text),
        `No file contents leaked for: ${decodeURIComponent(p).slice(0, 40)}`
      );
    }

    const write = await api('POST', '/profile/..%2F..%2Fowned', {
      token: tokens.aely,
      body: { fields: { bio: 'pwned' } },
    });
    check(write.status === 400 || write.status === 403, 'Traversal write is rejected');

    const escaped = fs.existsSync(path.join(dataDir, 'owned.profile'));
    check(!escaped, 'No file was created outside the profiles directory');
  }

  // =========================================================================
  section('4. Profile ownership and secret hygiene');
  // =========================================================================
  {
    const anon = await api('POST', '/profile/aely', { body: { fields: { bio: 'x' } } });
    check(anon.status === 401, 'Unauthenticated profile write is rejected');

    const other = await api('POST', '/profile/aely', {
      token: tokens.aiden,
      body: { fields: { bio: 'aiden was here' } },
    });
    check(other.status === 403, "ATTACK — cannot write another player's profile");

    const mine = await api('POST', '/profile/aely', {
      token: tokens.aely,
      body: {
        fields: {
          title: 'Wandering Tamer',
          bio: 'A traveller of the Palpagos Islands.',
          age: 24,
        },
      },
    });
    check(mine.status === 200, 'Owner can write their own profile');

    const creds = await api('POST', '/profile/aely', {
      token: tokens.aely,
      body: { fields: { bio: 'oops', password: 'hunter2' } },
    });
    check(creds.status === 400, 'Profile containing a credential field is refused');

    const pub = await api('GET', '/profile/aely');
    check(pub.status === 200, 'Anyone can read a profile');
    check(pub.json.fields.title === 'Wandering Tamer', 'Profile content round-trips');
    const serialised = JSON.stringify(pub.json);
    check(
      !/password|_password|salt|hash|token/i.test(serialised),
      'Public profile contains no credential material of any kind'
    );

    const onDisk = await fsp.readFile(path.join(dataDir, 'profiles', 'aely.profile'), 'utf8');
    check(
      !/password|salt|hash/i.test(onDisk),
      'The .profile file on disk contains no credential material either'
    );

    const accountFile = await fsp.readFile(path.join(dataDir, 'accounts', 'aely.account'), 'utf8');
    check(
      !accountFile.includes('correct-horse-battery'),
      'Password is not stored in plaintext in the account file'
    );
    check(/"hash"/.test(accountFile) && /"salt"/.test(accountFile), 'Account stores a salted hash');
  }

  // =========================================================================
  section('5. Search / the /who command');
  // =========================================================================
  {
    await api('POST', '/profile/aiden', { token: tokens.aiden, body: { fields: { bio: 'b' } } });
    await api('POST', '/profile/carol', { token: tokens.carol, body: { fields: { bio: 'c' } } });

    const a = await api('GET', '/search/a');
    const namesA = a.json.results.map((r) => r.name).sort();
    eq(namesA, ['aely', 'aiden'], 'Single letter prefix returns every matching name');

    const ae = await api('GET', '/search/ae');
    eq(ae.json.results.map((r) => r.name), ['aely'], 'Two letter partial narrows correctly');

    const full = await api('GET', '/search/aely');
    eq(full.json.results.map((r) => r.name), ['aely'], 'Exact name returns exactly one result');

    const z = await api('GET', '/search/z');
    eq(z.json.results, [], 'No match returns an empty list');

    const junk = await api('GET', '/search/%2E%2E%2F');
    check(junk.status === 200 && junk.json.results.length === 0, 'Search ignores illegal characters');
  }

  // =========================================================================
  section('6. ATTACK — socket identity cannot be asserted by the client');
  // =========================================================================
  {
    let rejected = false;
    try {
      await connect('');
    } catch {
      rejected = true;
    }
    check(rejected, 'Socket connection without a token is refused');

    rejected = false;
    try {
      await connect('not-a-real-token-at-all');
    } catch {
      rejected = true;
    }
    check(rejected, 'Socket connection with a forged token is refused');

    // The old server took characterName from the client. Here there is no such
    // field, and any attempt to smuggle one must be ignored.
    const impostor = await connect(tokens.aiden);
    impostor.socket.emit('register_player', { characterName: 'aely', guildId: 'anything' });
    await settle();

    const victim = await connect(tokens.aely);
    impostor.send({ command: 'say', message: 'am I aely?', sender: 'aely', name: 'aely' });
    await settle();

    const heard = victim.inbox.find((m) => m.message === 'am I aely?');
    check(Boolean(heard), 'Message was delivered');
    check(
      heard?.sender === 'aiden',
      'ATTACK — sender is the authenticated account, not the client-supplied name',
      `sender was ${heard?.sender}`
    );

    impostor.close();
    victim.close();
    await settle();
  }

  // =========================================================================
  section('7. Whispers');
  // =========================================================================
  {
    const aely = await connect(tokens.aely);
    const aiden = await connect(tokens.aiden);
    const carol = await connect(tokens.carol);
    await settle();

    aely.send({ command: 'whisper', target: 'Aiden', message: 'Heya!' });
    await settle();

    const inbound = aiden.inbox.find((m) => m.type === 'whisper_in');
    check(inbound?.message === 'Heya!' && inbound?.sender === 'aely', 'Recipient sees the whisper');

    const echo = aely.inbox.find((m) => m.type === 'whisper_out');
    check(echo?.target === 'aiden' && echo?.message === 'Heya!', 'Sender gets their own echo');

    check(
      carol.inbox.length === 0,
      'ATTACK — a third party receives nothing (whispers are not broadcast)'
    );

    aely.clear();
    aely.send({ command: 'whisper', target: 'nobody', message: 'hello?' });
    await settle();
    check(
      aely.errors.some((e) => /not online/i.test(e.message)),
      'Whispering an offline player returns a friendly error'
    );

    aely.close();
    aiden.close();
    carol.close();
    await settle();
  }

  // =========================================================================
  section('7b. ATTACK — whisper isolation on a crowded server');
  // =========================================================================
  {
    // The earlier whisper test had one bystander. This one stacks the deck:
    // every other client shares the sender's guild, channel and map position —
    // every route by which a message could otherwise reach them — so only the
    // direct routing itself keeps the whisper private.
    const extras = ['dave', 'erin', 'frank'];
    for (const who of extras) {
      const r = await api('POST', '/auth/register', {
        body: { name: who, password: `${who}-password-123` },
      });
      tokens[who] = r.json?.token;
      await api('POST', '/channels/ooc', { token: tokens[who] });
      await api('POST', '/guild/moonlight/join', {
        token: tokens[who],
        body: { passcode: 'guild-passcode-1' },
      });
    }
    await api('POST', '/channels/ooc', { token: tokens.aely });

    const sender = await connect(tokens.aely);
    const target = await connect(tokens.aiden);
    const bystanders = [];
    for (const who of extras) bystanders.push(await connect(tokens[who]));
    await settle();

    // Everyone standing on the same spot.
    for (const c of [sender, target, ...bystanders]) c.move({ x: 0, y: 0, z: 0 });
    await settle();
    for (const c of [sender, target, ...bystanders]) c.clear();

    const secret = 'Meet me behind the Small Settlement at dusk.';
    sender.send({ command: 'whisper', target: 'Aiden', message: secret });
    await settle();

    check(
      target.inbox.filter((m) => m.type === 'whisper_in').length === 1,
      'Target receives the whisper exactly once'
    );
    const leaked = bystanders.filter((b) => b.inbox.length > 0);
    check(
      leaked.length === 0,
      `ATTACK — no co-located guild/channel-mate received any frame (${leaked.length} leaked)`
    );
    check(
      !JSON.stringify(bystanders.map((b) => b.inbox)).includes('Small Settlement'),
      'ATTACK — the message text appears nowhere in bystander traffic'
    );

    // A second session for the target should get it; nobody else should.
    const target2 = await connect(tokens.aiden);
    await settle();
    for (const c of [target, target2, ...bystanders]) c.clear();
    sender.send({ command: 'whisper', target: 'aiden', message: 'both clients' });
    await settle();
    check(
      target.inbox.length === 1 && target2.inbox.length === 1,
      "Every one of the target's own sessions receives it, once each"
    );
    check(
      bystanders.every((b) => b.inbox.length === 0),
      'Still nothing to anyone else'
    );

    sender.close();
    target.close();
    target2.close();
    for (const b of bystanders) b.close();
    await settle();
  }

  // =========================================================================
  section('8. Local say, emotes and proximity');
  // =========================================================================
  {
    const aely = await connect(tokens.aely);
    const aiden = await connect(tokens.aiden);
    const carol = await connect(tokens.carol);
    await settle();

    aely.move({ x: 0, y: 0, z: 0 });
    aiden.move({ x: 1000, y: 0, z: 0 }); // within the 3000 unit radius
    carol.move({ x: 500000, y: 0, z: 0 }); // far away
    await settle();

    aely.send({ command: 'say', message: 'Anyone around?' });
    await settle();

    check(
      aiden.inbox.some((m) => m.type === 'say' && m.message === 'Anyone around?'),
      'A nearby player hears local say'
    );
    check(
      !carol.inbox.some((m) => m.message === 'Anyone around?'),
      'A distant player does not hear local say'
    );

    aiden.clear();
    aely.send({ command: 'emote', message: 'kisses Aiden.' });
    await settle();
    const emote = aiden.inbox.find((m) => m.type === 'emote');
    check(
      emote?.message === 'aely kisses Aiden.',
      'Emote is composed server-side as "<name> <action>"',
      `got: ${emote?.message}`
    );

    aely.close();
    aiden.close();
    carol.close();
    await settle();
  }

  // =========================================================================
  section('9. Guilds');
  // =========================================================================
  {
    const created = await api('POST', '/guild', {
      token: tokens.aely,
      body: { name: 'moonlight', passcode: 'guild-passcode-1' },
    });
    check(created.status === 201, 'A player can create a guild');

    const wrong = await api('POST', '/guild/moonlight/join', {
      token: tokens.aiden,
      body: { passcode: 'wrong-passcode-xx' },
    });
    check(wrong.status === 401, 'ATTACK — joining a guild with the wrong passcode fails');

    const missing = await api('POST', '/guild/doesnotexist/join', {
      token: tokens.aiden,
      body: { passcode: 'anything-at-all' },
    });
    check(
      missing.status === 401 && missing.json.error === wrong.json.error,
      'Unknown guild and wrong passcode are indistinguishable'
    );

    const joined = await api('POST', '/guild/moonlight/join', {
      token: tokens.aiden,
      body: { passcode: 'guild-passcode-1' },
    });
    check(joined.status === 200, 'Correct passcode joins the guild');

    const aely = await connect(tokens.aely);
    const aiden = await connect(tokens.aiden);
    const carol = await connect(tokens.carol);
    await settle();

    aely.send({ command: 'guild', message: 'Guild check!' });
    await settle();

    check(
      aiden.inbox.some((m) => m.type === 'guild' && m.message === 'Guild check!'),
      'Guild members receive guild chat'
    );
    check(
      !carol.inbox.some((m) => m.message === 'Guild check!'),
      'ATTACK — a non-member cannot receive guild chat'
    );

    carol.send({ command: 'guild', message: 'let me in', guild: 'moonlight', guildId: 'moonlight' });
    await settle();
    check(
      carol.errors.some((e) => /not in a guild/i.test(e.message)),
      'ATTACK — a client cannot assert guild membership in the packet'
    );

    aely.close();
    aiden.close();
    carol.close();
    await settle();
  }

  // =========================================================================
  section('10. ATTACK — custom channels route by name, not slot number');
  // =========================================================================
  {
    // In the old design routing keyed off the slot index 1-10, so "slot 1 = OOC"
    // for one player and "slot 1 = Trade" for another put them in one channel.
    await api('POST', '/channels/ooc', { token: tokens.aely });
    await api('POST', '/channels/trade', { token: tokens.aiden });
    await api('POST', '/channels/ooc', { token: tokens.carol });

    const aely = await connect(tokens.aely);
    const aiden = await connect(tokens.aiden);
    const carol = await connect(tokens.carol);
    await settle();

    aely.send({ command: 'channel', channel: 'ooc', message: 'ooc hello' });
    await settle();

    check(
      carol.inbox.some((m) => m.type === 'channel' && m.channel === 'ooc'),
      'Members of the same named channel receive the message'
    );
    check(
      !aiden.inbox.some((m) => m.message === 'ooc hello'),
      'ATTACK — someone in a different channel using the same slot hears nothing'
    );

    aely.clear();
    aely.send({ command: 'channel', channel: 'trade', message: 'sneaking in' });
    await settle();
    check(
      aely.errors.some((e) => /have not joined/i.test(e.message)),
      'ATTACK — cannot post to a channel you have not joined'
    );

    aely.close();
    aiden.close();
    carol.close();
    await settle();
  }

  // =========================================================================
  section('10b. Parties (/p)');
  // =========================================================================
  {
    const aely = await connect(tokens.aely);
    const aiden = await connect(tokens.aiden);
    const carol = await connect(tokens.carol);
    await settle();

    const created = await rpc(aely, 'party_create', {});
    check(created.ok === true, 'A player can create a party');
    check(
      typeof created.code === 'string' && created.code.length === 6,
      `Party code is six characters (${created.code})`
    );
    check(
      !/[01OI]/.test(created.code),
      'Party code avoids characters that get misread when spoken aloud'
    );
    check(created.leader === 'aely', 'Creator is the leader');

    const joined = await rpc(aiden, 'party_join', { code: created.code.toLowerCase() });
    check(joined.ok === true, 'Joining is case-insensitive');
    check(joined.members.length === 2, 'Party now has two members');

    const badJoin = await rpc(carol, 'party_join', { code: 'ZZZZZZ' });
    check(badJoin.ok === false, 'Joining a non-existent code fails cleanly');

    aely.clear();
    aiden.clear();
    carol.clear();
    aely.send({ command: 'party', message: 'Ready?' });
    await settle();

    check(
      aiden.inbox.some((m) => m.type === 'party' && m.message === 'Ready?'),
      'Party members receive party chat'
    );
    check(
      !carol.inbox.some((m) => m.message === 'Ready?'),
      'ATTACK — a non-member receives nothing'
    );

    carol.clear();
    carol.send({ command: 'party', message: 'let me in' });
    await settle();
    check(
      carol.errors.some((e) => /not in a party/i.test(e.message)),
      'Party chat without a party returns a helpful error'
    );

    // Leadership must transfer, or a party becomes unmanageable when the
    // leader logs off mid-session.
    let aidenParty = null;
    aiden.socket.on('party', (d) => {
      aidenParty = d;
    });
    await rpc(aely, 'party_leave', {});
    await settle();
    check(
      aidenParty && aidenParty.leader === 'aiden',
      'Leadership passes to the remaining member when the leader leaves'
    );
    check(aidenParty && aidenParty.members.length === 1, 'Party membership shrinks to one');

    const orphaned = await rpc(aely, 'party_info', {});
    check(orphaned.code === null, 'The player who left is no longer in a party');

    // Last member leaves -> code is released.
    await rpc(aiden, 'party_leave', {});
    await settle();
    const dead = await rpc(carol, 'party_join', { code: created.code });
    check(dead.ok === false, 'The code stops working once the party is empty');

    aely.close();
    aiden.close();
    carol.close();
    await settle();
  }

  // =========================================================================
  section('11. Server-side mute list');
  // =========================================================================
  {
    const muted = await api('POST', '/mutes/aely', { token: tokens.aiden });
    check(muted.status === 200 && muted.json.mutes.includes('aely'), 'Aiden mutes aely');

    const aely = await connect(tokens.aely);
    const aiden = await connect(tokens.aiden);
    const carol = await connect(tokens.carol);
    await settle();

    aely.send({ command: 'global', message: 'hello everyone' });
    await settle();

    check(
      carol.inbox.some((m) => m.message === 'hello everyone'),
      'An unmuted player still receives global chat'
    );
    check(
      !aiden.inbox.some((m) => m.message === 'hello everyone'),
      'A muted sender is filtered out server-side, so the bytes are never sent'
    );

    aely.clear();
    aely.send({ command: 'whisper', target: 'aiden', message: 'let me talk to you' });
    await settle();
    check(
      aely.errors.some((e) => /not accepting messages/i.test(e.message)),
      'Whispers from a muted sender are refused'
    );

    const unmuted = await api('DELETE', '/mutes/aely', { token: tokens.aiden });
    check(unmuted.status === 200 && !unmuted.json.mutes.includes('aely'), 'Unmute works');

    aely.close();
    aiden.close();
    carol.close();
    await settle();
  }

  // =========================================================================
  section('12. Unlimited-length roleplay, and fanout-aware throttling');
  // =========================================================================
  {
    const aely = await connect(tokens.aely);
    const aiden = await connect(tokens.aiden);
    await settle();
    aely.move({ x: 0, y: 0, z: 0 });
    aiden.move({ x: 100, y: 0, z: 0 });
    await settle();

    const bigEmote = 'writes a truly enormous lore backstory. '.repeat(1250); // ~50 KB
    check(bigEmote.length > 45000, `Test payload is ${bigEmote.length} characters`);

    aely.send({ command: 'emote', message: bigEmote });
    await settle();
    const received = aiden.inbox.find((m) => m.type === 'emote');
    check(
      received && received.message.length > 45000,
      `A ~50,000 character emote passes through intact (received ${received?.message.length ?? 0} chars)`
    );
    check(
      aely.errors.length === 0,
      'A huge emote to a small local audience is NOT throttled — this is the point of the mod'
    );

    // Same text, whole-server audience: now the cost is bytes x recipients.
    // Send until the budget is gone rather than assuming an exact number of
    // messages, so the assertion does not depend on refill timing.
    aely.clear();
    let sent = 0;
    for (let i = 0; i < 8 && aely.errors.length === 0; i++) {
      aely.send({ command: 'global', message: bigEmote });
      sent += 1;
      await settle();
    }
    check(
      aely.errors.some((e) => /too large|too quickly/i.test(e.message)),
      `The same text blasted repeatedly to the whole server IS throttled after ${sent} sends (fanout is charged)`
    );

    const overSize = 'x'.repeat(120000);
    aely.clear();
    aely.send({ command: 'say', message: overSize });
    await settle();
    check(
      aely.errors.some((e) => /limit is/i.test(e.message)),
      'A message above MAX_MESSAGE_BYTES is rejected with a clear error'
    );

    aely.close();
    aiden.close();
    await settle();
  }

  // =========================================================================
  section('13. ATTACK — rate limit survives reconnection');
  // =========================================================================
  {
    // The old limiter lived on the socket object, so `socket.disconnect();
    // socket.connect();` reset it completely. Buckets are now keyed by account.
    let aely = await connect(tokens.aely);
    await settle();

    const chunk = 'y'.repeat(90000);
    for (let i = 0; i < 6; i++) {
      aely.send({ command: 'global', message: chunk });
      await sleep(60);
    }
    await settle();
    const throttledBefore = aely.errors.length > 0;
    check(throttledBefore, 'Bucket is exhausted after sustained large sends');

    aely.close();
    await settle();
    aely = await connect(tokens.aely);
    await settle();

    aely.send({ command: 'global', message: chunk });
    await settle();
    check(
      aely.errors.length > 0,
      'ATTACK — reconnecting does not refill the bucket',
      'the limiter was reset by a reconnect, which is the bug we are fixing'
    );

    aely.close();
    await settle();
  }

  // =========================================================================
  section('14. Message flood limiter');
  // =========================================================================
  {
    const spammer = await connect(tokens.carol);
    await settle();
    for (let i = 0; i < 400; i++) spammer.send({ command: 'global', message: `spam ${i}` });
    await sleep(600);
    check(
      spammer.errors.some((e) => /too quickly/i.test(e.message)),
      'Thousands of tiny messages are caught by the count limiter, not just the byte limiter'
    );
    spammer.close();
    await settle();
  }

  // =========================================================================
  section('15. Admin and moderation');
  // =========================================================================
  {
    const noAuth = await api('GET', '/admin/stats');
    check(noAuth.status === 403, 'Admin endpoints reject an unauthenticated caller');

    const wrongToken = await api('GET', '/admin/stats', { token: 'nope' });
    check(wrongToken.status === 403, 'Admin endpoints reject a wrong token');

    const stats = await api('GET', '/admin/stats', { token: ADMIN_TOKEN });
    check(stats.status === 200 && stats.json.accounts >= 3, 'Admin can read server stats');

    const victim = await connect(tokens.carol);
    let kicked = false;
    victim.socket.on('force_disconnect', () => {
      kicked = true;
    });
    await settle();

    const ban = await api('POST', '/admin/ban/carol', {
      token: ADMIN_TOKEN,
      body: { reason: 'testing' },
    });
    check(ban.status === 200, 'Admin can ban an account');
    await settle();
    check(kicked, 'A banned player is disconnected immediately');

    const bannedLogin = await api('POST', '/auth/login', {
      body: { name: 'carol', password: 'carol-password-123' },
    });
    check(bannedLogin.status === 403, 'A banned account cannot log back in');

    let reconnectRefused = false;
    try {
      await connect(tokens.carol);
    } catch {
      reconnectRefused = true;
    }
    check(reconnectRefused, 'A banned account\u2019s old token no longer works');

    await api('POST', '/admin/unban/carol', { token: ADMIN_TOKEN });
    const afterUnban = await api('POST', '/auth/login', {
      body: { name: 'carol', password: 'carol-password-123' },
    });
    check(afterUnban.status === 200, 'Unban restores access');
    tokens.carol = afterUnban.json.token;
  }

  // =========================================================================
  section('16. Password change invalidates sessions');
  // =========================================================================
  {
    const changed = await api('POST', '/auth/password', {
      token: tokens.aiden,
      body: { currentPassword: 'aiden-password-123', newPassword: 'aiden-new-password-456' },
    });
    check(changed.status === 200, 'Password change succeeds with the current password');

    const stale = await api('GET', '/mutes', { token: tokens.aiden });
    check(stale.status === 401, 'The old session token is invalidated');

    const relogin = await api('POST', '/auth/login', {
      body: { name: 'aiden', password: 'aiden-new-password-456' },
    });
    check(relogin.status === 200, 'The new password works');
    tokens.aiden = relogin.json.token;

    const wrongCurrent = await api('POST', '/auth/password', {
      token: tokens.aiden,
      body: { currentPassword: 'not-it-at-all', newPassword: 'whatever-123456' },
    });
    check(wrongCurrent.status === 401, 'Password change requires the current password');
  }

  // =========================================================================
  section('17. Concurrent writes do not corrupt a profile');
  // =========================================================================
  {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        api('POST', '/profile/aely', {
          token: tokens.aely,
          body: { fields: { bio: `revision ${i}`, index: i } },
        })
      )
    );
    const after = await api('GET', '/profile/aely');
    check(after.status === 200, 'Profile is still readable after 25 concurrent writes');
    check(
      typeof after.json.fields?.index === 'number',
      'Profile JSON is intact (atomic writes, no torn file)'
    );
  }

  // =========================================================================
  section('18. Restart survival');
  // =========================================================================
  {
    await stopServer();
    await startServer();

    const login = await api('POST', '/auth/login', {
      body: { name: 'aely', password: 'correct-horse-battery' },
    });
    check(login.status === 200, 'Accounts survive a restart (password hash reloaded from disk)');
    tokens.aely = login.json.token;

    const profile = await api('GET', '/profile/aely');
    check(profile.status === 200, 'Profiles survive a restart');

    const search = await api('GET', '/search/ae');
    check(
      search.json.results.some((r) => r.name === 'aely'),
      'The search index is rebuilt from disk on boot'
    );

    const guildJoin = await api('POST', '/guild/moonlight/join', {
      token: tokens.aely,
      body: { passcode: 'guild-passcode-1' },
    });
    check(guildJoin.status === 200, 'Guilds survive a restart');

    const staleToken = await api('GET', '/mutes', { token: tokens.aiden });
    check(
      staleToken.status === 401,
      'Sessions are intentionally not persisted; clients re-login automatically'
    );

    const socket = await connect(tokens.aely);
    socket.send({ command: 'global', message: 'back online' });
    await settle();
    check(socket.errors.length === 0, 'Chat works immediately after a restart');
    socket.close();
    await settle();
  }

  // =========================================================================
  section('19. Application-layer AES-256-GCM (server relays, never decrypts)');
  // =========================================================================
  {
    await stopServer();
    await startServer({ REQUIRE_ENCRYPTION: 'true' });

    const login = await api('POST', '/auth/login', {
      body: { name: 'aely', password: 'correct-horse-battery' },
    });
    tokens.aely = login.json.token;
    const aidenLogin = await api('POST', '/auth/login', {
      body: { name: 'aiden', password: 'aiden-new-password-456' },
    });
    tokens.aiden = aidenLogin.json.token;

    const crypto = require('node:crypto');
    const KEY = crypto.randomBytes(32);
    const seal = (text) => {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
      const ct = Buffer.concat([c.update(text, 'utf8'), c.final(), c.getAuthTag()]);
      return { v: 1, iv: iv.toString('base64'), ct: ct.toString('base64') };
    };
    const open_ = (env) => {
      const raw = Buffer.from(env.ct, 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(env.iv, 'base64'));
      d.setAuthTag(raw.subarray(raw.length - 16));
      return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8');
    };

    const info = await api('GET', '/info');
    check(
      info.json.encryption?.required === true && info.json.encryption.algorithm === 'AES-256-GCM',
      'GET /info advertises that encryption is required'
    );

    const aely = await connect(tokens.aely);
    const aiden = await connect(tokens.aiden);
    await settle();

    const secret = 'This must never appear on the wire in clear text.';
    aiden.clear();
    aely.send({ command: 'say', message: seal(secret) });
    await settle();

    const frame = aiden.inbox.find((m) => m.type === 'say');
    check(Boolean(frame), 'Encrypted message is routed normally');
    check(
      frame && typeof frame.message === 'object' && frame.message.v === 1,
      'Delivered as an envelope, not a decrypted string'
    );
    check(open_(frame.message) === secret, 'Recipient decrypts back to the original text');
    check(
      !JSON.stringify(frame).includes('never appear'),
      'ATTACK — plaintext appears nowhere in the delivered frame'
    );

    aely.clear();
    aely.send({ command: 'say', message: 'plain text while encryption is required' });
    await settle();
    check(
      aely.errors.some((e) => /requires encrypted/i.test(e.message)),
      'Plaintext is refused when the server requires encryption'
    );

    const profRes = await api('POST', '/profile/aely', {
      token: tokens.aely,
      body: { fields: seal(JSON.stringify({ title: 'Wandering Tamer' })) },
    });
    check(profRes.status === 200 && profRes.json.encrypted === true, 'Encrypted profile is accepted');

    const readBack = await api('GET', '/profile/aely');
    check(
      readBack.json.fields?.v === 1 && open_(readBack.json.fields).includes('Wandering Tamer'),
      'Encrypted profile round-trips through storage untouched'
    );

    const onDisk = readBack.text;
    check(!onDisk.includes('Wandering Tamer'), 'Profile contents are not readable from the server');

    aely.close();
    aiden.close();
    await settle();
  }

  // =========================================================================
  // Summary
  // =========================================================================
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'='.repeat(64)}`);
  console.log(`  ${results.length - failed.length} passed, ${failed.length} failed`);
  console.log('='.repeat(64));
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  [${f.section}] ${f.label}`);
  }
  return failed.length;
}

(async () => {
  let code = 1;
  try {
    code = await run();
  } catch (err) {
    console.error('\nTest run crashed:', err);
    code = 1;
  } finally {
    await stopServer();
    if (dataDir) await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
  process.exit(code);
})();
