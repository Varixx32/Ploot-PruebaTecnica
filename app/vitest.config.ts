import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// DB credentials for API integration tests come from the repo's .env or CI env.
const rootEnv = new URL("../.env", import.meta.url).pathname;
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  resolve: {
    alias: {
      "@ploot/db": new URL("../packages/db/src/index.ts", import.meta.url).pathname,
      "@/": new URL("./src/", import.meta.url).pathname,
    },
  },
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
