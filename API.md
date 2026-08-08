# API reference

Everything the UE4SS client mod needs. Base URL is whatever the player puts in
the mod's "Backend URL" setting.

All request and response bodies are JSON. Errors are always
`{ "error": "human readable sentence" }` — safe to show directly in chat.

## Authentication model

1. `POST /auth/register` or `POST /auth/login` → `{ token, expiresAt }`
2. Send `Authorization: Bearer <token>` on authenticated REST calls.
3. Open the WebSocket with `{ auth: { token } }`.

The socket's character name comes from the token. There is no field anywhere
that lets a client state who it is. If the token expires (default 12 hours) the
mod should silently re-login using the stored password and reconnect.

---

## REST

### `GET /health`
`{ "ok": true, "uptimeSeconds": 1234 }`

### `GET /info`
Server capabilities. Call this before connecting so the mod can size its input
box and show whether registration is open.

```json
{
  "service": "palworld-rp-backend",
  "apiVersion": 1,
  "limits": { "maxMessageBytes": 100000, "localChatRadius": 3000, "...": "..." },
  "playersOnline": 7,
  "registrationOpen": true
}
```

### `POST /auth/register`
Body: `{ "name": "Aely", "password": "at least 8 chars" }`
→ `201 { "name": "aely", "token": "...", "expiresAt": 1234567890 }`
→ `409` name taken · `400` bad name or weak password · `429` too many from this IP

### `POST /auth/login`
Body: `{ "name": "Aely", "password": "..." }` → `200 { name, token, expiresAt }`
→ `401` wrong name **or** password (deliberately indistinguishable) · `403` banned

### `POST /auth/logout` · auth
Invalidates the current token.

### `POST /auth/password` · auth
Body: `{ "currentPassword": "...", "newPassword": "..." }`
Logs out every session on success, including the caller's.

### `GET /profile/:name`
Public — no token needed. This is the second half of `/who`.

```json
{
  "name": "aely",
  "updatedAt": 1738900000000,
  "fields": { "title": "Wandering Tamer", "bio": "...", "age": 24 },
  "online": true
}
```
`fields` is whatever the mod chose to store — the server does not care about its
shape, so you can design the TRP3-style layout entirely client-side.

### `POST /profile/:name` · auth
Body: `{ "fields": { ... } }` (a bare object is also accepted).
You may only write your own name; anything else is `403`.
Keys named `password`, `_password`, `token`, `salt` or `hash` are rejected —
profiles are world-readable and must never carry credentials.

### `DELETE /profile/:name` · auth
Deletes your own profile. The account and name remain yours.

### `GET /search/:query`
Powers `/who`. Prefix matches first, then substring matches.

```json
{
  "query": "ae",
  "results": [ { "name": "aely", "online": true }, { "name": "aerith", "online": false } ],
  "truncated": false
}
```
Client logic: exactly one result → fetch that profile and display it. More than
one → list the names. Zero → "No profiles found."

### Mutes · auth
- `GET /mutes` → `{ "mutes": ["someone"] }`
- `POST /mutes/:name` → adds
- `DELETE /mutes/:name` → removes

Enforced server-side at routing time: a muted player's messages are never sent
to you at all, so muting also saves your bandwidth.

### Guilds · auth
- `POST /guild` body `{ "name": "moonlight", "passcode": "..." }` — create and join
- `POST /guild/:name/join` body `{ "passcode": "..." }`
- `POST /guild/leave`

Guilds are backend-side groups with a shared passcode, not Palworld's in-game
guilds. This backend never talks to the game server, so it has no way to read
real guild membership.

### Channels · auth
- `GET /channels` → `{ "channels": ["ooc", "trade"] }`
- `POST /channels/:name` — join
- `DELETE /channels/:name` — leave

Channels are addressed **by name**. The `/1`–`/10` slots are purely a client-side
convenience: store the player's slot→name mapping in the mod's config and send
the resolved name.

### Admin · admin token
Disabled unless `ADMIN_TOKEN` is set. Send it as `Authorization: Bearer <token>`.

- `GET /admin/stats`
- `GET /admin/online`
- `POST /admin/ban/:name` body `{ "reason": "..." }` — disconnects them immediately
- `POST /admin/unban/:name`
- `DELETE /admin/account/:name`

---

## WebSocket (Socket.IO v4)

Connect with `{ auth: { token } }`. A missing or invalid token is refused at the
handshake, before any event is processed.

### Server → client

| Event | Payload |
|---|---|
| `ready` | `{ name, guild, channels, party, limits }` — sent immediately on connect |
| `chat_receive` | `{ type, sender, message, at, ... }` |
| `chat_error` | `{ message, retryAfterSeconds? }` — show this in chat |
| `membership` | `{ guild, channels }` — another session changed your memberships |
| `party` | `{ code, leader, members }` — your party changed; `code: null` means you left |
| `who_result` | same shape as `GET /search/:query`; only sent if you called `who` without an ack callback |
| `force_disconnect` | `{ reason }` — banned, deleted, or password changed |
| `server_shutdown` | `{ message }` — restarting; reconnect shortly |

