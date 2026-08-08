#!/bin/sh
#
# Palworld RP Backend — Linux one-liner.
#
#   curl -fsSL https://raw.githubusercontent.com/chaosfox26/palworld-rp-backend/main/deploy/setup-linux.sh | sudo bash
#
# Installs the prerequisites (Node.js, which brings npm and npx), then runs the
# npx install. Nothing needs to be present beforehand except curl, which is how
# you got this file.

set -eu

REPO_OWNER="${REPO_OWNER:-chaosfox26}"
REPO_NAME="${REPO_NAME:-palworld-rp-backend}"
BRANCH="${BRANCH:-main}"
SPEC="github:${REPO_OWNER}/${REPO_NAME}#${BRANCH}"
NODE_MAJOR="${NODE_MAJOR:-22}"

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

# Exported before anything else, and unconditionally. Previously these were set
# only inside the "Node is missing" branch, so a machine that already had Node
# skipped them entirely and hit needrestart's prompt later on.
# Whether a human can actually answer a prompt is decided HERE and nowhere else,
# and `[ -t 0 ]` alone is NOT the right test.
#
# With `curl ... | sudo bash`, Ubuntu's default `Defaults use_pty` makes sudo
# allocate a fresh pty and relay the curl pipe into it. Bash then reads its own
# PROGRAM from that pty — so `[ -t 0 ]` reports a terminal, and every naive
# check concludes the install is interactive. It is not: the user's keystrokes
# go to the real terminal, which sudo never reads. A prompt there waits forever.
#
# The honest question is not "is stdin a terminal" but "is bash reading the
# script itself from stdin". When it is, stdin is spoken for and no answer can
# arrive. Bash sets $0 to the bare shell name in exactly that case, and to the
# script's path when it was given a file.
#
#   cat f | sudo bash  ->  $0=bash          tty=YES   input NO
#   sudo bash f        ->  $0=/path/f       tty=YES   input YES
#   cat f | bash       ->  $0=bash          tty=NO    input NO
#   bash f             ->  $0=/path/f       tty=YES   input YES
PALRP_STDIN_TTY=0
case "$0" in
  bash|sh|dash|zsh|ksh|-bash|-sh|-dash|-zsh|-ksh|''|-)
    : ;;                                  # the script arrived on stdin
  *)
    [ -t 0 ] && PALRP_STDIN_TTY=1 ;;      # a real file, and a real terminal
esac
export PALRP_STDIN_TTY

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1
APT_OPTS="-o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef"

# Loud by default: a hidden package install that stalls is indistinguishable
# from one that is merely slow. Set QUIET=1 for summary-only output.
QUIET="${QUIET:-0}"
if [ "$QUIET" = "1" ]; then
  APT_Q="-qq"; loud() { "$@" >/dev/null 2>&1; }
else
  APT_Q="";    loud() { "$@"; }
fi
export QUIET

printf '\n%s  Palworld RP Backend — Linux setup%s\n' "$B" "$N"

# ---------------------------------------------------------------------------
step "Checking privileges"

# Piping into `sudo bash` is the documented form, so this normally passes. When
# someone pipes into plain `bash` instead, re-exec rather than failing at the
# first apt command with a confusing permissions error.
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    warn "Not running as root. Re-running under sudo."
    # The script arrived on stdin, so $0 is not a file that can be re-executed.
    # Feeding the already-read text back into a new shell is the only option.
    die "Re-run with: curl -fsSL <this-url> | sudo bash"
  fi
  die "Run this as root, or install sudo."
fi
ok "Running as root"

# ---------------------------------------------------------------------------
step "Installing Node.js ${NODE_MAJOR} (this is what provides npm and npx)"

need_node=1
if command -v node >/dev/null 2>&1; then
  CURRENT="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$CURRENT" -ge 20 ] 2>/dev/null; then
    need_node=0
    ok "Node $(node -v) already installed"
  else
    warn "Node $(node -v) is too old; installing ${NODE_MAJOR}."
  fi
fi

