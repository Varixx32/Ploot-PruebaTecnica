import type { Db, TokenCipher } from "@ploot/db";
import type { WorkerConfig } from "./config.js";
import { decide, decideTokenFailure, type Decision, type DecisionContext } from "./decide.js";
import type { Logger } from "./logger.js";
import type { Metrics } from "./metrics.js";
import type { ProviderClient, PublishResult } from "./provider.js";
import {
  applyOutcome,
  claimPosts,
  configureAppBucket,
  reapExpiredLeases,
  startAttempt,
  type ClaimedPost,
} from "./repo.js";
import { getAccessToken, markTokenExpired } from "./tokens.js";

/** Fault-injection points used by the crash tests. Never set in production. */
export interface WorkerHooks {
  beforeAttempt?: (post: ClaimedPost) => Promise<void> | void;
  afterProviderResponse?: (post: ClaimedPost, result: PublishResult) => Promise<void> | void;
}

export interface WorkerDeps {
  db: Db;
  cipher: TokenCipher;
  provider: ProviderClient;
  config: WorkerConfig;
  log: Logger;
  metrics: Metrics;
  hooks?: WorkerHooks;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Long-lived publisher. Each tick: recover expired leases, claim as many due posts as local
 * concurrency and the shared caps allow, and process them concurrently. All coordination between
 * replicas goes through Postgres (row locks + leases); replicas share no memory.
 */
export class Worker {
  private running = false;
  private loop?: Promise<void>;
  private inFlight = new Set<Promise<void>>();
  private lastTickAt = 0;

  constructor(private readonly d: WorkerDeps) {}

  get id(): string {
    return this.d.config.workerId;
  }

  isHealthy(): boolean {
    return this.running && Date.now() - this.lastTickAt < Math.max(10_000, this.d.config.pollIntervalMs * 10);
  }

  async start(): Promise<void> {
    const { config, db, log } = this.d;
    await configureAppBucket(db, config.appRate.capacity, config.appRate.refillPerSec);
    this.running = true;
    log.info({ worker_id: config.workerId, config: { ...config, databaseUrl: undefined, tokenEncKeys: undefined } }, "worker started");
    this.loop = this.run();
  }

  /** Graceful stop: no new claims, wait for in-flight posts (bounded by the lease anyway). */
  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
    await Promise.allSettled(this.inFlight);
    this.d.log.info({ worker_id: this.id }, "worker stopped");
  }

  /** Resolves when nothing is in flight in this process (tests). */
  async drain(): Promise<void> {
    await Promise.allSettled(this.inFlight);
  }

  private async run(): Promise<void> {
    while (this.running) {
      let claimedFullBatch = false;
      try {
        claimedFullBatch = await this.tick();
      } catch (err) {
        this.d.metrics.inc("ploot_worker_tick_errors_total", {}, 1, "Ticks that threw (DB down, etc.)");
        this.d.log.error({ err, worker_id: this.id }, "tick failed");
      }
      this.lastTickAt = Date.now();
      // Keep going without sleeping while there is a backlog we can take.
      if (!claimedFullBatch) await sleep(this.d.config.pollIntervalMs);
    }
  }

  /** One scheduling round. Returns true if it claimed a full batch (more work likely waiting). */
  async tick(): Promise<boolean> {
    const { config, db, log, metrics } = this.d;

    for (const r of await reapExpiredLeases(db)) {
      const verdict = r.maybe_sent ? "outcome_unknown" : "requeued";
      metrics.inc("ploot_worker_reaped_total", { verdict }, 1, "Expired leases recovered");
      log.warn({ post_id: r.id, tenant_id: r.tenant_id, ambassador_id: r.ambassador_id, verdict }, "lease expired, post recovered");
    }

    const room = config.localConcurrency - this.inFlight.size;
    if (room <= 0) return false;
    const limit = Math.min(room, config.claimBatch);
    const claim = await claimPosts(db, {
      workerId: config.workerId,
      limit,
      leaseSec: config.leaseSec,
      globalMaxInFlight: config.globalMaxInFlight,
      tenantMaxInFlight: config.tenantMaxInFlight,
    });
    metrics.inc("ploot_worker_claimed_total", {}, claim.posts.length, "Posts claimed");
    if (claim.limitedBy !== "none" && claim.limitedBy !== "nothing_due") {
      metrics.inc("ploot_worker_claim_limited_total", { reason: claim.limitedBy }, 1, "Claims cut short by a cap");
      log.debug({ limited_by: claim.limitedBy, budget_tokens: claim.budgetTokens }, "claim limited");
    }

    for (const post of claim.posts) {
      const p = this.process(post).finally(() => this.inFlight.delete(p));
      this.inFlight.add(p);
    }
    return claim.posts.length === limit;
  }

