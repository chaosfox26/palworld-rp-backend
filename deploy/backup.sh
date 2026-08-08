#!/usr/bin/env bash
#
# Snapshot the data directory. Run manually or by the systemd timer.
#
#     sudo bash /opt/palworld-rp-backend/deploy/backup.sh
#
# Backups are plain tarballs, so restoring is just untarring. They contain
# password hashes, so they are written mode 600 in a root-only directory.
#
set -euo pipefail

APP_NAME="palworld-rp-backend"
# Overridable so this works for non-standard installs and can be tested
# without touching the real system paths.
DATA_DIR="${DATA_DIR:-/var/lib/${APP_NAME}}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/${APP_NAME}}"
KEEP="${KEEP:-14}"

[ -d "$DATA_DIR" ] || { echo "No data directory at ${DATA_DIR}; nothing to back up." >&2; exit 0; }

# The real requirement is write access to the backup location, which normally
# means root. Check that rather than the uid, so overrides work.
if ! mkdir -p "$BACKUP_DIR" 2>/dev/null; then
  echo "Cannot create ${BACKUP_DIR}. Run with sudo." >&2
  exit 1
fi
[ -w "$BACKUP_DIR" ] || { echo "Cannot write to ${BACKUP_DIR}. Run with sudo." >&2; exit 1; }

chmod 700 "$BACKUP_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="${BACKUP_DIR}/data-${STAMP}.tar.gz"

# Write to a temp name and rename on success, so a failed or interrupted run
# never leaves a truncated archive that looks like a valid backup.
TMP="${TARGET}.partial"
tar -czf "$TMP" -C "$DATA_DIR" . 2>/dev/null
mv "$TMP" "$TARGET"
chmod 600 "$TARGET"

# Verify the archive actually reads back before we prune older ones.
if ! tar -tzf "$TARGET" >/dev/null 2>&1; then
  echo "Backup ${TARGET} failed verification; keeping all older backups." >&2
  rm -f "$TARGET"
  exit 1
fi

SIZE="$(du -h "$TARGET" | cut -f1)"
COUNT="$(tar -tzf "$TARGET" | grep -c '\.profile$' || true)"
echo "Backup written: ${TARGET} (${SIZE}, ${COUNT} profiles)"

# Prune, keeping the most recent $KEEP.
mapfile -t OLD < <(ls -1t "${BACKUP_DIR}"/data-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) || true)
for f in "${OLD[@]:-}"; do
  [ -n "$f" ] || continue
  rm -f "$f"
  echo "Pruned old backup: $(basename "$f")"
done

# A backup that only exists on the same disk as the data is not really a
# backup. Copy these off the box periodically, e.g. from your PC:
#     scp root@your-server:/var/backups/palworld-rp-backend/data-*.tar.gz .
