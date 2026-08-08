'use strict';

const crypto = require('node:crypto');
const { Server } = require('socket.io');

const config = require('./config');
const log = require('./log');
const store = require('./store');
const auth = require('./auth');
const rl = require('./ratelimit');
const envelope = require('./envelope');
const {
  ValidationError,
  normalizeName,
  normalizeChannel,
  normalizePosition,
  sanitizeMessage,
} = require('./validate');

/**
 * Real-time chat.
 *
 * Identity is established once, at handshake time, from a session token. After
 * that the socket's character name is server-owned. Nothing a client sends can
 * change who it is, which guild it is in, or which channels it can hear.
 */

function attach(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigin, methods: ['GET', 'POST'] },
    // Room for one oversized emote plus protocol overhead; anything larger is
    // dropped by the transport before it can be buffered in memory.
    maxHttpBufferSize: config.maxMessageBytes + 65536,
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  /** socket.id -> { name, position, socket } */
  const online = new Map();
  /** name -> Set<socket.id> (a player may have more than one session) */
  const sockets = new Map();

  // -------------------------------------------------------------------------
  // Handshake authentication
  // -------------------------------------------------------------------------

  io.use((socket, next) => {
    // Only the `auth` payload, never the query string.
    //
    // A token in the query string ends up in the handshake URL, which every
    // reverse proxy in the path writes to its access log — including the Caddy
    // instance in front of this service. That would leave working credentials
    // sitting in a log file in plaintext. The `auth` object travels in the
    // Socket.IO payload instead and is never logged.
    const token = socket.handshake.auth?.token;
    const account = auth.resolve(typeof token === 'string' ? token : '');
    if (!account) {
      return next(new Error('unauthorized'));
    }

    // Cap concurrent connections per account.
    //
    // MAX_SESSIONS_PER_ACCOUNT limits how many *tokens* exist, but a single
    // token can open an unlimited number of sockets. Every extra socket is
    // another copy of every global message, so an account could amplify its own
    // traffic — and consume memory — without limit.
    const existing = sockets.get(account.name);
    if (existing && existing.size >= config.maxSocketsPerAccount) {
      return next(new Error('too many connections'));
    }

    socket.data.name = account.name;
    return next();
  });

  // -------------------------------------------------------------------------
  // Parties  (/p)
  // -------------------------------------------------------------------------

  /**
   * Parties are deliberately ephemeral and in-memory.
   *
   * A guild is who you are; a party is who you are playing with right now. It
   * should not outlive the session, and it should not need a passcode file on
   * disk. So parties live only in RAM, are addressed by a short invite code you
   * can read out over voice chat, and disappear when the last member leaves or
   * the server restarts.
   */

  /** code -> { code, leader, members: Set<name>, createdAt } */
  const parties = new Map();
  /** name -> code */
  const partyOf = new Map();

  // No 0/O/1/I: these get read aloud and mistyped constantly.
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function newPartyCode() {
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = '';
      const bytes = crypto.randomBytes(6);
      for (let i = 0; i < 6; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
      if (!parties.has(code)) return code;
    }
    throw new Error('Could not allocate a party code.');
  }

  /** Tell everyone in a party that its membership changed. */
  function announceParty(code) {
    const party = parties.get(code);
    if (!party) return;
    for (const member of party.members) {
      const set = sockets.get(member);
      if (!set) continue;
      for (const id of set) {
        const socket = io.sockets.sockets.get(id);
        if (socket) {
          socket.emit('party', {
            code: party.code,
            leader: party.leader,
            members: [...party.members],
          });
        }
      }
    }
  }

  function leaveParty(name, { announce = true } = {}) {
    const code = partyOf.get(name);
    if (!code) return null;
    partyOf.delete(name);

    const party = parties.get(code);
    if (!party) return null;
    party.members.delete(name);

    if (party.members.size === 0) {
      parties.delete(code);
      return code;
    }
    // Leader left: hand it to whoever has been there longest.
    if (party.leader === name) {
      party.leader = [...party.members][0];
    }
    if (announce) announceParty(code);
    return code;
  }

  // -------------------------------------------------------------------------
  // Presence helpers
  // -------------------------------------------------------------------------

  function trackSocket(name, socket) {
    let set = sockets.get(name);
    if (!set) {
      set = new Set();
      sockets.set(name, set);
    }
    set.add(socket.id);
  }

  function untrackSocket(name, socket) {
    const set = sockets.get(name);
    if (!set) return;
    set.delete(socket.id);
    if (set.size === 0) sockets.delete(name);
  }

  /**
   * Push updated membership to every live session for an account.
   *
   * Routing itself needs no synchronisation: recipients are resolved from the
   * account record at send time, so a guild or channel change takes effect on
   * the very next message. This exists so a player's OTHER open sessions (and
   * their channel tab bar) learn about a change made over REST.
   */
  function syncMembership(name) {
    const set = sockets.get(name);
    if (!set) return;
    const account = store.getAccount(name);
    if (!account) return;
    for (const id of set) {
      const socket = io.sockets.sockets.get(id);
      if (socket) {
        socket.emit('membership', {
          guild: account.guild,
          channels: [...account.channels],
        });
      }
    }
  }

  function disconnectAccount(name, reason) {
    const set = sockets.get(name);
    if (!set) return 0;
    let count = 0;
    for (const id of [...set]) {
      const socket = io.sockets.sockets.get(id);
      if (socket) {
        socket.emit('force_disconnect', { reason });
        socket.disconnect(true);
        count += 1;
      }
    }
    return count;
  }

  const presence = {
    isOnline: (name) => sockets.has(name),
    onlineCount: () => sockets.size,
    listOnline: () =>
      [...sockets.keys()].map((name) => ({
        name,
        sessions: sockets.get(name).size,
      })),
    syncMembership,
    disconnectAccount,
    partyCount: () => parties.size,
  };

  // -------------------------------------------------------------------------
  // Delivery
  // -------------------------------------------------------------------------

  /**
   * Resolve the concrete recipient sockets for a scope, honouring mute lists.
   * We compute the recipient set BEFORE sending so the rate limiter can charge
   * for real fanout, and so muted players cost nothing at all.
   */
  function recipientsFor(scope, sender) {
    const out = [];
    const add = (entry) => {
      if (!entry) return;
      const account = store.getAccount(entry.name);
      if (!account) return;
      // Muting is enforced here: the message is never sent, not merely hidden.
      if (account.mutes.has(sender.name)) return;
      out.push(entry);
    };

    switch (scope.kind) {
      case 'local': {
        const radiusSq = config.localChatRadius * config.localChatRadius;
        for (const entry of online.values()) {
          const dx = entry.position.x - sender.position.x;
          const dy = entry.position.y - sender.position.y;
          const dz = entry.position.z - sender.position.z;
          if (dx * dx + dy * dy + dz * dz <= radiusSq) add(entry);
        }
        break;
      }
      case 'global': {
        for (const entry of online.values()) add(entry);
        break;
      }
      case 'guild': {
        for (const entry of online.values()) {
          const account = store.getAccount(entry.name);
          if (account?.guild && account.guild === scope.guild) add(entry);
        }
        break;
      }
      case 'channel': {
        for (const entry of online.values()) {
          const account = store.getAccount(entry.name);
          if (account?.channels.includes(scope.channel)) add(entry);
        }
        break;
      }
      case 'party': {
        const party = parties.get(scope.code);
        if (party) {
          for (const entry of online.values()) {
            if (party.members.has(entry.name)) add(entry);
          }
        }
        break;
      }
      case 'direct': {
        const set = sockets.get(scope.name);
        if (set) {
          for (const id of set) {
            const entry = online.get(id);
            if (entry) add(entry);
          }
        }
        break;
      }
      default:
        break;
    }
    return out;
  }

  function deliver(recipients, payload) {
    const frame = { ...payload, at: Date.now() };
    for (const entry of recipients) {
      entry.socket.emit('chat_receive', frame);
    }
  }

  function fail(socket, message, extra = {}) {
    socket.emit('chat_error', { message, ...extra });
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  io.on('connection', (socket) => {
    const name = socket.data.name;
    const entry = { name, position: { x: 0, y: 0, z: 0 }, socket };
    online.set(socket.id, entry);
    trackSocket(name, socket);

    const account = store.getAccount(name);
    socket.emit('ready', {
      name,
      guild: account?.guild ?? null,
      channels: account?.channels ?? [],
      party: partyOf.get(name) ?? null,
      limits: {
        maxMessageBytes: config.maxMessageBytes,
        localChatRadius: config.localChatRadius,
        maxPartySize: config.maxPartySize,
      },
    });
    log.debug('Socket connected', { name, id: socket.id });

    /**
     * Wrap a socket handler so that:
     *
     *  1. An unexpected throw becomes an error reply to that one client. Without
     *     this, an exception inside a Socket.IO handler propagates to
     *     `uncaughtException`, which this process treats as fatal — so a single
     *     malformed packet from one player could restart the server for
     *     everyone.
     *  2. Cheap query events get a rate limit. They are not chat messages, so
     *     the chat limiters never see them.
     */
    function guard(handler, { limit = true } = {}) {
      return (packet, ack) => {
        const replyError = (message) => {
          if (typeof ack === 'function') return ack({ ok: false, error: message });
          return fail(socket, message);
        };
        try {
          if (limit && !rl.socketQueries.consume(name, 1)) {
            return replyError('You are doing that too quickly. Wait a moment.');
          }
          return handler(packet, ack);
        } catch (err) {
          if (err instanceof ValidationError) return replyError(err.message);
          log.error('Socket handler threw', { name, err: err?.message, stack: err?.stack });
          return replyError('Internal error. That action did not complete.');
        }
      };
    }

    // -- position ----------------------------------------------------------
    /**
     * Position is client-reported and therefore not trustworthy: a modified
     * client can claim to be standing anywhere in order to listen in on local
     * chat. There is no fix for that without server-side game integration, and
     * integrating with the game server is exactly what this project avoids by
     * design. Treat /s and /em as "semi-private at best" and put anything
     * genuinely private in a whisper or a passcode-protected channel.
     */
    socket.on(
      'update_position',
      guard((raw) => {
        if (!rl.positionUpdates.consume(name, 1)) return; // silently drop excess
        entry.position = normalizePosition(raw);
      }, { limit: false })
    );

    // -- chat --------------------------------------------------------------
    socket.on('send_chat', (packet) => {
      try {
        // Charge the counter FIRST, before validating anything. If the
        // malformed-packet check came first, a flood of junk packets would cost
        // the sender nothing while still making the server emit an error for
        // each one.
        if (!rl.chatMessages.consume(name, 1)) {
          return fail(socket, 'You are sending messages too quickly.', {
            retryAfterSeconds: rl.chatMessages.retryAfter(name, 1),
          });
        }

        if (!packet || typeof packet !== 'object') {
          return fail(socket, 'Malformed chat packet.');
        }

        // Either an encrypted envelope (relayed untouched) or plaintext
        // (sanitised), depending on REQUIRE_ENCRYPTION.
        const content = envelope.normalizeContent(packet.message, {
          sanitizePlaintext: sanitizeMessage,
        });
        const message = content.payload;
        const bytes = content.bytes;
        const sender = entry;
        const senderAccount = store.getAccount(name);
        if (!senderAccount) return fail(socket, 'Your account no longer exists.');

        // Work out scope and recipients.
        let scope;
        let type;
        switch (packet.command) {
          case 'say':
            scope = { kind: 'local' };
            type = 'say';
            break;
          case 'emote':
            scope = { kind: 'local' };
            type = 'emote';
            break;
          case 'global':
            scope = { kind: 'global' };
            type = 'global';
            break;
          case 'guild':
            if (!senderAccount.guild) {
              return fail(socket, 'You are not in a guild. Use /guild join <name>.');
            }
            scope = { kind: 'guild', guild: senderAccount.guild };
            type = 'guild';
            break;
          case 'party': {
            const code = partyOf.get(name);
            if (!code) {
              return fail(socket, 'You are not in a party. Use /party new, or /party join <code>.');
            }
            scope = { kind: 'party', code };
            type = 'party';
            break;
          }
          case 'channel': {
            const channel = normalizeChannel(packet.channel);
            if (!senderAccount.channels.includes(channel)) {
              return fail(socket, `You have not joined channel "${channel}".`);
            }
            scope = { kind: 'channel', channel };
            type = 'channel';
            break;
          }
          case 'whisper': {
            const target = normalizeName(packet.target);
            if (target === name) {
              return fail(socket, 'You cannot whisper yourself.');
            }
            if (!sockets.has(target)) {
              return fail(socket, `${target} is not online.`);
            }
            const targetAccount = store.getAccount(target);
            if (targetAccount?.mutes.has(name)) {
              // Report the same message as "not online" would be dishonest to
              // the sender; report the block plainly instead.
              return fail(socket, `${target} is not accepting messages from you.`);
            }
            scope = { kind: 'direct', name: target };
            type = 'whisper';
            break;
          }
          default:
            return fail(socket, `Unknown chat command "${packet.command}".`);
        }

        const recipients = recipientsFor(scope, sender);

        // Fanout-aware cost: what this message actually costs the server to
        // push. A 50 KB emote heard by 3 people is cheap; the same text sent to
        // 300 people in global is not, and is throttled accordingly.
        const cost = bytes * Math.max(1, recipients.length);
        if (!rl.chatBytes.consume(name, cost)) {
          return fail(
            socket,
            'That message is too large to send to that many people right now. Try a smaller audience or wait a moment.',
            { retryAfterSeconds: rl.chatBytes.retryAfter(name, cost), recipients: recipients.length }
          );
        }

        if (type === 'whisper') {
          deliver(recipients, {
            type: 'whisper_in',
            sender: name,
            message,
          });
          // Echo to every one of the sender's own sessions so a second client
          // stays in sync.
          const ownSockets = recipientsFor({ kind: 'direct', name }, sender);
          deliver(ownSockets, {
            type: 'whisper_out',
            target: scope.name,
            message,
          });
          return undefined;
        }

        deliver(recipients, {
          type,
          sender: name,
          // Emotes read as "Aely kisses Aiden". When content is encrypted the
          // server cannot compose that string, so the client does it — using
          // `sender`, which is server-assigned and therefore still unspoofable.
          // The plaintext path keeps composing server-side so older clients
          // behave as before.
          message: type === 'emote' && !content.encrypted ? `${name} ${message}` : message,
          ...(type === 'emote' ? { composeWithSender: content.encrypted } : {}),
          ...(scope.kind === 'channel' ? { channel: scope.channel } : {}),
          ...(scope.kind === 'guild' ? { guild: scope.guild } : {}),
          ...(scope.kind === 'party' ? { party: scope.code } : {}),
        });
        return undefined;
      } catch (err) {
        if (err instanceof ValidationError) return fail(socket, err.message);
        log.error('send_chat failed', { name, err: err?.message });
        return fail(socket, 'Internal error handling that message.');
      }
    });

    // -- who ---------------------------------------------------------------
    /** Socket-side /who so the mod does not need a second HTTP round trip. */
    socket.on('who', guard((packet, ack) => {
      const respond = typeof ack === 'function' ? ack : (data) => socket.emit('who_result', data);
      const raw = String(packet?.query ?? '').toLowerCase();
      if (!/^[a-z0-9_-]{1,32}$/.test(raw)) return respond({ query: raw, results: [] });
      const names = store.search(raw);
      return respond({
        query: raw,
        results: names.map((n) => ({ name: n, online: sockets.has(n) })),
      });
    }));

    // -- party -------------------------------------------------------------

    socket.on('party_create', guard((packet, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      leaveParty(name); // you can only be in one party at a time
      const code = newPartyCode();
      parties.set(code, {
        code,
        leader: name,
        members: new Set([name]),
        createdAt: Date.now(),
      });
      partyOf.set(name, code);
      respond({ ok: true, code, leader: name, members: [name] });
      announceParty(code);
    }));

    socket.on('party_join', guard((packet, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      const code = String(packet?.code ?? '').trim().toUpperCase();
      const party = parties.get(code);
      if (!party) {
        return respond({ ok: false, error: 'No party with that code. Codes expire when the last member leaves.' });
      }
      if (party.members.has(name)) {
        return respond({ ok: true, code, leader: party.leader, members: [...party.members] });
      }
      if (party.members.size >= config.maxPartySize) {
        return respond({ ok: false, error: `That party is full (${config.maxPartySize} members).` });
      }
      leaveParty(name);
      party.members.add(name);
      partyOf.set(name, code);
      announceParty(code);
      return respond({ ok: true, code, leader: party.leader, members: [...party.members] });
    }));

    socket.on('party_leave', guard((packet, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      const code = leaveParty(name);
      respond({ ok: Boolean(code) });
      if (code) {
        // Tell the leaver their own party is now empty from their perspective.
        socket.emit('party', { code: null, leader: null, members: [] });
      }
    }));

    socket.on('party_info', guard((packet, ack) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      const code = partyOf.get(name);
      const party = code ? parties.get(code) : null;
      respond(
        party
          ? { ok: true, code: party.code, leader: party.leader, members: [...party.members] }
          : { ok: true, code: null, leader: null, members: [] }
      );
    }));

    socket.on('disconnect', () => {
      online.delete(socket.id);
      untrackSocket(name, socket);
      // Only drop out of the party when the LAST session for this account goes
      // away, otherwise a second client or a brief reconnect would kick them.
      if (!sockets.has(name)) leaveParty(name);
      log.debug('Socket disconnected', { name, id: socket.id });
    });
  });

  return { io, presence };
}

module.exports = { attach };
