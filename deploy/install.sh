#!/usr/bin/env bash
#
# Native installer for the Palworld RP Backend on Ubuntu.
#
# Installs Node 22 and Caddy from their official repositories, creates a locked
# down system user, lays out /opt + /etc + /var/lib, writes a systemd unit, and
# starts the service behind automatic HTTPS.
#
# Run from inside a checkout of this repository:
#     sudo bash deploy/install.sh
#
# It is idempotent: running it again upgrades in place without touching data.
#
set -euo pipefail

# --- Settings ---------------------------------------------------------------
APP_NAME="palworld-rp-backend"
APP_USER="palrp"
APP_DIR="/opt/${APP_NAME}"
DATA_DIR="/var/lib/${APP_NAME}"
CONF_DIR="/etc/${APP_NAME}"
ENV_FILE="${CONF_DIR}/env"
BACKUP_DIR="/var/backups/${APP_NAME}"
NODE_MAJOR=22
APP_PORT=3000

# --- Shared helpers ---------------------------------------------------------
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib.sh
. "${LIB_DIR}/lib.sh"

trap 'die "Install failed at line $LINENO. Re-running this script is safe: it is idempotent and your data in '"$DATA_DIR"' is untouched."' ERR

reattach_tty

# --- Preflight --------------------------------------------------------------
step "Preflight checks"

[ "$(id -u)" -eq 0 ] || die "Run this with sudo: sudo bash deploy/install.sh"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "${REPO_ROOT}/server.js" ] || die "Run this from inside the repository checkout (server.js not found next to deploy/)."
ok "Repository found at ${REPO_ROOT}"

if ! . /etc/os-release 2>/dev/null || [ "${ID:-}" != "ubuntu" ]; then
  warn "This script targets Ubuntu. Detected: ${PRETTY_NAME:-unknown}. Continuing, but apt package names may differ."
else
  ok "Ubuntu ${VERSION_ID:-?} detected"
fi

command -v systemctl >/dev/null || die "systemd is required."

# Public IP, used for the DNS sanity check below.
PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
[ -n "$PUBLIC_IP" ] && ok "Public IP: ${PUBLIC_IP}" || warn "Could not determine public IP; skipping the DNS check."

# --- Gather configuration ---------------------------------------------------
step "Configuration"

# Reuse existing answers on re-run so upgrades are non-interactive-friendly.
EXISTING_DOMAIN=""
EXISTING_EMAIL=""
EXISTING_ADMIN=""
EXISTING_TLS_MODE=""
if [ -f "$ENV_FILE" ]; then
  EXISTING_DOMAIN="$(grep -E '^DOMAIN=' "$ENV_FILE" | cut -d= -f2- || true)"
  EXISTING_EMAIL="$(grep -E '^ACME_EMAIL=' "$ENV_FILE" | cut -d= -f2- || true)"
  EXISTING_ADMIN="$(grep -E '^ADMIN_TOKEN=' "$ENV_FILE" | cut -d= -f2- || true)"
  EXISTING_TLS_MODE="$(grep -E '^TLS_MODE=' "$ENV_FILE" | cut -d= -f2- || true)"
  ok "Existing configuration found at ${ENV_FILE}; press Enter at each prompt to keep current values."
fi

DOMAIN="${DOMAIN:-$EXISTING_DOMAIN}"
ACME_EMAIL="${ACME_EMAIL:-$EXISTING_EMAIL}"
TLS_MODE="${TLS_MODE:-$EXISTING_TLS_MODE}"

decide_tls_mode

# decide_tls_mode chooses SITE. DOMAIN is only populated when the operator
# supplied one or a previous install left it in the env file, so on a fresh
# auto-hostname install it is empty — which previously printed the mod's
# Backend URL as a bare "https://". They are the same thing; keep them equal.
DOMAIN="$SITE"
BACKEND_URL="https://${SITE}"

# --- Decommission the old Docker deployment ---------------------------------
step "Retiring the old Docker container"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

if command -v docker >/dev/null 2>&1; then
  if docker inspect my-palworld-chat >/dev/null 2>&1; then
    # Find where the old bind mount pointed so we can save the v1 profiles.
    OLD_PROFILES="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/usr/src/app/profiles"}}{{.Source}}{{end}}{{end}}' my-palworld-chat 2>/dev/null || true)"
    STAMP="$(date +%Y%m%d-%H%M%S)"
    if [ -n "$OLD_PROFILES" ] && [ -d "$OLD_PROFILES" ]; then
      V1_BACKUP="${BACKUP_DIR}/v1-profiles-${STAMP}"
      cp -a "$OLD_PROFILES" "$V1_BACKUP"
      chmod -R go-rwx "$V1_BACKUP"
      ok "Old profiles copied to ${V1_BACKUP}"
      echo "$V1_BACKUP" > "${BACKUP_DIR}/.last-v1-profiles"
    else
      warn "Could not locate the old profiles bind mount; nothing to back up."
    fi

    docker rm -f my-palworld-chat >/dev/null
    ok "Container my-palworld-chat removed"
  else
    ok "No my-palworld-chat container present"
  fi

  if docker image inspect palworld-chat-backend >/dev/null 2>&1; then
    docker rmi -f palworld-chat-backend >/dev/null 2>&1 || true
    ok "Old image removed"
  fi