`chat_receive.type` is one of `say`, `emote`, `global`, `guild`, `party`,
`channel`, `whisper_in`, `whisper_out`. Channel messages also carry `channel`;
guild messages carry `guild`; party messages carry `party` (the code);
`whisper_out` carries `target` instead of `sender`.

### Client → server

**`update_position`** — `{ x, y, z }`, a few times a second. Drives `/s` and `/em`.

**`send_chat`** — the packet shape per command:

| Slash command | Packet |
|---|---|
| `/s Hello` | `{ "command": "say", "message": "Hello" }` |
| `/e` or `/em waves.` | `{ "command": "emote", "message": "waves." }` |
| `/w` or `/whisper Aiden Hey!` | `{ "command": "whisper", "target": "Aiden", "message": "Hey!" }` |
| `/p Ready?` | `{ "command": "party", "message": "Ready?" }` |
| `/g Guild check` | `{ "command": "guild", "message": "Guild check" }` |
| `/gl Anyone up?` | `{ "command": "global", "message": "Anyone up?" }` |
| `/1 LFG raid` | `{ "command": "channel", "channel": "ooc", "message": "LFG raid" }` |

Emote composition depends on whether content is encrypted. In plaintext mode the
server composes it: send `"waves."` and recipients get `"aely waves."`. With
`REQUIRE_ENCRYPTION` on the server cannot read the text, so the frame carries
`composeWithSender: true` and the client renders `sender + " " + decrypt(message)`.
Either way `sender` comes from the session token and cannot be spoofed.

**`who`** — `{ query: "ae" }` with an optional acknowledgement callback; same
result shape as `GET /search/:query`. Saves an HTTP round trip.

### How routing guarantees privacy

Every scope resolves to an explicit list of recipient sockets before anything is
sent. There is no broadcast-then-filter step anywhere in the server, and no
`socket.broadcast` call — a whisper is written only to the target's own
connections. A bystander sharing your guild, your channel, your party and your
exact map position still receives nothing, because they were never in the list.

Target name matching is case-insensitive (`/w Aiden` and `/w aiden` are the
same person). If the target is offline or unknown, the message is refused and
nothing is transmitted to anyone.

The server does still see the *metadata*: that `aely` whispered `aiden`, when,
and roughly how long the message was. Routing cannot work without that. With
`REQUIRE_ENCRYPTION` on, the content itself is ciphertext the server cannot
read.

### Parties (`/p`)

Parties are ephemeral: created on demand, identified by a six-character invite
code, and gone as soon as the last member disconnects or the server restarts.
Guilds are the persistent equivalent. Codes use an alphabet with no `0`, `O`,
`1` or `I`, so they survive being read aloud over voice chat.

All four take an optional acknowledgement callback, which is the easiest way to
use them:

```js
socket.emit('party_create', {}, (res) => {
  // { ok: true, code: "K7QM2X", leader: "aely", members: ["aely"] }
});

socket.emit('party_join', { code: 'K7QM2X' }, (res) => {
  // { ok: true, code, leader, members } or { ok: false, error }
});

socket.emit('party_leave', {}, (res) => { /* { ok: true } */ });
socket.emit('party_info',  {}, (res) => { /* current party, or code: null */ });
```

Whenever membership changes, every member receives a `party` event, so your
party frame can just re-render from that.

Notes for the mod:

- You can only be in one party at a time. Joining a second automatically leaves
  the first — no need to call `party_leave` yourself.
- Codes are case-insensitive on join; the server upper-cases them.
- Leaving is by last **session**, not last socket. A player with two clients
  open, or reconnecting after a blip, stays in the party.
- If the leader leaves, leadership passes to the longest-standing member
  automatically.
- Suggested command surface: `/party new`, `/party join <code>`, `/party leave`,
  `/party` to show the current roster.

---

## Client implementation notes

**Store the token, not just the password.** Keep the password only if the player
ticks "remember me", and keep it in the mod's own config file. On launch: try the
saved token, fall back to login, and prompt only if that fails.

**Handle `chat_error` visibly.** Rate limits, oversized messages and unjoined
channels all arrive this way. Silently swallowing them makes the mod feel broken.

**Position is client-reported and therefore not trustworthy.** A modified client
can claim to stand anywhere and listen to local chat from across the map. That is
unavoidable without server-side game integration, which this design deliberately
avoids. Treat `/s` and `/em` as semi-public; use whispers or a passcode-protected
channel for anything actually private, and say so in your mod's documentation.

**Reconnect with backoff.** Socket.IO does this by default; make sure you re-send
`update_position` after reconnecting, since the server starts you at the origin.
