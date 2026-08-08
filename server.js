'use strict';

const http = require('node:http');

// Order matters: the overrides file is applied to process.env before config is
// required, otherwise the configuration is already frozen from the environment
// and anything changed in the admin panel would be silently ignored.
require('./src/settings').loadIntoEnv();

const config = require('./src/config');
const log = require('./src/log');
const store = require('./src/store');
const guilds = require('./src/guilds');
const auth = require('./src/auth');
const rl = require('./src/ratelimit');
const { buildApp } = require('./src/rest');
const chat = require('./src/chat');
const admin = require('./src/admin');

async function main() {
  await store.init();
  await guilds.init();

  // The REST layer needs to ask the chat layer who is online, and the chat
  // layer needs an HTTP server that the REST app is already mounted on. This
  // late-bound reference breaks the cycle without any global state.
  const presenceRef = { current: null };
  const presence = {
    isOnline: (name) => presenceRef.current?.isOnline(name) ?? false,
    onlineCount: () => presenceRef.current?.onlineCount() ?? 0,
    listOnline: () => presenceRef.current?.listOnline() ?? [],
    syncMembership: (name) => presenceRef.current?.syncMembership(name),
    disconnectAccount: (name, reason) =>
      presenceRef.current?.disconnectAccount(name, reason) ?? 0,
    partyCount: () => presenceRef.current?.partyCount() ?? 0,
  };

  const app = buildApp({ presence });
  const httpServer = http.createServer(app);
  const { io, presence: livePresence } = chat.attach(httpServer);
  presenceRef.current = livePresence;

  // Periodic housekeeping: expire sessions and drop idle rate-limit buckets so
  // memory does not grow with every visitor the server has ever seen.
  const janitor = setInterval(() => {
    auth.sweep();
    rl.sweepAll();
  }, 60_000);
  janitor.unref();

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, resolve);
  });

  // Loopback-only by default, and a completely separate listener from the
  // public app so that Caddy has no route to it whatsoever.
  const adminServer = admin.start({ presence });

  log.info('Backend listening', {
    port: config.port,
    host: config.host,
    adminApi: config.adminToken ? 'enabled' : 'disabled',
  });

  if (config.warnIfInsecure) {
    log.warn(
      'This process serves plain HTTP. Put it behind the bundled Caddy reverse proxy (or your own TLS terminator) before exposing it to the internet — otherwise passwords and chat travel in cleartext.'
    );
  }
  if (!config.adminToken) {
    log.warn('ADMIN_TOKEN is not set, so moderation endpoints are disabled.');
  }

  // ---- Graceful shutdown --------------------------------------------------
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down', { signal });
    clearInterval(janitor);

    const forced = setTimeout(() => {
      log.warn('Shutdown timed out; exiting anyway.');
      process.exit(1);
    }, 10_000);
    forced.unref();

    io.emit('server_shutdown', { message: 'Server is restarting. Reconnecting shortly.' });
    await new Promise((resolve) => io.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
    if (adminServer) await new Promise((resolve) => adminServer.close(resolve));
    log.info('Shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A crashed process that Docker restarts is recoverable; a silently wedged
  // one is not. Log loudly and let the restart policy do its job.
  process.on('unhandledRejection', (err) => {
    log.error('Unhandled promise rejection', { err: err?.message, stack: err?.stack });
  });
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception', { err: err?.message, stack: err?.stack });
    shutdown('uncaughtException');
  });

  return { httpServer, io, adminServer };
}

if (require.main === module) {
  main().catch((err) => {
    log.error('Failed to start', { err: err?.message, stack: err?.stack });
    process.exit(1);
  });
}

module.exports = { main };
