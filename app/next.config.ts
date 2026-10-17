import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const config: NextConfig = {
  // Self-contained server bundle for the container image.
  output: "standalone",
  // Monorepo: trace workspace packages (@ploot/db) from the repo root.
  outputFileTracingRoot: fileURLToPath(new URL("..", import.meta.url)),
  // Native-ish driver: keep it out of the bundle, load it from node_modules at runtime.
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
};

export default config;
