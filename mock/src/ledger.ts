import { randomBytes } from "node:crypto";

export interface PublishRecord {
  external_id: string;
  provider_user_id: string;
  /** Caller-supplied reference (our post id). The provider has no idempotency: it only records it. */
  client_ref: string | null;
  text_length: number;
  published_at: string;
}

/** Everything the "social network" actually published. Lets tests count real side effects. */
export class PublishLedger {
  private records: PublishRecord[] = [];

  constructor(private readonly now: () => number) {}

  record(userId: string, clientRef: string | null, text: string): PublishRecord {
    const rec: PublishRecord = {
      external_id: `ext_${randomBytes(8).toString("hex")}`,
      provider_user_id: userId,
      client_ref: clientRef,
      text_length: text.length,
      published_at: new Date(this.now()).toISOString(),
    };
    this.records.push(rec);
    return rec;
  }

  all(): readonly PublishRecord[] {
    return this.records;
  }

  /** client_refs published more than once: should always be empty if the scheduler is correct. */
  duplicates(): { client_ref: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const r of this.records) {
      if (r.client_ref) counts.set(r.client_ref, (counts.get(r.client_ref) ?? 0) + 1);
    }
    return [...counts].filter(([, n]) => n > 1).map(([client_ref, count]) => ({ client_ref, count }));
  }

  reset(): void {
    this.records = [];
  }
}
