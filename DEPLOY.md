# Deploying natively on your Contabo Ubuntu server

No Docker. The app runs as a locked-down system user under systemd, behind Caddy
for automatic HTTPS.

Total time: about 15 minutes, most of it waiting for DNS.

---

## What you end up with

```
   internet
      │  :443 (HTTPS + WSS)
      ▼
   Caddy  ──────────────►  node server.js  ──►  /var/lib/palworld-rp-backend
   (systemd)  127.0.0.1:3000   (systemd, user: palrp)      accounts/ profiles/ guilds/
```

| Thing | Location |
|---|---|
| Code | `/opt/palworld-rp-backend` — owned by root, service cannot modify it |
| Data | `/var/lib/palworld-rp-backend` — owned by `palrp`, mode 750 |
| Config | `/etc/palworld-rp-backend/env` — mode 640, holds your admin token |
| Backups | `/var/backups/palworld-rp-backend` — daily, 14 kept |
| Service | `systemctl status palworld-rp-backend` |

The `palrp` account has no password, no home directory and `/usr/sbin/nologin`
as its shell. Nobody can log in as it. It exists only to own the process.

---

## Step 1 — (Optional) Point a domain at the server

**You can skip this entirely.** With no domain the installer derives a working
hostname automatically from your server's IP via sslip.io, verifies it resolves
back to you, and gets a real Let's Encrypt certificate for it. That is enough to
run the mod.

Do this step only if you want a hostname you own — nicer to share, and not
dependent on a third-party DNS service for future renewals.

1. Find your server's public IP: `curl https://api.ipify.org`
2. At your DNS provider, add an **A record**:
   - Name: `rp` (giving you `rp.yourdomain.com`)
   - Value: your server's IP
   - TTL: 300
3. Wait a few minutes, then confirm from the server:

```bash
getent ahostsv4 rp.yourdomain.com
```

The IP it prints must match your server's. If it doesn't, stop and fix DNS —
everything downstream depends on it.

**Open ports 80 and 443** in both places — this part is *not* optional:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

...and in the Contabo web panel's firewall. People forget the panel one
constantly. Port 80 is required even though your traffic uses 443 — Let's
Encrypt validates over it, and renewals will silently fail without it.

---

## Step 2 — Put the code on GitHub

The installer deploys from a git checkout, which is what makes `update.sh` able
to pull changes later.

On your PC, in the `palworld-rp-backend` folder:

```bash
# Generate the lockfile first — it makes every deploy install identical bits.
npm install

git init
git add .
git commit -m "Palworld RP backend"
git branch -M main
git remote add origin https://github.com/chaosfox26/palworld-rp-backend.git
git push -u origin main
```

Make the repo **public**, or set up a deploy key if you keep it private — a
private repo will prompt for credentials during clone and the install will hang.

`.gitignore` already excludes `node_modules/`, `data/` and `.env`, so no secrets
or data go up. Double-check with `git status` before you push.

---

## Step 3 — Install

