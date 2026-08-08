# 🎭 Palworld RP Backend v2.3.2

**A private chat and roleplay-profile server for a Palworld UE4SS/PalSchema mod.**

Palworld's built-in chat is tiny, global, and forgets everything the moment you
log out. This gives your roleplay server proper channels — say, emote, whisper,
party, guild, global and custom rooms — messages up to **100,000 characters**,
character profiles that live in the cloud, and a searchable `/who` directory.

It never talks to Palworld's servers, to Steam, to EOS, or to your game host.
It is a separate server your mod connects to directly. **Your Palworld server
keeps running untouched and completely unaware of it.**

---

## 🚀 1. Install It (start here)

You need a computer that stays on — a **VPS is ideal** (Contabo, Hetzner,
DigitalOcean, around $5/month), or a spare PC at home.

**You do not need to install anything first.** No Node, no npm, no git. The
command below installs everything for you.

Open a terminal on that machine, paste **one** line, press Enter:

| Your server runs | Paste this |
| :--- | :--- |
| 🐧 **Linux** | `curl -fsSL https://raw.githubusercontent.com/chaosfox26/palworld-rp-backend/main/deploy/setup-linux.sh \| sudo bash` |
| 🍎 **macOS** | `curl -fsSL https://raw.githubusercontent.com/chaosfox26/palworld-rp-backend/main/deploy/setup-macos.sh \| bash` |
| 🪟 **Windows** | `irm https://raw.githubusercontent.com/chaosfox26/palworld-rp-backend/main/deploy/setup-windows.ps1 \| iex` |

> 🪟 **Windows:** this must be an **Administrator** PowerShell. Click Start, type
> `PowerShell`, right-click it, choose **Run as administrator**.

### What that one command actually does

| Step | What happens | Why you need it |
| :--- | :--- | :--- |
| 1️⃣ | Installs **Node.js** | The language the server is written in. Brings `npm` and `npx` with it. |
| 2️⃣ | Installs **Caddy** | A web server that gets you a free HTTPS certificate automatically. |
| 3️⃣ | Creates a **locked-down user** | The server runs as `palrp`, which has no password and no shell. If it were ever hacked, the attacker gets almost nothing. |
| 4️⃣ | Gets an **HTTPS certificate** | Free, from Let's Encrypt. No domain needed — it builds a hostname from your IP. |
| 5️⃣ | Opens **ports 80 and 443** | The doors your players connect through. |
| 6️⃣ | Starts it **at boot** | Reboot the machine and it comes back on its own. |
| 7️⃣ | Prints your **Backend URL** | Paste this into the mod. This is the only thing you need to keep. |

When it finishes you'll see:

```
  Paste this into the mod's Backend URL setting:

      https://212-28-190-199.sslip.io
```

**That URL is the whole point.** Copy it into the mod's settings and you're done.

### ⚠️ One thing that catches nearly everyone

If you rent a VPS, it almost certainly has a **second firewall in its web
control panel**, separate from the one on the machine. **Ports 80 and 443 must
be opened there too**, or your certificate never arrives and nothing works.

Contabo, Hetzner and OVH all do this. It is the single most common reason an
install looks perfect but HTTPS never comes up.

> Port **80** is required even though players connect on **443**. Let's Encrypt
> uses port 80 to prove you own the address. Close it and your certificate
> silently fails to renew three months later.

### Prefer clicking to typing?

