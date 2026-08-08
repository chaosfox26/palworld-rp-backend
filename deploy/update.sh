#!/usr/bin/env bash
#
# Pull the latest code and restart, with an automatic rollback if the new
# version fails its health check.
#
#     sudo bash /opt/palworld-rp-backend/deploy/update.sh
#
set -euo pipefail

APP_NAME="palworld-rp-backend"

case "$(uname -s)" in
  Darwin)
    PLATFORM="macos"
    APP_DIR="/usr/local/opt/${APP_NAME}"
    ENV_FILE="/usr/local/etc/${APP_NAME}/env"
    SERVICE_LABEL="io.palworldrp.backend"
    ;;
  Linux)
    PLATFORM="linux"
    APP_DIR="/opt/${APP_NAME}"
    ENV_FILE="/etc/${APP_NAME}/env"
    SERVICE_LABEL="${APP_NAME}"
    ;;
  *)
    echo "This script supports Linux and macOS." >&2
    echo "On Windows, re-run deploy\\install-windows.ps1 from an Administrator PowerShell." >&2
    exit 2
    ;;
esac

APP_PORT="$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || echo 3000)"

restart_service() {
  if [ "$PLATFORM" = "macos" ]; then
    launchctl kickstart -k "system/${SERVICE_LABEL}"
  else
    systemctl restart "$APP_NAME"
  fi
}
refresh_units() {
  if [ "$PLATFORM" = "linux" ]; then
    install -m 0644 "${APP_DIR}/deploy/${APP_NAME}.service" "/etc/systemd/system/${APP_NAME}.service"
    install -m 0644 "${APP_DIR}/deploy/${APP_NAME}-backup.service" "/etc/systemd/system/${APP_NAME}-backup.service"
    install -m 0644 "${APP_DIR}/deploy/${APP_NAME}-backup.timer" "/etc/systemd/system/${APP_NAME}-backup.timer"
    systemctl daemon-reload
  fi
  # macOS: the plist points at a wrapper inside APP_DIR, so a code update needs
  # no plist change. Re-run install-macos.sh if the plist itself must change.
}

if [ -t 1 ]; then G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; B=$'\e[1m'; N=$'\e[0m'; else G=""; Y=""; R=""; B=""; N=""; fi
step() { printf '\n%s==> %s%s\n' "$B" "$1" "$N"; }
ok()   { printf '%s  ok%s   %s\n' "$G" "$N" "$1"; }
warn() { printf '%s  warn%s %s\n' "$Y" "$N" "$1"; }
die()  { printf '\n%s  error%s %s\n\n' "$R" "$N" "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run with sudo."
[ -d "${APP_DIR}/.git" ] || die "${APP_DIR} is not a git checkout, so there is nothing to pull.
  That is normal if you installed with npx. Update the same way you installed:

      npx palworld-rp@latest install

  It is idempotent and keeps your data and configuration."

cd "$APP_DIR"

step "Backing up data first"
bash "${APP_DIR}/deploy/backup.sh" || warn "Backup failed; continuing anyway."

step "Fetching latest code"
PREVIOUS="$(git rev-parse HEAD)"
git fetch --quiet origin
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git reset --hard --quiet "origin/${BRANCH}"
CURRENT="$(git rev-parse HEAD)"

if [ "$PREVIOUS" = "$CURRENT" ]; then
  ok "Already up to date at ${CURRENT:0:8}; restarting anyway to pick up config changes."
else
  ok "Updated ${PREVIOUS:0:8} -> ${CURRENT:0:8}"
  git --no-pager log --oneline "${PREVIOUS}..${CURRENT}" | sed 's/^/      /'
fi

step "Installing dependencies"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"

step "Refreshing service definitions"
refresh_units

step "Restarting"
restart_service

for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${APP_PORT}/health" >/dev/null 2>&1; then
    ok "Health check passed. Now running ${CURRENT:0:8}."
    exit 0
  fi
  sleep 1
done

# Health check failed: put the previous commit back rather than leaving the
# server down while you debug.
printf '\n%s  error%s New version failed its health check. Rolling back to %s.\n' "$R" "$N" "${PREVIOUS:0:8}" >&2
git reset --hard --quiet "$PREVIOUS"
npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1
restart_service

sleep 3
if curl -fsS --max-time 2 "http://127.0.0.1:${APP_PORT}/health" >/dev/null 2>&1; then
  warn "Rolled back successfully. The server is up on the previous version."
else
  printf '%s  error%s Rollback also failed. Investigate now:\n' "$R" "$N" >&2
  if [ "$PLATFORM" = "macos" ]; then
    tail -n 40 "/usr/local/var/log/${APP_NAME}/err.log" >&2 2>/dev/null || true
  else
    journalctl -u "$APP_NAME" -n 40 --no-pager >&2 || true
  fi
fi
exit 1
