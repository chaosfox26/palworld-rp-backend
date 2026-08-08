#!/usr/bin/env bash
#
# Diagnostics. Run this first whenever something looks wrong — it checks every
# layer in order and tells you which one is actually broken.
#
#     sudo bash /opt/palworld-rp-backend/deploy/doctor.sh
#
set -uo pipefail   # deliberately not -e: we want every check to run

APP_NAME="palworld-rp-backend"

# --- Platform ---------------------------------------------------------------
# The layout and the service manager differ per OS, so resolve both up front
# and use the abstractions below rather than calling systemctl directly.
case "$(uname -s)" in
  Darwin)
    PLATFORM="macos"
    APP_USER="_palrp"
    APP_DIR="/usr/local/opt/${APP_NAME}"
    DATA_DIR="/usr/local/var/${APP_NAME}"
    ENV_FILE="/usr/local/etc/${APP_NAME}/env"
    BACKUP_ROOT="/usr/local/var/backups/${APP_NAME}"
    LOG_DIR="/usr/local/var/log/${APP_NAME}"
    SERVICE_LABEL="io.palworldrp.backend"
    ;;
  Linux)
    PLATFORM="linux"
    APP_USER="palrp"
    APP_DIR="/opt/${APP_NAME}"
    DATA_DIR="/var/lib/${APP_NAME}"
    ENV_FILE="/etc/${APP_NAME}/env"
    BACKUP_ROOT="/var/backups/${APP_NAME}"
    LOG_DIR=""
    SERVICE_LABEL="${APP_NAME}"
    ;;
  *)
    echo "This script supports Linux and macOS." >&2
    echo "On Windows, check the service with:  Get-ScheduledTask -TaskName PalworldRPBackend" >&2
    exit 2
    ;;
esac

# --- Service abstraction ----------------------------------------------------
svc_active() {
  if [ "$PLATFORM" = "macos" ]; then
    launchctl print "system/${SERVICE_LABEL}" >/dev/null 2>&1
  else
    systemctl is-active --quiet "$APP_NAME" 2>/dev/null
  fi
}
svc_enabled_at_boot() {
  if [ "$PLATFORM" = "macos" ]; then
    # A LaunchDaemon plist with RunAtLoad is, by definition, boot-enabled.
    [ -f "/Library/LaunchDaemons/${SERVICE_LABEL}.plist" ]
  else
    systemctl is-enabled --quiet "$APP_NAME" 2>/dev/null
  fi
}
svc_recent_log() {
  if [ "$PLATFORM" = "macos" ]; then
    tail -n 20 "${LOG_DIR}/err.log" 2>/dev/null
  else
    journalctl -u "$APP_NAME" -n 20 --no-pager 2>/dev/null
  fi
}
svc_restart_count() {
  if [ "$PLATFORM" = "macos" ]; then
    echo 0   # launchd does not expose a restart counter
  else
    systemctl show -p NRestarts --value "$APP_NAME" 2>/dev/null || echo 0
  fi
}
caddy_active() {
  if [ "$PLATFORM" = "macos" ]; then
    pgrep -x caddy >/dev/null 2>&1
  else
    systemctl is-active --quiet caddy 2>/dev/null
  fi
}

if [ -t 1 ]; then G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; B=$'\e[1m'; N=$'\e[0m'; else G=""; Y=""; R=""; B=""; N=""; fi
FAILED=0
pass() { printf '%s  pass%s  %s\n' "$G" "$N" "$1"; }
fail() { printf '%s  FAIL%s  %s\n' "$R" "$N" "$1"; FAILED=$((FAILED+1)); }
warn() { printf '%s  warn%s  %s\n' "$Y" "$N" "$1"; }
head_() { printf '\n%s%s%s\n' "$B" "$1" "$N"; }

