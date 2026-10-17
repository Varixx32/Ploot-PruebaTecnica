import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// DB credentials for integration tests come from the repo's .env (scripts/init-env.sh) or CI env.
const rootEnv = new URL("../.env", import.meta.url).pathname;
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  resolve: {
    // Use the db package from source (no build step needed for tests).
    alias: [
      { find: "@ploot/db/admin", replacement: new URL("../packages/db/src/admin.ts", import.meta.url).pathname },
      { find: "@ploot/db", replacement: new URL("../packages/db/src/index.ts", import.meta.url).pathname },
    ],
  },
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Integration files share one Postgres database: run them one at a time.
    fileParallelism: false,
  },
});