  private ctx(post: ClaimedPost): DecisionContext {
    const { config } = this.d;
    return {
      attempts: post.attempts,
      maxAttempts: config.maxAttempts,
      backoff: config.backoff,
      ambassadorMinIntervalSec: config.ambassadorMinIntervalSec,
    };
  }

  private async process(post: ClaimedPost): Promise<void> {
    const { config, db, cipher, provider, log, metrics, hooks } = this.d;
    const startedAt = Date.now();
    const plog = log.child({
      post_id: post.id,
      tenant_id: post.tenant_id,
      ambassador_id: post.ambassador_id,
      attempt: post.attempts,
      worker_id: config.workerId,
    });

    try {
      const token = await getAccessToken(db, cipher, provider, post.ambassador_id, config.tokenRefreshSkewSec);
      if (token.kind === "ok" && token.refreshed) {
        metrics.inc("ploot_worker_token_refreshes_total", {}, 1, "OAuth refreshes performed before publishing");
        plog.info("token refreshed before publishing");
      }

      let decision: Decision;
      let httpStatus: number | undefined;
      let attemptId: number;
      if (token.kind !== "ok") {
        decision = decideTokenFailure(token, this.ctx(post));
        attemptId = await startAttempt(db, post, config.workerId);
      } else {
        await hooks?.beforeAttempt?.(post);
        // Committed before the call: if we die after this line, the reaper knows the request may be out.
        attemptId = await startAttempt(db, post, config.workerId);
        const result = await provider.publish(token.accessToken, post.content, post.id);
        await hooks?.afterProviderResponse?.(post, result);
        httpStatus = "status" in result ? result.status : undefined;
        decision = decide(result, this.ctx(post));
      }

      if (decision.markTokenExpired) await markTokenExpired(db, post.ambassador_id);
      const durationMs = Date.now() - startedAt;
      const applied = await applyOutcome(db, post, config.workerId, {
        post: decision.post,
        attempt: {
          id: attemptId,
          outcome: decision.outcome,
          httpStatus,
          errorCode: decision.errorCode,
          retryAfterSec: decision.retryAfterSec,
          durationMs,
        },
        throttle: decision.throttle,
        pauseAppSec: decision.pauseAppSec,
        revokeToken: decision.revokeToken,
      });

      metrics.inc("ploot_worker_publish_outcomes_total", { outcome: decision.outcome }, 1, "Provider call outcomes");
      const fields = {
        outcome: decision.outcome,
        transition: decision.post.kind,
        error_code: decision.errorCode,
        http_status: httpStatus,
        retry_after_sec: decision.retryAfterSec,
        throttle: decision.throttle,
        duration_ms: durationMs,
        lag_ms: startedAt - new Date(post.scheduled_at).getTime(),
      };
      if (!applied) plog.warn(fields, "lease lost before recording the outcome");
      else if (decision.post.kind === "fail") plog.error(fields, "post failed");
      else if (decision.post.kind === "requeue") plog.warn(fields, "post requeued");
      else plog.info(fields, "post published");
    } catch (err) {
      // Unexpected (DB down, simulated crash...). Write nothing: the lease expires and the reaper
      // decides with the same at-most-once rule as for a dead process.
      metrics.inc("ploot_worker_process_errors_total", {}, 1, "Posts abandoned to the reaper");
      plog.error({ err }, "processing aborted; left to lease recovery");
    }
  }
}