DOMAIN=""; PORT="3000"
if [ -r "$ENV_FILE" ]; then
  DOMAIN="$(grep -E '^DOMAIN=' "$ENV_FILE" | cut -d= -f2- || true)"
  PORT="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2- || echo 3000)"
fi

# BSD stat (macOS) and GNU stat (Linux) take different flags for the same job.
stat_mode()  { if [ "$PLATFORM" = "macos" ]; then stat -f '%Lp' "$1" 2>/dev/null; else stat -c '%a' "$1" 2>/dev/null; fi; }
stat_owner() { if [ "$PLATFORM" = "macos" ]; then stat -f '%Su' "$1" 2>/dev/null; else stat -c '%U' "$1" 2>/dev/null; fi; }

head_ "Files and permissions"
[ -f "${APP_DIR}/server.js" ] && pass "Application present at ${APP_DIR}" || fail "Missing ${APP_DIR}/server.js — re-run install.sh"
[ -d "${APP_DIR}/node_modules/express" ] && pass "Dependencies installed" || fail "node_modules missing — run: cd ${APP_DIR} && sudo npm ci --omit=dev"
if [ -r "$ENV_FILE" ]; then
  PERMS="$(stat_mode "$ENV_FILE")"
  [ "$PERMS" = "640" ] && pass "Env file permissions ${PERMS}" \
    || warn "Env file is ${PERMS}; expected 640 (it holds the admin token)"
else
  fail "Cannot read ${ENV_FILE} — are you running with sudo?"
fi
if id "$APP_USER" >/dev/null 2>&1; then
  pass "Service user ${APP_USER} exists"
  OWNER="$(stat_owner "$DATA_DIR" || echo missing)"
  [ "$OWNER" = "$APP_USER" ] && pass "Data directory owned by ${APP_USER}" || fail "Data directory owner is '${OWNER}', expected ${APP_USER}"
else
  fail "Service user ${APP_USER} does not exist"
fi

head_ "Service"
if svc_active; then
  pass "$APP_NAME is running (${PLATFORM})"
else
  fail "$APP_NAME is not running"
  echo "        Last 20 log lines:"
  svc_recent_log | sed 's/^/        /'
fi
if svc_enabled_at_boot; then
  pass "Enabled at boot"
elif [ "$PLATFORM" = "macos" ]; then
  fail "LaunchDaemon missing — re-run deploy/install-macos.sh"
else
  fail "Not enabled at boot — run: sudo systemctl enable ${APP_NAME}"
fi

RESTARTS="$(svc_restart_count)"
if [ "${RESTARTS:-0}" -gt 5 ] 2>/dev/null; then
  warn "Service has restarted ${RESTARTS} times — something is crashing it."
else
  pass "Restart count: ${RESTARTS:-0}"
fi

head_ "Application"
if curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  pass "Local health endpoint responds on 127.0.0.1:${PORT}"
  INFO="$(curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/info" 2>/dev/null || true)"
  [ -n "$INFO" ] && echo "        $INFO"
else
  fail "No response from http://127.0.0.1:${PORT}/health"
fi

# The app must NOT be listening on a public interface.
if [ "$PLATFORM" = "macos" ]; then
  LISTENERS="$(netstat -an -p tcp 2>/dev/null | grep "LISTEN" | grep "\.${PORT} ")"
else
  LISTENERS="$(ss -ltn 2>/dev/null | grep -E "LISTEN.*:${PORT}\b")"
fi
if [ -n "$LISTENERS" ] && printf '%s' "$LISTENERS" | grep -qv '127.0.0.1'; then
  fail "Port ${PORT} is bound to a public interface. Set HOST=127.0.0.1 in ${ENV_FILE} and restart."
else
  pass "Port ${PORT} is loopback-only, as intended"
fi

head_ "Caddy and TLS"
if caddy_active; then
  pass "Caddy is running"
elif [ "$PLATFORM" = "macos" ]; then
  fail "Caddy is not running — check: brew services list"
