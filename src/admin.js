'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const config = require('./config');
const log = require('./log');
const store = require('./store');
const auth = require('./auth');
const settings = require('./settings');
const { normalizeName } = require('./validate');

/**
 * The admin panel.
 *
 * This is a SEPARATE HTTP listener from the public API, bound to 127.0.0.1 by
 * default. That separation is the whole security model: Caddy proxies only the
 * public app on :3000, so there is no route from the internet to this port at
 * all. Reaching it requires being on the machine, or forwarding the port over
 * SSH. An admin login form on a public URL is the most attacked surface a small
 * server can have, and this avoids ever having one.
 *
 * It still requires the admin token to log in. Loopback is not a trust boundary
 * on a multi-user box — any local account could otherwise drive it.
 */

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const COOKIE = 'palrp_admin';

/** Login attempt tracking. Loopback or not, an unthrottled token form is a gift. */
const attempts = new Map();
const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

const sessions = new Map();

function newSession() {
  const id = crypto.randomBytes(32).toString('base64url');
  sessions.set(id, { created: Date.now(), expires: Date.now() + SESSION_TTL_MS });
  return id;
}

function validSession(id) {
  if (!id) return false;
  const s = sessions.get(id);
  if (!s) return false;
  if (s.expires < Date.now()) {
    sessions.delete(id);
    return false;
  }
  return true;
}

function throttled(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > ATTEMPT_WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return rec.count >= MAX_ATTEMPTS;
}

function noteFailure(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > ATTEMPT_WINDOW_MS) {
    attempts.set(ip, { first: Date.now(), count: 1 });
  } else {
    rec.count += 1;
  }
}

