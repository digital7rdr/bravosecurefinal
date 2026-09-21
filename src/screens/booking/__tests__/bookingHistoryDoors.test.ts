/**
 * B-786 — the doors into the booking history, and the two dead ends that made
 * the founder report "no history coming".
 *
 * These are RN components the node `booking` project cannot import, so the rules
 * are pinned by reading the source — the same pattern as myBookingsRoute.test.ts.
 * Both traps that class carries are handled below: CRLF is normalised (a
 * `\n`-anchored regex would match nothing and every assertion would pass
 * VACUOUSLY) and comments are stripped (prose naming a banned symbol must
 * neither satisfy nor break an assertion about CODE).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
const f = (...p: string[]) => join(ROOT, 'src', ...p);

function source(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function code(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

const PRO_DASHBOARD = code(f('screens', 'pro', 'ProDashboardScreen.tsx'));
const SUMMARY = code(f('screens', 'booking', 'SecureSummaryScreen.tsx'));
const HISTORY_SCREEN = code(f('screens', 'booking', 'BookingHistoryScreen.tsx'));
const LIST = code(f('screens', 'booking', 'BookingHistoryList.tsx'));
const CREDITS = code(f('screens', 'wallet', 'CreditsScreen.tsx'));

describe('B-786a — the Pro "Activity & Reports" tile is not a crew-scoped dead end', () => {
  /**
   * `GET /agents/me/missions` resolves `WHERE mc.agent_id = $1` against
   * `mission_crew`. A CLIENT is never crew, so that endpoint returns [] for
   * every Pro client — the tile rendered the agent's own copy ("No missions
   * yet") for a door promising "Bookings, logs & operational reports".
   */
  it('routes the reports tile at the booking history', () => {
    const tile = PRO_DASHBOARD.split('\n').find(l => l.includes("key: 'reports'"));
    expect(tile).toBeDefined();
    expect(tile).toMatch(/target: 'BookingHistory'/);
    expect(tile).not.toMatch(/target: 'ProActivityHistory'/);
  });

  it('never reaches the agent mission-history endpoint from a client surface', () => {
    for (const [name, src] of [
      ['ProDashboard', PRO_DASHBOARD], ['Summary', SUMMARY],
      ['BookingHistory', HISTORY_SCREEN], ['BookingHistoryList', LIST],
    ] as const) {
      expect(`${name}:${/getMissionHistory/.test(src)}`).toBe(`${name}:false`);
    }
  });
});

