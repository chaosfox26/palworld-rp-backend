#!/usr/bin/env bash
#
# One-command installer.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/chaosfox26/palworld-rp-backend/main/deploy/bootstrap.sh)
#
# Installs git if needed, fetches the repository, and runs the full installer:
# Node.js, Caddy, the service account, systemd units, automatic HTTPS and daily
# backups. Safe to re-run — it updates in place and never touches your data.
#
# Non-interactive:
#   sudo DOMAIN=rp.example.com ACME_EMAIL=you@example.com bash bootstrap.sh
#
# Options:
#   --repo <url>     install from a different fork
#   --branch <name>  install from a different branch (default: main)
#   --dir <path>     where to keep the checkout (default: /usr/local/src/...)
#
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/chaosfox26/palworld-rp-backend.git}"
BRANCH="${BRANCH:-main}"
SRC_DIR="${SRC_DIR:-/usr/local/src/palworld-rp-backend}"

# --- Terminal handling ------------------------------------------------------
# Piping into bash means stdin is the script text. Reattach to the terminal so
# the installer can still prompt for a domain.
# `[ -r /dev/tty ]` is not enough: the device node can exist and be readable
# while there is no controlling terminal attached (cron, CI, some SSH and
# container setups). In that case `exec < /dev/tty` fails, and under `set -e`
# that kills the installer before it starts. Probe by actually opening it.
if [ ! -t 0 ] && { : < /dev/tty; } 2>/dev/null; then
  exec < /dev/tty
fi

if [ -t 1 ]; then
  R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; B=$'\e[1m'; N=$'\e[0m'
else
  R=""; G=""; Y=""; B=""; N=""
fi
step() { printf '\n%s==> %s%s\n' "$B" "$1" "$N"; }
ok()   { printf '%s  ok%s   %s\n' "$G" "$N" "$1"; }
warn() { printf '%s  warn%s %s\n' "$Y" "$N" "$1"; }
die()  { printf '\n%s  error%s %s\n\n' "$R" "$N" "$1" >&2; exit 1; }

# --- Arguments --------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --repo)   REPO_URL="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}";   shift 2 ;;
    --dir)    SRC_DIR="${2:-}";  shift 2 ;;
    --help|-h)
      cat <<'USAGE'
Palworld RP Backend - one-command installer

  bash <(curl -fsSL https://raw.githubusercontent.com/chaosfox26/palworld-rp-backend/main/deploy/bootstrap.sh)

Installs git if needed, fetches the repository, then runs the full installer:
Node.js, Caddy, a locked-down service account, systemd units, automatic HTTPS
and daily backups. Safe to re-run; your data is never touched.

Non-interactive:
  sudo DOMAIN=rp.example.com ACME_EMAIL=you@example.com bash bootstrap.sh

Options:
  --repo <url>     install from a different fork
  --branch <name>  branch to install (default: main)
  --dir <path>     where to keep the checkout (default: /usr/local/src/palworld-rp-backend)
  --help           this message
USAGE
      exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

printf '\n%s  Palworld RP Backend — installer%s\n' "$B" "$N"

# --- Re-run as root if needed ----------------------------------------------
# Done here rather than demanding the user remember sudo. Environment variables
# are passed through explicitly, because sudo strips them by default.
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "Not running as root and sudo is not installed."
  warn "Not running as root; re-running under sudo."
  exec sudo -E \
    REPO_URL="$REPO_URL" BRANCH="$BRANCH" SRC_DIR="$SRC_DIR" \
    DOMAIN="${DOMAIN:-}" ACME_EMAIL="${ACME_EMAIL:-}" \
    bash "$0"
fi

# Forks: pass --repo https://github.com/you/your-fork.git to install from
# somewhere else. The default above points at the upstream repository.

# --- Platform detection -----------------------------------------------------
step "Checking prerequisites"

OS="$(uname -s)"
case "$OS" in
  Linux)
    INSTALLER="deploy/install.sh"
    if ! . /etc/os-release 2>/dev/null || [ "${ID:-}" != "ubuntu" ]; then
      warn "Targets Ubuntu. Detected: ${PRETTY_NAME:-unknown}. Continuing anyway."
    else
      ok "Ubuntu ${VERSION_ID:-?}"
    fi
    command -v systemctl >/dev/null 2>&1 || die "systemd is required; this is not a systemd host."

    export DEBIAN_FRONTEND=noninteractive
    # needrestart will otherwise prompt after any service package. See install.sh.
    export NEEDRESTART_MODE=a
    export NEEDRESTART_SUSPEND=1
    APT_OPTS="-o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef"
    NEEDED=""
    for pkg in git curl ca-certificates; do
      dpkg -s "$pkg" >/dev/null 2>&1 || NEEDED="$NEEDED $pkg"
    done
    if [ -n "$NEEDED" ]; then
      step "Installing:${NEEDED}"
      apt-get $APT_OPTS update -qq
      # shellcheck disable=SC2086
      apt-get $APT_OPTS install -y -qq $NEEDED >/dev/null
      ok "Installed${NEEDED}"
    else
      ok "git and curl already present"
    fi
    ;;

  Darwin)
    INSTALLER="deploy/install-macos.sh"
    ok "macOS $(sw_vers -productVersion 2>/dev/null || echo '?') on $(uname -m)"
    # git ships with the Xcode command line tools. Invoking it when they are
    # absent pops the OS installer dialog, which cannot be driven from here.
    if ! git --version >/dev/null 2>&1; then
      die "git is not available yet.

  macOS installs it with the Xcode command line tools. Run this once, accept the
  dialog, wait for it to finish, then run this installer again:

      xcode-select --install"
    fi
    ok "git available"
    ;;

  *)
    die "Unsupported platform: ${OS}.

  Linux and macOS use this script. On Windows, open an Administrator PowerShell
  and run:

      irm https://raw.githubusercontent.com/chaosfox26/palworld-rp-backend/main/deploy/bootstrap.ps1 | iex"
    ;;
esac

# --- Fetch the source -------------------------------------------------------
step "Fetching ${REPO_URL} (${BRANCH})"

mkdir -p "$(dirname "$SRC_DIR")"

if [ -d "${SRC_DIR}/.git" ]; then
  git -C "$SRC_DIR" remote set-url origin "$REPO_URL"
  git -C "$SRC_DIR" fetch --quiet --depth 1 origin "$BRANCH"
  git -C "$SRC_DIR" checkout --quiet -B "$BRANCH" "origin/${BRANCH}"
  git -C "$SRC_DIR" reset --hard --quiet "origin/${BRANCH}"
  ok "Updated existing checkout at ${SRC_DIR}"
else
  rm -rf "$SRC_DIR"
  git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$SRC_DIR" \
    || die "Clone failed. Is the repository public, and is the URL correct?
  Tried: ${REPO_URL} (branch ${BRANCH})"
  ok "Cloned to ${SRC_DIR}"
fi

[ -f "${SRC_DIR}/${INSTALLER}" ] \
  || die "That repository does not contain ${INSTALLER} — wrong URL or branch?"

# --- Hand over to the real installer ---------------------------------------
step "Running the installer"
exec bash "${SRC_DIR}/${INSTALLER}"
