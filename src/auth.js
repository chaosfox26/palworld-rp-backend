'use strict';

const crypto = require('node:crypto');
const config = require('./config');
const store = require('./store');

/**
 * Session tokens.
 *
 * This is the piece the previous backend had no equivalent of. Previously a
 * client emitted `register_player` with whatever `characterName` string it
 * liked, and the server believed it — so anyone could connect as "Aely" and
 * receive her whispers, or claim any guildId and read that guild's chat.
 *
 * Now: password -> token -> socket identity. The socket's name is assigned by
 * the server from the token and is never read from client input again.
 *
 * Tokens are opaque random bytes held in memory (not JWTs) so that revocation
 * is instant and there is no signing key to leak. A server restart invalidates
 * every token, which is fine: the mod stores the password and re-logs in
 * automatically.
 */

/** token -> { name, createdAt, expiresAt } */
const sessions = new Map();
/** name -> Set<token>, so we can cap and revoke per account */
const byAccount = new Map();

function issue(name) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const session = { name, createdAt: now, expiresAt: now + config.sessionTtlMs };
  sessions.set(token, session);

  let set = byAccount.get(name);
  if (!set) {
    set = new Set();
    byAccount.set(name, set);
  }
  set.add(token);

  // Cap concurrent sessions; evict the oldest beyond the limit.
  if (set.size > config.maxSessionsPerAccount) {
    const ordered = [...set].sort(
      (a, b) => (sessions.get(a)?.createdAt ?? 0) - (sessions.get(b)?.createdAt ?? 0)
    );
    while (ordered.length > config.maxSessionsPerAccount) {
      revoke(ordered.shift());
    }
  }

  return { token, expiresAt: session.expiresAt };
}

function resolve(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    revoke(token);
    return null;
  }
  const account = store.getAccount(session.name);
  if (!account || account.banned) {
    revoke(token);
    return null;
  }
  return account;
}

function revoke(token) {
  const session = sessions.get(token);
  if (!session) return false;
  sessions.delete(token);
  const set = byAccount.get(session.name);
  if (set) {
    set.delete(token);
    if (set.size === 0) byAccount.delete(session.name);
  }
  return true;
}

function revokeAllFor(name) {
  const set = byAccount.get(name);
  if (!set) return 0;
  const count = set.size;
  for (const token of [...set]) revoke(token);
  return count;
}

function sweep() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) revoke(token);
  }
}

function stats() {
  return { activeSessions: sessions.size, accountsWithSessions: byAccount.size };
}

/** Express middleware: requires a valid Bearer token, attaches req.account. */
function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const account = resolve(token);
  if (!account) {
    return res.status(401).json({ error: 'Invalid or expired session. Log in again.' });
  }
  req.account = account;
  req.token = token;
  return next();
}

/** Express middleware for owner-only routes. */
function requireAdmin(req, res, next) {
  if (!config.adminToken) {
    return res.status(404).json({ error: 'Admin API is disabled on this server.' });
  }
  const header = req.get('authorization') || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const a = Buffer.from(provided);
  const b = Buffer.from(config.adminToken);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(403).json({ error: 'Forbidden.' });
  return next();
}

module.exports = {
  issue,
  resolve,
  revoke,
  revokeAllFor,
  sweep,
  stats,
  requireAuth,
  requireAdmin,
};