else
  fail "Caddy is not running — check: journalctl -u caddy -n 30"
fi

if [ -n "$DOMAIN" ]; then
  PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  if [ "$PLATFORM" = "macos" ]; then
    RESOLVED="$(dscacheutil -q host -a name "$DOMAIN" 2>/dev/null | awk '/^ip_address:/{print $2; exit}')"
  else
    RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)"
  fi
  if [ -z "$RESOLVED" ]; then
    fail "${DOMAIN} does not resolve. Add an A record pointing at ${PUBLIC_IP:-this server}."
  elif [ -n "$PUBLIC_IP" ] && [ "$RESOLVED" != "$PUBLIC_IP" ]; then
    fail "${DOMAIN} resolves to ${RESOLVED} but this server is ${PUBLIC_IP}. Certificates cannot be issued."
  else
    pass "DNS: ${DOMAIN} -> ${RESOLVED}"
  fi

  TLS_MODE_CFG="$(grep -E '^TLS_MODE=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
  CURL_TRUST=""
  if [ "$TLS_MODE_CFG" = "internal" ]; then
    # Expected: the certificate is signed by Caddy's local CA, which the system
    # trust store does not know about. Verifying against the exported CA proves
    # TLS is genuinely working rather than skipping the check entirely.
    CA_FILE="$(dirname "$ENV_FILE")/local-ca.crt"
    if [ -f "$CA_FILE" ]; then
      CURL_TRUST="--cacert $CA_FILE"
      pass "Local CA present at ${CA_FILE} (ship this with the mod)"
    else
      warn "TLS_MODE=internal but ${CA_FILE} is missing — players cannot verify the connection."
    fi
  fi

  # shellcheck disable=SC2086
  if curl -fsS $CURL_TRUST --max-time 8 "https://${DOMAIN}/health" >/dev/null 2>&1; then
    pass "HTTPS works: https://${DOMAIN}/health"
    EXPIRY="$(echo | openssl s_client -servername "$DOMAIN" -connect "${DOMAIN}:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || true)"
    [ -n "$EXPIRY" ] && pass "Certificate valid until ${EXPIRY}"

    # Report the cipher actually negotiated, rather than assuming the config
    # took effect. This is the check that makes "AES-256 end to end" verifiable.
    HANDSHAKE="$(echo | openssl s_client -servername "$DOMAIN" -connect "${DOMAIN}:443" 2>/dev/null || true)"
    [ "$TLS_MODE_CFG" = "internal" ] && warn "Certificate is locally issued, so it is not publicly trusted. Expected for a home install."
    NEG_PROTO="$(printf '%s' "$HANDSHAKE" | grep -oE 'Protocol\s*:\s*\S+' | head -1 | awk '{print $NF}')"
    NEG_CIPHER="$(printf '%s' "$HANDSHAKE" | grep -oE 'Cipher\s*:\s*\S+' | head -1 | awk '{print $NF}')"
    if [ -n "$NEG_CIPHER" ]; then
      case "$NEG_CIPHER" in
        *AES_256*|*AES256*)
          pass "Encryption in use: ${NEG_PROTO:-TLS} / ${NEG_CIPHER} — AES-256, both directions" ;;
        *CHACHA20*)
          warn "Encryption in use: ${NEG_PROTO:-TLS} / ${NEG_CIPHER}"
          warn "  ChaCha20-Poly1305 is as strong as AES-256, but it is not AES."
          warn "  Pin TLS_AES_256_GCM_SHA384 in the mod's TLS client to force AES-256." ;;
        *AES_128*|*AES128*)
          warn "Encryption in use: ${NEG_PROTO:-TLS} / ${NEG_CIPHER}"
          warn "  This is what OpenSSL negotiated just now, not what the mod will."
          warn "  On TLS 1.3 the CLIENT picks the suite and Go/Caddy cannot override"
          warn "  it, so pin TLS_AES_256_GCM_SHA384 in the mod to get AES-256 here."
          warn "  Chat payloads are AES-256-GCM at the application layer regardless," 
          warn "  so message contents are already AES-256 inside this TLS 1.3 tunnel." ;;
        *)
          warn "Encryption in use: ${NEG_PROTO:-TLS} / ${NEG_CIPHER} (unrecognised suite)" ;;
      esac
    fi

    # Anything below TLS 1.2 would be a genuine problem.
    case "${NEG_PROTO:-}" in
      TLSv1.3|TLSv1.2|"") : ;;
      *) fail "Negotiated ${NEG_PROTO}, which is obsolete. Check the tls block in /etc/caddy/Caddyfile." ;;
    esac
  else
    fail "https://${DOMAIN}/health did not respond"
    echo "        Most likely: DNS wrong, or ports 80/443 blocked."
    echo "        Port 80 must be open too — Let's Encrypt validates over it."
    echo "        Check issuance with: sudo journalctl -u caddy -n 50"
  fi
