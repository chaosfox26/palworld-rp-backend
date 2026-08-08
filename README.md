# Palworld RP Backend

A standalone chat and roleplay-profile server for a Palworld UE4SS/PalSchema
mod. It never talks to Palworld's own servers, to Steam, to EOS, or to your game
host — it is an independent hub the mod connects to directly. Your Palworld
server keeps running untouched and unaware.

**Features:** local/emote/whisper/party/guild/global/custom-channel routing, cloud-saved
character profiles with `/who` search, server-side mute lists, and messages up to
100,000 characters so long-form roleplay is not cut off by the game's tiny input
cap.

**Encryption:** AES-256-GCM twice over — TLS on the wire, plus an application
envelope the server relays without holding a key. See **[ENCRYPTION.md](ENCRYPTION.md)**
for what each layer does and does not protect against.

---

## Install

One command for your platform. Each installs the prerequisites — Node.js, which
is what provides npm and npx — and then runs the npx install. Nothing needs to
be present beforehand.

**Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/chaosfox26/palworld-rp-backend/main/deploy/setup-linux.sh | sudo bash
```

**macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/chaosfox26/palworld-rp-backend/main/deploy/setup-macos.sh | bash
```

**Windows** — in an **Administrator** PowerShell:

```powershell
irm https://raw.githubusercontent.com/chaosfox26/palworld-rp-backend/main/deploy/setup-windows.ps1 | iex
```

Each one installs Node.js and Caddy, registers a service that starts at boot,
sets up HTTPS, opens the firewall, and prints the URL for the mod:

```
  Backend URL for the mod:

      https://212-28-190-199.sslip.io
```

Re-run any time to upgrade in place; your data and admin token are preserved.

### Already have Node.js?

Then you already have npx, and the setup script is just a wrapper around this:

```
npx -y github:chaosfox26/palworld-rp-backend
```

Note there is no word after the spec — npm reads a trailing bare word as the
program to run, so `npx <spec> install` tries to launch `/usr/bin/install`. The
CLI installs by default.

### Prefer to download a file?

