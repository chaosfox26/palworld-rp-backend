'use strict';

const config = require('./config');

/**
 * Token buckets.
 *
 * Two changes from the previous design, both of which mattered:
 *
 * 1. Buckets are keyed by ACCOUNT (or IP), not by socket. The old version
 *    stored the bucket on the socket object, so the limiter was defeated by
 *    disconnecting and reconnecting — about four lines of client code.
 *
 * 2. The cost of a chat message is (bytes x recipients), not just bytes. The
 *    old limiter charged a 99 KB global message the same as a 99 KB whisper,
 *    but the global costs the server 99 KB x everyone online. On a 200-player
 *    server that is 20 MB of egress for one keypress. Charging fanout means a
 *    huge emote to the four people standing next to you stays cheap — which is
 *    exactly the roleplay case we want to keep unlimited — while the same text
 *    sprayed at the whole server gets throttled.
 */

class BucketSet {
  constructor({ capacity, refillPerSec, idleMs = 10 * 60 * 1000 }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.idleMs = idleMs;
    this.buckets = new Map();
  }

  _bucket(key, now) {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, last: now };
      this.buckets.set(key, b);
      return b;
    }
    const elapsed = (now - b.last) / 1000;
    b.last = now;
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSec);
    return b;
  }

  /** Returns true and deducts if affordable; otherwise returns false. */
  consume(key, cost = 1, now = Date.now()) {
    const b = this._bucket(key, now);
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return true;
    }
    return false;
  }

  /** Seconds until `cost` would be affordable. Used for friendly error text. */
  retryAfter(key, cost = 1, now = Date.now()) {
    const b = this._bucket(key, now);
    if (b.tokens >= cost) return 0;
    if (this.refillPerSec <= 0) return Infinity;
    return Math.ceil((cost - b.tokens) / this.refillPerSec);
  }

  /** Drop buckets that have been idle long enough to be back at full. */
  sweep(now = Date.now()) {
    for (const [key, b] of this.buckets) {
      if (now - b.last > this.idleMs) this.buckets.delete(key);
    }
  }

  reset(key) {
    this.buckets.delete(key);
  }

  get size() {
    return this.buckets.size;
  }
}

// Chat: bytes actually pushed to clients.
const chatBytes = new BucketSet({
  capacity: config.chatBurstBytes,
  refillPerSec: config.chatRefillBytesPerSec,
});

// Chat: raw message count, to stop tiny-message floods that barely dent bytes.
const chatMessages = new BucketSet({
  capacity: config.chatBurstMessages,
  refillPerSec: config.chatRefillMessagesPerSec,
});

// Position updates, per account.
const positionUpdates = new BucketSet({
  capacity: Math.max(config.positionUpdatesPerSec * 2, 4),
  refillPerSec: config.positionUpdatesPerSec,
});

/**
 * Cheap-looking socket queries: /who lookups, party create/join/leave/info.
 *
 * These are individually inexpensive, which is exactly why they need a limit.
 * A /who with a two-character query scans the whole name index for substring
 * matches; unthrottled, an authenticated client can pin a CPU core with a loop
 * that costs it nothing. The chat limiters do not cover these events.
 */
const socketQueries = new BucketSet({
  capacity: config.socketQueryBurst,
  refillPerSec: config.socketQueryRefillPerSec,
});

// HTTP limiters, keyed by client IP.
const httpRegister = new BucketSet({
  capacity: config.registerPerHour,
  refillPerSec: config.registerPerHour / 3600,
  idleMs: 6 * 60 * 60 * 1000,
});
const httpLogin = new BucketSet({
  capacity: config.loginPerMinute,
  refillPerSec: config.loginPerMinute / 60,
});
const httpProfileWrite = new BucketSet({
  capacity: config.profileWritesPerMinute,
  refillPerSec: config.profileWritesPerMinute / 60,
});
const httpWrite = new BucketSet({
  capacity: config.writesPerMinute,
  refillPerSec: config.writesPerMinute / 60,
});
const httpRead = new BucketSet({
  capacity: config.readsPerMinute,
  refillPerSec: config.readsPerMinute / 60,
});

const allSets = [
  chatBytes,
  chatMessages,
  positionUpdates,
  socketQueries,
  httpRegister,
  httpLogin,
  httpProfileWrite,
  httpWrite,
  httpRead,
];

function sweepAll() {
  const now = Date.now();
  for (const set of allSets) set.sweep(now);
}

/** Express middleware factory for the per-IP HTTP buckets. */
function httpLimiter(bucketSet, label) {
  return (req, res, next) => {
    const key = req.clientIp || 'unknown';
    if (bucketSet.consume(key, 1)) return next();
    const retry = bucketSet.retryAfter(key, 1);
    res.set('Retry-After', String(Math.max(1, Math.min(retry, 3600))));
    return res.status(429).json({
      error: `Too many ${label} requests. Slow down and try again shortly.`,
      retryAfterSeconds: retry,
    });
  };
}

module.exports = {
  BucketSet,
  chatBytes,
  chatMessages,
  positionUpdates,
  socketQueries,
  httpRegister,
  httpLogin,
  httpProfileWrite,
  httpWrite,
  httpRead,
  sweepAll,
  httpLimiter,
};