else
  ok "Docker not installed; nothing to retire"
fi

# Make sure nothing else is squatting on the port we want.
if ss -ltn "sport = :${APP_PORT}" 2>/dev/null | grep -q LISTEN; then
  if ! systemctl is-active --quiet "${APP_NAME}"; then
    die "Something is already listening on port ${APP_PORT}. Stop it and re-run. (Check with: ss -ltnp sport = :${APP_PORT})"
  fi
fi

# --- Node.js ----------------------------------------------------------------
# --- Unattended apt ----------------------------------------------------------
# Three separate things can make apt sit there forever on a modern Ubuntu box,
# and all three have to be handled or the install appears to hang:
#
#   1. needrestart. Ubuntu 22.04+ installs it by default. After any package that
#      provides a service — Caddy does — it opens a whiptail dialog asking which
#      services to restart. DEBIAN_FRONTEND does NOT suppress it; it has its own
#      variables. This is the usual cause of a hang at "Installing Caddy".
#   2. dpkg config prompts. This installer rewrites /etc/caddy/Caddyfile, so on a
#      reinstall dpkg would stop to ask whether to keep the modified version.
#   3. The dpkg lock. On a freshly booted VPS, unattended-upgrades is often still
#      running and apt blocks on the lock silently, with no output at all.
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1

# Wait up to ten minutes for the lock, then fail with a real message rather than
# hanging indefinitely.
APT_OPTS="-o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef"

step "Installing Node.js ${NODE_MAJOR}"

need_node=1
if command -v node >/dev/null 2>&1; then
  CURRENT="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$CURRENT" -ge 20 ] 2>/dev/null; then
    need_node=0
    ok "Node $(node -v) already installed"
  else
    warn "Node $(node -v) is too old (need >= 20); upgrading."
  fi
fi

if [ "$need_node" -eq 1 ]; then
  apt-get $APT_OPTS update -qq
  apt-get $APT_OPTS install -y -qq ca-certificates curl gnupg >/dev/null
  install -m 0755 -d /usr/share/keyrings
  # Downloaded to a file first rather than piped straight into gpg. In a pipeline
  # only the LAST command's status counts, so a failed download produced an empty
  # keyring and the script carried on to fail two lines later with
  # "chmod: cannot access ...", which says nothing about the real cause.
  NODE_KEY_TMP="$(mktemp)"
  curl -fsSL --connect-timeout 20 --max-time 60 --retry 3 --retry-delay 3 \
    https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$NODE_KEY_TMP" \
    || { rm -f "$NODE_KEY_TMP"; die "Could not download the NodeSource signing key.
  Check this machine has internet access and can reach deb.nodesource.com."; }
  gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg < "$NODE_KEY_TMP" \
    || { rm -f "$NODE_KEY_TMP"; die "The NodeSource signing key could not be decoded."; }
  rm -f "$NODE_KEY_TMP"
  [ -s /usr/share/keyrings/nodesource.gpg ] \
    || die "The NodeSource keyring came out empty. deb.nodesource.com may be down."
  chmod a+r /usr/share/keyrings/nodesource.gpg
  mkdir -p /etc/apt/sources.list.d
  echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get $APT_OPTS update -qq
  apt-get $APT_OPTS install -y -qq nodejs >/dev/null
  ok "Node $(node -v) installed"
fi

# --- Caddy ------------------------------------------------------------------
step "Installing Caddy"

# Deliberately NOT the Cloudsmith apt repository that Caddy's docs recommend.
# Adding it means two network fetches to dl.cloudsmith.io plus an `apt-get
# update` against it, and when that host is slow or blocked the install hangs
# with no output at all — no timeout, no error, just a stalled TCP connection.
# A single release tarball from GitHub, checksum-verified, removes that whole
# dependency and the third-party repo along with it.

CADDY_VERSION="${CADDY_VERSION:-2.11.4}"

case "$(uname -m)" in
  x86_64|amd64)   CADDY_ARCH=amd64 ;;
  aarch64|arm64)  CADDY_ARCH=arm64 ;;
  armv7l|armv7)   CADDY_ARCH=armv7 ;;
  armv6l|armv6)   CADDY_ARCH=armv6 ;;
  ppc64le)        CADDY_ARCH=ppc64le ;;
  s390x)          CADDY_ARCH=s390x ;;
  riscv64)        CADDY_ARCH=riscv64 ;;
  *) die "Unsupported CPU architecture: $(uname -m). Install Caddy manually, then re-run." ;;
esac

