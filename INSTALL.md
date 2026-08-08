# Install

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

### Installing from a fork or a branch

Every script honours these:

```bash
REPO_OWNER=someone-else BRANCH=dev curl -fsSL https://raw.githubusercontent.com/chaosfox26/palworld-rp-backend/main/deploy/setup-linux.sh | sudo bash -s
```

---

## Before you start

Installing a system service needs administrator rights on every platform. On
Linux and macOS the CLI elevates itself with `sudo` and asks for your password.
On Windows it cannot — UAC opens a separate window, so you would lose sight of
the install — and it tells you to start an Administrator PowerShell instead.

**Windows:** open PowerShell **as Administrator** (Start → type PowerShell →
right-click → Run as Administrator). The installer needs it to install software,
open the firewall and register a boot service. It will not silently elevate
itself, because UAC opens a new window and you would lose sight of the install.

**macOS:** you need Homebrew. If it is missing the installer tells you and stops:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

You also need git, which comes with the Xcode command line tools —
`xcode-select --install` if prompted.

**Linux:** Ubuntu with systemd. The installer elevates itself with sudo.

---

## HTTPS: what happens automatically

The installer works out which situation you are in and picks accordingly.

**A server with a public IP** — a VPS like Contabo, Hetzner or DigitalOcean.
It derives a hostname from your IP via sslip.io, verifies it really resolves
back to you, and gets a genuine Let's Encrypt certificate. Publicly trusted, no
domain to buy. Ports 80 and 443 must be reachable.

**A home machine behind a router** — your gaming PC, a Mac, a NAS. A public
certificate is *impossible* here: Let's Encrypt has to reach your machine from
the internet to validate it, and your router does not allow that. So Caddy issues
its own certificate instead. This is still real TLS with AES-256 — it is simply
signed by a local authority rather than a public one.

That distinction matters for your players:

```
config/local-ca.crt   ← ship this with the mod
```

The mod must be told to trust that file, or the connection is refused. That is
TLS working correctly, not a bug.

**Your own domain** — best long term. Point an A record at the machine and:

```bash
sudo DOMAIN=rp.yourdomain.com bash deploy/install.sh          # Linux
sudo DOMAIN=rp.yourdomain.com bash deploy/install-macos.sh    # macOS
```
```powershell
.\deploy\install-windows.ps1 -Domain rp.yourdomain.com        # Windows
```

Override the choice at any time with `TLS_MODE=letsencrypt` or `TLS_MODE=internal`.

---

## Where things land

| | Linux | macOS | Windows |
|---|---|---|---|
| Code | `/opt/palworld-rp-backend` | `/usr/local/opt/palworld-rp-backend` | `%ProgramData%\PalworldRPBackend\app` |
| Data | `/var/lib/palworld-rp-backend` | `/usr/local/var/palworld-rp-backend` | `%ProgramData%\PalworldRPBackend\data` |
| Config | `/etc/palworld-rp-backend/env` | `/usr/local/etc/palworld-rp-backend/env` | `%ProgramData%\PalworldRPBackend\config\env` |
| Service | systemd | launchd | Scheduled Task |
| Runs as | `palrp` | `_palrp` | `SYSTEM` |

On Linux and macOS the service runs as a dedicated account with no shell and no
password. Windows has no clean equivalent, so it runs as SYSTEM with the data
directory and env file locked by ACL to SYSTEM and Administrators only.

---

## Updating and removing

```
palworld-rp update
palworld-rp uninstall              # keeps your data
palworld-rp uninstall --purge-data # removes it too
```

`update` works because npx has already re-fetched the repository before the
command runs — the copy executing *is* the new version. All it does then is
re-run the installer, which is idempotent and preserves data and configuration.

If you installed from a git clone rather than npx, `deploy/update.sh` does a
proper git pull with automatic rollback when the new version fails its health
check.

---

## Managing it

**Linux**
```bash
systemctl status palworld-rp-backend
journalctl -u palworld-rp-backend -f
sudo systemctl restart palworld-rp-backend
```

**macOS**
```bash
sudo launchctl kickstart -k system/io.palworldrp.backend   # restart
sudo launchctl bootout   system/io.palworldrp.backend      # stop
tail -f /usr/local/var/log/palworld-rp-backend/out.log
```

**Windows**
```powershell
Restart-ScheduledTask -TaskName PalworldRPBackend
Stop-ScheduledTask    -TaskName PalworldRPBackend
Get-Content "$env:ProgramData\PalworldRPBackend\logs\out.log" -Tail 50 -Wait
```

Lost the URL? It is saved in `backend-url.txt` next to the env file.

---

## Troubleshooting

**Linux and macOS:** `sudo bash deploy/doctor.sh` checks every layer in order —
files, permissions, service, port binding, Caddy, DNS, certificate, cipher,
firewall, backups — and names the one that is actually broken. It knows both
platforms' paths and service managers.

**Windows** has no doctor script. Check by hand:

```powershell
Get-ScheduledTask -TaskName PalworldRPBackend
Invoke-WebRequest http://127.0.0.1:3000/health -UseBasicParsing
Get-Content "$env:ProgramData\PalworldRPBackend\logs\err.log" -Tail 40
```

**`ERROR: You must supply a command`**, with options listed like
`--shell-auto-fallback` and `--npm` — you have the *deprecated standalone npx
package* shadowing the one built into npm. They take different arguments. Remove
it and use npm's own:

```bash
sudo npm uninstall -g npx
hash -r                 # forget the cached path to the old binary
npx -y github:chaosfox26/palworld-rp-backend
```

Or bypass npx entirely:

```bash
npm exec --yes --package github:chaosfox26/palworld-rp-backend -- palworld-rp
```

**"winget is not recognised"** — install *App Installer* from the Microsoft
Store, then re-run.

**Windows: "node is not recognised" straight after install** — winget updates
PATH for new processes only. Close the window, open a fresh Administrator
PowerShell, run the command again. The installer detects this and says so.

**Certificate never issues on a server** — ports 80 and 443 must be reachable
from the internet. Port 80 is required even though traffic uses 443: that is how
Let's Encrypt validates. On a VPS check the provider's control-panel firewall as
well as the one on the machine.

**The mod refuses to connect on a home install** — expected until it trusts
`local-ca.crt`. That is the local certificate authority doing its job.

**Home install, players outside your network** — they cannot reach a machine
behind your router unless you forward ports 80 and 443 to it. If you are opening
your home network to strangers, a cheap VPS is the better answer.
