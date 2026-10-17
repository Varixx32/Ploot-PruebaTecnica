import { describe, expect, it } from "vitest";
import { backoffMs, parseRetryAfter } from "../src/backoff.js";

describe("backoffMs (full jitter)", () => {
  it("stays within [0, base·2^(n-1)]", () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const ceiling = 1000 * 2 ** (attempt - 1);
      expect(backoffMs(attempt, 1000, 60_000, () => 0)).toBe(0);
      expect(backoffMs(attempt, 1000, 60_000, () => 0.999999)).toBe(Math.floor(0.999999 * ceiling));
    }
  });

  it("is capped", () => {
    expect(backoffMs(30, 1000, 5000, () => 0.999999)).toBeLessThan(5000);
  });

  it("spreads simultaneous failures instead of re-synchronising them", () => {
    const delays = new Set(Array.from({ length: 50 }, () => backoffMs(4, 1000, 60_000)));
    expect(delays.size).toBeGreaterThan(40);
  });
});

describe("parseRetryAfter", () => {
  const now = Date.UTC(2026, 9, 17, 9, 0, 0);

  it("accepts delta-seconds", () => {
    expect(parseRetryAfter("20", 30, now)).toBe(20);
  });

  it("accepts an HTTP-date", () => {
    expect(parseRetryAfter(new Date(now + 45_000).toUTCString(), 30, now)).toBe(45);
  });

  it("falls back when missing or garbage", () => {
    expect(parseRetryAfter(null, 30, now)).toBe(30);
    expect(parseRetryAfter("soon", 30, now)).toBe(30);
  });

  it("clamps to [1s, 1h]", () => {
    expect(parseRetryAfter("0", 30, now)).toBe(1);
    expect(parseRetryAfter("999999", 30, now)).toBe(3600);
    expect(parseRetryAfter(new Date(now - 10_000).toUTCString(), 30, now)).toBe(1);
  });
});
