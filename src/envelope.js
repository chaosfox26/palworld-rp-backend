'use strict';

const config = require('./config');
const { ValidationError } = require('./validate');

/**
 * Application-layer encryption envelope.
 *
 * WHAT THIS IS
 * ------------
 * Chat content is encrypted by the mod with AES-256-GCM before it is sent, and
 * decrypted by the receiving mod. This server relays the ciphertext. It has no
 * key and never decrypts anything — the code to do so does not exist here.
 *
 * This sits on top of TLS, it does not replace it. TLS still protects the
 * connection itself (and the parts that cannot be encrypted, like whose name is
 * being whispered to). Turning TLS off because messages are encrypted would be
 * a mistake.
 *
 * WHAT IT PROTECTS AGAINST
 * ------------------------
 *   - Someone who compromises the server, or steals a backup, or reads the disk.
 *   - Anyone who can read the server's logs.
 *   - A hosting provider poking at what is stored.
 *
 * WHAT IT DOES NOT PROTECT AGAINST
 * --------------------------------
 *   - Other players. The key ships inside the mod, so every user of the mod
 *     has it. Anyone willing to open the mod files can decrypt any message
 *     they can capture. This is obfuscation with respect to players, not
 *     secrecy. Do not tell your users their whispers are private from each
 *     other, because that would not be true.
 *   - Traffic analysis. The server still sees who talks to whom, when, how
 *     often, and roughly how much — that metadata is what makes routing work.
 *
 * WHAT IT COSTS
 * -------------
 *   - The server cannot moderate message content. Identity-based tools (bans,
 *     mutes, rate limits) all still work; reading a reported message does not.
 *   - Emotes are composed client-side, because the server cannot prepend a name
 *     to text it cannot read.
 *
 * FORMAT
 * ------
 *   { "v": 1, "iv": "<base64, 12 bytes>", "ct": "<base64, ciphertext||tag>" }
 *
 * 12-byte IV is the standard nonce size for GCM. The 16-byte authentication tag
 * is appended to the ciphertext, which is what Node's crypto and most other
 * implementations do by convention.
 */

const ENVELOPE_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Strict base64 — rejects whitespace and non-canonical padding. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function decodedLength(b64) {
  const len = b64.length;
  if (len % 4 !== 0) return -1;
  let padding = 0;
  if (b64.endsWith('==')) padding = 2;
  else if (b64.endsWith('=')) padding = 1;
  return (len / 4) * 3 - padding;
}

/**
 * Validate an envelope without decrypting it.
 * Returns { bytes } — the ciphertext size, used for rate-limit accounting.
 */
function validateEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(
      'This server requires encrypted messages. Expected an object of the form { v, iv, ct }.'
    );
  }
  if (value.v !== ENVELOPE_VERSION) {
    throw new ValidationError(
      `Unsupported envelope version ${value.v}; this server speaks version ${ENVELOPE_VERSION}.`
    );
  }
  if (typeof value.iv !== 'string' || typeof value.ct !== 'string') {
    throw new ValidationError('Envelope fields "iv" and "ct" must both be base64 strings.');
  }
  if (!BASE64_RE.test(value.iv) || !BASE64_RE.test(value.ct)) {
    throw new ValidationError('Envelope fields "iv" and "ct" must be valid base64.');
  }

  const ivLen = decodedLength(value.iv);
  if (ivLen !== IV_BYTES) {
    throw new ValidationError(
      `Envelope "iv" must decode to exactly ${IV_BYTES} bytes, got ${ivLen < 0 ? 'invalid base64' : ivLen}.`
    );
  }

  const ctLen = decodedLength(value.ct);
  if (ctLen < 0) {
    throw new ValidationError('Envelope "ct" is not valid base64.');
  }
  // At minimum: one byte of plaintext plus the GCM tag. Anything shorter cannot
  // be a real message and is almost certainly a malformed or probing client.
  if (ctLen < TAG_BYTES + 1) {
    throw new ValidationError('Envelope "ct" is too short to contain a message and its auth tag.');
  }
  if (ctLen > config.maxMessageBytes) {
    throw new ValidationError(
      `Encrypted message is ${ctLen} bytes; the limit is ${config.maxMessageBytes}.`,
      413
    );
  }

  return { bytes: ctLen };
}

/**
 * Accept either an envelope or plaintext, depending on server policy.
 * Returns { payload, bytes, encrypted }.
 *
 * `payload` is passed through untouched when encrypted: the server is a relay
 * for these bytes and must not alter them, or the receiver's authentication tag
 * check will fail.
 */
function normalizeContent(raw, { sanitizePlaintext }) {
  if (config.requireEncryption) {
    const { bytes } = validateEnvelope(raw);
    return { payload: { v: raw.v, iv: raw.iv, ct: raw.ct }, bytes, encrypted: true };
  }

  // Encryption not required. An envelope is still accepted and relayed as-is,
  // so a mixed fleet of clients works during a rollout.
  if (raw && typeof raw === 'object' && raw.v === ENVELOPE_VERSION) {
    const { bytes } = validateEnvelope(raw);
    return { payload: { v: raw.v, iv: raw.iv, ct: raw.ct }, bytes, encrypted: true };
  }

  const text = sanitizePlaintext(raw);
  return { payload: text, bytes: Buffer.byteLength(text, 'utf8'), encrypted: false };
}

module.exports = {
  ENVELOPE_VERSION,
  IV_BYTES,
  TAG_BYTES,
  validateEnvelope,
  normalizeContent,
  decodedLength,
};