# Published checksums for the pinned version, so the download is verified
# without a second network call. Overriding CADDY_VERSION skips to fetching
# checksums.txt instead.
caddy_expected_sha() {
  if [ "$CADDY_VERSION" != "2.11.4" ]; then echo ""; return; fi
  case "$CADDY_ARCH" in
    amd64)   echo "527fbf917c39189a1e3b31d34fa955601680b2d5c8055d2a87b8b9588dec7bb9" ;;
    arm64)   echo "52d42ae12b3462097e9868da6dfed3c9648ae12edd3b3638102312af84cb6904" ;;
    armv7)   echo "caa71eb180cf6f1f55b37a6c5a364d5cdca6c90f5473de9eb97b1df456184f42" ;;
    armv6)   echo "24ed7d2c7dad8d9e57499c1004bd45909de5ca0683b38b22ae6fec80c4b80e92" ;;
    ppc64le) echo "34a99f9c7f45ce0a881a5d50b3f45504e2165055c630c29059129401a8d2b8fd" ;;
    s390x)   echo "730ef4430d40e23e222e370f6c76b48940c716c9eaaa3352b08c4c833d42b736" ;;
    riscv64) echo "3bb7545503bb294785717d5faaeadba3c0c99869940d77d193efca5c0c2dc365" ;;
    *) echo "" ;;
  esac
}

if command -v caddy >/dev/null 2>&1; then
  ok "Caddy $(caddy version 2>/dev/null | head -1) already installed"
