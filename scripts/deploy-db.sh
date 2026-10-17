#!/usr/bin/env sh
# Prepares the deployed database: migrations (advisory-locked, idempotent), runtime login roles
# and the idempotent demo seed. Reads secrets from .env.deploy (gitignored), never from the repo.
#
#   cp infra/deploy.env.example .env.deploy   # fill it in
#   ./scripts/deploy-db.sh
set -eu
cd "$(dirname "$0")/.."

[ -f .env.deploy ] || { echo "Missing .env.deploy (see infra/deploy.env.example)" >&2; exit 1; }
set -a
. ./.env.deploy
set +a
for v in DATABASE_URL APP_DB_PASSWORD WORKER_DB_PASSWORD TOKEN_ENC_KEYS MOCK_FIXTURE_SECRET; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || { echo "$v is empty in .env.deploy" >&2; exit 1; }
done

npm run build -w @ploot/db >/dev/null
# JWT_SECRET deliberately unset: don't print demo tokens for the public deployment to the terminal.
env -u JWT_SECRET node packages/db/dist/cli.js setup
