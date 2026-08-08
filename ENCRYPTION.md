# Encryption

Two independent layers. Both are on by default.

| Layer | Algorithm | Protects against | Key held by |
|---|---|---|---|
| Transport (TLS) | AES-256-GCM | Anyone on the network path | Caddy, automatically |
| Application (envelope) | AES-256-GCM | The server operator, disk theft, logs | The mod only |

---

## Layer 1 — Transport

Every byte in both directions travels inside TLS: HTTPS for profiles and search,
WSS for chat. Same listener, same certificate, no unencrypted path. The Node
process binds to `127.0.0.1` only, so nothing can reach it except Caddy.

The server pins TLS 1.2 to AES-256-GCM. **TLS 1.3 cipher choice belongs to the
client** — Go, and therefore Caddy, does not expose it. On a 1.3 connection the
client picks from AES-256-GCM, AES-128-GCM and ChaCha20-Poly1305.

So if AES-256 specifically matters to you, the mod must pin it:

```
TLS_AES_256_GCM_SHA384
```

Check what is actually being negotiated:

```bash
sudo bash /opt/palworld-rp-backend/deploy/doctor.sh   # reports the live cipher
echo | openssl s_client -connect your-host:443 2>/dev/null | grep -E 'Protocol|Cipher'
```

Forcing AES-256 by disabling TLS 1.3 would be a downgrade, not an upgrade.
AES-128-GCM is not a weakness.

---

## Layer 2 — Application envelope

The mod encrypts message content before sending. The server relays the
ciphertext and **holds no key** — there is no decryption code in it at all.

### Envelope format

```json
{ "v": 1, "iv": "<base64, 12 bytes>", "ct": "<base64, ciphertext||tag>" }
```

- AES-256-GCM
- 12-byte random IV, **fresh for every single message**
- 16-byte authentication tag appended to the ciphertext

Send this object as `message` in `send_chat`, and as `fields` when writing a
profile. The server validates the shape and size, then passes the bytes through
untouched.

### Generate the key

```bash
node scripts/keygen.js
```

Put it in the mod. Never in the server's environment file.

### Reference implementation (Node)

```js
const crypto = require('node:crypto');
const KEY = Buffer.from('<base64 from keygen>', 'base64'); // 32 bytes

function seal(plaintext) {
  const iv = crypto.randomBytes(12);              // never reuse an IV
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final(), c.getAuthTag()]);
  return { v: 1, iv: iv.toString('base64'), ct: ct.toString('base64') };
}

function open(env) {
  const raw = Buffer.from(env.ct, 'base64');
  const tag = raw.subarray(raw.length - 16);
  const body = raw.subarray(0, raw.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(env.iv, 'base64'));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}
```

`d.final()` throws if the tag does not verify. Treat that as a hostile or
corrupted message and drop it — never display unverified plaintext.

### The one rule that actually matters

**Never reuse an IV with the same key.** GCM fails catastrophically on nonce
reuse: two messages under the same key and IV leak the XOR of their plaintexts,
and the forgery protection collapses entirely. Generate 12 fresh random bytes
per message from a real CSPRNG. Do not use a counter that resets when the game
restarts, and do not seed from the clock.

---

## What changes because content is encrypted

**Emotes are composed client-side.** The server cannot prepend a name to text it
cannot read. Encrypted emote frames carry `composeWithSender: true`; render
`sender + " " + decrypt(message)`. `sender` is still assigned by the server from
the session token, so it cannot be spoofed.

**Content moderation is impossible.** Bans, mutes, rate limits and reports all
still work — they key off identity, not text. But you cannot read a reported
message to judge it. Decide how you will handle reports before you need to.

**Search only sees names.** Account names stay in clear text because routing and
`/who` depend on them. If profile fields are encrypted, you cannot search inside
them.

**Metadata is not hidden.** The server sees who talks to whom, when, how often,
and roughly how much. That is what routing is made of.

---

## Honest limits

The key ships inside the mod. Every player has it. Anyone willing to open the
mod files can decrypt any message they capture.

So this layer protects your users **from whoever runs the server** — including
you, and including anyone who steals the disk or reads the logs. It does not
make whispers private between players.

Do not describe it to your users as end-to-end encryption, and do not tell them
their private messages are secret from other players. Both would be false, and
someone will eventually check.

If you want privacy that holds up between players, the key cannot be a shared
constant — it has to be per-conversation and negotiated between the
participants. That is a materially bigger design, and worth doing properly
rather than approximating.

---

## Turning it off

```ini
REQUIRE_ENCRYPTION=false
```

The server then accepts plaintext and still relays envelopes, which is what you
want mid-rollout while some clients have updated and some have not. TLS is
unaffected either way.
