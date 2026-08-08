#!/bin/sh
#
# Palworld RP Backend — macOS one-liner.
#
#   curl -fsSL https://raw.githubusercontent.com/chaosfox26/palworld-rp-backend/main/deploy/setup-macos.sh | bash
#
# Installs the prerequisites (Homebrew if needed, then Node.js, which brings
# npm and npx), then runs the npx install.
#
# Deliberately NOT run under sudo: Homebrew refuses to run as root, and doing so
# leaves a broken prefix owned by the wrong user. The npx install elevates
# itself when it reaches the parts that genuinely need root.

set -eu

REPO_OWNER="${REPO_OWNER:-chaosfox26}"
REPO_NAME="${REPO_NAME:-palworld-rp-backend}"
BRANCH="${BRANCH:-main}"
SPEC="github:${REPO_OWNER}/${REPO_NAME}#${BRANCH}"

if [ -t 1 ]; then
  R=$(printf '\033[31m'); G=$(printf '\033[32m'); Y=$(printf '\033[33m')
  B=$(printf '\033[1m');  N=$(printf '\033[0m')
else
  R=''; G=''; Y=''; B=''; N=''
fi
step() { printf '\n%s==> %s%s\n' "$B" "$1" "$N"; }
ok()   { printf '%s  ok%s   %s\n' "$G" "$N" "$1"; }
warn() { printf '%s  warn%s %s\n' "$Y" "$N" "$1"; }
die()  { printf '\n%s  error%s %s\n\n' "$R" "$N" "$1" >&2; exit 1; }

printf '\n%s  Palworld RP Backend — macOS setup%s\n' "$B" "$N"

# ---------------------------------------------------------------------------
step "Checking the environment"

[ "$(uname -s)" = "Darwin" ] || die "This is the macOS script. On Linux use deploy/setup-linux.sh."

if [ "$(id -u)" -eq 0 ]; then
  die "Do not run this with sudo. Homebrew refuses to run as root, and the
  installer asks for your password itself when it needs to."
fi
ok "macOS $(sw_vers -productVersion 2>/dev/null || echo '?') on $(uname -m)"

# ---------------------------------------------------------------------------
step "Checking for Homebrew"

BREW=""
for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  [ -x "$candidate" ] && BREW="$candidate" && break
done

if [ -z "$BREW" ]; then
  warn "Homebrew is not installed. Installing it now."
  printf '  This is the official installer from brew.sh. It will ask for your\n'
  printf '  password and takes a few minutes.\n\n'
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
    || die "Homebrew installation failed. Install it from https://brew.sh then re-run."
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -x "$candidate" ] && BREW="$candidate" && break
  done
  [ -n "$BREW" ] || die "Homebrew installed but could not be found. Open a new terminal and re-run."
fi
ok "Homebrew at ${BREW}"

# A fresh Homebrew install does not put brew on PATH for the CURRENT shell, only
# for new ones. Everything below would fail with "command not found" without
# this, which is a confusing way to fail immediately after a successful install.
eval "$("$BREW" shellenv)"

# ---------------------------------------------------------------------------
step "Installing Node.js (this is what provides npm and npx)"

need_node=1
if command -v node >/dev/null 2>&1; then
  CURRENT="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$CURRENT" -ge 20 ] 2>/dev/null; then
    need_node=0
    ok "Node $(node -v) already installed"
  else
    warn "Node $(node -v) is too old; installing a current one."
  fi
fi

if [ "$need_node" -eq 1 ]; then
  "$BREW" install node || die "Installing Node.js through Homebrew failed."
  hash -r 2>/dev/null || true
  command -v node >/dev/null 2>&1 || die "Node.js still is not on PATH. Open a new terminal and re-run."
  ok "Node $(node -v) installed"
fi

# ---------------------------------------------------------------------------
step "Checking npm and npx"

command -v npm >/dev/null 2>&1 || die "npm is missing even though Node is installed."
ok "npm $(npm -v)"

# The deprecated standalone npx package shadows npm's built-in one and takes
# different arguments, producing "ERROR: You must supply a command".
if npm ls -g --depth=0 2>/dev/null | grep -q ' npx@'; then
  warn "The deprecated standalone npx package is installed and would shadow npm's."
  npm uninstall -g npx >/dev/null 2>&1 || true
  hash -r 2>/dev/null || true
  ok "Removed it"
fi
command -v npx >/dev/null 2>&1 || die "npx is missing. Reinstall Node."
ok "npx $(npx -v 2>/dev/null || echo present)"

# ---------------------------------------------------------------------------
step "Installing Palworld RP Backend"
printf '  Running: npx -y %s\n' "$SPEC"
printf '  It will ask for your password when it installs the service.\n'

# Nothing after the spec: npm would read a trailing word as the program to run.
exec npx -y "$SPEC"
