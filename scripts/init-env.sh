#!/usr/bin/env sh
# Creates .env from .env.example, filling every empty secret with a fresh random value.
# Local development only; deployments inject their own secrets through the host's environment.
set -eu

cd "$(dirname "$0")/.."

if [ -f .env ] && [ "${1:-}" != "--force" ]; then
  echo ".env already exists (use --force to regenerate; this invalidates the local DB volume)." >&2
  exit 1
fi

command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 1; }

hex() { openssl rand -hex "$1"; }

umask 077
awk -F= \
  -v pg="$(hex 24)" -v app="$(hex 24)" -v worker="$(hex 24)" \
  -v keys="1:$(openssl rand -base64 32)" -v jwt="$(hex 32)" \
  -v fixture="$(hex 32)" -v admin="$(hex 24)" '
  /^POSTGRES_PASSWORD=$/   { print $1 "=" pg; next }
  /^APP_DB_PASSWORD=$/     { print $1 "=" app; next }
  /^WORKER_DB_PASSWORD=$/  { print $1 "=" worker; next }
  /^TOKEN_ENC_KEYS=$/      { print $1 "=" keys; next }
  /^JWT_SECRET=$/          { print $1 "=" jwt; next }
  /^MOCK_FIXTURE_SECRET=$/ { print $1 "=" fixture; next }
  /^MOCK_ADMIN_KEY=$/      { print $1 "=" admin; next }
  { print }
' .env.example > .env

echo ".env created with random secrets (permissions 600)."