else
  CADDY_TGZ="caddy_${CADDY_VERSION}_linux_${CADDY_ARCH}.tar.gz"
  CADDY_URL="https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/${CADDY_TGZ}"
  CADDY_TMP="$(mktemp -d)"

  echo "  Downloading ${CADDY_TGZ} (about 16 MB)"
  # Every flag here earns its place: --max-time stops the indefinite hang that
  # the apt repo caused, and --retry rides out a transient blip.
  curl -fL --proto '=https' --tlsv1.2 \
       --connect-timeout 20 --max-time 300 --retry 3 --retry-delay 3 \
       -o "${CADDY_TMP}/${CADDY_TGZ}" "$CADDY_URL" \
    || { rm -rf "$CADDY_TMP"; die "Could not download Caddy from GitHub.
  Tried: ${CADDY_URL}
  Check this machine has internet access and can reach github.com."; }

  EXPECTED="$(caddy_expected_sha)"
  if [ -z "$EXPECTED" ]; then
    # Unpinned version: fetch the release's own checksum list.
    curl -fsSL --connect-timeout 20 --max-time 60 \
      "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_checksums.txt" \
      -o "${CADDY_TMP}/checksums.txt" \
      || { rm -rf "$CADDY_TMP"; die "Could not download the checksum file for Caddy ${CADDY_VERSION}."; }
    EXPECTED="$(awk -v f="$CADDY_TGZ" '$2==f || $2=="*"f {print $1}' "${CADDY_TMP}/checksums.txt" | head -1)"
    [ -n "$EXPECTED" ] || { rm -rf "$CADDY_TMP"; die "No checksum listed for ${CADDY_TGZ}."; }
  fi

  ACTUAL="$(sha256sum "${CADDY_TMP}/${CADDY_TGZ}" | awk '{print $1}')"
  if [ "$ACTUAL" != "$EXPECTED" ]; then
    rm -rf "$CADDY_TMP"
    die "Caddy download failed its checksum check.
  expected ${EXPECTED}
  got      ${ACTUAL}
  Refusing to install it."
  fi
  ok "Downloaded and checksum verified"

  tar -C "$CADDY_TMP" -xzf "${CADDY_TMP}/${CADDY_TGZ}" caddy \
    || { rm -rf "$CADDY_TMP"; die "Could not extract the Caddy binary."; }
  install -m 0755 -o root -g root "${CADDY_TMP}/caddy" /usr/bin/caddy
  rm -rf "$CADDY_TMP"

  # The .deb would normally create these. Doing it by hand keeps the layout
  # identical, so every other part of this installer and doctor.sh still apply.
  if ! id caddy >/dev/null 2>&1; then
    groupadd --system caddy 2>/dev/null || true
    useradd --system --gid caddy --create-home --home-dir /var/lib/caddy \
            --shell /usr/sbin/nologin --comment "Caddy web server" caddy 2>/dev/null || true
  fi
  mkdir -p /etc/caddy /var/lib/caddy /var/log/caddy
  chown -R caddy:caddy /var/lib/caddy /var/log/caddy
  chmod 0755 /var/log/caddy

  # Mirrors the unit the official package ships. AmbientCapabilities is what
  # lets an unprivileged process bind 80 and 443.
  cat > /etc/systemd/system/caddy.service <<'CADDYUNIT'
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE
LogsDirectory=caddy
LogsDirectoryMode=0755

[Install]
WantedBy=multi-user.target
CADDYUNIT
  systemctl daemon-reload
  ok "Caddy $(caddy version 2>/dev/null | head -1) installed from the official release"
fi

# --- Service account --------------------------------------------------------
step "Creating the service account"

if id "$APP_USER" >/dev/null 2>&1; then
  ok "User ${APP_USER} already exists"
else
  # No login shell, no home directory, no password. This account exists only to
  # own the running process.
  useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
  ok "User ${APP_USER} created (system account, no shell)"
fi

# --- Application files ------------------------------------------------------
step "Installing application to ${APP_DIR}"

mkdir -p "$APP_DIR"

# Copy the checkout, including .git so deploy/update.sh can `git pull` later.
# Exclude node_modules: we install production deps fresh below.
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude 'node_modules' --exclude 'data' --exclude '.env' \
    "${REPO_ROOT}/" "${APP_DIR}/"
else
  find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
  tar -C "$REPO_ROOT" --exclude=node_modules --exclude=data --exclude=.env -cf - . \
    | tar -C "$APP_DIR" -xf -
fi

# Code is owned by root and only readable by the service user. The app cannot
# rewrite its own source even if it is compromised.
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"
ok "Source installed"

step "Installing production dependencies"
cd "$APP_DIR"
# Two lockfile names, and the difference matters here.
#
# npm strips package-lock.json out of every pack, including the pack it makes
# when installing from a git spec — so an `npx github:...` install never sees
# one, no matter what is committed. npm-shrinkwrap.json is the publishable
# equivalent: npm always includes it, and `npm ci` accepts it. Committing a
# shrinkwrap is what makes npx installs reproducible.
if [ -f npm-shrinkwrap.json ] || [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund
else
  warn "No lockfile found, so dependency versions are resolved fresh."
  warn "For reproducible installs, run this once in the repo and commit the result:"
  warn "    npm install && npm shrinkwrap"
  npm install --omit=dev --no-audit --no-fund
fi
chown -R root:root "${APP_DIR}/node_modules"
ok "Dependencies installed"

# --- Command on PATH --------------------------------------------------------
step "Installing the palworld-rp command"

# After this, npx is never needed again: `palworld-rp doctor`, `palworld-rp url`
# and so on work directly. This also avoids the npx quirk where a subcommand
# written after the package spec is taken as the command name rather than an
# argument.
cat > /usr/local/bin/palworld-rp <<EOF
#!/bin/sh
exec "$(command -v node)" "${APP_DIR}/bin/palworld-rp.js" "\$@"
EOF
chmod 0755 /usr/local/bin/palworld-rp

# Both names, because package.json declares both and people reach for the
# longer one after reading the repository name. A missing command is a much
# more confusing first experience than a duplicate launcher.
cp /usr/local/bin/palworld-rp /usr/local/bin/palworld-rp-backend
chmod 0755 /usr/local/bin/palworld-rp-backend
ok "palworld-rp is now on your PATH"

# --- Data directory ---------------------------------------------------------
step "Preparing ${DATA_DIR}"

mkdir -p "$DATA_DIR"
chown "${APP_USER}:${APP_USER}" "$DATA_DIR"
chmod 750 "$DATA_DIR"
ok "Data directory ready (owned by ${APP_USER}, mode 750)"

# --- Environment file -------------------------------------------------------
step "Writing ${ENV_FILE}"

mkdir -p "$CONF_DIR"
# 0755, not 0750. The secret in here is the env file, which is protected by its
# own 0640 root:palrp mode. Locking the DIRECTORY down as well meant nobody but
# root could traverse into it, so the non-secret files beside it —
# backend-url.txt and local-ca.crt, both deliberately world-readable — could not
# be read by the operator running `palworld-rp url`, nor by the service account
# running the admin panel. Directory permissions gate the path, not the file.
chmod 0755 "$CONF_DIR"

ADMIN_TOKEN="$EXISTING_ADMIN"
if [ -z "$ADMIN_TOKEN" ]; then
  ADMIN_TOKEN="$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64)"
  NEW_TOKEN=1
else
  NEW_TOKEN=0
  ok "Keeping the existing admin token"
fi

if [ -f "$ENV_FILE" ]; then
  cp -a "$ENV_FILE" "${ENV_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
fi

cat > "$ENV_FILE" <<EOF
# Written by deploy/install.sh. Safe to edit; run
#   sudo systemctl restart ${APP_NAME}
# afterwards. Re-running the installer preserves DOMAIN, ACME_EMAIL and
# ADMIN_TOKEN but rewrites everything else, so keep custom tuning in mind.

# --- Identity of this deployment ---
DOMAIN=${SITE}
TLS_MODE=${TLS_MODE}
ACME_EMAIL=${ACME_EMAIL}

# --- Moderation ---
# Send as: Authorization: Bearer <token>
ADMIN_TOKEN=${ADMIN_TOKEN}

# --- Networking ---
# Loopback only. Caddy is the sole path in from the internet, which is what
# keeps the app off the public interface even if the firewall is misconfigured.
HOST=127.0.0.1
PORT=${APP_PORT}
DATA_DIR=${DATA_DIR}
# One reverse proxy (Caddy) sits in front, so trust exactly one X-Forwarded-For
# hop. Set to 0 if you ever remove Caddy, or clients can spoof their IP and
# evade the per-IP rate limits.
TRUST_PROXY_HOPS=1
# Caddy terminates TLS, so the startup warning about cleartext is expected here.
WARN_IF_INSECURE=false

# --- Identity / sessions ---
SESSION_TTL_MINUTES=720
MIN_PASSWORD_LENGTH=8
MAX_PASSWORD_LENGTH=200
MAX_SESSIONS_PER_ACCOUNT=5
# Concurrent WebSocket connections per account. Not the same as the session
# cap: one token can open many sockets, and each one multiplies that player's
# share of every global message.
MAX_SOCKETS_PER_ACCOUNT=8
# Guilds one account may own. Each is a file on disk.
MAX_GUILDS_OWNED=3
MAX_ACCOUNTS=50000

# --- Message sizing ---
# Application-layer encryption. When true, message and profile content must
# arrive as an AES-256-GCM envelope that this server relays without decrypting.
# The key lives in the mod; the server never has it. See ENCRYPTION.md.
REQUIRE_ENCRYPTION=true

MAX_MESSAGE_BYTES=100000
MAX_PROFILE_BYTES=262144
MAX_PROFILE_DEPTH=12

# --- Rate limiting (cost = message bytes x recipients) ---
CHAT_BURST_BYTES=4000000
CHAT_REFILL_BYTES_PER_SEC=512000
CHAT_BURST_MESSAGES=20
CHAT_REFILL_MESSAGES_PER_SEC=4
# /who lookups and party management. Cheap per call, so they need their own
# ceiling or a loop can pin a CPU core for free.
SOCKET_QUERY_BURST=30
SOCKET_QUERY_REFILL_PER_SEC=5

# --- Proximity ---
LOCAL_CHAT_RADIUS=3000
POSITION_UPDATES_PER_SEC=5

# --- Parties, channels and mutes ---
MAX_PARTY_SIZE=8
MAX_CHANNELS_PER_ACCOUNT=10
MAX_MUTES_PER_ACCOUNT=500

# --- Per-IP HTTP limits ---
REGISTER_PER_HOUR=5
LOGIN_PER_MINUTE=20
PROFILE_WRITES_PER_MINUTE=20
# Other authenticated writes: mutes, channel joins, guild management.
WRITES_PER_MINUTE=60
READS_PER_MINUTE=240

# --- Misc ---
SEARCH_MAX_RESULTS=25
SEARCH_MIN_QUERY_LENGTH=1
LOG_LEVEL=info
CORS_ORIGIN=*
NODE_ENV=production
EOF

# Readable by the service user, writable only by root. It holds the admin token.
chown root:"$APP_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"
ok "Environment written (mode 640, root:${APP_USER})"

# --- Caddy configuration ----------------------------------------------------
step "Configuring Caddy for ${DOMAIN}"

# Caddy's own log directory. `caddy validate` does NOT open the log file, so a
# missing or unwritable directory passes validation and then kills the service
# at startup with "permission denied" — which looks exactly like a firewall
# problem from the outside. Create it and hand it to Caddy's service account.
CADDY_USER="$(systemctl show caddy -p User --value 2>/dev/null || true)"
[ -n "$CADDY_USER" ] || CADDY_USER=caddy
CADDY_GROUP="$(systemctl show caddy -p Group --value 2>/dev/null || true)"
[ -n "$CADDY_GROUP" ] || CADDY_GROUP="$CADDY_USER"

CADDY_LOG_OK=0
if id -u "$CADDY_USER" >/dev/null 2>&1; then
  mkdir -p /var/log/caddy
  # -R matters. A previous failed start can leave access.log owned by root
  # inside a directory we have just handed to caddy; opening an existing file
  # for append checks permissions on the FILE, not the directory, so chowning
  # only the directory looks correct and still fails with permission denied.
  chown -R "${CADDY_USER}:${CADDY_GROUP}" /var/log/caddy 2>/dev/null || true
  chmod 0755 /var/log/caddy

  # Belt and braces: let systemd own the problem. LogsDirectory= makes systemd
  # create /var/log/caddy with the service user as owner on every single start,
  # which self-heals if anything ever changes it back.
  mkdir -p /etc/systemd/system/caddy.service.d
  cat > /etc/systemd/system/caddy.service.d/10-logdir.conf <<'DROPIN'
# Added by the Palworld RP Backend installer.
# Caddy is configured to write an access log to /var/log/caddy. systemd creates
# this directory owned by the service user before each start, so the service
# cannot fail on a stale root-owned file.
[Service]
LogsDirectory=caddy
LogsDirectoryMode=0755
DROPIN
  systemctl daemon-reload

  # Prove it rather than assume: write as the service user.
  # runuser is preferred: the installer is already root, and it does not depend
  # on sudo being installed or configured. Falling through to neither means the
  # test cannot be performed, so the config takes the journald path instead —
  # degraded, but still a Caddy that starts.
  as_caddy() {
    if command -v runuser >/dev/null 2>&1; then runuser -u "$CADDY_USER" -- "$@"
    elif command -v sudo >/dev/null 2>&1; then sudo -u "$CADDY_USER" "$@"
    else return 1; fi
  }
  if as_caddy touch /var/log/caddy/access.log 2>/dev/null; then
    CADDY_LOG_OK=1
    ok "Log directory /var/log/caddy is writable by ${CADDY_USER}"
  else
    warn "${CADDY_USER} still cannot write /var/log/caddy."
  fi
fi
if [ "$CADDY_LOG_OK" -ne 1 ]; then
  warn "Could not give ${CADDY_USER} a writable /var/log/caddy."
  warn "Sending Caddy's access log to the journal instead (journalctl -u caddy)."
fi

if [ -f /etc/caddy/Caddyfile ] && [ ! -f /etc/caddy/Caddyfile.orig ]; then
  cp -a /etc/caddy/Caddyfile /etc/caddy/Caddyfile.orig
  ok "Original Caddyfile saved to /etc/caddy/Caddyfile.orig"
fi

# The email block is optional. Caddy accepts an empty `email` directive as a
# syntax error rather than ignoring it, so when no address was supplied the
# whole global block is removed instead of being left blank. An email is only
# used for expiry reminders; certificates issue fine without one.
if [ -n "$ACME_EMAIL" ]; then
  sed -e "/BEGIN_EMAIL/d" -e "/END_EMAIL/d" \
      -e "s|{{ACME_EMAIL}}|${ACME_EMAIL}|g" \
      "${APP_DIR}/deploy/Caddyfile.template" > /tmp/Caddyfile.stage
else
  sed -e "/BEGIN_EMAIL/,/END_EMAIL/d" \
      "${APP_DIR}/deploy/Caddyfile.template" > /tmp/Caddyfile.stage
fi
caddy_tls_block > /tmp/Caddyfile.tls
sed -e "s|{{SITE}}|${SITE}|g" \
    -e "s|{{APP_PORT}}|${APP_PORT}|g" \
    -e "/{{TLS_BLOCK}}/r /tmp/Caddyfile.tls" \
    -e "/{{TLS_BLOCK}}/d" \
    /tmp/Caddyfile.stage > /etc/caddy/Caddyfile
rm -f /tmp/Caddyfile.tls
rm -f /tmp/Caddyfile.stage

# Fall back to journald rather than shipping a config that cannot start.
if [ "$CADDY_LOG_OK" -ne 1 ]; then
  awk '
    /output file \/var\/log\/caddy\/access\.log \{/ { print "\t\toutput stderr"; skip=1; next }
    skip && /^[[:space:]]*\}/                          { skip=0; next }
    skip                                                { next }
    { print }
  ' /etc/caddy/Caddyfile > /etc/caddy/Caddyfile.nolog && mv /etc/caddy/Caddyfile.nolog /etc/caddy/Caddyfile
fi

if caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  ok "Caddyfile written and validated (TLS pinned to AES-256-GCM)"
else
  # Cipher suite names and the `tls` sub-directives vary a little between Caddy
  # releases. Rather than abort the whole install over a hardening preference,
  # drop the tls block and retry: TLS still happens, Caddy just chooses the
  # suite itself (which on TLS 1.3 means AES-256, AES-128 or ChaCha20 — all
  # strong). Better a working server with good defaults than no server.
  warn "Caddy rejected the explicit TLS block; retrying with Caddy's defaults."
  # `tls internal` is a single directive with no block, so the brace-matching
  # strip below would not apply to it anyway; only the pinned-cipher block.
  awk '/^\ttls \{/{skip=1} skip&&/^\t\}/{skip=0;next} !skip' \
    /etc/caddy/Caddyfile > /etc/caddy/Caddyfile.nofips && mv /etc/caddy/Caddyfile.nofips /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
    || die "Generated Caddyfile failed validation even without the TLS block.
  Inspect /etc/caddy/Caddyfile and report this."
  warn "TLS is active with Caddy's default suites. Pin TLS_AES_256_GCM_SHA384 in"
  warn "the mod's TLS client if you need AES-256 specifically."
  ok "Caddyfile written and validated"
fi

# --- systemd ----------------------------------------------------------------
step "Installing the systemd service"

install -m 0644 "${APP_DIR}/deploy/${APP_NAME}.service" "/etc/systemd/system/${APP_NAME}.service"
install -m 0644 "${APP_DIR}/deploy/${APP_NAME}-backup.service" "/etc/systemd/system/${APP_NAME}-backup.service"
install -m 0644 "${APP_DIR}/deploy/${APP_NAME}-backup.timer" "/etc/systemd/system/${APP_NAME}-backup.timer"
systemctl daemon-reload
ok "Unit files installed"

# --- Admin panel privileges -------------------------------------------------
step "Admin panel privileges"

# A malformed file in /etc/sudoers.d can break sudo for every user on the
# machine, so this is validated with `visudo -c` in a temporary location and
# only moved into place if it parses. Never write directly into sudoers.d.
SUDOERS_TMP="$(mktemp)"
sed -e "s|{{APP_DIR}}|${APP_DIR}|g" \
    -e "s|{{APP_NAME}}|${APP_NAME}|g" \
    -e "s|{{SERVICE_USER}}|${APP_USER}|g" \
    "${APP_DIR}/deploy/sudoers.template" > "$SUDOERS_TMP"

# This step must never be fatal. Service control is a convenience; failing to
# grant it is not a reason to abandon an otherwise complete install, and under
# `set -e` an unguarded failure here would abort after everything else is done.
mkdir -p /etc/sudoers.d 2>/dev/null || true
if ! command -v visudo >/dev/null 2>&1; then
  warn "visudo is not available, so sudo rules were not installed."
  warn "The admin panel works; its service-control buttons will not."
elif ! visudo -cf "$SUDOERS_TMP" >/dev/null 2>&1; then
  warn "Generated sudoers file failed validation and was NOT installed."
  warn "The admin panel works; its service-control buttons will not."
elif install -m 0440 -o root -g root "$SUDOERS_TMP" "/etc/sudoers.d/${APP_NAME}" 2>/dev/null; then
  ok "Service control granted to ${APP_USER} (restart/stop/start only)"
else
  warn "Could not write /etc/sudoers.d/${APP_NAME}."
  warn "The admin panel works; its service-control buttons will not."
fi
rm -f "$SUDOERS_TMP"

chmod 0755 "${APP_DIR}/deploy/backup.sh" 2>/dev/null || true

# --- Firewall ---------------------------------------------------------------
step "Firewall"

# 22, 80 and 443 are always opened.
#   22  — SSH. Enabling a firewall without it is the classic way to lock
#          yourself out of a remote server permanently.
#   80  — Let's Encrypt validates over it. Closed means no certificate, and a
#          silent renewal failure three months later.
#   443 — what players actually connect to.
FW_PORTS="22/tcp 80/tcp 443/tcp"

# Anything else is site-specific, so it is asked for rather than guessed. A VNC
# or remote-console port is the common case on a VPS.
suggest_vnc_port() {
  # If something is already listening on a non-standard port, offer it as the
  # default so the number does not have to be remembered.
  command -v ss >/dev/null 2>&1 || return 0
  # `|| true` and the explicit `return 0` both matter. This script runs under
  # `set -euo pipefail`, and with pipefail a grep that matches nothing returns 1
  # and fails the WHOLE pipeline even though `head` succeeded. Finding no extra
  # listening port is the normal case on a fresh server, so without this the
  # installer aborted at the firewall step on exactly the machines it was meant
  # to help.
  ss -tlnH 2>/dev/null | awk '{print $4}' \
    | grep -vE '^(127\.|\[::1\]|\[?::1)' \
    | sed 's/.*://' | grep -E '^[0-9]+$' | sort -un \
    | grep -vE "^(22|80|443|${APP_PORT}|${ADMIN_UI_PORT:-8787})$" | head -1 || true
  return 0
}

valid_port() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "$1" -ge 1 ] 2>/dev/null && [ "$1" -le 65535 ] 2>/dev/null
}

