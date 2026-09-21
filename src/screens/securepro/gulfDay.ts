/**
 * E2E-09 — the client half of the ONE canonical "today" for Secure Pro.
 * Server twin: `apps/auth-service/src/pro-applications/gulf-day.ts`.
 *
 * Three definitions used to compete over the same reserved date: this client's
 * `new Date().toISOString().slice(0,10)` (UTC), the server's todayGulf() (UTC+4)
 * and Postgres CURRENT_DATE. For a UAE user the mission-day tile stayed locked
 * ~4 h into the mission day and opened ~4 h into the next one, and the calendar
 * would let a date be tapped that the server then rejected as date_in_past.
 *
 * A Pro reserved date is a BUSINESS CALENDAR DAY, not an instant — "the 5th"
 * means the officer's 5th, wherever the phone is — so the Gulf calendar day is
 * the definition. (The repo's `@utils/datetime` UTC-everywhere rule governs
 * timestamps; these are bare YYYY-MM-DD days with no clock attached.)
 */

/** UAE never observes DST, so a fixed offset is exact for all time. */
export const GULF_UTC_OFFSET_HOURS = 4;

/** The Gulf (UTC+4) calendar day as YYYY-MM-DD — compare reserved dates to THIS. */
export function todayGulf(now: number = Date.now()): string {
  return new Date(now + GULF_UTC_OFFSET_HOURS * 3600_000).toISOString().slice(0, 10);
}