describe('B-786 — both history doors render the SAME list', () => {
  it('the Summary tab mounts the shared list', () => {
    expect(SUMMARY).toMatch(/<BookingHistoryList[\s/>]/);
  });

  it('the pushed "My Bookings" screen mounts the same shared list', () => {
    expect(HISTORY_SCREEN).toMatch(/<BookingHistoryList[\s/>]/);
  });

  it('neither screen keeps a second row model', () => {
    // The old BookingHistoryScreen owned its own `renderItem`, its own status
    // chip and its own date formatter. Two row models is how the two surfaces
    // drifted; the list is the only place a row is built.
    for (const src of [SUMMARY, HISTORY_SCREEN]) {
      expect(src).not.toMatch(/renderItem=/);
      expect(src).not.toMatch(/<FlatList/);
    }
  });

  it('rows are built by the pinned view-model, not inline in the view', () => {
    expect(LIST).toMatch(/buildHistoryRow\(/);
    expect(LIST).toMatch(/groupByMonth\(/);
  });
});

describe('B-786b — no booking surface formats a date in UTC', () => {
  /**
   * The old list passed `timeZone: 'UTC'` to `toLocaleDateString`, so a 01:00
   * Gulf booking was dated the previous day. `formatBookingTime` /
   * `formatRowWhen` (device-local, 12-hour) is the rule, and a review round
   * already rejected the same defect once on the summary rows ("14:30Z" for a
   * time the user picked as "2:30 PM").
   */
  const SURFACES: Array<[string, string]> = [
    ['SecureSummaryScreen', SUMMARY],
    ['BookingHistoryScreen', HISTORY_SCREEN],
    ['BookingHistoryList', LIST],
  ];

  it.each(SURFACES)('%s does not pin a timezone', (name, src) => {
    expect(`${name}:${/timeZone/.test(src)}`).toBe(`${name}:false`);
  });

  it('the row builder is the only place a booking date is formatted', () => {
    expect(LIST).not.toMatch(/toLocaleDateString/);
    expect(SUMMARY).not.toMatch(/toLocaleDateString/);
    expect(HISTORY_SCREEN).not.toMatch(/toLocaleDateString/);
  });
});

describe('B-786f — the credits ledger and the booking history cross-read', () => {
  it('labels a booking row with the shared short reference, not the raw uuid', () => {
    // The server writes `description = "Booking <full uuid>"`, which no human
    // can match to a booking.
    expect(CREDITS).toMatch(/shortRef\(/);
    expect(CREDITS).toMatch(/from '@screens\/booking\/bookingHistoryRows'/);
  });

  it('makes a booking-linked ledger row a door to that booking', () => {
    expect(CREDITS).toMatch(/navigateOnce\([^)]*'TripSummary'/);
  });
});

describe('rapid-use contract on the list', () => {
  it('row presses go through navigateOnce (a hot forward press)', () => {
    expect(LIST).toMatch(/navigateOnce\(/);
  });

  it('the back affordance goes through goBackOnce', () => {
    expect(HISTORY_SCREEN).toMatch(/goBackOnce\(/);
  });

  it('registers no mount-scoped hardware back handler', () => {
    // A `useEffect`-scoped BackHandler on a pushed screen EATS the first back
    // press on every screen pushed above it (N1).
    for (const src of [SUMMARY, HISTORY_SCREEN, LIST]) {
      expect(src).not.toMatch(/BackHandler/);
    }
  });

  /**
   * These two were re-anchored when an adversarial review found a P0 in the
   * store: a load-level latch that refused to start, combined with a
   * superseded-reply drop that touched no state, could strand the list on a
   * permanent skeleton. The concurrency contract is now pinned BEHAVIOURALLY by
   * store/__tests__/bookingHistoryStore.test.ts (which is the stronger pin);
   * these keep the structural half honest.
   */
  it('paginates behind a synchronous latch, not a disabled prop alone', () => {
    // A second tap, and every onEndReached in a fast scroll, lands in the same
    // JS tick — before any React state commits. The latch is PAGING-only: it
    // must never gate `load`, which is what caused the freeze.
    const store = code(f('store', 'bookingHistoryStore.ts'));
    expect(store).toMatch(/let moreInFlight = false/);
    expect(store).toMatch(/if \(!cursor \|\| moreInFlight/);
    expect(store).toMatch(/finally \{\s*moreInFlight = false;/);
    // The regression guard: no latch may refuse to START a first-page load.
    expect(store).not.toMatch(/load: async[\s\S]{0,200}if \(\w*[iI]nFlight\w*\) \{return;\}/);
  });

  it('drops a superseded response instead of letting it land', () => {
    const store = code(f('store', 'bookingHistoryStore.ts'));
    // Two counters, not one: filter identity AND issue order. A single shared
    // generation could not tell "the filters moved on" from "a newer request
    // exists", which is how a reply got dropped with nothing left to settle.
    expect(store).toMatch(/let filterGen = 0/);
    expect(store).toMatch(/let reqSeq = 0/);
    expect(store).toMatch(/mySeq !== reqSeq \|\| myFilterGen !== filterGen/);
  });
});

describe('the history store never touches the resume model', () => {
  /**
   * `useBookingStore.bookings` is what the Home hero, the B-405 upcoming card,
   * the LB17 one-mission slot and the pollers read. Paging a history into it is
   * how all of those regress.
   */
  it('does not import or write the booking store', () => {
    const store = code(f('store', 'bookingHistoryStore.ts'));
    expect(store).not.toMatch(/bookingStore/);
  });

  it('is cleared on sign-out', () => {
    // It holds another user's addresses, amounts and receipt numbers.
    const auth = code(f('store', 'authStore.ts'));
    expect(auth).toMatch(/useBookingHistoryStore\.getState\(\)\.reset\(\)/);
  });
});

describe('fixes from the adversarial review of this change', () => {
  it('a TERMINAL booking opens its detail, never LiveTracking', () => {
    // resumeTargetFor checks mission_status FIRST (and must keep doing so), so a
    // completed booking carrying a stale live mission row used to render
    // COMPLETED and then open LiveTracking on tap.
    expect(LIST).toMatch(/isTerminalBookingStatus\(bookingStatus\)/);
    const opener = LIST.slice(LIST.indexOf('export function openBookingFromRow'));
    // The guard must come BEFORE the resolver, or it cannot win.
    expect(opener.indexOf('isTerminalBookingStatus'))
      .toBeLessThan(opener.indexOf('resumeTargetFor('));
  });

  it('hides the filter controls while the list is degraded', () => {
    // A degraded (legacy-server) list is not filtered server-side, so offering
    // the controls showed chips and a "filtered" count over an unchanged list.
    expect(LIST).toMatch(/const canFilter = !degraded/);
    expect(LIST).toMatch(/\{canFilter && \(/);
  });

  it('hides the pinned active booking from the rows beneath it', () => {
    expect(LIST).toMatch(/r\.id !== excludeId/);
    expect(SUMMARY).toMatch(/excludeId=\{active\?\.id/);
  });

  it('keeps the row callback identity stable across a page load', () => {
    // Depending on `rows` re-created onRowPress on every fetch and busted
    // React.memo on every mounted row — and view mounting is the measured cost.
    expect(LIST).toMatch(/rowsRef\.current\.find/);
    // Scope to the callback itself — a whole-file scan for "[navigation]" would
    // pass on any other hook in the file.
    // Exactly the callback, no more: slicing at the first ');' cut inside
    // `find(...)`, and a fixed window overran into the next hook (which reads
    // `rows` legitimately) and made the negative assertion fire on that.
    const start = LIST.indexOf('const onRowPress');
    const deps = LIST.slice(start, LIST.indexOf('const sections', start));
    expect(deps).toMatch(/\[navigation\]/);
    expect(deps).not.toMatch(/\[rows/);
  });

  it('does not rebuild the active card on every poll tick', () => {
    expect(SUMMARY).toMatch(/useMemo\(/);
  });

  it('derives the date-range pill from the window in force', () => {
    expect(LIST).toMatch(/rangeKeyFor\(filters\.from\)/);
    expect(LIST).not.toMatch(/filters\.from \? '30' : 'any'/);
  });
});