VNC_CHOICE="${VNC_PORT:-}"

if [ -n "$VNC_CHOICE" ]; then
  : # supplied non-interactively
elif [ -t 0 ]; then
  DEFAULT_VNC="$(suggest_vnc_port)"
  echo
  echo "  Ports 22 (SSH), 80 and 443 will be opened automatically."
  echo
  if [ -n "$DEFAULT_VNC" ]; then
    echo "  Something is listening on port ${DEFAULT_VNC} — that is probably your"
    echo "  VNC or remote console."
    printf '  VNC port to open [%s], or "n" for none: ' "$DEFAULT_VNC"
  else
    echo "  If you use a VNC or remote console, enter its port so the firewall"
    echo "  does not cut you off from it."
    printf '  VNC port to open (blank for none): '
  fi
  read -r VNC_CHOICE || VNC_CHOICE=""
  case "$VNC_CHOICE" in
    n|N|no|NO) VNC_CHOICE="" ;;
    '')        VNC_CHOICE="${DEFAULT_VNC:-}" ;;
  esac
else
  warn "Not interactive, so no VNC port was requested."
  warn "To open one, re-run with: VNC_PORT=63274"
fi

if [ -n "$VNC_CHOICE" ]; then
  if valid_port "$VNC_CHOICE"; then
    FW_PORTS="$FW_PORTS ${VNC_CHOICE}/tcp"
    ok "Will also open ${VNC_CHOICE}/tcp for VNC"
  else
    warn "\"${VNC_CHOICE}\" is not a valid port number (1-65535). Skipping it."
  fi
