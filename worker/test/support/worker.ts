import pino from "pino";
import { createPool, type Db } from "@ploot/db";
import type { WorkerConfig } from "../../src/config.js";
import { Metrics } from "../../src/metrics.js";
import { ProviderClient } from "../../src/provider.js";
import { Worker, type WorkerHooks } from "../../src/worker.js";
import type { TestDb } from "./db.js";

export const silentLog = pino({ level: process.env.TEST_LOG_LEVEL ?? "silent" });

export function testConfig(over: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    workerId: `test-${Math.random().toString(36).slice(2, 8)}`,
    databaseUrl: "",
    dbPoolMax: 3,
    providerBaseUrl: "",
    tokenEncKeys: "",
    pollIntervalMs: 20,
    claimBatch: 10,
    localConcurrency: 8,
    globalMaxInFlight: 100,
    tenantMaxInFlight: 100,
    appRate: { capacity: 1000, refillPerSec: 1000 },
    ambassadorMinIntervalSec: 0,
    leaseSec: 30,
    maxAttempts: 5,
    backoff: { baseMs: 20, maxMs: 200 },
    httpTimeoutMs: 2000,
    tokenRefreshSkewSec: 60,
    defaultRetryAfterSec: 1,
    httpPort: 0,
    ...over,
  };
}

export interface TestWorker {
  worker: Worker;
  pool: Db;
  metrics: Metrics;
  stop: () => Promise<void>;
}

export async function startWorker(
  tdb: TestDb,
  providerUrl: string,
  over: Partial<WorkerConfig> = {},
  hooks?: WorkerHooks,
): Promise<TestWorker> {
  const config = testConfig({ ...over, databaseUrl: tdb.workerUrl, providerBaseUrl: providerUrl, tokenEncKeys: tdb.tokenKeys });
  const pool = createPool({ connectionString: tdb.workerUrl, max: config.dbPoolMax });
  const metrics = new Metrics();
  const worker = new Worker({
    db: pool,
    cipher: tdb.cipher,
    provider: new ProviderClient({ baseUrl: providerUrl, timeoutMs: config.httpTimeoutMs, defaultRetryAfterSec: 1 }),
    config,
    log: silentLog,
    metrics,
    hooks,
  });
  await worker.start();
  return {
    worker,
    pool,
    metrics,
    stop: async () => {
      await worker.stop();
      await pool.end();
    },
  };
}
