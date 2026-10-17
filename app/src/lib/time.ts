import { ApiError } from "./http";

/**
 * Wall-clock ("09:00 in Europe/Madrid") -> UTC instant, DST-correct, without Temporal (not in
 * Node 22). Posts are stored as timestamptz instants; the zone is kept for display/audit.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Wall clock in `timeZone` at instant `utcMs`, expressed as if it were UTC (ms). */
function wallClockMs(utcMs: number, timeZone: string): number {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  return Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
}

/** UTC offset of `timeZone` at instant `utcMs`, in ms (e.g. +2h for Madrid in summer). */
export function offsetMs(utcMs: number, timeZone: string): number {
  return wallClockMs(Math.floor(utcMs / 1000) * 1000, timeZone) - Math.floor(utcMs / 1000) * 1000;
}

export type LocalResolution =
  | { kind: "ok"; instant: Date; ambiguous: boolean }
  /** The wall-clock time is skipped by a DST jump (e.g. 02:30 on the last Sunday of March in Madrid). */
  | { kind: "nonexistent" };

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Resolves a local date-time in an IANA zone. Candidates are built from the offsets in force one
 * day before and after, and kept only if they map back to the same wall clock:
 *  - 0 candidates: nonexistent (spring-forward gap);
 *  - 2 candidates: ambiguous (fall-back overlap) -> the earlier instant, like Temporal's
 *    "compatible" disambiguation (the first time the clock shows it).
 */
export function zonedLocalToUtc(local: string, timeZone: string): LocalResolution {
  const m = LOCAL_RE.exec(local);
  if (!m) throw new ApiError(422, "invalid_local_datetime", "Expected YYYY-MM-DDTHH:mm[:ss]");
  const [, y, mo, d, h, mi, s] = m;
  const naive = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +(s ?? 0));
  // Reject things like 2026-02-30 that Date.UTC silently rolls over.
  const check = new Date(naive);
  if (check.getUTCMonth() !== +mo! - 1 || check.getUTCDate() !== +d! || +h! > 23 || +mi! > 59) {
    throw new ApiError(422, "invalid_local_datetime", "Not a real calendar date/time");
  }

  const day = 24 * 3600 * 1000;
  const offsets = new Set([offsetMs(naive - day, timeZone), offsetMs(naive + day, timeZone)]);
  const candidates = [...offsets]
    .map((o) => naive - o)
    .filter((utc) => wallClockMs(utc, timeZone) === naive)
    .sort((a, b) => a - b);

  if (candidates.length === 0) return { kind: "nonexistent" };
  return { kind: "ok", instant: new Date(candidates[0]!), ambiguous: candidates.length > 1 };
}

export const MAX_SCHEDULE_AHEAD_DAYS = 90;
/** Small grace for clock skew between client and server. */
const PAST_GRACE_MS = 60_000;

export interface ScheduleInput {
  /** Absolute instant; must carry an explicit offset or Z. */
  scheduled_at?: string;
  /** Wall-clock time, interpreted in `timezone`. */
  scheduled_local?: string;
  timezone: string;
}

/** Turns API input into a validated UTC instant inside the allowed window. */
export function resolveSchedule(input: ScheduleInput, now: Date = new Date()): { instant: Date; timezone: string } {
  if (!isValidTimeZone(input.timezone)) {
    throw new ApiError(422, "invalid_timezone", `Unknown IANA time zone: ${input.timezone}`);
  }
  let instant: Date;
  if (input.scheduled_at !== undefined) {
    // A bare "2027-03-28T09:00" is ambiguous by nature: demand an offset or use scheduled_local.
    if (!/(Z|[+-]\d{2}:\d{2})$/.test(input.scheduled_at) || Number.isNaN(Date.parse(input.scheduled_at))) {
      throw new ApiError(422, "invalid_instant", "scheduled_at must be ISO-8601 with an offset (or use scheduled_local + timezone)");
    }
    instant = new Date(input.scheduled_at);
  } else if (input.scheduled_local !== undefined) {
    const r = zonedLocalToUtc(input.scheduled_local, input.timezone);
    if (r.kind === "nonexistent") {
      throw new ApiError(
        422,
        "nonexistent_local_time",
        `${input.scheduled_local} does not exist in ${input.timezone} (clocks jump forward). Pick another time.`,
      );
    }
    instant = r.instant;
  } else {
    throw new ApiError(422, "missing_schedule", "Provide scheduled_at or scheduled_local + timezone");
  }

  if (instant.getTime() < now.getTime() - PAST_GRACE_MS) {
    throw new ApiError(422, "scheduled_in_past", "The scheduled time is in the past");
  }
  if (instant.getTime() > now.getTime() + MAX_SCHEDULE_AHEAD_DAYS * 24 * 3600 * 1000) {
    throw new ApiError(422, "too_far_ahead", `Posts can be scheduled at most ${MAX_SCHEDULE_AHEAD_DAYS} days ahead`);
  }
  return { instant, timezone: input.timezone };
}
