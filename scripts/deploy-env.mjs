#!/usr/bin/env node
// Deploy configuration helper. Secrets are written to gitignored files and never printed.
//
//   node scripts/deploy-env.mjs init     -> creates .env.deploy with random secrets (DATABASE_URL empty)
//   node scripts/deploy-env.mjs render   -> after pasting Neon's URL into .env.deploy, writes
//                                           .deploy/{railway-mock,railway-worker,vercel}.env ready to paste
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const ENV_FILE = `${root}.env.deploy`;
const OUT_DIR = `${root}.deploy`;

const hex = (n) => randomBytes(n).toString("hex");

function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function write(path, lines) {
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
}

/** Neon URL -> { direct, pooled } as plain objects (host with and without "-pooler"). */
function neonHosts(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL in .env.deploy is not a valid URL (it must start with postgresql://)");
  }
  const [first, ...rest] = url.hostname.split(".");
  const endpoint = first.replace(/-pooler$/, "");
  return {
    url,
    direct: [endpoint, ...rest].join("."),
    pooled: [`${endpoint}-pooler`, ...rest].join("."),
  };
}

function pgUrl({ user, password, host, database }) {
  const u = new URL("postgresql://localhost/");
  u.username = user;
  u.password = password;
  u.hostname = host;
  u.pathname = `/${database}`;
  u.search = "?sslmode=require"; // channel_binding left out on purpose (not needed, not portable)
  return u.toString();
}

/** Owner URL normalised for migrations: direct host, no channel_binding. */
export function directOwnerUrl(raw) {
  const { url, direct } = neonHosts(raw);
  return pgUrl({
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    host: direct,
    database: url.pathname.replace(/^\//, "") || "neondb",
  });
}

function init() {
  if (existsSync(ENV_FILE)) {
    console.log(".env.deploy already exists: left untouched (delete it to regenerate every secret).");
    return;
  }
  write(ENV_FILE, [
    "# Fill DATABASE_URL with Neon's connection string (owner). Never commit this file.",
    "DATABASE_URL=",
    `APP_DB_PASSWORD=${hex(24)}`,
    `WORKER_DB_PASSWORD=${hex(24)}`,
    `TOKEN_ENC_KEYS=1:${randomBytes(32).toString("base64")}`,
    `MOCK_FIXTURE_SECRET=${hex(32)}`,
    `MOCK_ADMIN_KEY=${hex(24)}`,
    `JWT_SECRET=${hex(32)}`,
  ]);
  console.log("Created .env.deploy with random secrets. Next: paste Neon's URL after DATABASE_URL=");
}

function render() {
  if (!existsSync(ENV_FILE)) throw new Error("Missing .env.deploy: run `node scripts/deploy-env.mjs init` first");
  const env = parseEnv(readFileSync(ENV_FILE, "utf8"));
  const required = ["DATABASE_URL", "APP_DB_PASSWORD", "WORKER_DB_PASSWORD", "TOKEN_ENC_KEYS", "MOCK_FIXTURE_SECRET", "MOCK_ADMIN_KEY", "JWT_SECRET"];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new Error(`Empty in .env.deploy: ${missing.join(", ")}`);

  const { url, direct, pooled } = neonHosts(env.DATABASE_URL);
  const database = url.pathname.replace(/^\//, "") || "neondb";
  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });

  write(`${OUT_DIR}/railway-mock.env`, [
    `MOCK_FIXTURE_SECRET=${env.MOCK_FIXTURE_SECRET}`,
    `MOCK_ADMIN_KEY=${env.MOCK_ADMIN_KEY}`,
    "MOCK_HOST=::",
    "PORT=4000",
  ]);
  write(`${OUT_DIR}/railway-worker.env`, [
    `DATABASE_URL=${pgUrl({ user: "ploot_worker_login", password: env.WORKER_DB_PASSWORD, host: direct, database })}`,
    "PROVIDER_BASE_URL=http://${{mock.RAILWAY_PRIVATE_DOMAIN}}:4000",
    `TOKEN_ENC_KEYS=${env.TOKEN_ENC_KEYS}`,
  ]);
  write(`${OUT_DIR}/vercel.env`, [
    `APP_DATABASE_URL=${pgUrl({ user: "ploot_app_login", password: env.APP_DB_PASSWORD, host: pooled, database })}`,
    `JWT_SECRET=${env.JWT_SECRET}`,
    "APP_DB_POOL_MAX=1",
    "DEMO_LOGIN_ENABLED=true",
  ]);

  console.log("Written (values not shown):");
  console.log("  .deploy/railway-mock.env    -> Railway, service 'mock'   (Variables > Raw Editor)");
  console.log("  .deploy/railway-worker.env  -> Railway, service 'worker' (Variables > Raw Editor)");
  console.log("  .deploy/vercel.env          -> Vercel, Settings > Environment Variables");
  console.log(`  worker uses the direct host ${direct}`);
  console.log(`  app uses the pooled host    ${pooled}`);
}

const cmd = process.argv[2];
try {
  if (cmd === "init") init();
  else if (cmd === "render") render();
  else if (cmd === "direct-url") process.stdout.write(directOwnerUrl(parseEnv(readFileSync(ENV_FILE, "utf8")).DATABASE_URL ?? ""));
  else {
    console.error("usage: node scripts/deploy-env.mjs <init|render>");
    process.exit(2);
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
