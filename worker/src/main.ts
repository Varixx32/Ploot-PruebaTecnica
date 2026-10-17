import { TokenCipher, createPool } from "@ploot/db";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { Metrics, startHttpServer } from "./metrics.js";
import { ProviderClient } from "./provider.js";
import { Worker } from "./worker.js";

const config = loadConfig();
const db = createPool({ connectionString: config.databaseUrl, max: config.dbPoolMax, applicationName: `worker:${config.workerId}` });
const metrics = new Metrics();
const worker = new Worker({
  db,
  cipher: TokenCipher.fromEnv(config.tokenEncKeys),
  provider: new ProviderClient({
    baseUrl: config.providerBaseUrl,
    timeoutMs: config.httpTimeoutMs,
    defaultRetryAfterSec: config.defaultRetryAfterSec,
  }),
  config,
  log: logger,
  metrics,
});

const server = config.httpPort > 0 ? startHttpServer(config.httpPort, {
      db,
      metrics,
      isHealthy: () => worker.isHealthy(),
      onError: (err) => logger.warn({ err }, "queue gauges query failed"),
    }) : undefined;

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "shutting down");
  await worker.stop();
  server?.close();
  await db.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

worker.start().catch((err) => {
  logger.fatal({ err }, "worker failed to start");
  process.exit(1);
});