fi

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  for pspec in $FW_PORTS; do
    ufw allow "$pspec" >/dev/null 2>&1 || warn "Could not add ufw rule for ${pspec}"
  done
  ok "ufw: opened ${FW_PORTS}"
  if ufw status | grep -qE "^${APP_PORT}[/ ]"; then
    warn "Port ${APP_PORT} appears to be open in ufw. It no longer needs to be — the app binds loopback only."
    warn "Close it with: sudo ufw delete allow ${APP_PORT}/tcp"
  fi
else
  warn "ufw is not active, so no rules were applied. To turn it on:"
  echo
  for pspec in $FW_PORTS; do echo "        sudo ufw allow ${pspec}"; done
  echo "        sudo ufw enable"
  echo
  echo "    Run the allow lines FIRST. Enabling ufw before allowing 22 will"
  echo "    disconnect you, and keep a second session open until you have"
  echo "    confirmed you can still get back in."
fi
warn "Your VPS host has a separate firewall in its web panel. Ports 80 and 443"
warn "must be open there too, or the certificate will never be issued."

# --- Start ------------------------------------------------------------------
step "Starting services"

systemctl enable --now "${APP_NAME}" >/dev/null 2>&1 || true
systemctl restart "${APP_NAME}"
systemctl enable --now "${APP_NAME}-backup.timer" >/dev/null 2>&1 || true
systemctl enable caddy >/dev/null 2>&1 || true
if systemctl restart caddy 2>/dev/null && systemctl is-active --quiet caddy; then
  ok "Caddy is running"
