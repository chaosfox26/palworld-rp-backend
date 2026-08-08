'use strict';

const path = require('node:path');
const config = require('./config');

/**
 * Character / account names.
 *
 * This regex is the single most important line in the codebase. The previous
 * version of this backend passed `req.params.name` straight into path.join().
 * Express percent-decodes route params AFTER matching, so a request to
 *   GET /profile/..%2F..%2F..%2Fetc%2Fpasswd
 * matched the `:name` segment (no literal slash in the raw path) and then
 * decoded into `../../../etc/passwd` — a full read/write primitive outside the
 * profiles directory. Allow-listing the character set removes the whole class
 * of bug rather than trying to filter dangerous sequences.
 */
const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,23}$/;

// Windows reserves these device names, and the reservation still applies when
// an extension is appended — `con.json` cannot be created at all. The backend
// supports Windows natively and stores one file per account, so a player named
// "con" would make their own profile unwritable there. Rejecting them on every
// platform also keeps a data directory portable between hosts, rather than
// producing files that copy to a Windows box and then cannot be opened.
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

/** Channel names: same idea, slightly looser, still no path characters. */
const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
  }
}

/**
 * Normalise and validate a character name.
 * Returns the canonical lowercase form, or throws ValidationError.
 */
function normalizeName(raw) {
  if (typeof raw !== 'string') {
    throw new ValidationError('Name must be a string.');
  }
  const name = raw.trim().toLowerCase();
  if (!NAME_RE.test(name)) {
    throw new ValidationError(
      'Names must be 2-24 characters, start with a letter or number, and contain only letters, numbers, hyphens and underscores.'
    );
  }
  if (WINDOWS_RESERVED_RE.test(name)) {
    throw new ValidationError('That name is reserved by the operating system. Pick another.');
  }
  return name;
}

function normalizeChannel(raw) {
  if (typeof raw !== 'string') {
    throw new ValidationError('Channel must be a string.');
  }
  const ch = raw.trim().toLowerCase();
  if (!CHANNEL_RE.test(ch)) {
    throw new ValidationError(
      'Channel names must be 2-32 characters and contain only letters, numbers, hyphens and underscores.'
    );
  }
  return ch;
}

function validatePassword(raw) {
  if (typeof raw !== 'string') {
    throw new ValidationError('Password must be a string.');
  }
  if (raw.length < config.minPasswordLength) {
    throw new ValidationError(
      `Password must be at least ${config.minPasswordLength} characters.`
    );
  }
  if (raw.length > config.maxPasswordLength) {
    throw new ValidationError(
      `Password must be at most ${config.maxPasswordLength} characters.`
    );
  }
  return raw;
}

/**
 * Build a filesystem path inside `baseDir` for an already-validated name, then
 * assert the result really is inside baseDir. Belt and braces: even if the
 * regex above were ever loosened, this second check still holds the line.
 */
function safeJoin(baseDir, name, suffix) {
  const resolvedBase = path.resolve(baseDir);
  const candidate = path.resolve(resolvedBase, `${name}${suffix}`);
  if (candidate !== path.join(resolvedBase, `${name}${suffix}`)) {
    throw new ValidationError('Invalid path.', 400);
  }
  if (!candidate.startsWith(resolvedBase + path.sep)) {
    throw new ValidationError('Invalid path.', 400);
  }
  return candidate;
}

/** Reject non-finite / absurd coordinates before they poison distance math. */
function normalizePosition(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const coord = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(-1e9, Math.min(1e9, n)) : 0;
  };
  return { x: coord(p.x), y: coord(p.y), z: coord(p.z) };
}

/** Strip control characters that would corrupt a chat log or terminal. */
function sanitizeMessage(raw) {
  if (typeof raw !== 'string') {
    throw new ValidationError('Message must be a string.');
  }
  // Keep newlines and tabs (multi-paragraph emotes are the whole point);
  // drop the rest of the C0/C1 control ranges.
  const cleaned = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
  if (cleaned.length === 0) {
    throw new ValidationError('Message is empty.');
  }
  const bytes = Buffer.byteLength(cleaned, 'utf8');
  if (bytes > config.maxMessageBytes) {
    throw new ValidationError(
      `Message is ${bytes} bytes; the limit is ${config.maxMessageBytes}.`,
      413
    );
  }
  return cleaned;
}

module.exports = {
  ValidationError,
  NAME_RE,
  CHANNEL_RE,
  normalizeName,
  normalizeChannel,
  validatePassword,
  safeJoin,
  normalizePosition,
  sanitizeMessage,
};
