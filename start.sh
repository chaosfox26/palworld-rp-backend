#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "=== Palworld RP Backend ==="

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. Install it first: https://docs.docker.com/engine/install/"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required (the 'docker compose' subcommand)."
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo
  echo "Created .env from the example."
  echo "Open it and set ADMIN_TOKEN (and DOMAIN/ACME_EMAIL for HTTPS), then run this again."
  echo
  echo "  Generate an admin token with:  openssl rand -base64 32"
  exit 0
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a

if [ "${DOMAIN:-rp.example.com}" != "rp.example.com" ] && [ -n "${DOMAIN:-}" ]; then
  echo "Starting with HTTPS for ${DOMAIN} ..."
  docker compose --profile tls up -d --build
  echo
  echo "Backend URL for the mod:  https://${DOMAIN}"
else
  echo "No DOMAIN set — starting in plain HTTP mode on port 3000 (loopback only)."
  echo "This is fine for local testing. Do NOT expose it to the internet like this:"
  echo "passwords and chat would travel unencrypted."
  docker compose up -d --build backend
  echo
  echo "Backend URL for the mod:  http://127.0.0.1:3000"
fi

echo
docker compose ps
echo
echo "Logs:      docker compose logs -f backend"
echo "Stop:      docker compose down"
echo "Data lives in the 'rp-data' Docker volume and survives rebuilds."
