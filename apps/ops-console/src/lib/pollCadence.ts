/**
 * E2E-43 — parsing a poll-cadence env override, safely.
 *
 * This is one function in its own module for one reason: it must be reachable
 * from the node test project, and `lib/api.ts` (where the POLL_* constants
 * live) pulls in SWR and Next and cannot be imported there.
 *
 * The hazard it closes: SWR's `refreshInterval` treats BOTH `NaN` and `0` as
 * falsy and responds by disabling polling — silently, with no error and no
 * visual difference. A console whose polls are dead still renders its last
 * payload and still looks live. So a single typo in a deploy env
 * (`NEXT_PUBLIC_DASHBOARD_POLL_MS=5s`, or an empty value from an unset
 * variable) used to stop every cadence derived from that knob, including:
 *
 *   • POLL_AMBER (= POLL_DASH × 2), the console-wide SosAlertBar sweep that
 *     surfaces critical incidents, lost-signal missions, failed dispatches and
 *     stale VBG protectees on EVERY page;
 *   • the Shell's `STALE_AFTER_MS = 3 * POLL_DASH` (Shell.tsx:52), which as
 *     `NaN` fails every `age > STALE_AFTER_MS` comparison — so the freshness
 *     pill can never say STALE, and the one indicator that would reveal the
 *     outage is disabled by the very same typo.
 *
 * A malformed override should therefore cost the OVERRIDE, never the polling.
 */
export function pollMs(raw: string | undefined | null, fallback: number): number {
  if (raw === undefined || raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  // Finite and positive: rejects NaN, Infinity, 0 and negatives, each of which
  // reaches SWR as "never poll" rather than as an error.
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