On the Contabo server, one command:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/chaosfox26/palworld-rp-backend/main/deploy/bootstrap.sh)
```

It re-runs itself under sudo if needed, installs git, clones the repo to
`/usr/local/src/palworld-rp-backend`, and hands over to the installer.

To skip the prompts entirely:

```bash
sudo DOMAIN=rp.yourdomain.com ACME_EMAIL=you@example.com \
  bash <(curl -fsSL https://raw.githubusercontent.com/chaosfox26/palworld-rp-backend/main/deploy/bootstrap.sh)
```

If you would rather inspect the script before running it as root — a reasonable
instinct — download it first, read it, then run it:

```bash
curl -fsSL -o bootstrap.sh https://raw.githubusercontent.com/chaosfox26/palworld-rp-backend/main/deploy/bootstrap.sh
less bootstrap.sh
sudo bash bootstrap.sh
```

Or do it manually:

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/chaosfox26/palworld-rp-backend.git
cd palworld-rp-backend
sudo bash deploy/install.sh
```

Either way it asks for your domain and an email for certificate notices, then
does everything else:

- backs up your old Docker profiles, then removes the `my-palworld-chat`
  container and its image
- installs Node 22 and Caddy from their official apt repositories
- creates the `palrp` system user and the directory layout
- generates a random admin token
- writes and validates the Caddy config
- installs and starts the systemd services
- waits for the health check and for HTTPS to come up

**Save the admin token it prints.** It's also in
`/etc/palworld-rp-backend/env` if you lose it.

Re-running the installer later is safe: it upgrades in place and keeps your
domain, email, token and data.

---

## Step 4 — Verify

```bash
sudo bash /opt/palworld-rp-backend/deploy/doctor.sh
```

This checks every layer in order — files, permissions, service, port binding,
Caddy, DNS, certificate expiry, firewall, backups — and tells you which one is
actually broken rather than making you guess. Run it any time something looks
wrong.

Quick manual checks:

```bash
curl https://rp.yourdomain.com/health
curl https://rp.yourdomain.com/info
systemctl status palworld-rp-backend
```

Then confirm it survives a reboot, which is the test that actually matters:

```bash
sudo reboot
# wait, reconnect
sudo bash /opt/palworld-rp-backend/deploy/doctor.sh
```

---

## Step 5 — Import your old profiles

If the installer found your Docker profiles, it printed the exact command.
Otherwise:

```bash
sudo -u palrp DATA_DIR=/var/lib/palworld-rp-backend \
  node /opt/palworld-rp-backend/scripts/migrate-from-v1.js \
  /var/backups/palworld-rp-backend/v1-profiles-YYYYMMDD-HHMMSS
```

Old passwords keep working, so nobody has to re-register. But they were stored
in plaintext on the old server — anyone who had access to that disk has already
seen them. Tell your players to change theirs after logging in.

---

## Step 6 — Run the full test suite against the real install

The unit tests need no dependencies:

```bash
cd /opt/palworld-rp-backend
sudo npm run test:unit
```

The end-to-end suite needs the dev dependency and spawns its own server on port
34117, so it won't disturb the live one:

```bash
cd ~/palworld-rp-backend      # your clone, not /opt
npm install
npm test
```

Every section marked ATTACK reproduces a hole that existed in the first version.
They should all pass.

---

## Day-to-day operations

```bash
# Logs (structured JSON, one object per line)
journalctl -u palworld-rp-backend -f
journalctl -u caddy -f

# Restart / stop
sudo systemctl restart palworld-rp-backend
sudo systemctl stop palworld-rp-backend

# Deploy new code: pulls, installs, restarts, and rolls back automatically
# if the new version fails its health check
sudo bash /opt/palworld-rp-backend/deploy/update.sh

# Backups
sudo bash /opt/palworld-rp-backend/deploy/backup.sh    # manual
systemctl list-timers palworld-rp-backend-backup.timer # daily schedule

# Review the sandbox
systemd-analyze security palworld-rp-backend
```

### Changing settings

Edit `/etc/palworld-rp-backend/env`, then:

```bash
sudo systemctl restart palworld-rp-backend
```

Note that re-running `install.sh` rewrites this file (preserving domain, email
and admin token). If you customise tuning values, keep a note of them.

### Moderation

```bash
export A="Authorization: Bearer $(sudo grep '^ADMIN_TOKEN=' /etc/palworld-rp-backend/env | cut -d= -f2-)"

curl -H "$A" https://rp.yourdomain.com/admin/stats
curl -H "$A" https://rp.yourdomain.com/admin/online
curl -H "$A" -X POST https://rp.yourdomain.com/admin/ban/troublemaker \
     -H 'Content-Type: application/json' -d '{"reason":"spam"}'
curl -H "$A" -X POST https://rp.yourdomain.com/admin/unban/troublemaker
```

A ban disconnects every session immediately and blocks re-login.

### Restoring from a backup

```bash
sudo systemctl stop palworld-rp-backend
sudo rm -rf /var/lib/palworld-rp-backend/*
sudo tar -xzf /var/backups/palworld-rp-backend/data-YYYYMMDD-HHMMSS.tar.gz \
     -C /var/lib/palworld-rp-backend
sudo chown -R palrp:palrp /var/lib/palworld-rp-backend
sudo systemctl start palworld-rp-backend
```

Backups only on the same disk as the data aren't really backups. Pull them
down periodically:

```bash
scp root@rp.yourdomain.com:/var/backups/palworld-rp-backend/data-*.tar.gz .
```

---

## Troubleshooting

**`doctor.sh` first.** It will usually name the problem outright.

**HTTPS never comes up.** Almost always DNS or port 80.

```bash
sudo journalctl -u caddy -n 50        # the ACME error is in here
getent ahostsv4 rp.yourdomain.com     # must match: curl https://api.ipify.org
sudo ufw status                        # 80 and 443 both allowed?
```

Also check the Contabo panel firewall. If you retried many times, you may have
hit Let's Encrypt's rate limit (5 failures per hostname per hour) — wait an hour.

**Service won't start.**

```bash
sudo systemctl status palworld-rp-backend
sudo journalctl -u palworld-rp-backend -n 50
```

If it's a permissions error on the data directory:

```bash
sudo chown -R palrp:palrp /var/lib/palworld-rp-backend
```

**Port 3000 already in use.** The old Docker container is probably still
running:

```bash
sudo docker ps
sudo docker rm -f my-palworld-chat
```

**Everything looks fine but the mod can't connect.** Confirm the mod is using
`https://` / `wss://` and not `http://`, and check for a certificate error:

```bash
curl -v https://rp.yourdomain.com/health
```

---

## Uninstalling

```bash
sudo bash /opt/palworld-rp-backend/deploy/uninstall.sh              # keeps data
sudo bash /opt/palworld-rp-backend/deploy/uninstall.sh --purge-data # removes it
```

`--purge-data` takes one final snapshot into `/var/backups` before deleting
anything.
