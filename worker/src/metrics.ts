import { createServer, type Server } from "node:http";
import type { Db } from "@ploot/db";

type Labels = Record<string, string>;

/** Minimal Prometheus registry (counters + gauges), enough for this service without a dependency. */
export class Metrics {
  private counters = new Map<string, Map<string, number>>();
  private gauges = new Map<string, number>();
  private help = new Map<string, string>();

  inc(name: string, labels: Labels = {}, by = 1, help?: string): void {
    if (help) this.help.set(name, help);
    const series = this.counters.get(name) ?? new Map<string, number>();
    const key = Object.entries(labels)
      .sort()
      .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
      .join(",");
    series.set(key, (series.get(key) ?? 0) + by);
    this.counters.set(name, series);
  }

  set(name: string, value: number, help?: string): void {
    if (help) this.help.set(name, help);
    this.gauges.set(name, value);
  }

  get(name: string, labels: Labels = {}): number {
    const key = Object.entries(labels)
      .sort()
      .map(([k, v]) => `${k}="${v}"`)
      .join(",");
    return this.counters.get(name)?.get(key) ?? 0;
  }

  render(): string {
    const out: string[] = [];
    for (const [name, series] of this.counters) {
      if (this.help.has(name)) out.push(`# HELP ${name} ${this.help.get(name)}`);
      out.push(`# TYPE ${name} counter`);
      for (const [labels, v] of series) out.push(`${name}${labels ? `{${labels}}` : ""} ${v}`);
    }
    for (const [name, v] of this.gauges) {
      if (this.help.has(name)) out.push(`# HELP ${name} ${this.help.get(name)}`);
      out.push(`# TYPE ${name} gauge`, `${name} ${v}`);
    }
    return `${out.join("\n")}\n`;
  }
}

/** Queue-level gauges read from Postgres at scrape time (the source of truth, shared by replicas). */
export async function refreshQueueGauges(db: Db, metrics: Metrics): Promise<void> {
  const { rows: [q] } = await db.query<{ due: number; lag: number | null; in_flight: number; paused: number }>(
    `SELECT
       (SELECT count(*)::int FROM posts WHERE status = 'scheduled' AND due_at <= now()) AS due,
       (SELECT EXTRACT(EPOCH FROM now() - min(scheduled_at))::float8
          FROM posts WHERE status = 'scheduled' AND due_at <= now()) AS lag,
       (SELECT count(*)::int FROM posts WHERE status = 'publishing') AS in_flight,
       (SELECT CASE WHEN paused_until > now() THEN EXTRACT(EPOCH FROM paused_until - now())::float8 ELSE 0 END
          FROM rate_buckets WHERE name = 'provider_app') AS paused`,
  );
  metrics.set("ploot_queue_due_posts", q!.due, "Posts due now and not yet published (backlog)");
  metrics.set("ploot_queue_oldest_due_lag_seconds", q!.lag ?? 0, "Publication lag of the oldest due post");
  metrics.set("ploot_queue_in_flight_posts", q!.in_flight, "Posts in publishing across all replicas");
  metrics.set("ploot_app_paused_seconds", q!.paused ?? 0, "Seconds left of a provider app-level pause");
}

export function startHttpServer(
  port: number,
  deps: { db: Db; metrics: Metrics; isHealthy: () => boolean; onError?: (err: unknown) => void },
): Server {
  const server = createServer(async (req, res) => {
    if (req.url === "/healthz") {
      const ok = deps.isHealthy();
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify({ ok }));
      return;
    }
    if (req.url === "/metrics") {
      try {
        await refreshQueueGauges(deps.db, deps.metrics);
      } catch (err) {
        // Serve process metrics even if the DB is unreachable, but make the failure visible.
        deps.metrics.inc("ploot_worker_metrics_query_errors_total", {}, 1, "Failed queue-gauge queries");
        deps.onError?.(err);
      }
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(deps.metrics.render());
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port);
  return server;
}
