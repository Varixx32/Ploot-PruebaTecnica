import { describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/http";
import { resolveSchedule, zonedLocalToUtc } from "../src/lib/time";

const MADRID = "Europe/Madrid";
const utc = (local: string, tz = MADRID) => {
  const r = zonedLocalToUtc(local, tz);
  if (r.kind !== "ok") throw new Error(`${local} is nonexistent`);
  return r.instant.toISOString();
};
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as ApiError).code;
  }
  return "no error";
};

describe("Europe/Madrid DST correctness", () => {
  it("09:00 local is 08:00Z in winter (CET, +1) and 07:00Z in summer (CEST, +2)", () => {
    expect(utc("2027-01-15T09:00")).toBe("2027-01-15T08:00:00.000Z");
    expect(utc("2027-07-15T09:00")).toBe("2027-07-15T07:00:00.000Z");
  });

  it("spring forward (last Sunday of March 2027): same 09:00 wall clock, one hour less in UTC", () => {
    expect(utc("2027-03-27T09:00")).toBe("2027-03-27T08:00:00.000Z"); // Saturday, CET
    expect(utc("2027-03-28T09:00")).toBe("2027-03-28T07:00:00.000Z"); // Sunday, CEST
  });

  it("fall back (last Sunday of October 2026): same 09:00 wall clock, one hour more in UTC", () => {
    expect(utc("2026-10-24T09:00")).toBe("2026-10-24T07:00:00.000Z"); // Saturday, CEST
    expect(utc("2026-10-25T09:00")).toBe("2026-10-25T08:00:00.000Z"); // Sunday, CET
  });

  it("a weekly 09:00 slot keeps its local time across the change (UTC hour moves)", () => {
    const mondays = ["2026-10-19T09:00", "2026-10-26T09:00", "2026-11-02T09:00"];
    expect(mondays.map((m) => new Date(utc(m)).getUTCHours())).toEqual([7, 8, 8]);
  });

  it("02:30 on spring-forward day does not exist", () => {
    expect(zonedLocalToUtc("2027-03-28T02:30", MADRID)).toEqual({ kind: "nonexistent" });
    expect(utc("2027-03-28T01:59")).toBe("2027-03-28T00:59:00.000Z");
    expect(utc("2027-03-28T03:00")).toBe("2027-03-28T01:00:00.000Z");
  });

  it("02:30 on fall-back day happens twice: resolved to the first (CEST) occurrence", () => {
    const r = zonedLocalToUtc("2026-10-25T02:30", MADRID);
    expect(r).toEqual({ kind: "ok", instant: new Date("2026-10-25T00:30:00.000Z"), ambiguous: true });
  });

  it("other zones work too (no DST / opposite hemisphere)", () => {
    expect(utc("2027-01-15T09:00", "UTC")).toBe("2027-01-15T09:00:00.000Z");
    expect(utc("2027-01-15T09:00", "America/Sao_Paulo")).toBe("2027-01-15T12:00:00.000Z");
    expect(utc("2027-01-15T09:00", "Australia/Sydney")).toBe("2027-01-14T22:00:00.000Z"); // AEDT +11
  });

  it("rejects impossible calendar dates", () => {
    expect(code(() => zonedLocalToUtc("2027-02-30T09:00", MADRID))).toBe("invalid_local_datetime");
    expect(code(() => zonedLocalToUtc("tomorrow 9am", MADRID))).toBe("invalid_local_datetime");
  });
});

describe("resolveSchedule", () => {
  const now = new Date("2026-10-17T10:00:00Z");

  it("local time + zone -> instant", () => {
    expect(resolveSchedule({ scheduled_local: "2026-10-25T09:00", timezone: MADRID }, now).instant.toISOString()).toBe(
      "2026-10-25T08:00:00.000Z",
    );
  });

  it("absolute instant needs an explicit offset", () => {
    expect(resolveSchedule({ scheduled_at: "2026-10-20T09:00:00+02:00", timezone: MADRID }, now).instant.toISOString()).toBe(
      "2026-10-20T07:00:00.000Z",
    );
    expect(code(() => resolveSchedule({ scheduled_at: "2026-10-20T09:00:00", timezone: MADRID }, now))).toBe("invalid_instant");
  });

  it("typed errors for nonexistent times, unknown zones and the 90-day window", () => {
    expect(code(() => resolveSchedule({ scheduled_local: "2027-03-28T02:30", timezone: MADRID }, new Date("2027-03-01T00:00:00Z")))).toBe(
      "nonexistent_local_time",
    );
    expect(code(() => resolveSchedule({ scheduled_local: "2026-10-20T09:00", timezone: "Mars/Olympus" }, now))).toBe("invalid_timezone");
    expect(code(() => resolveSchedule({ scheduled_local: "2026-10-01T09:00", timezone: MADRID }, now))).toBe("scheduled_in_past");
    expect(code(() => resolveSchedule({ scheduled_local: "2027-01-16T09:00", timezone: MADRID }, now))).toBe("too_far_ahead");
    expect(code(() => resolveSchedule({ timezone: MADRID }, now))).toBe("missing_schedule");
  });
});