/** Constant-time compare so the token cannot be recovered by timing the form. */
function tokenMatches(supplied) {
  const a = Buffer.from(String(supplied || ''), 'utf8');
  const b = Buffer.from(config.adminToken, 'utf8');
  if (a.length !== b.length) {
    // Still burn the comparison so length is not trivially probeable.
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Privileged helpers
//
// The service runs as an unprivileged account that deliberately cannot write
// its own code or restart itself. Service control therefore goes through sudo,
// restricted by /etc/sudoers.d/palworld-rp-backend to an exact list of
// commands. If that file is not installed these calls simply fail and the
// panel reports it — the panel degrades, the security model does not.
// ---------------------------------------------------------------------------

function run(cmd, args, { timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err?.code ?? 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

const SERVICES = {
  backend: 'palworld-rp-backend',
  caddy: 'caddy',
};
const ACTIONS = new Set(['restart', 'stop', 'start', 'reload']);

async function serviceStatus(unit) {
  if (process.platform !== 'linux') return { state: 'unknown', platform: process.platform };
  const active = await run('systemctl', ['is-active', unit]);
  const enabled = await run('systemctl', ['is-enabled', unit]);
  const props = await run('systemctl', [
    'show', unit, '-p', 'NRestarts', '-p', 'ActiveEnterTimestamp', '--value',
  ]);
  const lines = props.stdout.trim().split('\n');
  return {
    state: active.stdout.trim() || 'unknown',
    enabled: enabled.stdout.trim() || 'unknown',
    restarts: Number.parseInt(lines[0], 10) || 0,
    since: lines[1] || '',
  };
}

// ---------------------------------------------------------------------------
// Tiny HTTP plumbing. Express is only mounted on the public app; the panel is
// deliberately dependency-free so that adding it cannot change what the public
// surface loads.
// ---------------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  // 413 means the client is still uploading a body nobody is reading. Without
  // closing, the connection sits half-consumed until it times out.
  if (status === 413) headers = { Connection: 'close', ...headers };
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // The panel is one self-contained file: no external scripts, styles or
    // frames are ever legitimate, so forbid them outright.
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; form-action 'none'; frame-ancestors 'none'",
    ...headers,
  });
  res.end(payload);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let stopped = false;
    const chunks = [];
    req.on('data', (c) => {
      if (stopped) return;
      size += c.length;
      if (size > limit) {
        // Deliberately NOT req.destroy() here. Destroying the socket means the
        // client sees a connection reset rather than the 413 explaining what
        // went wrong. Stop accumulating, let the handler send a real response,
        // and let `Connection: close` end the upload afterwards.
        stopped = true;
        reject(Object.assign(new Error('Body too large.'), { statusCode: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Body must be JSON.'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// ---------------------------------------------------------------------------

function buildHandler({ presence, uiHtml }) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;
    const ip = req.socket.remoteAddress || 'local';

    try {
      // ---- unauthenticated ------------------------------------------------
      if (route === '/' && req.method === 'GET') {
        return send(res, 200, uiHtml);
      }

      if (route === '/api/login' && req.method === 'POST') {
        if (throttled(ip)) {
          return send(res, 429, { error: 'Too many attempts. Wait 15 minutes.' });
        }
        const body = await readBody(req);
        if (!config.adminToken) {
          return send(res, 503, {
            error: 'ADMIN_TOKEN is not set on this server, so the panel is disabled.',
          });
        }
        if (!tokenMatches(body.token)) {
          noteFailure(ip);
          log.warn('Admin panel login failed', { ip });
          return send(res, 401, { error: 'Incorrect token.' });
        }
        attempts.delete(ip);
        const id = newSession();
        log.info('Admin panel login', { ip });
        return send(res, 200, { ok: true }, {
          'Set-Cookie': `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
        });
      }

      // ---- everything below requires a session ----------------------------
      const sid = cookies(req)[COOKIE];
      if (!validSession(sid)) {
        return send(res, 401, { error: 'Not signed in.' });
      }

      if (route === '/api/logout' && req.method === 'POST') {
        sessions.delete(sid);
        return send(res, 200, { ok: true }, {
          'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
        });
      }

      // ---- overview -------------------------------------------------------
      if (route === '/api/overview' && req.method === 'GET') {
        const [backend, caddy] = await Promise.all([
          serviceStatus(SERVICES.backend),
          serviceStatus(SERVICES.caddy),
        ]);
        let backendUrl = '';
        try {
          backendUrl = (await fsp.readFile(
            path.join(path.dirname(process.env.ENV_FILE || '/etc/palworld-rp-backend/env'), 'backend-url.txt'),
            'utf8'
          )).trim();
        } catch { /* not fatal; the panel just shows nothing */ }

        return send(res, 200, {
          backendUrl,
          version: require('../package.json').version,
          node: process.version,
          platform: `${process.platform} ${os.release()}`,
          uptimeSec: Math.floor(process.uptime()),
          playersOnline: presence.onlineCount(),
          accounts: store.accountCount(),
          registrationOpen: config.registrationOpen,
          requireEncryption: config.requireEncryption,
          sessions: auth.stats?.() ?? null,
          services: { backend, caddy },
          dataDir: config.dataDir,
        });
      }

      // ---- players --------------------------------------------------------
      if (route === '/api/players' && req.method === 'GET') {
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const online = new Set(presence.listOnline().map((p) => (p.name || p)));
        const rows = [];
        for (const [name, account] of store._accounts) {
          if (q && !name.includes(q)) continue;
          rows.push({
            name,
            online: online.has(name),
            banned: Boolean(account.banned),
            banReason: account.banReason || '',
            mutes: account.mutes ? account.mutes.size : 0,
            created: account.created || null,
          });
        }
        rows.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
        return send(res, 200, { players: rows.slice(0, 500), total: rows.length });
      }

      const playerMatch = route.match(/^\/api\/players\/([^/]+)\/(ban|unban|kick|delete)$/);
      if (playerMatch && req.method === 'POST') {
        const name = normalizeName(decodeURIComponent(playerMatch[1]));
        const action = playerMatch[2];
        const account = store.getAccount(name);
        if (!account) return send(res, 404, { error: 'No such player.' });
        const body = await readBody(req).catch(() => ({}));

        if (action === 'ban') {
          await store.updateAccount(account, (a) => {
            a.banned = true;
            a.banReason = String(body.reason || 'No reason given.').slice(0, 300);
          });
          auth.revokeAllFor(name);
          const dropped = presence.disconnectAccount(name, 'You were banned by an administrator.');
          log.info('Admin ban', { name, dropped });
          return send(res, 200, { ok: true, dropped });
        }
        if (action === 'unban') {
          await store.updateAccount(account, (a) => {
            a.banned = false;
            a.banReason = '';
          });
          log.info('Admin unban', { name });
          return send(res, 200, { ok: true });
        }
        if (action === 'kick') {
          auth.revokeAllFor(name);
          const dropped = presence.disconnectAccount(name, 'You were disconnected by an administrator.');
          return send(res, 200, { ok: true, dropped });
        }
        if (action === 'delete') {
          auth.revokeAllFor(name);
          presence.disconnectAccount(name, 'Your account was removed by an administrator.');
          await store.deleteAccount(name);
          log.warn('Admin deleted account', { name });
          return send(res, 200, { ok: true });
        }
      }

      // ---- settings -------------------------------------------------------
      if (route === '/api/settings' && req.method === 'GET') {
        return send(res, 200, { settings: settings.describe() });
      }
      if (route === '/api/settings' && req.method === 'PATCH') {
        const body = await readBody(req);
        const saved = await settings.save(body);
        log.info('Admin changed settings', { keys: Object.keys(body) });
        return send(res, 200, { ok: true, overrides: saved, settings: settings.describe() });
      }
      if (route === '/api/settings/reset' && req.method === 'POST') {
        const body = await readBody(req);
        await settings.reset(String(body.key || ''));
        return send(res, 200, { ok: true, settings: settings.describe() });
      }

      // ---- service control ------------------------------------------------
      const svcMatch = route.match(/^\/api\/service\/(backend|caddy)\/(\w+)$/);
      if (svcMatch && req.method === 'POST') {
        const unit = SERVICES[svcMatch[1]];
        const action = svcMatch[2];
        if (!ACTIONS.has(action)) return send(res, 400, { error: 'Unsupported action.' });
        if (process.platform !== 'linux') {
          return send(res, 501, { error: 'Service control is Linux-only in this build.' });
        }
        // -n: never prompt. Without the sudoers rule this fails immediately
        // rather than hanging forever waiting for a password nobody can type.
        const r = await run('sudo', ['-n', 'systemctl', action, unit]);
        if (!r.ok) {
          return send(res, 403, {
            error: 'Not permitted. The installer must add /etc/sudoers.d/palworld-rp-backend.',
            detail: (r.stderr || r.stdout).slice(0, 400),
          });
        }
        log.warn('Admin service action', { unit, action });
        return send(res, 200, { ok: true });
      }

      // ---- backups --------------------------------------------------------
      if (route === '/api/backups' && req.method === 'GET') {
        const dir = process.env.BACKUP_DIR || '/var/backups/palworld-rp-backend';
        try {
          const names = await fsp.readdir(dir);
          const files = [];
          for (const n of names.filter((x) => x.endsWith('.tar.gz'))) {
            const st = await fsp.stat(path.join(dir, n)).catch(() => null);
            if (st) files.push({ name: n, size: st.size, mtime: st.mtimeMs });
          }
          files.sort((a, b) => b.mtime - a.mtime);
          return send(res, 200, { dir, backups: files });
        } catch (err) {
          return send(res, 200, { dir, backups: [], error: err.message });
        }
      }
      if (route === '/api/backups' && req.method === 'POST') {
        // Invoked directly, not via `bash <script>`, so the sudoers rule can
        // name one exact executable. Allowing `bash <path>` would mean allowing
        // bash, and an attacker who could influence the path would have a shell.
        const script = path.join(__dirname, '..', 'deploy', 'backup.sh');
        const r = await run('sudo', ['-n', script], { timeout: 120000 });
        if (!r.ok) {
          return send(res, 403, {
            error: 'Not permitted. The installer must add /etc/sudoers.d/palworld-rp-backend.',
            detail: (r.stderr || r.stdout).slice(0, 400),
          });
        }
        return send(res, 200, { ok: true, output: r.stdout.slice(-2000) });
      }

      // ---- logs -----------------------------------------------------------
      if (route === '/api/logs' && req.method === 'GET') {
        const lines = Math.min(Math.max(Number.parseInt(url.searchParams.get('lines'), 10) || 200, 10), 2000);
        const unit = url.searchParams.get('unit') === 'caddy' ? 'caddy' : SERVICES.backend;
        if (process.platform !== 'linux') {
          return send(res, 200, { text: 'Log reading is Linux-only in this build.' });
        }
        const r = await run('journalctl', ['-u', unit, '-n', String(lines), '--no-pager']);
        return send(res, 200, { text: r.stdout || r.stderr || '(no output)' });
      }

      return send(res, 404, { error: 'No such endpoint.' });
    } catch (err) {
      // ValidationError comes from src/validate.js and means the request was
      // malformed — a 400, not a 500. Without this, every bad player name was
      // reported as a server error and logged with a stack trace.
      const status = err.statusCode || (err.name === 'ValidationError' ? 400 : 500);
      if (status >= 500) log.error('Admin panel error', { err: err.message, route });
      return send(res, status, { error: err.message || 'Server error.' });
    }
  };
}

function start({ presence }) {
  if (!config.adminUiEnabled) {
    log.info('Admin panel disabled by ADMIN_UI=0');
    return null;
  }
  if (!config.adminToken) {
    log.warn('Admin panel not started: ADMIN_TOKEN is empty, so there would be nothing to log in with.');
    return null;
  }

  let uiHtml;
  try {
    uiHtml = fs.readFileSync(path.join(__dirname, 'admin-ui.html'), 'utf8');
  } catch (err) {
    log.error('Admin panel UI file missing; panel not started.', { err: err.message });
    return null;
  }

  const server = http.createServer(buildHandler({ presence, uiHtml }));

  server.listen(config.adminUiPort, config.adminUiBind, () => {
    log.info('Admin panel listening', {
      url: `http://${config.adminUiBind}:${config.adminUiPort}`,
      exposed: config.adminUiBind !== '127.0.0.1' && config.adminUiBind !== 'localhost',
    });
    if (config.adminUiBind !== '127.0.0.1' && config.adminUiBind !== 'localhost') {
      log.warn(
        'ADMIN_UI_BIND is not loopback. The admin panel is reachable from the network — this publishes an admin login form. Set ADMIN_UI_BIND=127.0.0.1 and use an SSH tunnel instead.'
      );
    }
  });

  server.on('error', (err) => {
    log.error('Admin panel failed to listen', {
      err: err.message, port: config.adminUiPort, bind: config.adminUiBind,
    });
  });

  return server;
}

module.exports = { start, _internals: { tokenMatches, validSession, newSession, throttled, noteFailure, sessions, attempts } };
