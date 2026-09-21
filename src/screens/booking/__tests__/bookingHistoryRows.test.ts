/**
 * B-786 — the booking-history row view-model.
 *
 * The headline pin is the LOCAL-TIME one. The screen this replaces formatted
 * with `timeZone: 'UTC'`, so a booking at 01:00 Gulf time was dated the previous
 * day (B-786b). That test is RED against the old formatter and is the reason
 * this file exists; everything else guards the "rich row" the founder asked for.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  buildHistoryRow, formatRowWhen, routeLine, teamLine, rowAmount, formatCredits,
  monthKeyFor, monthLabelFor, groupByMonth, serviceTitle, shortPlace, shortRef,
  a11yLabelFor, rangeKeyFor, paymentMethodLabel, type HistoryRowInput,
} from '../bookingHistoryRows';

const NOW = new Date('2026-09-03T12:00:00').getTime();

function b(over: Partial<HistoryRowInput> = {}): HistoryRowInput {
  return {
    id: '0f9a1b2c-3d4e-5f60-7a8b-9c0d1e2f3a4b',
    status: 'COMPLETED',
    service: 'secure_transfer',
    start_time: new Date('2026-09-02T18:30:00').toISOString(),
    duration_hours: 4,
    pickup_address: 'Dubai Marina, Dubai, UAE',
    dropoff_address: 'DIFC, Dubai',
    cpo_count: 1,
    vehicle_count: 1,
    total_eur: 980,
    ...over,
  };
}

describe('time — local clock, never UTC (B-786b)', () => {
  it('dates an early-morning booking on the day the user picked it', () => {
    // The regression: at UTC+4 this instant is 01:00 on the 3rd locally and
    // 21:00 on the 2nd in UTC. A UTC formatter prints the WRONG DAY.
    const local1am = new Date(2026, 8, 3, 1, 0, 0);
    const when = formatRowWhen(local1am.toISOString(), 4, NOW);
    expect(when).toContain('Today');
    expect(when).toContain('1:00 AM');
    expect(when).not.toContain('02 Sep');
  });

  it('prints the time of day, which the old row omitted entirely', () => {
    expect(formatRowWhen(new Date(2026, 8, 2, 18, 30).toISOString(), 4, NOW))
      .toContain('6:30 PM');
  });

  it('uses relative day words inside a 48-hour window', () => {
    const at = (d: number, h: number) => new Date(2026, 8, d, h, 0).toISOString();
    expect(formatRowWhen(at(3, 9), 2, NOW)).toContain('Today');
    expect(formatRowWhen(at(4, 9), 2, NOW)).toContain('Tomorrow');
    expect(formatRowWhen(at(2, 9), 2, NOW)).toContain('Yesterday');
    expect(formatRowWhen(at(6, 9), 2, NOW)).toContain('Sun 06 Sep');
  });

  it('compares CALENDAR days, not elapsed hours', () => {
    // 11 PM tonight and 1 AM tomorrow are 2 h apart but are different days.
    const lateTonight = new Date(2026, 8, 3, 23, 0).toISOString();
    const earlyTomorrow = new Date(2026, 8, 4, 1, 0).toISOString();
    expect(formatRowWhen(lateTonight, 1, NOW)).toContain('Today');
    expect(formatRowWhen(earlyTomorrow, 1, NOW)).toContain('Tomorrow');
  });

  it('renders the duration beside the time', () => {
    expect(formatRowWhen(new Date(2026, 8, 2, 18, 30).toISOString(), 4, NOW)).toContain('4 h');
    expect(formatRowWhen(new Date(2026, 8, 2, 18, 30).toISOString(), null, NOW)).not.toContain('h');
  });

  it('survives a missing or unparseable start time', () => {
    expect(formatRowWhen(null, 4, NOW)).toBe('4 h');
    expect(formatRowWhen('not-a-date', null, NOW)).toBe('');
  });
});

describe('what — service, task type, reference', () => {
  it('names the service in the product wording', () => {
    expect(serviceTitle(b())).toBe('Secure Transfer');
    expect(serviceTitle(b({service: 'recon_team'}))).toBe('Recon Team');
  });

  it('appends the executive task type — the "category" the founder asked for', () => {
    expect(serviceTitle(b({service: 'executive_protection', task_type: 'event_security'})))
      .toBe('Executive Protection · Event Security');
  });

  it('ignores an unknown task type rather than printing a raw key', () => {
    expect(serviceTitle(b({service: 'executive_protection', task_type: 'zzz'})))
      .toBe('Executive Protection');
  });

  it('falls back to a humanised key for a service the catalogue does not know', () => {
    expect(serviceTitle(b({service: 'drone_overwatch'}))).toBe('Drone Overwatch');
  });

  it('computes the same support reference the server does', () => {
    expect(shortRef('0f9a1b2c-3d4e-5f60-7a8b-9c0d1e2f3a4b')).toBe('BL-9C0D1E2F3A4B');
  });

  it('prefers a server-supplied reference over recomputing one', () => {
    expect(buildHistoryRow(b({reference: 'BL-SERVER01'}), NOW).reference).toBe('BL-SERVER01');
  });
});

describe('where — route', () => {
  it('shows pickup to drop-off using the first address segment', () => {
    expect(routeLine(b())).toBe('Dubai Marina → DIFC');
  });

  it('says "protection only" for an executive detail with no transfer leg', () => {
    expect(routeLine(b({service: 'executive_protection', dropoff_address: null})))
      .toBe('Dubai Marina · Protection only');
  });

  it('does not say "protection only" when a transfer leg exists', () => {
    expect(routeLine(b({
      service: 'executive_protection', dropoff_address: null, exec_transport: {mode: 'return'},
    }))).toBe('Dubai Marina');
  });

  it('reads a nested pickup object (the plain wire Booking shape)', () => {
    expect(routeLine({id: 'x', pickup: {address: 'Marina'}, dropoff: {address: 'DIFC'}}))
      .toBe('Marina → DIFC');
  });

  it('returns empty rather than a dangling arrow when nothing is known', () => {
    expect(routeLine({id: 'x'})).toBe('');
  });

  it('keeps a single-segment address intact', () => {
    expect(shortPlace('Marina')).toBe('Marina');
    expect(shortPlace('  ')).toBeNull();
  });
});

describe('team line', () => {
  it('pluralises and drops zero counts', () => {
    expect(teamLine(b({cpo_count: 2, vehicle_count: 1}))).toBe('2 CPOs · 1 vehicle');
    expect(teamLine(b({cpo_count: 0, vehicle_count: 0}))).toBe('');
  });

  it('shows driver-only instead of a vehicle count', () => {
    expect(teamLine(b({cpo_count: 1, vehicle_count: 1, driver_only: true})))
      .toBe('1 CPO · Driver only');
  });

  it('surfaces armed and female requirements', () => {
    expect(teamLine(b({requirements: {armed: true, female: true}})))
      .toContain('Armed');
    expect(teamLine(b({requirements: {armed: true, female: true}})))
      .toContain('Female CPO');
  });
});

describe('how much — the amount never implies money that did not move', () => {
  it('shows the charge once a payment exists', () => {
    expect(rowAmount(b({payment: {state: 'paid', charged_credits: 980}})))
      .toEqual({amount: '980 BC', quoted: false});
  });

  it('flags a bare quote as quoted so the UI can say so', () => {
    expect(rowAmount(b())).toEqual({amount: '980 BC', quoted: true});
  });

  it('renders a refund negative', () => {
    expect(rowAmount(b({payment: {state: 'refunded', charged_credits: 980, refunded_credits: 980}})).amount)
      .toBe('−980 BC');
  });

  it('shows what was kept AND what came back on a partial refund', () => {
    expect(rowAmount(b({payment: {state: 'partially_refunded', charged_credits: 980, refunded_credits: 300}})).amount)
      .toBe('680 BC · 300 BC back');
  });

  it('falls back to the quote while the money is still due', () => {
    expect(rowAmount(b({total_eur: 1240, payment: {state: 'due', charged_credits: 0}})))
      .toEqual({amount: '1,240 BC', quoted: true});
  });

  it('shows nothing rather than "0 BC" when there is no figure', () => {
    expect(rowAmount({id: 'x'}).amount).toBe('');
  });

  it('groups thousands', () => {
    expect(formatCredits(4120)).toBe('4,120 BC');
    expect(formatCredits(-480)).toBe('−480 BC');
  });
});

describe('paid with', () => {
  it('names the method', () => {
    expect(buildHistoryRow(b({payment: {state: 'paid', method: 'bravo_credits', charged_credits: 980}}), NOW).paidWith)
      .toBe('Credits');
    expect(buildHistoryRow(b({payment: {state: 'paid', method: 'card', charged_credits: 980}}), NOW).paidWith)
      .toBe('Card');
  });

  // B-834 — RE-POINTED, not weakened. The rule is "name the OTHER payer"; the
  // wording went neutral because linked people are Members now, and
  // `family_owner` stays the wire value (a server enum, not user-facing copy).
  //
  // B-843/A18 — RE-POINTED again: a member may now be under SEVERAL roots, so
  // "plan holder" no longer identifies anyone. The server projects
  // `payer_name`; the old copy stays the fallback for rows (and servers) that
  // carry none.
  it('names the ROOT that paid when the server sent it', () => {
    expect(buildHistoryRow(
      b({payment: {state: 'paid', method: 'bravo_credits', payer: 'family_owner', payer_name: 'Acme Ltd'}}),
      NOW,
    ).paidWith).toBe('Paid by Acme Ltd');
  });

  it('falls back to the neutral wording when no name was projected', () => {
    expect(buildHistoryRow(b({payment: {state: 'paid', method: 'bravo_credits', payer: 'family_owner'}}), NOW).paidWith)
      .toBe('Paid by plan holder');
    expect(buildHistoryRow(
      b({payment: {state: 'paid', method: 'bravo_credits', payer: 'family_owner', payer_name: '   '}}),
      NOW,
    ).paidWith).toBe('Paid by plan holder');
  });

  it('a self-paid row is never captioned with a payer name', () => {
    expect(buildHistoryRow(
      b({payment: {state: 'paid', method: 'card', payer: 'self', payer_name: 'Acme Ltd'}}),
      NOW,
    ).paidWith).toBe('Card');
  });

  it('reads the legacy top-level payment_method when there is no payment block', () => {
    expect(buildHistoryRow(b({payment_method: 'card'}), NOW).paidWith).toBe('Card');
  });
});

describe('month grouping', () => {
  it('keys and labels by the LOCAL month', () => {
    const iso = new Date(2026, 8, 2, 18, 30).toISOString();
    expect(monthKeyFor(iso)).toBe('2026-09');
    expect(monthLabelFor(iso)).toMatch(/2026/);
  });

  it('does not crash on a missing date', () => {
    expect(monthKeyFor(null)).toBe('unknown');
    expect(monthLabelFor(null)).toBe('Earlier');
  });

  it('groups consecutive rows and preserves server order', () => {
    const rows = [
      {monthKey: '2026-09', monthLabel: 'SEPTEMBER 2026'},
      {monthKey: '2026-09', monthLabel: 'SEPTEMBER 2026'},
      {monthKey: '2026-08', monthLabel: 'AUGUST 2026'},
    ];
    const out = groupByMonth(rows);
    expect(out.map(s => s.key)).toEqual(['2026-09', '2026-08']);
    expect(out[0].data).toHaveLength(2);
  });

  it('never re-sorts — a repeated month later in the page opens a new section', () => {
    // Re-sorting a PAGE is how a cursor-paged list starts interleaving.
    const out = groupByMonth([
      {monthKey: '2026-09', monthLabel: 'S'},
      {monthKey: '2026-08', monthLabel: 'A'},
      {monthKey: '2026-09', monthLabel: 'S'},
    ]);
    expect(out).toHaveLength(3);
  });
});

describe('the whole row', () => {
  it('answers all five questions for a completed, paid booking', () => {
    const vm = buildHistoryRow(b({
      payment: {state: 'released', method: 'bravo_credits', charged_credits: 980},
      rating: {stars: 5},
      receipt: {invoice_number: 'BS-000123'},
    }), NOW);
    expect(vm.title).toBe('Secure Transfer');
    expect(vm.when).toContain('Yesterday');
    expect(vm.where).toBe('Dubai Marina → DIFC');
    expect(vm.team).toBe('1 CPO · 1 vehicle');
    expect(vm.status.label).toBe('COMPLETED');
    expect(vm.status.money).toBe('PAID');
    expect(vm.amount).toBe('980 BC');
    expect(vm.paidWith).toBe('Credits');
    expect(vm.stars).toBe(5);
    expect(vm.receiptNumber).toBe('BS-000123');
    expect(vm.bucket).toBe('past');
  });

  it('reads a numeric rating (the wire Booking shape)', () => {
    expect(buildHistoryRow(b({rating: 4}), NOW).stars).toBe(4);
    expect(buildHistoryRow(b({rating: 0}), NOW).stars).toBeNull();
  });

  it('groups by created_at when a booking has no start time yet', () => {
    const vm = buildHistoryRow(
      {id: 'x', status: 'PENDING_OPS', start_time: null, created_at: new Date(2026, 7, 15).toISOString()},
      NOW,
    );
    expect(vm.monthKey).toBe('2026-08');
  });

  it('speaks one sentence with the same five answers', () => {
    const vm = buildHistoryRow(b({
      payment: {state: 'released', method: 'bravo_credits', charged_credits: 980},
      rating: {stars: 5},
    }), NOW);
    expect(vm.accessibilityLabel).toContain('Secure Transfer');
    expect(vm.accessibilityLabel).toContain('Dubai Marina → DIFC');
    expect(vm.accessibilityLabel).toContain('completed, paid');
    expect(vm.accessibilityLabel).toContain('980 credits');
    expect(vm.accessibilityLabel).toContain('rated 5 stars');
  });

  it('never speaks a raw "BC" or a unicode minus', () => {
    const vm = buildHistoryRow(b({
      payment: {state: 'refunded', charged_credits: 980, refunded_credits: 980},
    }), NOW);
    expect(vm.accessibilityLabel).not.toContain('BC');
    expect(vm.accessibilityLabel).toContain('minus');
  });

  it('omits empty parts from the spoken label instead of leaving gaps', () => {
    const label = a11yLabelFor({
      id: 'x', reference: 'BL-1', title: 'T', when: 'W', where: '', team: '',
      status: {label: 'COMPLETED', money: null, color: '#fff', bucket: 'past'},
      bucket: 'past', amount: '', paidWith: null, quoted: true, stars: null,
      receiptNumber: null, monthKey: '2026-09', monthLabel: 'S',
    });
    expect(label).toBe('T, W, completed');
  });
});

// ─── fixes from the adversarial review of this change ───────────────────────

describe('rangeKeyFor — the filter sheet shows the window actually in force', () => {
  // The sheet re-seeded with `filters.from ? '30' : 'any'`, so reopening after
  // "Last 90 days" showed the 30-day pill selected — and an Apply meant only to
  // change the service then silently narrowed the window to 30 days.
  // Renamed from NOW: it shadowed the module-level NOW (line 15) and tripped
  // @typescript-eslint/no-shadow (an error, not a warning) in the pre-commit hook.
  const NOW_UTC = new Date('2026-09-03T12:00:00Z').getTime();
  const ago = (days: number) => new Date(NOW_UTC - days * 86_400_000).toISOString();

  it('resolves each window back to its own pill', () => {
    expect(rangeKeyFor(ago(30), NOW_UTC)).toBe('30');
    expect(rangeKeyFor(ago(90), NOW_UTC)).toBe('90');
    expect(rangeKeyFor(ago(365), NOW_UTC)).toBe('365');
  });

  it('is "any" with no window set', () => {
    expect(rangeKeyFor(null, NOW_UTC)).toBe('any');
    expect(rangeKeyFor(undefined, NOW_UTC)).toBe('any');
  });

  it('never silently narrows a 90-day window to 30 days', () => {
    expect(rangeKeyFor(ago(90), NOW_UTC)).not.toBe('30');
  });

  it('tolerates clock drift by snapping to the nearest window', () => {
    expect(rangeKeyFor(ago(89), NOW_UTC)).toBe('90');
    expect(rangeKeyFor(ago(92), NOW_UTC)).toBe('90');
  });

  it('falls back to "any" on an unparseable value', () => {
    expect(rangeKeyFor('not-a-date', NOW_UTC)).toBe('any');
  });
});

describe('amounts never print a zero where there is no figure', () => {
  it('shows nothing for a refunded row with no numbers at all', () => {
    // Previously rendered "0 BC" beside a REFUNDED chip.
    expect(rowAmount({
      id: 'x', payment: {state: 'refunded', charged_credits: 0, refunded_credits: 0},
    }).amount).toBe('');
  });

  it('still shows a real refund', () => {
    expect(rowAmount({
      id: 'x', payment: {state: 'refunded', charged_credits: 480, refunded_credits: 480},
    }).amount).toBe('−480 BC');
  });
});

describe('an executive detail with no address still says what it is', () => {
  it('reads "Protection only" rather than an empty line', () => {
    expect(routeLine({id: 'x', service: 'executive_protection'})).toBe('Protection only');
  });

  it('leaves a non-executive booking with no address blank', () => {
    expect(routeLine({id: 'x', service: 'secure_transfer'})).toBe('');
  });
});

/**
 * B-847 — one helper, two surfaces.
 *
 * Trip Summary used to render the raw column through `.replace(/_/g, ' ')`, so
 * the honest value now stored there ('bravo_credits') would have read
 * "bravo credits" while the history row beside it said "Credits". The label
 * table is `PAID_WITH`, and this is its only public door.
 */
