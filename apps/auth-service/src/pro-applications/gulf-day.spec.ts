/**
 * E2E-09 — the canonical day, pinned to LITERAL values.
 *
 * Every other spec in this lane asserts the timezone by importing the same
 * helper the code under test calls (`expect(params).toEqual([todayGulf()])`) or
 * by interpolating `GULF_TODAY_SQL` into its own expectation. Those pin that
 * one definition is used EVERYWHERE — which is most of the value — but they are
 * self-referential about what the definition IS: delete the `+ 4 hours` and
 * they all still pass. This file is the other half: hand-computed instants and
 * the literal SQL text, so the offset itself cannot drift.
 *
 * It also pins that the JS and SQL halves agree, which nothing else does — the
 * SQL is deliberately written as an explicit UTC shift rather than
 * `AT TIME ZONE 'Asia/Dubai'` or a bare `::date`, so it is arithmetically the
 * same expression as todayGulf() and depends on neither the connection's
 * TimeZone setting nor the server's tzdata.
 */
import {GULF_TODAY_SQL, GULF_UTC_OFFSET_HOURS, gulfDayPlus, todayGulf} from './gulf-day';

describe('todayGulf — literal instants, not a re-derivation', () => {
  it('20:00 UTC on the 4th is already the 5th in the Gulf', () => {
    expect(todayGulf(Date.parse('2026-10-04T20:00:00.000Z'))).toBe('2026-10-05');
  });

  it('19:59:59 UTC on the 4th is still the 4th', () => {
    expect(todayGulf(Date.parse('2026-10-04T19:59:59.999Z'))).toBe('2026-10-04');
  });

  it('00:00 UTC is the same calendar day', () => {
    expect(todayGulf(Date.parse('2026-10-04T00:00:00.000Z'))).toBe('2026-10-04');
  });

  it('has no DST seam — the same 20:00 rule holds in July and in January', () => {
    expect(todayGulf(Date.parse('2026-07-04T20:00:00.000Z'))).toBe('2026-07-05');
    expect(todayGulf(Date.parse('2026-01-04T20:00:00.000Z'))).toBe('2026-01-05');
    expect(todayGulf(Date.parse('2026-07-04T19:00:00.000Z'))).toBe('2026-07-04');
    expect(todayGulf(Date.parse('2026-01-04T19:00:00.000Z'))).toBe('2026-01-04');
  });

  it('rolls the month, the year and a leap day correctly', () => {
    expect(todayGulf(Date.parse('2026-10-31T20:00:00.000Z'))).toBe('2026-11-01');
    expect(todayGulf(Date.parse('2026-12-31T20:00:00.000Z'))).toBe('2027-01-01');
    expect(todayGulf(Date.parse('2032-02-28T20:00:00.000Z'))).toBe('2032-02-29');
  });

  it('the offset constant IS four hours', () => {
    expect(GULF_UTC_OFFSET_HOURS).toBe(4);
  });
});

describe('gulfDayPlus — the escalation horizon', () => {
  it('shifts whole days off the SAME Gulf day', () => {
    const t = Date.parse('2026-10-04T20:00:00.000Z'); // Gulf: the 5th
    expect(gulfDayPlus(0, t)).toBe('2026-10-05');
    expect(gulfDayPlus(1, t)).toBe('2026-10-06');
    expect(gulfDayPlus(2, t)).toBe('2026-10-07');
  });

  it('crosses a month boundary', () => {
    expect(gulfDayPlus(1, Date.parse('2026-10-31T06:00:00.000Z'))).toBe('2026-11-01');
  });
});

describe('GULF_TODAY_SQL — the SQL half says the same thing', () => {
  it('is an explicit +4h shift off UTC, in literal text', () => {
    expect(GULF_TODAY_SQL).toContain(`interval '4 hours'`);
    expect(GULF_TODAY_SQL).toContain(`now() AT TIME ZONE 'UTC'`);
    expect(GULF_TODAY_SQL).toContain('::date');
  });

  it('never falls back to CURRENT_DATE or a named zone', () => {
    // CURRENT_DATE follows the pod's session TimeZone and a named zone needs
    // tzdata — both were the E2E-09 defect, in different clothes.
    expect(GULF_TODAY_SQL).not.toMatch(/CURRENT_DATE/);
    expect(GULF_TODAY_SQL).not.toMatch(/Asia\/Dubai/);
  });
});
