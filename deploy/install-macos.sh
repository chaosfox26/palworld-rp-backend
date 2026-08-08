#!/usr/bin/env bash
#
# Native installer for macOS.
#
#     sudo bash deploy/install-macos.sh
#
# Uses Homebrew for Node and Caddy, and launchd to keep the service running.
# Idempotent: re-run to upgrade in place without touching data.
#
set -euo pipefail

APP_NAME="palworld-rp-backend"
APP_LABEL="io.palworldrp.backend"
APP_DIR="/usr/local/opt/${APP_NAME}"
DATA_DIR="/usr/local/var/${APP_NAME}"
CONF_DIR="/usr/local/etc/${APP_NAME}"
ENV_FILE="${CONF_DIR}/env"
BACKUP_DIR="/usr/local/var/backups/${APP_NAME}"
LOG_DIR="/usr/local/var/log/${APP_NAME}"
PLIST="/Library/LaunchDaemons/${APP_LABEL}.plist"
APP_PORT=3000

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/lib.sh
. "${LIB_DIR}/lib.sh"

trap 'die "Install failed at line $LINENO. Re-running is safe; your data in '"$DATA_DIR"' is untouched."' ERR
reattach_tty

# --- Preflight --------------------------------------------------------------
step "Preflight checks"

[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS. On Linux use deploy/install.sh."
[ "$(id -u)" -eq 0 ] || die "Run this with sudo: sudo bash deploy/install-macos.sh"

REPO_ROOT="$(cd "${LIB_DIR}/.." && pwd)"
[ -f "${REPO_ROOT}/server.js" ] || die "Run this from inside the repository checkout."
ok "Repository found at ${REPO_ROOT}"
ok "macOS $(sw_vers -productVersion 2>/dev/null || echo '?') on $(uname -m)"

# Homebrew installs into different prefixes on Intel and Apple Silicon, and it
# refuses to run as root — so find the invoking user and run brew as them.
REAL_USER="${SUDO_USER:-$(stat -f '%Su' /dev/console)}"
[ -n "$REAL_USER" ] && [ "$REAL_USER" != "root" ] \
  || die "Could not determine which user to run Homebrew as. Run with sudo from a normal account."

BREW=""
for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  [ -x "$candidate" ] && BREW="$candidate" && break
done

if [ -z "$BREW" ]; then
  step "Installing Homebrew"
  warn "Homebrew is required and is not installed."
  warn "Install it (as your normal user, not root) then re-run this script:"
  echo
  echo '    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  echo
  die "Homebrew missing."
fi
ok "Homebrew at ${BREW}"

brew_as_user() { sudo -u "$REAL_USER" "$BREW" "$@"; }

# Homebrew's prefix differs by architecture: /usr/local on Intel, /opt/homebrew
# on Apple Silicon. Caddy's formula reads its config from <prefix>/etc/Caddyfile,
# so this must be resolved rather than assumed or the config is silently ignored.
BREW_PREFIX="$(brew_as_user --prefix 2>/dev/null || true)"
[ -n "$BREW_PREFIX" ] || BREW_PREFIX="$(dirname "$(dirname "$BREW")")"
ok "Homebrew prefix ${BREW_PREFIX}"

# --- Configuration ----------------------------------------------------------
step "Configuration"

EXISTING_DOMAIN=""; EXISTING_EMAIL=""; EXISTING_ADMIN=""; EXISTING_TLS_MODE=""
if [ -f "$ENV_FILE" ]; then
  EXISTING_DOMAIN="$(grep -E '^DOMAIN=' "$ENV_FILE" | cut -d= -f2- || true)"
  EXISTING_EMAIL="$(grep -E '^ACME_EMAIL=' "$ENV_FILE" | cut -d= -f2- || true)"
  EXISTING_ADMIN="$(grep -E '^ADMIN_TOKEN=' "$ENV_FILE" | cut -d= -f2- || true)"
  EXISTING_TLS_MODE="$(grep -E '^TLS_MODE=' "$ENV_FILE" | cut -d= -f2- || true)"
  ok "Reusing existing configuration at ${ENV_FILE}"
fi

DOMAIN="${DOMAIN:-$EXISTING_DOMAIN}"
ACME_EMAIL="${ACME_EMAIL:-$EXISTING_EMAIL}"
TLS_MODE="${TLS_MODE:-$EXISTING_TLS_MODE}"

decide_tls_mode

# --- Dependencies -----------------------------------------------------------
step "Installing Node.js and Caddy"

need_node=1
if command -v node >/dev/null 2>&1; then
  CURRENT="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$CURRENT" -ge 20 ] 2>/dev/null; then
    need_node=0
    ok "Node $(node -v) already installed"
  fi
