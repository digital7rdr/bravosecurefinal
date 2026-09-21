/**
 * Coverage Calendar month model — pure, node-testable.
 *
 * B-814 (founder, 2026-09-07): the pager always opened on the FIRST covered
 * month ("always open on month August and we are in September now"). The
 * calendar must open on the month you are in — inside the covered period —
 * and fall back to the nearest edge when today lies outside it.
 */

/** [y, m] pairs spanning startIso..endIso (YYYY-MM-DD). */
export function monthsBetween(startIso: string, endIso: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let y = Number(startIso.slice(0, 4));
  let m = Number(startIso.slice(5, 7)) - 1;
  const ey = Number(endIso.slice(0, 4));
  const em = Number(endIso.slice(5, 7)) - 1;
  while (y < ey || (y === ey && m <= em)) {
    out.push([y, m]);
    m += 1;
    if (m > 11) {m = 0; y += 1;}
    if (out.length > 24) {break;} // safety — plans cap well below 2 years
  }
  return out;
}

/**
 * The pager index the calendar should OPEN on: today's month when it is
 * covered; the last page when the period is already behind us; the first when
 * it has not started yet. `todayIso` is the Gulf business day (E2E-09).
 */
export function initialMonthIndex(months: ReadonlyArray<readonly [number, number]>, todayIso: string): number {
  if (months.length === 0) {return 0;}
  const y = Number(todayIso.slice(0, 4));
  const m = Number(todayIso.slice(5, 7)) - 1;
  if (!Number.isFinite(y) || !Number.isFinite(m)) {return 0;}
  const key = y * 12 + m;
  const first = months[0][0] * 12 + months[0][1];
  const last = months[months.length - 1][0] * 12 + months[months.length - 1][1];
  if (key <= first) {return 0;}
  if (key >= last) {return months.length - 1;}
  const ix = months.findIndex(([yy, mm]) => yy === y && mm === m);
  return ix >= 0 ? ix : 0;
}
