#!/bin/sh
#
# Palworld RP Backend — one-file installer for macOS and Linux.
#
# Double-click it on macOS, or run ./Install-Mac-Linux.command on Linux.
# It needs NOTHING preinstalled: no Node, no npm, no npx, no git. Those are
# installed for you if they are missing.
#
# What it does, in order:
#   1. Finds a download tool (curl or wget), installing one if neither exists.
#   2. Downloads deploy/bootstrap.sh from the repository.
#   3. Hands over to it. The bootstrap installs git, clones the repo, and runs
#      the platform installer, which installs Node.js, Caddy, the service, and
#      HTTPS.
#
# npx is never involved. That path requires npm to already exist, which is the
# whole problem this file avoids.

set -eu

# Overridable so a fork works without editing this file:
#   REPO_OWNER=someone-else ./Install-Mac-Linux.command
REPO_OWNER="${REPO_OWNER:-chaosfox26}"
REPO_NAME="${REPO_NAME:-palworld-rp-backend}"
BRANCH="${BRANCH:-main}"
URL="${INSTALLER_URL:-https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${BRANCH}/deploy/bootstrap.sh}"

if [ -t 1 ]; then
  R=$(printf '\033[31m'); G=$(printf '\033[32m'); Y=$(printf '\033[33m')
  B=$(printf '\033[1m');  N=$(printf '\033[0m')
else
  R=''; G=''; Y=''; B=''; N=''
fi

step() { printf '\n%s==> %s%s\n' "$B" "$1" "$N"; }
ok()   { printf '%s  ok%s   %s\n' "$G" "$N" "$1"; }
warn() { printf '%s  warn%s %s\n' "$Y" "$N" "$1"; }

# When this is double-clicked in Finder the window closes the instant the
# script ends, taking any error message with it. Pausing first makes failures
# readable instead of a window that blinks and vanishes.
PAUSE_ON_EXIT=0
case "${1:-}" in --no-pause) PAUSE_ON_EXIT=0 ;; *) [ -t 0 ] && PAUSE_ON_EXIT=1 ;; esac

# Takes the exit code as an argument rather than reading $? — by the time a
# composite trap like `trap 'cleanup; finish' EXIT` calls this, $? is the status
# of `cleanup`, not of the script. Reading $? here silently reported success for
# every failure.
finish() {
  code="${1:-$?}"
  if [ "$code" -ne 0 ]; then
    printf '\n%s  The installer stopped with an error (exit %s).%s\n' "$R" "$code" "$N"
    printf '  Scroll up for the reason. Re-running this file is safe.\n'
  fi
  if [ "$PAUSE_ON_EXIT" -eq 1 ]; then
    printf '\n  Press Enter to close this window. '
    read -r _dummy || true
  fi
  exit $code
}
trap 'finish $?' EXIT INT TERM

printf '\n%s  Palworld RP Backend — installer%s\n' "$B" "$N"
printf '  macOS and Linux. Nothing needs to be installed first.\n'

# ---------------------------------------------------------------------------
step "Checking for a download tool"

DL=""
if command -v curl >/dev/null 2>&1; then
  DL="curl"
elif command -v wget >/dev/null 2>&1; then
  DL="wget"
else
  warn "Neither curl nor wget is present. Installing curl."
  # Only Linux package managers here: macOS has shipped curl since forever, so
  # reaching this branch on a Mac would mean something is deeply wrong.
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq && sudo apt-get install -y -qq curl
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y -q curl
  elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y -q curl
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -Sy --noconfirm curl
  elif command -v zypper >/dev/null 2>&1; then
    sudo zypper --non-interactive install curl
  else
    printf '\n%s  error%s Could not find curl or wget, and no known package\n' "$R" "$N" >&2
    printf '  manager to install one with. Install curl by hand, then re-run.\n' >&2
    exit 1
  fi
  command -v curl >/dev/null 2>&1 || { printf '  Installing curl failed.\n' >&2; exit 1; }
  DL="curl"
fi
ok "Using ${DL}"

# ---------------------------------------------------------------------------
step "Downloading the installer"

TMP="$(mktemp -t palworld-rp-bootstrap.XXXXXX 2>/dev/null || mktemp)"
# The temp file is removed even if the download or the installer fails.
cleanup_tmp() { rm -f "$TMP"; }
trap 'code=$?; cleanup_tmp; finish $code' EXIT INT TERM

if [ "$DL" = "curl" ]; then
  curl -fsSL "$URL" -o "$TMP" || {
    printf '\n%s  error%s Could not download the installer.%s\n' "$R" "$N" "$N" >&2
    printf '  Tried: %s\n' "$URL" >&2
    printf '  Check this machine has internet access, and that the repository\n' >&2
    printf '  is public.\n' >&2
    exit 1
  }
else
  wget -qO "$TMP" "$URL" || {
    printf '\n%s  error%s Could not download the installer.%s\n' "$R" "$N" "$N" >&2
    printf '  Tried: %s\n' "$URL" >&2
    exit 1
  }
fi

# A repository that has moved or a branch that does not exist returns a short
# HTML 404 page rather than failing, which would otherwise be handed to bash.
if [ ! -s "$TMP" ]; then
  printf '\n%s  error%s The downloaded file is empty.%s\n' "$R" "$N" "$N" >&2
  exit 1
fi
if ! head -1 "$TMP" | grep -q '^#!'; then
  printf '\n%s  error%s The download does not look like a script.%s\n' "$R" "$N" "$N" >&2
  printf '  This usually means the URL returned a 404 page. Check that\n' >&2
  printf '  %s/%s exists and is public.\n' "$REPO_OWNER" "$REPO_NAME" >&2
  exit 1
fi
ok "Downloaded and sanity-checked"

# ---------------------------------------------------------------------------
step "Handing over to the installer"
printf '  From here the bootstrap installs git, clones the repository, and\n'
printf '  runs the platform installer. It will ask for your password: setting\n'
printf '  up a system service and a firewall rule requires administrator rights.\n'

# Not `exec`: the pause-on-exit trap has to survive so a double-clicked window
# stays open long enough to read. The bootstrap elevates itself with sudo.
# `set -e` would abort at the first non-zero here, so the assignment on the
# next line would never run and the real exit code would be lost.
STATUS=0
sh "$TMP" || STATUS=$?

if [ "$STATUS" -eq 0 ]; then
  printf '\n%s  Done.%s Run %spalworld-rp menu%s to manage the server,\n' "$G" "$N" "$B" "$N"
  printf '  or %spalworld-rp doctor%s to check every layer.\n' "$B" "$N"
fi
exit $STATUS