fi
[ "$need_node" -eq 1 ] && { brew_as_user install node@22 >/dev/null; ok "Node installed"; }

if command -v caddy >/dev/null 2>&1; then
  ok "Caddy already installed"
else
  brew_as_user install caddy >/dev/null
  ok "Caddy installed"
fi

NODE_BIN="$(command -v node)"
CADDY_BIN="$(command -v caddy)"

# --- Service account --------------------------------------------------------
step "Creating the service account"

# macOS has no useradd. dscl needs a free UID in the system range; 200-400 is
# conventional for daemons and is below the 501 where real users begin.
if dscl . -read "/Users/_palrp" >/dev/null 2>&1; then
  ok "User _palrp already exists"
else
  NEXT_UID=401
  while dscl . -list /Users UniqueID | awk '{print $2}' | grep -qx "$NEXT_UID"; do
    NEXT_UID=$((NEXT_UID + 1))
  done
  dscl . -create /Groups/_palrp PrimaryGroupID "$NEXT_UID"
  dscl . -create /Users/_palrp UniqueID "$NEXT_UID"
  dscl . -create /Users/_palrp PrimaryGroupID "$NEXT_UID"
  dscl . -create /Users/_palrp UserShell /usr/bin/false
  dscl . -create /Users/_palrp NFSHomeDirectory /var/empty
  dscl . -create /Users/_palrp RealName "Palworld RP Backend"
  # No password hash at all: the account cannot be authenticated into.
  dscl . -create /Users/_palrp Password '*'
  ok "User _palrp created (uid ${NEXT_UID}, no shell, no password)"
fi

# --- Application ------------------------------------------------------------
step "Installing application to ${APP_DIR}"

mkdir -p "$APP_DIR" "$DATA_DIR" "$CONF_DIR" "$BACKUP_DIR" "$LOG_DIR"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude node_modules --exclude data --exclude .env \
    "${REPO_ROOT}/" "${APP_DIR}/"
else
  tar -C "$REPO_ROOT" --exclude=node_modules --exclude=data --exclude=.env -cf - . \
    | tar -C "$APP_DIR" -xf -
fi
chown -R root:wheel "$APP_DIR"
ok "Source installed"

