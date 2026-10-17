#!/usr/bin/env sh
# Prepares the deployed database: migrations (advisory-locked, idempotent), runtime login roles
# and the idempotent demo seed. Reads secrets from .env.deploy (gitignored), never from the repo.
#
#   node scripts/deploy-env.mjs init   # creates .env.deploy with random secrets
#   (paste Neon's URL after DATABASE_URL=)
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

# Migrations need a session (advisory lock): force Neon's direct host and drop channel_binding,
# whatever variant of the connection string was pasted.
DATABASE_URL="$(node scripts/deploy-env.mjs direct-url)"
export DATABASE_URL

npm run build -w @ploot/db >/dev/null
# JWT_SECRET deliberately unset: don't print demo tokens for the public deployment to the terminal.
env -u JWT_SECRET node packages/db/dist/cli.js setup
