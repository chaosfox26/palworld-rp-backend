'use strict';

/**
 * Generate the shared AES-256 key that goes inside the mod.
 *
 *   node scripts/keygen.js
 *
 * The server never needs this key and must never be given it — the whole point
 * is that the server cannot read message content. Put it in the mod only.
 */

const crypto = require('node:crypto');

const key = crypto.randomBytes(32); // 256 bits

console.log(`
Shared AES-256 key for the mod
==============================

  base64  ${key.toString('base64')}
  hex     ${key.toString('hex')}

Put this in the mod's source or its bundled config. Do NOT put it in the
server's environment file, and do NOT commit it to a public repository — not
because that would break the encryption model (every player has it anyway), but
because rotating it later means every client must update in lockstep.

Read this before you rely on it
-------------------------------
Every copy of the mod carries this key, so every player can decrypt any message
they can capture. What this protects is the SERVER side: whoever runs the
backend, or steals its disk, or reads its logs, sees only ciphertext.

It does not make whispers private between players. Do not tell your users that
it does.

Rotating the key
----------------
Changing it makes every stored profile and every in-flight message unreadable to
clients on the old key. There is no migration path that does not involve
shipping a mod update to everyone first. Plan for that before you need it.
`);