[Install-Windows.bat](https://github.com/chaosfox26/palworld-rp-backend/raw/main/Install-Windows.bat)
double-clicks on Windows;
[Install-Mac-Linux.command](https://github.com/chaosfox26/palworld-rp-backend/raw/main/Install-Mac-Linux.command)
double-clicks on macOS. Same result, no terminal needed.

### After installing

A **`palworld-rp` command lands on your PATH**:

```
palworld-rp menu        interactive menu for everything below
palworld-rp doctor      check every layer, report what is broken
palworld-rp status      is it running?
palworld-rp url         print the backend URL again
palworld-rp update      re-fetch and reinstall
palworld-rp help        everything else
```

On Windows, open a **new** terminal first — PATH changes only apply to processes
started afterwards.

### HTTPS without a domain

On a **server with a public IP**, the installer derives a hostname from that IP
via sslip.io, verifies it resolves back to you, and obtains a real Let's Encrypt
certificate — publicly trusted, nothing to buy.

On a **home machine behind a router**, a public certificate is impossible: Let's
Encrypt cannot reach you to validate. Caddy issues its own instead. Still real
TLS with AES-256, but the mod must be told to trust the exported
`local-ca.crt`. The installer detects which case you are in and tells you which
it chose.

Using your own domain is better long term:

```bash
sudo DOMAIN=rp.yourdomain.com bash deploy/install.sh
```

The URL is also saved in `backend-url.txt` beside the config file.

### Docker instead

If you would rather run containers: `./start.sh` (Linux/macOS) or `start.bat`
(Windows). See **[DEPLOY.md](DEPLOY.md)**.

---

## Firewall

The installer opens 80 and 443 in `ufw` for you. If your host has a firewall in
its control panel — Contabo does — **you must open them there too**. That panel
is the single most common reason an install looks fine but HTTPS never comes up.

Port 80 is required even though your traffic uses 443: Let's Encrypt validates
over it, and renewals fail silently three months later without it.

Port 3000 should **not** be exposed. The app binds to loopback only, so Caddy is
the sole route in.

Why HTTPS matters here: passwords and every chat message cross the network. Over
plain HTTP anyone on the path can read all of it and log in as any of your
players. For a project whose whole point is a chat channel nobody else controls,
shipping it unencrypted would undercut the goal.

---

## Operating it

```
palworld-rp status
palworld-rp doctor
palworld-rp backup
```

Underneath, on Linux:

```bash
journalctl -u palworld-rp-backend -f                  # follow logs (structured JSON)
sudo systemctl restart palworld-rp-backend            # restart
```

Data lives in `/var/lib/palworld-rp-backend`, backed up daily to
`/var/backups/palworld-rp-backend` with 14 kept. Full detail in
**[DEPLOY.md](DEPLOY.md)**.

<details>
<summary>Docker equivalents</summary>

```bash
docker compose logs -f backend
docker compose ps
docker compose down
docker compose --profile tls up -d --build
```

Data lives in the `rp-data` Docker volume; it survives `down`, rebuilds and
reboots.

```bash
# Back up
docker run --rm -v palworld-rp-backend_rp-data:/data -v "$PWD":/out alpine \
  tar czf /out/rp-backup-$(date +%F).tar.gz -C /data .

# Restore
docker run --rm -v palworld-rp-backend_rp-data:/data -v "$PWD":/in alpine \
  sh -c "rm -rf /data/* && tar xzf /in/rp-backup-2026-08-07.tar.gz -C /data"
```

</details>

Restart on boot is handled either way — systemd for the native install,
`restart: unless-stopped` for Docker.

### Moderation

With `ADMIN_TOKEN` set:

```bash
A="Authorization: Bearer $ADMIN_TOKEN"
curl -H "$A" https://rp.example.com/admin/stats
curl -H "$A" https://rp.example.com/admin/online
curl -H "$A" -X POST https://rp.example.com/admin/ban/troublemaker \
     -H 'Content-Type: application/json' -d '{"reason":"spam"}'
```

A ban disconnects every one of that player's sessions immediately and blocks
re-login. Running a public chat server means you will eventually need this.

---

## Migrating from the first version

If you have the old `profiles/` folder where each file contained a plaintext
`_password`:

```bash
docker compose cp /path/to/old/profiles backend:/tmp/old-profiles
docker compose exec backend node scripts/migrate-from-v1.js /tmp/old-profiles
```

Existing passwords keep working. They were stored in plaintext before, so anyone
who had access to that disk has already seen them — tell players to change theirs.

---

## Tuning

Every knob is an environment variable in `.env`, documented inline there. The two
that matter most:

**`MAX_MESSAGE_BYTES`** (default 100000) — the biggest single message. This is
what "unlimited chat" actually means.

**`CHAT_BURST_BYTES` / `CHAT_REFILL_BYTES_PER_SEC`** — the chat budget. Cost is
charged as *message bytes × number of recipients*, i.e. what the message really
costs the server to deliver. A 50 KB emote heard by four nearby players costs
200 KB and sails through. The same text sent to 200 people in global costs 10 MB
and gets throttled. That asymmetry is deliberate: long-form local roleplay stays
unlimited, mass spam does not.

---

## Testing

```bash
npm install
npm run test:unit   # validation, storage, sessions, guilds, rate limiting — no deps needed
npm test            # full end-to-end: HTTP + WebSocket, spawns a real server
```

The end-to-end suite includes an ATTACK section for each vulnerability that was
present in the original implementation — path traversal, identity spoofing,
guild spoofing, channel crosstalk, rate-limit reset by reconnect. If you modify
the server, these are what stop you from quietly reintroducing a hole.

---

## Architecture

```
Palworld client + your UE4SS mod
        │  HTTPS (profiles, search, auth)
        │  WSS   (real-time chat)
        ▼
   Caddy :443  ──►  Node :3000  ──►  /var/lib/palworld-rp-backend
   (TLS, auto-renew)   (this app)      accounts/  profiles/  guilds/
```

Your Palworld game server is not in this diagram, on purpose. It never sees any
of this traffic and needs no changes.

| File | Role |
|---|---|
| `server.js` | wiring, graceful shutdown |
| `src/config.js` | every tunable, read from env |
| `src/validate.js` | name/message validation — the path traversal defence |
| `src/store.js` | accounts, profiles, atomic writes, search index |
| `src/auth.js` | session tokens |
| `src/guilds.js` | passcode-protected guilds |
| `src/ratelimit.js` | token buckets, fanout accounting |
| `src/rest.js` | HTTP routes |
| `src/chat.js` | Socket.IO routing |
| `src/envelope.js` | AES-256-GCM envelope validation (no key, no decryption) |
| `bin/palworld-rp.js` | the npx CLI — dispatches to the right platform installer |
| `deploy/` | per-platform installers, update, backup, uninstall, diagnostics |

See **API.md** for the full client contract and **DEPLOY.md** for native
deployment.

---

## Security notes, honestly

**Encryption:** AES-256-GCM in transit (TLS) and at the application layer, where
the server relays ciphertext it cannot read. The application key lives in the mod
— which means it protects your players from *you*, the host, but not from each
other, since every player has the mod. **[ENCRYPTION.md](ENCRYPTION.md)** is
explicit about this; do not describe it to users as end-to-end encryption.

**Handled:** passwords are scrypt-hashed with per-user salts and never stored or
served in plaintext; identity comes from a session token, never from client
input; profile names are strictly allow-listed so no request can escape the data
directory; rate limits are keyed to accounts and survive reconnects; guild and
channel membership is server-side; the container runs as a non-root user;
oversized bodies and messages are rejected before allocation.

**Not handled, by design:**

- *Position is client-reported.* A modified client can claim to be standing
  anywhere and read local chat from across the map. Fixing this would require
  the backend to talk to the game server, which is exactly what this
  architecture avoids. Treat `/s` and `/em` as semi-public.
- *No end-to-end encryption.* TLS protects messages in transit, but the server
  operator can read everything. If you host it, your players are trusting you.
  Say so plainly in your mod's description.
- *No content moderation.* Ban tools exist; automatic filtering does not. Running
  a public chat service means you are responsible for what happens on it.

**Your job as operator:** set a strong `ADMIN_TOKEN`, keep `docker compose pull`
and rebuilds current, take backups, and use HTTPS.

## License

MIT.