cd "$APP_DIR"
# npm-shrinkwrap.json is the lockfile npm actually ships inside a package;
# package-lock.json is stripped from every pack. See install.sh for detail.
if [ -f npm-shrinkwrap.json ] || [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund
else
  warn "No lockfile found, so dependency versions are resolved fresh."
  warn "For reproducible installs: npm install && npm shrinkwrap, then commit it."
  npm install --omit=dev --no-audit --no-fund
fi
ok "Dependencies installed"

chown -R _palrp:_palrp "$DATA_DIR" "$LOG_DIR"
chmod 750 "$DATA_DIR"
chmod 700 "$BACKUP_DIR"

# --- Command on PATH --------------------------------------------------------
step "Installing the palworld-rp command"

cat > /usr/local/bin/palworld-rp <<EOF
#!/bin/sh
exec "${NODE_BIN}" "${APP_DIR}/bin/palworld-rp.js" "\$@"
EOF
chmod 0755 /usr/local/bin/palworld-rp
ok "palworld-rp is now on your PATH"

# --- Environment ------------------------------------------------------------
step "Writing ${ENV_FILE}"

ADMIN_TOKEN="$EXISTING_ADMIN"
NEW_TOKEN=0
if [ -z "$ADMIN_TOKEN" ]; then
  ADMIN_TOKEN="$(openssl rand -base64 32)"
  NEW_TOKEN=1
fi

cat > "$ENV_FILE" <<EOF
# Written by deploy/install-macos.sh. Edit, then:
#   sudo launchctl kickstart -k system/${APP_LABEL}

DOMAIN=${SITE}
TLS_MODE=${TLS_MODE}
ACME_EMAIL=${ACME_EMAIL}
ADMIN_TOKEN=${ADMIN_TOKEN}

HOST=127.0.0.1
PORT=${APP_PORT}
DATA_DIR=${DATA_DIR}
TRUST_PROXY_HOPS=1
WARN_IF_INSECURE=false

REQUIRE_ENCRYPTION=true
SESSION_TTL_MINUTES=720
MIN_PASSWORD_LENGTH=8
MAX_PASSWORD_LENGTH=200
MAX_SESSIONS_PER_ACCOUNT=5
MAX_SOCKETS_PER_ACCOUNT=8
MAX_GUILDS_OWNED=3
MAX_ACCOUNTS=50000
MAX_MESSAGE_BYTES=100000
MAX_PROFILE_BYTES=262144
MAX_PROFILE_DEPTH=12
CHAT_BURST_BYTES=4000000
CHAT_REFILL_BYTES_PER_SEC=512000
CHAT_BURST_MESSAGES=20
CHAT_REFILL_MESSAGES_PER_SEC=4
SOCKET_QUERY_BURST=30
SOCKET_QUERY_REFILL_PER_SEC=5
LOCAL_CHAT_RADIUS=3000
POSITION_UPDATES_PER_SEC=5
MAX_PARTY_SIZE=8
MAX_CHANNELS_PER_ACCOUNT=10
MAX_MUTES_PER_ACCOUNT=500
REGISTER_PER_HOUR=5
LOGIN_PER_MINUTE=20
PROFILE_WRITES_PER_MINUTE=20
WRITES_PER_MINUTE=60
READS_PER_MINUTE=240
SEARCH_MAX_RESULTS=25
SEARCH_MIN_QUERY_LENGTH=1
LOG_LEVEL=info
CORS_ORIGIN=*
NODE_ENV=production
EOF
chown root:_palrp "$ENV_FILE"
chmod 640 "$ENV_FILE"
ok "Environment written"

# --- Caddy ------------------------------------------------------------------
step "Configuring Caddy for ${SITE}"

# The Homebrew caddy formula runs: caddy run --config <prefix>/etc/Caddyfile
# Writing anywhere else means brew services starts Caddy with a different (or
# absent) config and this whole step accomplishes nothing.
CADDY_CONF_DIR="${BREW_PREFIX}/etc"
CADDY_CONF="${CADDY_CONF_DIR}/Caddyfile"
CADDY_LOG_DIR="${BREW_PREFIX}/var/log/caddy"
mkdir -p "$CADDY_CONF_DIR" "$CADDY_LOG_DIR"

# Caddy must run as root to bind 443 (macOS reserves ports below 1024), so the
# log directory is root-owned to match. `caddy validate` never opens this file,
# so an unwritable directory would pass validation and then crash at startup.
chown root:wheel "$CADDY_LOG_DIR" 2>/dev/null || true
chmod 0755 "$CADDY_LOG_DIR"

if [ -f "$CADDY_CONF" ] && [ ! -f "${CADDY_CONF}.orig" ]; then
  cp -a "$CADDY_CONF" "${CADDY_CONF}.orig"
  ok "Existing Caddyfile saved to ${CADDY_CONF}.orig"
fi

if [ -n "$ACME_EMAIL" ]; then
  sed -e "/BEGIN_EMAIL/d" -e "/END_EMAIL/d" -e "s|{{ACME_EMAIL}}|${ACME_EMAIL}|g" \
    "${APP_DIR}/deploy/Caddyfile.template" > /tmp/Caddyfile.stage
else
  sed -e "/BEGIN_EMAIL/,/END_EMAIL/d" "${APP_DIR}/deploy/Caddyfile.template" > /tmp/Caddyfile.stage
fi
caddy_tls_block > /tmp/Caddyfile.tls
sed -e "s|{{SITE}}|${SITE}|g" -e "s|{{APP_PORT}}|${APP_PORT}|g" \
    -e "s|/var/log/caddy|${CADDY_LOG_DIR}|g" \
    -e "/{{TLS_BLOCK}}/r /tmp/Caddyfile.tls" -e "/{{TLS_BLOCK}}/d" \
    /tmp/Caddyfile.stage > "$CADDY_CONF"
rm -f /tmp/Caddyfile.stage /tmp/Caddyfile.tls

"$CADDY_BIN" validate --config "$CADDY_CONF" >/dev/null 2>&1 \
  || die "Generated Caddyfile failed validation. Inspect ${CADDY_CONF}."
ok "Caddyfile written and validated at ${CADDY_CONF}"

# Deliberately NOT brew_as_user here. A user-level LaunchAgent cannot bind port
# 443 on macOS, so Caddy has to be a root LaunchDaemon. `brew services` run as
# root installs into /Library/LaunchDaemons, which is what that requires.
"$BREW" services restart caddy >/dev/null 2>&1 || "$BREW" services start caddy >/dev/null 2>&1 || true
sleep 2
if pgrep -x caddy >/dev/null 2>&1; then
  ok "Caddy running as root (required to bind 443)"
else
  warn "Caddy is not running. HTTPS cannot work until it is, and this is not a"
  warn "firewall problem. Check its log:"
  warn "    tail -50 ${BREW_PREFIX}/var/log/caddy.log"
  CADDY_FAILED=1
fi

# --- launchd ----------------------------------------------------------------
step "Installing the launchd service"

# launchd has no EnvironmentFile equivalent, so the daemon is started through a
# tiny shell wrapper that sources the env file. This keeps configuration in one
# place and out of the plist, which would otherwise need regenerating on every
# settings change.
cat > "${APP_DIR}/deploy/launchd-run.sh" <<EOF
#!/bin/sh
set -a
. "${ENV_FILE}"
set +a
exec "${NODE_BIN}" "${APP_DIR}/server.js"
EOF
chmod 755 "${APP_DIR}/deploy/launchd-run.sh"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${APP_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${APP_DIR}/deploy/launchd-run.sh</string></array>
  <key>UserName</key><string>_palrp</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>${APP_DIR}</string>
  <key>StandardOutPath</key><string>${LOG_DIR}/out.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/err.log</string>
  <key>ProcessType</key><string>Background</string>
  <key>SoftResourceLimits</key><dict><key>NumberOfFiles</key><integer>65535</integer></dict>
</dict>
</plist>
EOF
chmod 644 "$PLIST"
chown root:wheel "$PLIST"

launchctl bootout "system/${APP_LABEL}" 2>/dev/null || true
launchctl bootstrap system "$PLIST"
launchctl enable "system/${APP_LABEL}" 2>/dev/null || true
ok "Service loaded and enabled at boot"

# --- Health -----------------------------------------------------------------
step "Waiting for the service"

HEALTHY=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${APP_PORT}/health" >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 1
done
[ "$HEALTHY" -eq 1 ] || {
  printf '\n%s  error%s Service did not become healthy. Recent log:\n' "$R" "$N" >&2
  tail -30 "${LOG_DIR}/err.log" 2>/dev/null >&2 || true
  exit 1
}
ok "Local health check passed"

if [ "$TLS_MODE" = "internal" ]; then
  CA_SRC="$(find_caddy_root_ca || true)"
  if [ -n "$CA_SRC" ]; then
    install -m 0644 "$CA_SRC" "${CONF_DIR}/local-ca.crt"
    ok "Local CA exported to ${CONF_DIR}/local-ca.crt"
  fi
fi

echo "https://${SITE}" > "${CONF_DIR}/backend-url.txt"

# Does HTTPS actually answer? Claiming success without checking is how a dead
# Caddy gets reported as a working install.
TLS_OK=0
for _ in $(seq 1 20); do
  if curl -fsSk --max-time 3 "https://${SITE}/health" >/dev/null 2>&1; then TLS_OK=1; break; fi
  sleep 2
done

printf '\n%s================================================================%s\n' "$B" "$N"
printf '%s  Installation complete%s\n' "$G" "$N"
printf '%s================================================================%s\n\n' "$B" "$N"
if [ "$TLS_OK" -eq 1 ]; then
  printf '%s  Paste this into the mod'"'"'s Backend URL setting:%s\n\n' "$B" "$N"
  printf '      %shttps://%s%s\n\n' "$B" "$SITE" "$N"
  ok "HTTPS is live and serving"
else
  warn "The service is running, but HTTPS is not answering yet at https://${SITE}"
  echo
  if [ "${CADDY_FAILED:-0}" -eq 1 ] || ! pgrep -x caddy >/dev/null 2>&1; then
    echo "    The cause is Caddy itself: it is not running, so nothing is"
    echo "    listening on 443. This is not a firewall problem. Check:"
    echo "        tail -50 ${BREW_PREFIX}/var/log/caddy.log"
  else
    echo "    Caddy is running, so this is a reachability question. Issuance"
    echo "    needs ports 80 AND 443 open from the internet."
    echo "        tail -f ${BREW_PREFIX}/var/log/caddy.log"
  fi
  echo
  echo "    Once it succeeds, the mod's Backend URL is:  https://${SITE}"
  echo
fi

if [ "$TLS_MODE" = "internal" ]; then
  echo "  This install uses a locally-issued certificate. Every player's mod must"
  echo "  trust ${CONF_DIR}/local-ca.crt, or the connection will be refused."
  echo "  Send that file along with the mod. See ENCRYPTION.md."
  echo
fi
if [ "$NEW_TOKEN" -eq 1 ]; then
  printf '%s  Admin token (not shown again):%s\n      %s\n\n' "$B" "$N" "$ADMIN_TOKEN"
fi

cat <<EOF
  Useful commands
    sudo launchctl kickstart -k system/${APP_LABEL}   # restart
    sudo launchctl bootout system/${APP_LABEL}        # stop
    tail -f ${LOG_DIR}/out.log                        # logs
    sudo bash ${APP_DIR}/deploy/doctor.sh             # diagnose

  Layout
    code    ${APP_DIR}
    data    ${DATA_DIR}
    config  ${ENV_FILE}
    logs    ${LOG_DIR}

EOF