else
  warn "Caddy failed to start. HTTPS cannot work until this is fixed, and it is"
  warn "NOT a firewall problem — the reason is in its own log:"
  echo
  journalctl -u caddy -n 15 --no-pager 2>/dev/null | sed 's/^/      /' || true
  echo
  CADDY_FAILED=1
fi

# Wait for the app to answer locally.
HEALTHY=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${APP_PORT}/health" >/dev/null 2>&1; then
    HEALTHY=1
    break
  fi
  sleep 1
done

if [ "$HEALTHY" -ne 1 ]; then
  printf '\n%s  error%s The service did not become healthy.\n\n' "$R" "$N" >&2
  echo "Recent logs:" >&2
  journalctl -u "${APP_NAME}" -n 40 --no-pager >&2 || true
  exit 1
fi
ok "Local health check passed"

# Certificate issuance takes a few seconds on first run.
TLS_OK=0
for _ in $(seq 1 45); do
  if curl -fsS --max-time 3 "https://${SITE}/health" >/dev/null 2>&1; then
    TLS_OK=1
    break
  fi
  sleep 2
done

# --- Summary ----------------------------------------------------------------
printf '\n%s================================================================%s\n' "$B" "$N"
printf '%s  Installation complete%s\n' "$G" "$N"
printf '%s================================================================%s\n\n' "$B" "$N"

