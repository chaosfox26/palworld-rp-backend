#!/usr/bin/env bash
#
# Remove the service. Data and backups are KEPT unless you pass --purge-data.
#
#     sudo bash /opt/palworld-rp-backend/deploy/uninstall.sh
#     sudo bash /opt/palworld-rp-backend/deploy/uninstall.sh --purge-data
#
set -euo pipefail

case "$(uname -s)" in
  Linux) : ;;
  Darwin)
    cat >&2 <<'MACOS'
This uninstaller is for Linux. On macOS, remove it with:

  sudo launchctl bootout system/io.palworldrp.backend
  sudo rm -f /Library/LaunchDaemons/io.palworldrp.backend.plist
  sudo rm -rf /usr/local/opt/palworld-rp-backend
  sudo dscl . -delete /Users/_palrp; sudo dscl . -delete /Groups/_palrp

Your data in /usr/local/var/palworld-rp-backend is left alone; delete it
yourself once you are sure you no longer need it.
MACOS
    exit 2 ;;
  *)
    echo "This uninstaller supports Linux. On Windows:" >&2
    echo "  Unregister-ScheduledTask -TaskName PalworldRPBackend,PalworldRPBackendCaddy" >&2
    echo "  Remove-Item -Recurse \"\$env:ProgramData\\PalworldRPBackend\\app\"" >&2
    exit 2 ;;
esac

APP_NAME="palworld-rp-backend"
APP_USER="palrp"
APP_DIR="/opt/${APP_NAME}"
DATA_DIR="/var/lib/${APP_NAME}"
CONF_DIR="/etc/${APP_NAME}"
BACKUP_DIR="/var/backups/${APP_NAME}"

PURGE=0
[ "${1:-}" = "--purge-data" ] && PURGE=1

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo." >&2; exit 1; }

echo "Stopping services..."
systemctl disable --now "${APP_NAME}" 2>/dev/null || true
systemctl disable --now "${APP_NAME}-backup.timer" 2>/dev/null || true

rm -f "/etc/systemd/system/${APP_NAME}.service" \
      "/etc/systemd/system/${APP_NAME}-backup.service" \
      "/etc/systemd/system/${APP_NAME}-backup.timer"
systemctl daemon-reload
systemctl reset-failed 2>/dev/null || true
echo "Service removed."

rm -rf "$APP_DIR"
echo "Application files removed from ${APP_DIR}."

if [ "$PURGE" -eq 1 ]; then
  # Take one final backup before destroying anything, because this is the kind
  # of command people run at 2am and regret at 9am.
  if [ -d "$DATA_DIR" ]; then
    mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
    FINAL="${BACKUP_DIR}/final-before-purge-$(date +%Y%m%d-%H%M%S).tar.gz"
    tar -czf "$FINAL" -C "$DATA_DIR" . 2>/dev/null && chmod 600 "$FINAL"
    echo "Final snapshot saved to ${FINAL}"
  fi
  rm -rf "$DATA_DIR" "$CONF_DIR"
  userdel "$APP_USER" 2>/dev/null || true
  echo "Data, configuration and the ${APP_USER} user were removed."
  echo "Backups in ${BACKUP_DIR} were kept. Delete them yourself if you are sure."
else
  echo
  echo "Kept:"
  echo "  data     ${DATA_DIR}"
  echo "  config   ${CONF_DIR}"
  echo "  backups  ${BACKUP_DIR}"
  echo "  user     ${APP_USER}"
  echo
  echo "Re-running deploy/install.sh will pick all of this back up."
  echo "To remove everything: sudo bash $0 --purge-data"
fi

echo
echo "Caddy was left installed. If nothing else uses it:"
echo "  sudo systemctl disable --now caddy && sudo apt-get remove --purge caddy"