if [ "$need_node" -eq 1 ]; then
  if command -v apt-get >/dev/null 2>&1; then
    loud apt-get $APT_OPTS update $APT_Q
    loud apt-get $APT_OPTS install -y $APT_Q curl ca-certificates gnupg
    # NodeSource rather than the distribution package: Ubuntu ships versions of
    # Node too old for this project, and its `nodejs` package historically did
    # not include npm at all — which is precisely the npx problem.
    if [ "$QUIET" = "1" ]; then
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1 \
        || die "Could not add the NodeSource repository."
    else
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
        || die "Could not add the NodeSource repository."
    fi
    loud apt-get $APT_OPTS install -y $APT_Q nodejs || die "Installing Node.js failed."
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1 || true
    dnf install -y -q nodejs || die "Installing Node.js failed."
  elif command -v yum >/dev/null 2>&1; then
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1 || true
    yum install -y -q nodejs || die "Installing Node.js failed."
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm nodejs npm || die "Installing Node.js failed."
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install "nodejs${NODE_MAJOR}" npm || die "Installing Node.js failed."
  else
    die "No supported package manager found. Install Node.js ${NODE_MAJOR}+ manually, then re-run."
  fi
  hash -r 2>/dev/null || true
  command -v node >/dev/null 2>&1 || die "Node.js still is not on PATH after installing."
  ok "Node $(node -v) installed"
fi

# ---------------------------------------------------------------------------
step "Checking git"

# npx resolves a `github:owner/repo` spec by shelling out to git — npm has no
# bundled git. Ubuntu Server does not ship git, so on a genuinely fresh box the
# install died at the final step with a bare "npm error code ENOGIT", which says
# nothing about the actual cause.
#
# This deliberately sits OUTSIDE the Node block above: a machine that already has
# Node skips that branch entirely, and would otherwise skip installing git too.
if command -v git >/dev/null 2>&1; then
  ok "git $(git --version 2>/dev/null | awk '{print $3}')"
else
  warn "git is not installed. npx needs it to fetch the repository."
  if command -v apt-get >/dev/null 2>&1; then
    loud apt-get $APT_OPTS update $APT_Q
    loud apt-get $APT_OPTS install -y $APT_Q git || die "Installing git failed."
  elif command -v dnf >/dev/null 2>&1; then dnf install -y -q git || die "Installing git failed."
  elif command -v yum >/dev/null 2>&1; then yum install -y -q git || die "Installing git failed."
  elif command -v pacman >/dev/null 2>&1; then pacman -Sy --noconfirm git || die "Installing git failed."
  elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install git || die "Installing git failed."
  else die "git is required and no supported package manager was found. Install git, then re-run."
  fi
  hash -r 2>/dev/null || true
  command -v git >/dev/null 2>&1 || die "git still is not on PATH after installing."
  ok "git installed"
fi

# ---------------------------------------------------------------------------
step "Checking npm and npx"

command -v npm >/dev/null 2>&1 || die "npm is missing even though Node is installed. Install the npm package for your distribution."
ok "npm $(npm -v)"

# The deprecated standalone `npx` package takes completely different arguments
# from the one built into npm, and if it is installed globally it shadows the
# real one. The symptom is "ERROR: You must supply a command", which looks
# nothing like a shadowing problem. Remove it before it causes that.
if npm ls -g --depth=0 2>/dev/null | grep -q ' npx@'; then
  warn "The deprecated standalone npx package is installed and would shadow npm's."
  npm uninstall -g npx >/dev/null 2>&1 || true
  hash -r 2>/dev/null || true
  ok "Removed it"
fi
command -v npx >/dev/null 2>&1 || die "npx is missing. Reinstall npm."
ok "npx $(npx -v 2>/dev/null || echo present)"

# ---------------------------------------------------------------------------
step "Installing Palworld RP Backend"
printf '  Running: npx -y %s\n' "$SPEC"

# Nothing after the spec. npm reads the next bare word as the name of the
# program to run, so `npx <spec> install` launches /usr/bin/install and fails
# with "install: missing file operand". The CLI installs by default.
#
# npx clones the repository silently by default, which is a long quiet gap right
# where people expect to see progress. `loglevel=info` makes it report what it
# is fetching.
if [ "$QUIET" != "1" ]; then
  export npm_config_loglevel=info
  export npm_config_progress=true
fi
exec npx -y "$SPEC"
