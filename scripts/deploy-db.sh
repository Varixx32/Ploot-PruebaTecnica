#!/usr/bin/env sh
# Prepares the deployed database: migrations (advisory-locked, idempotent), runtime login roles
# and the idempotent demo seed. Secrets come from .env.deploy (gitignored), never from the repo.
#
#   node scripts/deploy-env.mjs init   # creates .env.deploy with random secrets
#   (paste Neon's URL after DATABASE_URL=)
#   ./scripts/deploy-db.sh
set -eu
cd "$(dirname "$0")/.."

# .env.deploy is parsed by Node, not sourced: URLs contain '&' and '?' that a shell would interpret.
# The owner URL is normalised to Neon's direct host (the advisory lock needs a session).
env_lines="$(node scripts/deploy-env.mjs shell-env)"
eval "$env_lines"
unset env_lines

npm run build -w @ploot/db >/dev/null
# JWT_SECRET deliberately unset: don't print demo tokens for the public deployment to the terminal.
env -u JWT_SECRET node packages/db/dist/cli.js setup