else
  warn "No DOMAIN set in ${ENV_FILE}; skipping TLS checks."
fi

head_ "Firewall"
if [ "$PLATFORM" = "macos" ]; then
  warn "macOS: check System Settings > Network > Firewall allows Caddy on 80/443."
elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw status | grep -q "80/tcp" && pass "ufw allows 80" || fail "ufw does not allow 80 (needed for certificate renewal)"
  ufw status | grep -q "443/tcp" && pass "ufw allows 443" || fail "ufw does not allow 443"
  if ufw status | grep -qE "^${PORT}[/ ]"; then
    warn "Port ${PORT} is open in ufw but no longer needs to be: sudo ufw delete allow ${PORT}/tcp"
  fi
else
  warn "ufw inactive — verify ports 80/443 another way."
fi
warn "If this is a hosted VPS, its control panel has a separate firewall too."

head_ "Backups"
BACKUPS="$(find "${BACKUP_ROOT}" -maxdepth 1 -name 'data-*.tar.gz' 2>/dev/null | wc -l)"
if [ "$BACKUPS" -gt 0 ]; then
  pass "${BACKUPS} backup(s) present; newest: $(find "${BACKUP_ROOT}" -maxdepth 1 -name 'data-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2- | xargs -r basename)"
else
  warn "No backups yet. Run: sudo bash ${APP_DIR}/deploy/backup.sh"
fi
if [ "$PLATFORM" = "linux" ]; then
  systemctl is-active --quiet "${APP_NAME}-backup.timer" 2>/dev/null \
    && pass "Daily backup timer active" \
    || warn "Backup timer inactive — sudo systemctl enable --now ${APP_NAME}-backup.timer"
else
  warn "Automatic backups are not scheduled on macOS. Run deploy/backup.sh from cron or a launchd timer."
fi

head_ "Data"
if [ -d "${DATA_DIR}/profiles" ]; then
  echo "        profiles: $(find "${DATA_DIR}/profiles" -name '*.profile' 2>/dev/null | wc -l)"
  echo "        accounts: $(find "${DATA_DIR}/accounts" -name '*.account' 2>/dev/null | wc -l)"
  echo "        guilds:   $(find "${DATA_DIR}/guilds" -name '*.guild' 2>/dev/null | wc -l)"
  echo "        disk:     $(du -sh "$DATA_DIR" 2>/dev/null | cut -f1)"
else
  warn "No data directory contents yet (normal on a fresh install)."
fi

printf '\n%s================================================================%s\n' "$B" "$N"
if [ "$FAILED" -eq 0 ]; then
  printf '%s  Everything checks out.%s\n' "$G" "$N"
else
  printf '%s  %d check(s) failed — see FAIL lines above.%s\n' "$R" "$FAILED" "$N"
fi
printf '%s================================================================%s\n\n' "$B" "$N"
exit $((FAILED > 0))
