/**
 * E2E-09 — ONE canonical "today" for the whole Secure Pro lane.
 *
 * Three definitions used to compete over the same reserved date: the client's
 * `new Date().toISOString().slice(0,10)` (UTC), this service's todayGulf()
 * (UTC+4) and Postgres CURRENT_DATE (whatever the pod's session TimeZone is).
 * For a UAE user that left the mission-day tile locked ~4 h into the mission
 * day and open ~4 h into the next one.
 *
 * A Pro reserved date is a BUSINESS CALENDAR DAY, not an instant — "the 5th"
 * means the officer's 5th, wherever the phone happens to be — so the Gulf
 * calendar day is the definition (the repo's UTC-everywhere rule governs
 * timestamps, which these are not). Every comparison in the Pro lane goes
 * through this module: server code via todayGulf(), SQL via GULF_TODAY_SQL,
 * the client screens via the twin at `src/screens/securepro/gulfDay.ts`.
 */

/** UAE never observes DST, so a fixed offset is exact for all time. */
export const GULF_UTC_OFFSET_HOURS = 4;

/** The Gulf (UTC+4) calendar day as YYYY-MM-DD. */
export function todayGulf(now: number = Date.now()): string {
  return new Date(now + GULF_UTC_OFFSET_HOURS * 3600_000).toISOString().slice(0, 10);
}

/** `todayGulf()` shifted by whole days — the sweeper's escalation horizon. */
export function gulfDayPlus(days: number, now: number = Date.now()): string {
  return todayGulf(now + days * 86_400_000);
}

/**
 * The SAME day inside SQL — a drop-in for CURRENT_DATE on every Pro date column.
 *
 * Why: expressed as an explicit UTC shift rather than `AT TIME ZONE 'Asia/Dubai'`
 * or a bare `::date` cast, so it is arithmetically identical to todayGulf() and
 * depends on neither the connection's TimeZone setting nor the server's tzdata.
 */
export const GULF_TODAY_SQL =
  `((now() AT TIME ZONE 'UTC' + interval '${GULF_UTC_OFFSET_HOURS} hours')::date)`;