describe('B-847 — paymentMethodLabel', () => {
  it('names every method the table knows', () => {
    expect(paymentMethodLabel('bravo_credits')).toBe('Credits');
    expect(paymentMethodLabel('card')).toBe('Card');
    expect(paymentMethodLabel('corporate')).toBe('Corporate');
    expect(paymentMethodLabel('plan')).toBe('Plan');
  });

  it('is the SAME table the history rows read — no second copy to drift', () => {
    // If someone forks the map, this and the row caption disagree on one value.
    expect(paymentMethodLabel('card')).toBe(buildHistoryRow(b({payment_method: 'card'}), NOW).paidWith);
  });

  it('opens the underscores on a value the table has not been taught', () => {
    expect(paymentMethodLabel('apple_pay')).toBe('apple pay');
  });

  it('degrades an empty / missing method to an em dash, never to a blank row', () => {
    expect(paymentMethodLabel(null)).toBe('—');
    expect(paymentMethodLabel(undefined)).toBe('—');
    expect(paymentMethodLabel('')).toBe('—');
    expect(paymentMethodLabel('   ')).toBe('—');
  });
});

describe('B-847 — TripSummaryScreen renders through the helper', () => {
  // The screen mounts RN and cannot be imported by this node project, so the
  // wiring is a source scan. CRLF-safe and comment-stripped: this file's own
  // prose names `replace(/_/g`, which is exactly how such a scan goes vacuous.
  const src = (): string =>
    readFileSync(join(process.cwd(), 'src/screens/booking/TripSummaryScreen.tsx'), 'utf8')
      .replace(/\r?\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  /**
   * Scoped to the Payment ROW, not the file. A whole-file
   * `not.toContain('replace(/_/g')` went red on line 217, where `booking.type`
   * is humanised the same way and legitimately — the CLAUDE.md rule that a scan
   * must assert the decision SITE, caught live.
   */
  const paymentRow = (): string => {
    const s = src();
    const at = s.indexOf('k="Payment"');
    expect(at).toBeGreaterThan(-1);
    return s.slice(at, s.indexOf('\n', at));
  };

  it('the Payment row calls paymentMethodLabel(', () => {
    expect(paymentRow()).toContain('paymentMethodLabel(booking.payment_method)');
    // …and imports it, rather than declaring a local of the same name.
    expect(src()).toMatch(/import \{paymentMethodLabel\} from '\.\/bookingHistoryRows';/);
  });

  it('the Payment row hand-rolls nothing any more', () => {
    const row = paymentRow();
    expect(row).not.toContain('replace(/_/g');
    expect(row).not.toContain('toUpperCase()');
  });
});
