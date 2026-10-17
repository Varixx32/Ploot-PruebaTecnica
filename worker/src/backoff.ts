/**
 * Exponential backoff with full jitter (AWS architecture blog): uniform in [0, min(cap, base·2^(n-1))].
 * Full jitter spreads retries of many posts that failed together, instead of re-synchronising them
 * into the burst that the provider punishes.
 */
export function backoffMs(attempt: number, baseMs: number, maxMs: number, rng: () => number = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(rng() * exp);
}

/**
 * Retry-After is either delta-seconds or an HTTP-date (RFC 9110). Falls back to `fallbackSec` when
 * missing or unparsable, and clamps to [1s, 1h] so a hostile/buggy header can't stall us forever.
 */
export function parseRetryAfter(header: string | null, fallbackSec: number, nowMs = Date.now()): number {
  let sec = fallbackSec;
  if (header) {
    const trimmed = header.trim();
    if (/^\d+$/.test(trimmed)) {
      sec = Number(trimmed);
    } else {
      const at = Date.parse(trimmed);
      if (!Number.isNaN(at)) sec = Math.ceil((at - nowMs) / 1000);
    }
  }
  return Math.min(3600, Math.max(1, sec));
}
