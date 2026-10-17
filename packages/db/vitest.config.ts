import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Local runs read DB credentials from the repo's .env (created by scripts/init-env.sh). CI sets
// TEST_ADMIN_DATABASE_URL directly. Nothing secret is hardcoded.
const rootEnv = new URL("../../.env", import.meta.url).pathname;
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  test: {
    globalSetup: ["./test/support/global-setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
