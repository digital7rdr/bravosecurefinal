/**
 * B-860 follow-up — `windowsForDates` must be a LOCAL CALENDAR add, like every
 * other date in `shiftSeries.ts`.
 *
 * The overnight roll used `+ 86_400_000` MILLISECONDS. Across a DST boundary
 * that is not one calendar day: a 22:00–06:00 shift on the night the clocks go
 * forward ended at 07:00 wall-clock, an hour after the manager said it would,
 * and the geofenced check-in window moved with it. Spring-forward is an hour
 * late, autumn fall-back an hour early. The B-860 daily series made that
 * reachable on any night of a run rather than once a year on the weekly path.
 *
 * ── WHY THIS SWEEPS A WHOLE YEAR INSTEAD OF NAMING ONE DATE ──────────────────
 *
 * The transition dates belong to the HOST timezone and there is no way to force
 * one from inside a test here: jest hands each file a COPY of `process.env`, so
 * assigning `process.env.TZ` never reaches the V8 notification that re-reads it
 * (the read-back succeeds and `getTimezoneOffset()` does not move — verified).
 * So the pin runs every night of 2026 and asserts the invariant the manager
 * cares about: the shift ends at the wall-clock time they typed, on the next
 * calendar day. Whatever transitions the host zone has are inside that sweep —
 * `TRANSITIONS` below names them, and asserts the sweep really did cross one,
 * so a DST-free machine reports the pin as degraded rather than passing quietly.
 */
import {windowsForDates} from '../shiftSeries';

/** 22:00 / 06:00 as the time pickers hand them over — only h:m is ever read. */
const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m, 0, 0);

const pad = (n: number) => String(n).padStart(2, '0');
const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Every local date in 2026 (a calendar walk, so it is correct in any zone). */
const DAYS_2026: string[] = (() => {
  const out: string[] = [];
  for (let i = 0; ; i += 1) {
    const d = new Date(2026, 0, 1 + i, 12, 0, 0, 0);
    if (d.getFullYear() !== 2026) {break;}
    out.push(key(d));
  }
  return out;
})();

/** The days whose local UTC offset differs from the day before — the DST ones. */
const TRANSITIONS = DAYS_2026.filter((_, i) => {
  if (i === 0) {return false;}
  const prev = new Date(2026, 0, i, 12, 0, 0, 0).getTimezoneOffset();
  const cur = new Date(2026, 0, i + 1, 12, 0, 0, 0).getTimezoneOffset();
  return prev !== cur;
});

describe('windowsForDates — the overnight roll is a calendar day, not 86 400 000 ms', () => {
  it('the host timezone has DST, so the sweep below really crosses a boundary', () => {
    // Not an assertion about WHICH zone — only that this file is not degrading
    // to an identity check without saying so.
    expect(DAYS_2026).toHaveLength(365);
    expect(TRANSITIONS.length).toBeGreaterThan(0);
  });

  it('every night of 2026 ends at the wall-clock the manager typed, next day', () => {
    const wins = windowsForDates(DAYS_2026, at(22), at(6));
    expect(wins).toHaveLength(DAYS_2026.length);
    const wrong: string[] = [];
    wins.forEach((w, i) => {
      const st = new Date(Date.parse(w.start_at));
      const en = new Date(Date.parse(w.end_at));
      const nextDay = new Date(2026, 0, 1 + i + 1, 6, 0, 0, 0);
      if (st.getHours() !== 22 || en.getHours() !== 6 || en.getMinutes() !== 0
        || key(en) !== key(nextDay)) {
        wrong.push(`${DAYS_2026[i]} -> ${en.toString()}`);
      }
    });
    expect(wrong).toEqual([]);
  });

  it('the two DST nights specifically, named', () => {
    // Spring-forward: + 86 400 000 ms lands an hour LATE (07:00).
    // Fall-back: it lands an hour EARLY (05:00).
    for (const t of TRANSITIONS) {
      const i = DAYS_2026.indexOf(t);
      const night = DAYS_2026[i - 1];
      const [w] = windowsForDates([night], at(22), at(6));
      const en = new Date(Date.parse(w.end_at));
      expect(`${night} ends ${en.getHours()}:${pad(en.getMinutes())}`).toBe(`${night} ends 6:00`);
      expect(key(en)).toBe(t);
    }
  });

  it('an ordinary night is exactly 8 hours, 22:00 to 06:00', () => {
    const [w] = windowsForDates(['2026-06-10'], at(22), at(6));
    expect(Date.parse(w.end_at) - Date.parse(w.start_at)).toBe(8 * 3600_000);
  });

  it('a same-day window never rolls, and every selected date is answered', () => {
    const out = windowsForDates(['2026-03-07', '2026-03-08'], at(6), at(14));
    expect(out).toHaveLength(2);
    for (const w of out) {
      expect(new Date(Date.parse(w.start_at)).getHours()).toBe(6);
      expect(new Date(Date.parse(w.end_at)).getHours()).toBe(14);
    }
  });
});