if [ "$TLS_MODE" = "internal" ]; then
  step "Exporting the local certificate authority"
  # Caddy writes its root only after it has started and issued something, so
  # this runs late. Players need this file to trust the connection.
  CA_SRC="$(find_caddy_root_ca || true)"
  if [ -n "$CA_SRC" ]; then
    install -m 0644 "$CA_SRC" "${CONF_DIR}/local-ca.crt"
    ok "CA exported to ${CONF_DIR}/local-ca.crt"
  else
    warn "Could not locate Caddy's root CA yet. After the first connection, find it with:"
    warn "  sudo find / -name root.crt -path '*caddy*' 2>/dev/null"
  fi
fi

# Record it somewhere findable, so nobody has to scroll back through a terminal.
echo "https://${SITE}" > "${CONF_DIR}/backend-url.txt"
chmod 644 "${CONF_DIR}/backend-url.txt"

if [ "$TLS_OK" -eq 1 ]; then
  printf '\n%s  Paste this into the mod'"'"'s Backend URL setting:%s\n\n' "$B" "$N"
  printf '      %shttps://%s%s\n\n' "$B" "$DOMAIN" "$N"
  ok "HTTPS is live and serving"
else
  warn "The service is running, but HTTPS is not answering yet at https://${SITE}"
  echo
  if [ "${CADDY_FAILED:-0}" -eq 1 ] || ! systemctl is-active --quiet caddy; then
    echo "    The cause is Caddy itself: it is not running, so nothing is"
    echo "    listening on 443 and no certificate has been requested. Your"
    echo "    firewall is not the problem. The error is above, and in:"
    echo "        sudo journalctl -u caddy -n 30 --no-pager"
  else
    echo "    Caddy is running, so this is now a reachability question."
    echo "    Certificate issuance needs ports 80 AND 443 open from the internet."
    echo "    On Contabo, check the firewall in the web panel as well as ufw."
    echo "    Watch issuance happen with:"
    echo "        sudo journalctl -u caddy -f"
  fi
  echo
  echo "    Once it succeeds, the mod's Backend URL is:  https://${SITE}"
fi

if [ -n "$AUTO_HOSTNAME" ]; then
  echo
  echo "  That hostname is automatic (sslip.io resolves it to this server's IP),"
  echo "  so there was no domain to buy or DNS to configure. To move to your own"
  echo "  domain later, point an A record at ${PUBLIC_IP} and re-run with:"
  echo "      sudo DOMAIN=rp.yourdomain.com bash ${APP_DIR}/deploy/install.sh"
fi

if [ "${NEW_TOKEN:-0}" -eq 1 ]; then
  echo
  printf '%s  Save your admin token now — it is not shown again:%s\n' "$B" "$N"
  echo "      ${ADMIN_TOKEN}"
  echo "  (It also lives in ${ENV_FILE}, readable by root.)"
fi

if [ -f "${BACKUP_DIR}/.last-v1-profiles" ]; then
  V1="$(cat "${BACKUP_DIR}/.last-v1-profiles")"
  echo
  printf '%s  Old profiles from the Docker deployment were saved.%s\n' "$B" "$N"
  echo "  Import them (existing passwords keep working) with:"
  echo "      sudo -u ${APP_USER} DATA_DIR=${DATA_DIR} node ${APP_DIR}/scripts/migrate-from-v1.js ${V1}"
fi

cat <<EOF

  Useful commands
    systemctl status ${APP_NAME}
    journalctl -u ${APP_NAME} -f
    journalctl -u caddy -f
    sudo bash ${APP_DIR}/deploy/update.sh      # pull latest and restart
    sudo bash ${APP_DIR}/deploy/backup.sh      # manual backup
    systemd-analyze security ${APP_NAME}       # review the sandbox

  Layout
    code    ${APP_DIR}        (root-owned, service cannot modify it)
    data    ${DATA_DIR}       (${APP_USER}-owned)
    config  ${ENV_FILE}
    backups ${BACKUP_DIR}     (daily, 14 kept)

EOF
