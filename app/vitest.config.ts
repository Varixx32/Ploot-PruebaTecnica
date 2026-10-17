import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// DB credentials for API integration tests come from the repo's .env or CI env.
const rootEnv = new URL("../.env", import.meta.url).pathname;
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  resolve: {
    alias: [
      { find: "@ploot/db/admin", replacement: new URL("../packages/db/src/admin.ts", import.meta.url).pathname },
      { find: "@ploot/db", replacement: new URL("../packages/db/src/index.ts", import.meta.url).pathname },
      { find: /^@\/(.*)$/, replacement: `${new URL("./src/", import.meta.url).pathname}$1` },
    ],
  },
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
