'use strict';

const express = require('express');

const config = require('./config');
const log = require('./log');
const store = require('./store');
const guilds = require('./guilds');
const auth = require('./auth');
const rl = require('./ratelimit');
const envelope = require('./envelope');
const {
  ValidationError,
  normalizeName,
  normalizeChannel,
  validatePassword,
} = require('./validate');

/**
 * Measure nesting depth iteratively. A recursive version would itself blow the
 * stack on the very input we are trying to reject.
 */
function jsonDepth(value) {
  let max = 0;
  const stack = [[value, 1]];
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (depth > max) max = depth;
    if (depth > 200) return depth; // deep enough to reject; stop walking
    if (node && typeof node === 'object') {
      for (const child of Object.values(node)) stack.push([child, depth + 1]);
    }
  }
  return max;
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function buildApp({ presence }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops);

  // Resolve the real client IP once, so every limiter agrees on the key.
  app.use((req, res, next) => {
    req.clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    next();
  });

  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', config.corsOrigin);
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.set('X-Content-Type-Options', 'nosniff');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });

  // Body cap. Express's default is 100 KB; we set it explicitly against the
  // configured profile ceiling so a large roleplay profile is not silently
  // truncated, and a hostile one is rejected before it reaches any handler.
  app.use(express.json({ limit: config.maxProfileBytes }));

  // -------------------------------------------------------------------------
  // Health & discovery
  // -------------------------------------------------------------------------

  app.get('/health', (req, res) => {
    res.json({ ok: true, uptimeSeconds: Math.floor(process.uptime()) });
  });

  /**
   * Lets the mod check compatibility and show server rules before connecting,
   * so a player pointing at a stranger's backend knows what they are joining.
   */
  app.get('/info', (req, res) => {
    res.json({
      service: 'palworld-rp-backend',
      apiVersion: 1,
      limits: {
        maxMessageBytes: config.maxMessageBytes,
        maxProfileBytes: config.maxProfileBytes,
        localChatRadius: config.localChatRadius,
        maxChannelsPerAccount: config.maxChannelsPerAccount,
        maxPartySize: config.maxPartySize,
        minPasswordLength: config.minPasswordLength,
      },
      encryption: {
        required: config.requireEncryption,
        algorithm: 'AES-256-GCM',
        envelopeVersion: envelope.ENVELOPE_VERSION,
      },
      playersOnline: presence.onlineCount(),
      registrationOpen: config.registrationOpen && store.accountCount() < config.maxAccounts,
    });
  });

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------

  app.post(
    '/auth/register',
    rl.httpLimiter(rl.httpRegister, 'registration'),
    asyncRoute(async (req, res) => {
      // Checked before validation so a closed server gives the same answer to
      // every would-be registrant, rather than leaking which names are taken.
      if (!config.registrationOpen) {
        return res.status(403).json({ error: 'Registration is currently closed.' });
      }
      const name = normalizeName(req.body?.name);
      const password = validatePassword(req.body?.password);
      await store.createAccount(name, password);
      const session = auth.issue(name);
      log.info('Account registered', { name, ip: req.clientIp });
      res.status(201).json({ name, ...session });
    })
  );

  app.post(
    '/auth/login',
    rl.httpLimiter(rl.httpLogin, 'login'),
    asyncRoute(async (req, res) => {
      let name;
      try {
        name = normalizeName(req.body?.name);
      } catch {
        // Do not leak "that name could not exist" vs "wrong password".
        return res.status(401).json({ error: 'Invalid name or password.' });
      }
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const account = store.getAccount(name);
      const ok = await store.verifyPassword(password, account);
      if (!ok) {
        return res.status(401).json({ error: 'Invalid name or password.' });
      }
      if (account.banned) {
        return res
          .status(403)
          .json({ error: 'This account is banned.', reason: account.banReason });
      }
      const session = auth.issue(name);
      return res.json({ name, ...session });
    })
  );

  app.post('/auth/logout', auth.requireAuth, rl.httpLimiter(rl.httpWrite, 'write'), (req, res) => {
    auth.revoke(req.token);
    res.json({ ok: true });
  });

  app.post(
    '/auth/password',
    auth.requireAuth,
    rl.httpLimiter(rl.httpLogin, 'password change'),
    asyncRoute(async (req, res) => {
      const current = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
      const ok = await store.verifyPassword(current, req.account);
      if (!ok) return res.status(401).json({ error: 'Current password is incorrect.' });
      const next = validatePassword(req.body?.newPassword);
      await store.changePassword(req.account, next);
      auth.revokeAllFor(req.account.name);
      presence.disconnectAccount(req.account.name, 'Password changed. Log in again.');
      res.json({ ok: true, message: 'Password changed. All sessions were logged out.' });
    })
  );

  // -------------------------------------------------------------------------
  // Profiles
  // -------------------------------------------------------------------------

  /**
   * Public read. The stored file contains no secret material at all, so there
   * is nothing here to accidentally forget to strip.
   */
  app.get(
    '/profile/:name',
    rl.httpLimiter(rl.httpRead, 'read'),
    asyncRoute(async (req, res) => {
      const name = normalizeName(req.params.name);
      const profile = await store.readProfile(name);
      if (!profile) return res.status(404).json({ error: 'Profile not found.' });
      res.json({ ...profile, online: presence.isOnline(name) });
    })
  );

  /**
   * Write. Authenticated by session token, and you may only write your own
   * profile — the name in the URL must match the token holder.
   */
  app.post(
    '/profile/:name',
    auth.requireAuth,
    rl.httpLimiter(rl.httpProfileWrite, 'profile write'),
    asyncRoute(async (req, res) => {
      const name = normalizeName(req.params.name);
      if (name !== req.account.name) {
        return res.status(403).json({ error: 'You can only edit your own profile.' });
      }
      const fields = req.body?.fields ?? req.body;
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        throw new ValidationError('Profile body must be a JSON object.');
      }
      // Defensive: refuse anything that looks like a credential so a buggy
      // client cannot publish its own password into a world-readable file.
      for (const key of ['password', '_password', 'token', 'salt', 'hash']) {
        if (key in fields) {
          throw new ValidationError(
            `Profile fields may not contain "${key}". Credentials are never stored in profiles.`
          );
        }
      }
      // A profile may be submitted as an encrypted envelope, in which case it
      // is stored and served verbatim and the server never sees its contents.
      // The account NAME stays in clear text regardless, because /who search
      // and routing depend on it.
      if (fields && typeof fields === 'object' && fields.v === envelope.ENVELOPE_VERSION) {
        envelope.validateEnvelope(fields);
        const savedEnc = await store.writeProfile(name, fields);
        return res.json({ ok: true, updatedAt: savedEnc.updatedAt, encrypted: true });
      }
      if (config.requireEncryption) {
        throw new ValidationError(
          'This server requires encrypted profiles. Send fields as { v, iv, ct }.'
        );
      }

      const depth = jsonDepth(fields);
      if (depth > config.maxProfileDepth) {
        throw new ValidationError(
          `Profile is nested ${depth} levels deep; the limit is ${config.maxProfileDepth}.`
        );
      }
      const saved = await store.writeProfile(name, fields);
      return res.json({ ok: true, updatedAt: saved.updatedAt });
    })
  );

  app.delete(
    '/profile/:name',
    auth.requireAuth,
    rl.httpLimiter(rl.httpWrite, 'write'),
    asyncRoute(async (req, res) => {
      const name = normalizeName(req.params.name);
      if (name !== req.account.name) {
        return res.status(403).json({ error: 'You can only delete your own profile.' });
      }
      await store.deleteProfile(name);
      return res.json({ ok: true });
    })
  );

  /** Powers /who. Prefix matches first, then substring, capped and index-backed. */
  app.get(
    '/search/:query',
    rl.httpLimiter(rl.httpRead, 'search'),
    (req, res) => {
      const raw = String(req.params.query || '').toLowerCase();
      // Only search within the legal name alphabet; anything else matches nothing.
      if (!/^[a-z0-9_-]{1,32}$/.test(raw)) return res.json({ query: raw, results: [] });
      const names = store.search(raw);
      res.json({
        query: raw,
        results: names.map((name) => ({ name, online: presence.isOnline(name) })),
        truncated: names.length >= config.searchMaxResults,
      });
    }
  );

  // -------------------------------------------------------------------------
  // Mutes  (the "automatic mute list" from the original design)
  // -------------------------------------------------------------------------

  /**
   * Mutes are enforced server-side at routing time, so a muted player's text is
   * never sent to you at all. That is both a moderation feature and a bandwidth
   * one: on a busy server it removes traffic rather than filtering it after
   * delivery like a client-side ignore list would.
   */
  app.get('/mutes', auth.requireAuth, (req, res) => {
    res.json({ mutes: [...req.account.mutes] });
  });

  app.post(
    '/mutes/:name',
    auth.requireAuth,
    rl.httpLimiter(rl.httpWrite, 'write'),
    asyncRoute(async (req, res) => {
      const target = normalizeName(req.params.name);
      if (target === req.account.name) {
        throw new ValidationError('You cannot mute yourself.');
      }
      if (req.account.mutes.size >= config.maxMutesPerAccount && !req.account.mutes.has(target)) {
        throw new ValidationError(`Mute list is full (${config.maxMutesPerAccount} entries).`);
      }
      await store.updateAccount(req.account, (a) => a.mutes.add(target));
      return res.json({ ok: true, mutes: [...req.account.mutes] });
    })
  );

  app.delete(
    '/mutes/:name',
    auth.requireAuth,
    rl.httpLimiter(rl.httpWrite, 'write'),
    asyncRoute(async (req, res) => {
      const target = normalizeName(req.params.name);
      await store.updateAccount(req.account, (a) => a.mutes.delete(target));
      return res.json({ ok: true, mutes: [...req.account.mutes] });
    })
  );

  // -------------------------------------------------------------------------
  // Guilds
  // -------------------------------------------------------------------------

  app.post(
    '/guild',
    auth.requireAuth,
    rl.httpLimiter(rl.httpWrite, 'write'),
    asyncRoute(async (req, res) => {
      const name = normalizeChannel(req.body?.name);
      const passcode = validatePassword(req.body?.passcode);
      // Each guild is a file on disk. Without a cap, one authenticated account
      // can fill the volume by creating guilds in a loop.
      const owned = guilds.list().filter((g) => g.owner === req.account.name).length;
      if (owned >= config.maxGuildsOwned) {
        throw new ValidationError(
          `You already own ${owned} guilds, which is the limit on this server.`,
          409
        );
      }
      await guilds.create(name, passcode, req.account.name);
      await store.updateAccount(req.account, (a) => {
        a.guild = name;
      });
      presence.syncMembership(req.account.name);
      return res.status(201).json({ ok: true, guild: name });
    })
  );

  app.post(
    '/guild/:name/join',
    auth.requireAuth,
    rl.httpLimiter(rl.httpLogin, 'guild join'),
    asyncRoute(async (req, res) => {
      const name = normalizeChannel(req.params.name);
      const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode : '';
      const ok = await guilds.verifyPasscode(name, passcode);
      if (!ok) return res.status(401).json({ error: 'Unknown guild or wrong passcode.' });
      await store.updateAccount(req.account, (a) => {
        a.guild = name;
      });
      presence.syncMembership(req.account.name);
      return res.json({ ok: true, guild: name });
    })
  );

  app.post(
    '/guild/leave',
    auth.requireAuth,
    rl.httpLimiter(rl.httpWrite, 'write'),
    asyncRoute(async (req, res) => {
      await store.updateAccount(req.account, (a) => {
        a.guild = null;
      });
      presence.syncMembership(req.account.name);
      return res.json({ ok: true });
    })
  );

  // -------------------------------------------------------------------------
  // Custom channels (/1 .. /10 map to these client-side)
  // -------------------------------------------------------------------------

  /**
   * Channels are addressed by NAME. In the previous version routing was done by
   * slot number, so if you had "OOC" in slot 1 and someone else had "Trade" in
   * slot 1, you were unknowingly in the same channel and the names were purely
   * decorative. Slots are now a client-side convenience only; the server never
   * sees them.
   */
  app.get('/channels', auth.requireAuth, (req, res) => {
    res.json({ channels: req.account.channels });
  });

  app.post(
    '/channels/:name',
    auth.requireAuth,
    rl.httpLimiter(rl.httpWrite, 'write'),
    asyncRoute(async (req, res) => {
      const channel = normalizeChannel(req.params.name);
      if (
        req.account.channels.length >= config.maxChannelsPerAccount &&
        !req.account.channels.includes(channel)
      ) {
        throw new ValidationError(
          `You may only be in ${config.maxChannelsPerAccount} channels at once.`
        );
      }
      await store.updateAccount(req.account, (a) => {
        if (!a.channels.includes(channel)) a.channels.push(channel);
      });
      presence.syncMembership(req.account.name);
      return res.json({ ok: true, channels: req.account.channels });
    })
  );

  app.delete(
    '/channels/:name',
    auth.requireAuth,
    rl.httpLimiter(rl.httpWrite, 'write'),
    asyncRoute(async (req, res) => {
      const channel = normalizeChannel(req.params.name);
      await store.updateAccount(req.account, (a) => {
        a.channels = a.channels.filter((c) => c !== channel);
      });
      presence.syncMembership(req.account.name);
      return res.json({ ok: true, channels: req.account.channels });
    })
  );

  // -------------------------------------------------------------------------
  // Admin (disabled unless ADMIN_TOKEN is set)
  // -------------------------------------------------------------------------

  app.get('/admin/stats', auth.requireAdmin, (req, res) => {
    res.json({
      accounts: store.accountCount(),
      profiles: store._nameIndex().length,
      online: presence.onlineCount(),
      sessions: auth.stats(),
      guilds: guilds.list().length,
      parties: presence.partyCount(),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  app.get('/admin/online', auth.requireAdmin, (req, res) => {
    res.json({ players: presence.listOnline() });
  });

  app.post(
    '/admin/ban/:name',
    auth.requireAdmin,
    asyncRoute(async (req, res) => {
      const name = normalizeName(req.params.name);
      const account = store.getAccount(name);
      if (!account) return res.status(404).json({ error: 'No such account.' });
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null;
      await store.updateAccount(account, (a) => {
        a.banned = true;
        a.banReason = reason;
      });
      auth.revokeAllFor(name);
      presence.disconnectAccount(name, 'You have been banned from this server.');
      log.warn('Account banned', { name, reason });
      return res.json({ ok: true });
    })
  );

  app.post(
    '/admin/unban/:name',
    auth.requireAdmin,
    asyncRoute(async (req, res) => {
      const name = normalizeName(req.params.name);
      const account = store.getAccount(name);
      if (!account) return res.status(404).json({ error: 'No such account.' });
      await store.updateAccount(account, (a) => {
        a.banned = false;
        a.banReason = null;
      });
      return res.json({ ok: true });
    })
  );

  app.delete(
    '/admin/account/:name',
    auth.requireAdmin,
    asyncRoute(async (req, res) => {
      const name = normalizeName(req.params.name);
      auth.revokeAllFor(name);
      presence.disconnectAccount(name, 'Your account was removed by an administrator.');
      const removed = await store.deleteAccount(name);
      return res.status(removed ? 200 : 404).json({ ok: removed });
    })
  );

  // -------------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------------

  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body is too large.' });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body is not valid JSON.' });
    }
    log.error('Unhandled request error', { path: req.path, err: err?.message });
    // Never echo internal error text to a public client.
    return res.status(500).json({ error: 'Internal server error.' });
  });

  return app;
}

module.exports = { buildApp };