| Platform | Download | How |
| :--- | :--- | :--- |
| 🪟 Windows | [Install-Windows.bat](https://github.com/chaosfox26/palworld-rp-backend/raw/main/Install-Windows.bat) | Double-click, approve the UAC prompt |
| 🍎 macOS | [Install-Mac-Linux.command](https://github.com/chaosfox26/palworld-rp-backend/raw/main/Install-Mac-Linux.command) | Double-click. First time, **right-click → Open** (Gatekeeper) |
| 🐧 Linux | [Install-Mac-Linux.command](https://github.com/chaosfox26/palworld-rp-backend/raw/main/Install-Mac-Linux.command) | `chmod +x` it, then run it |

### Already have Node.js?

Then you already have `npx`, and the setup script is only a wrapper around this:

```
npx -y github:chaosfox26/palworld-rp-backend
```

> ⚠️ **Nothing goes after the spec.** `npx <spec> install` makes npm think
> `install` is the *program to run*, so it launches `/usr/bin/install` and fails
> with `install: missing file operand`. With no word after it, the CLI installs
> by default.

---

## 🧭 2. Quick Reference — "where do I type this?"

**You never need to `cd` anywhere.** The installer puts the command on your
system PATH, so it works from any folder. Just open a terminal and type it.

| What you want | Type this | Run it from |
| :--- | :--- | :--- |
| 🎛️ **Open the menu** | `palworld-rp menu` | 📍 Anywhere |
| 🩺 Something is broken | `palworld-rp doctor` | 📍 Anywhere |
| 🔗 Get my Backend URL | `palworld-rp url` | 📍 Anywhere |
| ✅ Is it running? | `palworld-rp status` | 📍 Anywhere |
| 💾 Back up now | `palworld-rp backup` | 📍 Anywhere |
| ⬆️ Update it | `palworld-rp update` | 📍 Anywhere |
| ❓ What else can it do? | `palworld-rp help` | 📍 Anywhere |

Both `palworld-rp` and `palworld-rp-backend` work — they are the same command.
The short one is less typing.

### 😕 "command not found"

| Cause | Fix |
| :--- | :--- |
| 🪟 You're on Windows and just installed | Close the terminal and open a **new** one. PATH only updates for new processes. |
| 🐧 You're on Linux/macOS and just installed | `hash -r`, or open a new terminal. |
| It still isn't found | Run it by full path: `sudo /opt/palworld-rp-backend/bin/palworld-rp.js menu` |
| Nothing works | It probably isn't installed. Re-run the install command from §1 — it's safe to run twice. |

### 📁 Where everything lives

You don't need these day to day, but here they are for when something goes wrong.

| What | Linux | macOS | Windows |
| :--- | :--- | :--- | :--- |
| ⚙️ **Your settings + admin token** | `/etc/palworld-rp-backend/env` | `/usr/local/etc/palworld-rp-backend/env` | `%ProgramData%\PalworldRPBackend\config\env` |
| 🔗 **Your Backend URL** | `/etc/palworld-rp-backend/backend-url.txt` | `/usr/local/etc/palworld-rp-backend/backend-url.txt` | `%ProgramData%\PalworldRPBackend\config\` |
| 💾 **Player data** | `/var/lib/palworld-rp-backend` | `/usr/local/var/palworld-rp-backend` | `%ProgramData%\PalworldRPBackend\data` |
| 📦 **The program itself** | `/opt/palworld-rp-backend` | `/usr/local/opt/palworld-rp-backend` | `%ProgramData%\PalworldRPBackend\app` |
| 🗄️ **Backups** | `/var/backups/palworld-rp-backend` | `/usr/local/var/backups/palworld-rp-backend` | `%ProgramData%\PalworldRPBackend\backups` |

Two commands you might actually want to type by hand:

```bash
# See your admin token (for signing in to the web panel)
sudo grep ADMIN_TOKEN /etc/palworld-rp-backend/env

# Watch the server log live, press Ctrl-C to stop
sudo journalctl -u palworld-rp-backend -f
```

---

## 🎮 3. Chat Command Mapping Table

This is the translation layer. The player types a slash command, your mod turns
it into a **message type**, and the server decides **who receives it**.

The server never guesses — it routes purely on `type`, and it decides recipients
itself so a modified client cannot eavesdrop on a channel it does not belong to.

| Player types | Mod sends `type` | Who actually receives it | Notes |
| :--- | :--- | :--- | :--- |
| `/s Hello there` | `say` | Players within **3,000 units** | Ordinary local speech. Range is configurable. |
| `/em waves slowly` | `emote` | Players within **3,000 units** | Rendered as *"Player waves slowly"*. |
| `/w Player2 psst` | `whisper` | **Only Player2.** Nobody else. | Delivered to that account's sockets and no others. |
| `/p Regrouping` | `party` | Everyone in your party | Parties are temporary and vanish when empty. |
| `/g For the guild` | `guild` | Everyone in your guild | You must have joined a guild first. |
| `/global Anyone about?` | `global` | **Every player online** | Costs the most against your rate limit. |
| `/c tavern Evening` | `channel` | Everyone in channel `tavern` | Custom rooms. Up to 10 per account. |
| `/who blacksmith` | *(query)* | Just you | Searches every character profile. |

### 🔒 Why whisper is genuinely private

`/w` does not broadcast-and-filter. The server resolves the target account,
collects **only that player's open sockets**, and writes to exactly those. There
is no `socket.broadcast` call anywhere in the codebase, and the only server-wide
`emit` is the shutdown notice. A player running a modified mod cannot subscribe
to somebody else's whispers, because nothing is ever sent to them to intercept.

### ⚠️ Where local chat is *not* private

Your position is reported by your own game client. A modified client can claim
to be standing anywhere and read `/s` and `/em` from across the map. Fixing this
would require the backend to talk to your Palworld server, which is exactly what
this design avoids. **Treat `/s` and `/em` as semi-public.**

---

## 🖥️ 4. Running Your Server

After installing, you get a **`palworld-rp`** command. If you remember only one
thing, remember this:

```
palworld-rp menu
```

That opens an arrow-key menu covering everything below, so you never have to
memorise commands.

### Command mapping table

| Command | What it does | When you'd use it |
| :--- | :--- | :--- |
| `palworld-rp menu` | Interactive menu for everything here | Any time. Start here. |
| `palworld-rp doctor` | Checks **every layer** and names what is broken | 🩺 First thing when anything misbehaves |
| `palworld-rp status` | Is the server running? | Quick sanity check |
| `palworld-rp url` | Prints your Backend URL again | You lost the URL |
| `palworld-rp backup` | Saves a snapshot now | Before you change anything risky |
| `palworld-rp update` | Fetches the latest version and reinstalls | A new version is out |
| `palworld-rp keygen` | Generates the AES-256 key for the mod | Setting up the mod |
| `palworld-rp uninstall` | Removes the service, **keeps your data** | Moving to another machine |
| `palworld-rp help` | Lists everything | You forgot a command |

> 💡 Add `--dry-run` to any command to see what it *would* do without doing it.
> 🪟 On Windows, open a **new** terminal after installing or the command won't be found yet.

### 🎛️ The web control panel

There's a full graphical panel: players and bans, service health, settings,
backups and logs.

It listens on **127.0.0.1:8787** and is deliberately **not reachable from the
internet**. To open it from your own computer, forward the port over SSH:

```bash
ssh -L 8787:127.0.0.1:8787 you@your-server
```

Then open **http://localhost:8787** and sign in with your admin token
(`palworld-rp menu` → *Open the admin panel* prints both for you).

| Tab | What you can do there |
| :--- | :--- |
| 📊 **Overview** | Players online, uptime, and the live state of the server and Caddy — with restart buttons |
| 👥 **Players** | Ban with a reason, kick, unban, or delete an account |
| ⚙️ **Settings** | Change the tunables below, with their limits explained |
| 💾 **Backups** | Back up now, and see what you already have |
| 📜 **Logs** | The last N lines from the server or Caddy |

**Why it isn't on a public URL:** an admin login page on a public address gets
found through certificate transparency logs and attacked within hours. Having no
public login form at all is a stronger position than having a well-defended one.

Full detail in **[ADMIN.md](ADMIN.md)**.

---

## ⚙️ 5. Settings Mapping Table

Everything here is editable **live in the panel** — no file editing, no root.

| Setting | Default | Allowed | Takes effect | What it controls |
| :--- | :--- | :--- | :--- | :--- |
| `MAX_MESSAGE_BYTES` | 100000 | 1,024 – 1,000,000 | 🔄 restart | Biggest single message. This is what "unlimited chat" means. |
| `CHAT_BURST_BYTES` | — | 1,024 – 100,000,000 | 🔄 restart | How much a player can send at once before throttling |
| `CHAT_REFILL_BYTES_PER_SEC` | — | 128 – 10,000,000 | 🔄 restart | How fast that allowance refills |
| `LOCAL_CHAT_RADIUS` | 3000 | 100 – 100,000 | 🔄 restart | How far `/s` and `/em` carry |
| `MAX_PARTY_SIZE` | 8 | 2 – 64 | 🔄 restart | Players per party |
| `MAX_CHANNELS_PER_ACCOUNT` | 10 | 1 – 100 | 🔄 restart | Custom channels one player may join |
| `MIN_PASSWORD_LENGTH` | 8 | 8 – 128 | 🔄 restart | Applies to new passwords only |
| `REGISTRATION_OPEN` | on | on / off | ⚡ live | Turn **off** to stop new signups during a spam wave |
| `REQUIRE_ENCRYPTION` | on | on / off | 🔄 restart | Require AES-256 envelopes. **Leave this on.** |

### 🚫 What the panel deliberately *cannot* change

The admin token, your domain, TLS mode, the listen ports, the data directory,
and the panel's own bind address. Those live only in the root-owned env file.

The server runs as an unprivileged user that **cannot write its own config**.
That is what stops a compromised server from handing itself a new admin token.
The worst a stolen panel session can do is make your server annoying — not let
someone in.

### 📈 How the rate limit actually works

Cost is charged as **message bytes × number of recipients** — what the message
really costs the server to deliver.

| Example | Recipients | Cost | Result |
| :--- | :--- | :--- | :--- |
| 50 KB emote heard by 4 nearby players | 4 | 200 KB | ✅ Sails through |
| The same 50 KB sent to 200 people in global | 200 | 10 MB | 🛑 Throttled |

That asymmetry is deliberate: **long-form local roleplay stays unlimited, mass
spam does not.**

---

## 🗄️ 6. Data Schema (what's on disk)

Everything lives in one directory — `/var/lib/palworld-rp-backend` on Linux.
Plain JSON files, one per player. No database to install or maintain.

```
data/
├── accounts/<name>.account     🔒 secrets: password hash, mutes, guild, ban state
├── profiles/<name>.profile     📖 public: the character sheet /who searches
├── guilds/<name>.guild         🏰 guild roster and passcode hash
└── settings.json               ⚙️ overrides written by the admin panel
```

```jsonc
// accounts/player.account — never served to any player
{
  "name": "player",
  "salt": "…",                  // unique per account
  "hash": "…",                  // scrypt. The password itself is never stored
  "createdAt": 1786163439000,
  "guild": "wanderers",         // or null
  "mutes": ["spammer1"],        // this player's personal mute list
  "channels": ["tavern"],
  "banned": false,
  "banReason": ""
}

// profiles/player.profile — public, returned by /profile and /who
{
  "name": "player",
  "displayName": "Player",
  "pronouns": "she/her",
  "occupation": "Blacksmith",
  "appearance": "Soot-stained apron, copper hair",
  "backstory": "…",             // free-form, up to 256 KB total
  "updatedAt": 1786163439000
}
```

**The split is deliberate.** The old design kept the password inside the profile
and deleted it before responding — one forgotten line away from leaking every
password on the server. Secrets and public data now live in separate files, so
that mistake is not possible.

---

## 🔌 7. API Map (for writing the mod)

### HTTP endpoints

| Method | Path | Auth | Purpose |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | — | Is it alive? Returns limits and encryption settings |
| `GET` | `/info` | — | Server capabilities |
| `POST` | `/auth/register` | — | Create an account |
| `POST` | `/auth/login` | — | Get a session token |
| `POST` | `/auth/logout` | 🔑 | Invalidate this session |
| `POST` | `/auth/password` | 🔑 | Change password |
| `GET` | `/profile/:name` | — | Read a character sheet |
| `POST` | `/profile/:name` | 🔑 | Write **your own** sheet |
| `GET` | `/search/:query` | 🔑 | The `/who` directory search |
| `GET` `POST` `DELETE` | `/mutes` `/mutes/:name` | 🔑 | Personal mute list |
| `GET` `POST` `DELETE` | `/channels` `/channels/:name` | 🔑 | Custom channel membership |
| `POST` | `/guild` `/guild/:name/join` `/guild/leave` | 🔑 | Guild management |
| `GET` | `/admin/stats` `/admin/online` | 🛡️ | Moderation read-only |
| `POST` | `/admin/ban/:name` `/admin/unban/:name` | 🛡️ | Ban and unban |
| `DELETE` | `/admin/account/:name` | 🛡️ | Delete an account |

🔑 = session token · 🛡️ = admin token

### WebSocket events

| Direction | Event | Meaning |
| :--- | :--- | :--- |
| 📤 Mod → Server | `send_chat` | Send a message. Carries `type` from the table in §2 |
| 📤 Mod → Server | `who` | Search profiles |
| 📤 Mod → Server | `party_create` `party_join` `party_leave` `party_info` | Party management |
| 📥 Server → Mod | `chat_receive` | A message for you |
| 📥 Server → Mod | `chat_error` | Rejected — rate limit, bad channel, unknown target |
| 📥 Server → Mod | `ready` | Connected and authenticated |
| 📥 Server → Mod | `party` `membership` | Your party or guild changed |
| 📥 Server → Mod | `who_result` | Search results |
| 📥 Server → Mod | `force_disconnect` | You were banned or kicked |
| 📥 Server → Mod | `server_shutdown` | Restarting — reconnect shortly |

Full request and response shapes in **[API.md](API.md)**.

---

## 🗂️ 8. File Map

| File | Role |
| :--- | :--- |
| `server.js` | Wiring and graceful shutdown |
| `src/config.js` | Every tunable, read from the environment |
| `src/validate.js` | Name and message validation — **the path-traversal defence** |
| `src/store.js` | Accounts, profiles, atomic writes, search index |
| `src/auth.js` | Session tokens |
| `src/guilds.js` | Passcode-protected guilds |
| `src/ratelimit.js` | Token buckets with fanout accounting |
| `src/rest.js` | HTTP routes |
| `src/chat.js` | **Message routing.** Decides who receives what |
| `src/envelope.js` | AES-256-GCM envelope validation — no key, no decryption |
| `src/settings.js` | The runtime-editable allowlist |
| `src/admin.js` | The loopback-only admin panel |
| `src/admin-ui.html` | The panel itself, one self-contained file |
| `bin/palworld-rp.js` | The CLI |
| `bin/menu.js` | The interactive menu |
| `deploy/setup-*.sh` `setup-windows.ps1` | The three one-liner installers |
| `deploy/install*.sh` `install-windows.ps1` | The real per-platform installers |
| `deploy/doctor.sh` | The diagnostic that checks every layer |

---

## 🩺 9. Troubleshooting Table

Every one of these is a real error somebody has hit.

| You see | What it means | Fix |
| :--- | :--- | :--- |
| `install: missing file operand` | You put a word after the npx spec, so npm ran `/usr/bin/install` | Drop the trailing word: `npx -y github:chaosfox26/palworld-rp-backend` |
| `ERROR: You must supply a command` | The **deprecated standalone npx** package is shadowing npm's built-in one | `sudo npm uninstall -g npx` then `hash -r` |
| **Install hangs at "Installing Caddy"** | `needrestart` is showing an invisible "restart which services?" prompt, or `unattended-upgrades` holds the apt lock | Ctrl-C, then re-run with `sudo NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1 DEBIAN_FRONTEND=noninteractive bash /tmp/setup.sh`. Fixed for good in v2.3.2. |
| `open /var/log/caddy/access.log: permission denied` | Caddy can't write its log, so it never starts | `sudo chown -R caddy:caddy /var/log/caddy` then restart Caddy |
| HTTPS never comes up | Usually the **VPS control-panel firewall**, not the server | Open 80 **and** 443 in your host's web panel. Then `palworld-rp doctor` |
| `Could not read backend-url.txt` | The config directory isn't readable by your user | `sudo chmod 0755 /etc/palworld-rp-backend` |
| `TLS_AES_128_GCM_SHA256` in doctor | On TLS 1.3 the **client** picks the cipher — the server cannot force it | Pin `TLS_AES_256_GCM_SHA384` in the mod. Chat payloads are AES-256 regardless |
| Mod refuses to connect (home install) | You got a local certificate, not a public one | Ship `config/local-ca.crt` with the mod so it trusts your server |
| Node "not recognised" right after installing | PATH only updates for **new** processes | Close the terminal, open a new one |

**When in doubt: `palworld-rp doctor`.** It checks files, permissions, the
service, port binding, Caddy, DNS, the certificate, the cipher, the firewall and
backups — and names the one layer that is actually broken.

> ⚠️ **Enabling `ufw` can lock you out of your own server.** Always
> `sudo ufw allow OpenSSH` *before* `sudo ufw enable`, and keep a second
> connection open until you've confirmed you can still get back in.

---

## 🛡️ 10. Security, Honestly

**Encryption is AES-256-GCM twice over.** TLS on the wire, plus an application
envelope the server relays without holding a key.

**What that second layer does and does not do.** The key lives in the mod, which
every player has. So it protects your players from **you, the host** — you
cannot read their messages off your own disk or logs. It does **not** protect
them from **each other**, because anyone can extract the key from the mod.
Please don't describe it to your players as end-to-end encryption. Details in
**[ENCRYPTION.md](ENCRYPTION.md)**.

**Handled:** passwords are scrypt-hashed with per-account salts and never
stored or served in plaintext · identity always comes from a session token,
never from anything the client claims · profile names are strictly allow-listed
so no request can escape the data directory · rate limits are keyed to accounts
and survive reconnects · guild and channel membership is decided server-side ·
the service runs as an unprivileged user that cannot modify its own code.

**Not handled, by design:** position is client-reported, so `/s` and `/em` are
semi-public · the server operator can read everything at the TLS layer · there
is no automatic content filtering, only ban tools.

**Your job as the operator:** keep a strong `ADMIN_TOKEN`, run
`palworld-rp update` occasionally, take backups, and tell your players honestly
what you can and cannot see.

---

## 📚 More Documentation

| Document | For |
| :--- | :--- |
| **[INSTALL.md](INSTALL.md)** | Every install path, all three platforms, in depth |
| **[ADMIN.md](ADMIN.md)** | The panel and the menu, and the privilege model |
| **[API.md](API.md)** | Full client contract for writing the mod |
| **[ENCRYPTION.md](ENCRYPTION.md)** | Exactly what each encryption layer protects |
| **[DEPLOY.md](DEPLOY.md)** | Native deployment, Docker, migrating old data |
| **[GITHUB.md](GITHUB.md)** | Publishing your own copy |

---

## 🧪 Testing

```bash
npm install
npm run test:unit   # validation, storage, sessions, guilds, rate limits — no deps needed
npm test            # full end-to-end: HTTP + WebSocket against a real server
```

The end-to-end suite includes an **ATTACK section** for every vulnerability
present in the original implementation — path traversal, identity spoofing,
guild spoofing, channel crosstalk, rate-limit reset by reconnect. If you modify
the server, those are what stop you quietly reintroducing a hole.

---

## 🏗️ Architecture

```
   Palworld client + your UE4SS mod
            │  HTTPS  (profiles, search, login)
            │  WSS    (real-time chat)
            ▼
   ┌──────────────────┐        ┌──────────────────┐
   │   Caddy  :443    │───────▶│   Node   :3000   │
   │  TLS, auto-renew │        │    this app      │
   └──────────────────┘        └────────┬─────────┘
                                        ▼
                          /var/lib/palworld-rp-backend
                          accounts/  profiles/  guilds/
```

Your Palworld game server is **not in this diagram, on purpose**. It never sees
any of this traffic and needs no changes.

---

## 📄 License

MIT.
