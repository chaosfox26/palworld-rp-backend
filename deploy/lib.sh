#!/usr/bin/env bash
#
# Shared helpers for the Linux and macOS installers. Sourced, never run.
#
# shellcheck shell=bash

# --- Output -----------------------------------------------------------------
if [ -t 1 ]; then
  R=$'\e[31m'; G=$'\e[32m'; Y=$'\e[33m'; B=$'\e[1m'; N=$'\e[0m'
else
  R=""; G=""; Y=""; B=""; N=""
fi
step() { printf '\n%s==> %s%s\n' "$B" "$1" "$N"; }
ok()   { printf '%s  ok%s   %s\n' "$G" "$N" "$1"; }
warn() { printf '%s  warn%s %s\n' "$Y" "$N" "$1"; }
die()  { printf '\n%s  error%s %s\n\n' "$R" "$N" "$1" >&2; exit 1; }

# --- Terminal ---------------------------------------------------------------
# Piping into bash makes stdin the script text, so prompts would read source or
# hit EOF. `[ -r /dev/tty ]` is not sufficient: the node can exist with no
# controlling terminal attached, and `exec` would then fail under `set -e`.
reattach_tty() {
  if [ ! -t 0 ] && { : < /dev/tty; } 2>/dev/null; then
    exec < /dev/tty
  fi
}

# --- Network ----------------------------------------------------------------

detect_public_ip() {
  curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true
}

# Every IPv4 address bound to a local interface, one per line.
local_ipv4_addresses() {
  if command -v ip >/dev/null 2>&1; then
    ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1
  elif command -v ifconfig >/dev/null 2>&1; then
    ifconfig 2>/dev/null | awk '/inet /{print $2}' | grep -v '^127\.'
  fi
}

# The address other machines on this LAN would use to reach us.
primary_lan_ip() {
  local_ipv4_addresses | grep -vE '^(127\.|169\.254\.)' | head -1
}

# Does a hostname resolve to the address we expect?
resolves_to() {
  local host="$1" want="$2" got=""
  if command -v getent >/dev/null 2>&1; then
    got="$(getent ahostsv4 "$host" 2>/dev/null | awk 'NR==1{print $1}')"
  else
    # macOS has no getent.
    got="$(dscacheutil -q host -a name "$host" 2>/dev/null | awk '/^ip_address:/{print $2; exit}')"
    [ -n "$got" ] || got="$(ping -c1 -t1 "$host" 2>/dev/null | sed -n 's/.*(\([0-9.]*\)).*/\1/p' | head -1)"
  fi
  [ -n "$got" ] && [ "$got" = "$want" ]
}

# --- TLS mode decision ------------------------------------------------------
#
# Sets three globals:
#   TLS_MODE      letsencrypt | internal
#   SITE          the address Caddy serves (hostname for LE, bare IP for internal)
#   BACKEND_URL   what goes into the mod
#   AUTO_HOSTNAME 1 if SITE was derived from the IP via sslip.io/nip.io, else ""
#
# The rule: a publicly-trusted certificate requires a name that resolves to this
# machine AND ports 80/443 reachable from the internet. A desktop behind a home
# router satisfies neither, so attempting ACME there just produces a confusing
# failure. Detect that case and use Caddy's own CA instead — still real TLS with
# AES-256, just signed by a local authority the mod has to be told to trust.
decide_tls_mode() {
  TLS_MODE="${TLS_MODE:-}"
  SITE=""
  # Callers print an explanatory note when this is set. It must always be
  # defined: the installers run under `set -u`, so referencing it while unset
  # aborts the script after the work is already done.
  AUTO_HOSTNAME=""

  # An explicit domain means the operator has done the DNS work deliberately.
  if [ -n "${DOMAIN:-}" ]; then
    SITE="$DOMAIN"
    [ -n "$TLS_MODE" ] || TLS_MODE="letsencrypt"
    ok "Using the domain you supplied: ${SITE}"
    return
  fi

  local public_ip; public_ip="$(detect_public_ip)"

  if [ -n "$public_ip" ] && local_ipv4_addresses | grep -qx "$public_ip"; then
    # The public address is bound directly to this machine: a real server.
    local dashed="${public_ip//./-}" candidate
    for candidate in "${dashed}.sslip.io" "${dashed}.nip.io"; do
      if resolves_to "$candidate" "$public_ip"; then
        SITE="$candidate"
        AUTO_HOSTNAME=1
        TLS_MODE="${TLS_MODE:-letsencrypt}"
        ok "Publicly reachable; using ${SITE} with a Let's Encrypt certificate"
        return
      fi
    done
    warn "Publicly reachable, but no automatic hostname service resolved."
  fi

  # Behind NAT, or no public address at all: a desktop or a LAN box.
  local lan_ip; lan_ip="$(primary_lan_ip)"
  [ -n "$lan_ip" ] || die "Could not determine any usable IP address for this machine."

  SITE="$lan_ip"
  TLS_MODE="internal"
  if [ -n "$public_ip" ]; then
    ok "This machine is behind NAT (public ${public_ip}, local ${lan_ip})"
  else
    ok "No public address detected; treating this as a local install"
  fi
  warn "Using a locally-issued certificate. Real TLS, but not publicly trusted:"
  warn "  the mod must be pointed at the exported CA file, or set to trust it."
}

# The tls{} block that goes into the Caddyfile for the chosen mode.
caddy_tls_block() {
  if [ "$TLS_MODE" = "internal" ]; then
    cat <<'EOF'
	# Certificate issued by Caddy's own local authority. The connection is still
	# TLS with AES-256; it is simply not signed by a public CA, because a machine
	# behind a home router cannot complete an ACME challenge.
	tls internal
EOF
  else
    cat <<'EOF'
	# `ciphers` applies to TLS 1.2 only and pins it to AES-256-GCM. TLS 1.3 suite
	# selection is not configurable in Go, and therefore not in Caddy: the client
	# chooses. Pin TLS_AES_256_GCM_SHA384 in the mod to force AES-256 there.
	tls {
		protocols tls1.2 tls1.3
		ciphers TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384 TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
		curves x25519 secp384r1
	}
EOF
  fi
}

# Find Caddy's local CA root so the mod can be told to trust it.
find_caddy_root_ca() {
  local candidates=(
    "/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt"
    "/root/.local/share/caddy/pki/authorities/local/root.crt"
    "${HOME}/.local/share/caddy/pki/authorities/local/root.crt"
    "${HOME}/Library/Application Support/Caddy/pki/authorities/local/root.crt"
    "/usr/local/var/lib/caddy/pki/authorities/local/root.crt"
    "/opt/homebrew/var/lib/caddy/pki/authorities/local/root.crt"
  )
  local c
  for c in "${candidates[@]}"; do
    [ -f "$c" ] && { printf '%s' "$c"; return 0; }
  done
  return 1
}
