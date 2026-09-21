import {create} from 'zustand';
import {bookingApi} from '@services/api';
import type {HistoryBucket, HistoryPaymentFilter, HistorySummary} from '@services/api';
import type {HistoryRowInput} from '@screens/booking/bookingHistoryRows';

/**
 * A row is either a rich `HistoryBooking` from GET /bookings/history or, on the
 * legacy fallback below, a plain wire `Booking`. `HistoryRowInput` is the
 * structural type both satisfy, and `buildHistoryRow` renders either — a
 * fallback row simply shows its amount as "Quoted" and carries no payment
 * state, receipt or rating.
 */
export type HistoryRow = HistoryRowInput;

/**
 * B-786 — the booking-history read model, client side.
 *
 * DELIBERATELY SEPARATE from `useBookingStore`. That store's `bookings` array is
 * the RESUME model: the Home hero, the B-405 upcoming card, the LB17 "one
 * mission at a time" slot and the pollers all read it, and every one of those is
 * sensitive to its ordering and its contents. Paging a history into it is how
 * they regress. Nothing here writes to it.
 *
 * Not persisted. A persisted store on this shape would stringify the whole page
 * on every `set()` (the B-633/B-669 defect) for data that is a single request
 * away, and the screen already degrades to an error-with-retry offline.
 */

export interface HistoryFilters {
  bucket: HistoryBucket;
  /** Empty = no service filter. */
  services: string[];
  from: string | null;
  to: string | null;
  payment: HistoryPaymentFilter | null;
}

export const EMPTY_FILTERS: HistoryFilters = {
  bucket: 'all', services: [], from: null, to: null, payment: null,
};

export type HistoryStatus = 'idle' | 'loading' | 'refreshing' | 'more' | 'ready' | 'error';

interface HistoryState {
  rows: HistoryRow[];
  cursor: string | null;
  total: number;
  summary: HistorySummary | null;
  filters: HistoryFilters;
  status: HistoryStatus;
  error: string | null;
  /**
   * True when the rows came from the LEGACY `GET /bookings` fallback because
   * this device is talking to a server that predates `/bookings/history`.
   *
   * The deploy order for this feature is migration -> server -> APK, and that
   * order has been got wrong before (B-605/B-606). Without this fallback an APK
   * that shipped first would turn "My Bookings" — a screen that works TODAY —
   * into a permanent error page. Degraded rows have no payment state, receipt
   * or rating, and no filtering or paging, so the UI says so rather than
   * silently showing a poorer list.
   */
  degraded: boolean;
}

interface HistoryActions {
  /** First page for the current filters. `refresh` keeps the visible rows
   *  mounted (pull-to-refresh) instead of flashing a skeleton. */
  load: (mode?: 'initial' | 'refresh') => Promise<void>;
  loadMore: () => Promise<void>;
  setFilters: (next: Partial<HistoryFilters>) => void;
  clearFilters: () => void;
  clearError: () => void;
  reset: () => void;
}

const INITIAL: HistoryState = {
  rows: [], cursor: null, total: 0, summary: null,
  filters: EMPTY_FILTERS, status: 'idle', error: null, degraded: false,
};

/**
 * TWO counters, because they answer two different questions — and conflating
 * them is what froze the list.
 *
 * `filterGen` is the identity of what is being asked for; a filter change or a
 * reset bumps it, and a reply stamped with an older one is DROPPED so a slow
 * "All" response cannot land on top of a fast "Cancelled" one.
 *
 * `reqSeq` is issue order. A reply applies only if it belongs to the NEWEST
 * request issued, which is what guarantees the newest request always settles
 * `status`.
 *
 * The first cut had a single generation plus a bare `if (inFlight) {return;}`
 * at the top of `load()`, and that combination could strand the screen on a
 * permanent skeleton: tapping two segments in quick succession made
 * `setFilters` clear the rows and set `status: 'loading'`, then its `load()` was
 * dropped by the latch while the original in-flight reply was dropped by the
 * generation check — so NOTHING ever moved `status` off 'loading', and the only
 * escapes were pull-to-refresh or a 3-second-old focus. `load()` therefore no
 * longer refuses to start; correctness comes from the two counters, and a
 * superseded reply is discarded by whichever one caught it.
 */
let filterGen = 0;
let reqSeq = 0;

/**
 * Synchronous latch for PAGING only, NOT a `disabled={state}` prop.
 *
 * `onEndReached` can fire many times while a page is in flight and a second tap
 * lands in the same JS tick as the first, before any React state has committed,
 * so only a plain module-level flag closes it (the N-series rapid-use rule).
 * Always released in `finally`. It never blocks `load()` — see above.
 */
let moreInFlight = false;

function message(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'Could not load your bookings';
}

/** A 404 from this endpoint means the ROUTE is absent (an older server), not
 *  that the user has no bookings — the handler always answers 200 with a list. */
function isMissingRoute(e: unknown): boolean {
  return (e as {response?: {status?: number}} | null)?.response?.status === 404;
}

/** Server takes a comma-separated list; an empty selection means "no filter". */
function paramsFor(f: HistoryFilters, before?: string) {
  return {
    bucket: f.bucket,
    ...(f.services.length > 0 ? {service: f.services.join(',')} : {}),
    ...(f.from ? {from: f.from} : {}),
    ...(f.to ? {to: f.to} : {}),
    ...(f.payment ? {payment: f.payment} : {}),
    ...(before ? {before} : {}),
    limit: 30,
  };
}

export const useBookingHistoryStore = create<HistoryState & HistoryActions>()((set, get) => ({
  ...INITIAL,

  load: async (mode = 'initial') => {
    const myFilterGen = filterGen;
    const mySeq = ++reqSeq;
    const filters = get().filters;
    set({status: mode === 'refresh' ? 'refreshing' : 'loading', error: null});
    // Stale iff a NEWER request was issued, or the filters have moved on.
    const stale = () => mySeq !== reqSeq || myFilterGen !== filterGen;
    try {
      const {data} = await bookingApi.history(paramsFor(filters));
      if (stale()) {return;}
      set({
        rows: Array.isArray(data?.bookings) ? data.bookings : [],
        cursor: data?.next_cursor ?? null,
        total: data?.total ?? 0,
        // The summary rides the first page only; keep the previous one on a
        // later refresh rather than blanking the stats strip.
        summary: data?.summary ?? get().summary,
        degraded: false,
        status: 'ready',
        error: null,
      });
    } catch (e: unknown) {
      if (stale()) {return;}
      // The server may predate this endpoint (deploy order, B-605/B-606) — a
      // 404 on the ROUTE, not a failure of the user's data. Serve the legacy
      // list rather than turning a working screen into an error page. Any other
      // failure (network, 5xx, auth) is reported honestly.
      if (isMissingRoute(e)) {
        try {
          const {data} = await bookingApi.list();
          if (stale()) {return;}
          const legacy = Array.isArray(data?.bookings) ? data.bookings : [];
          set({
            rows: legacy as unknown as HistoryRow[],
            cursor: null,
            total: legacy.length,
            summary: null,
            degraded: true,
            status: 'ready',
            error: null,
          });
          return;
        } catch (fallbackErr: unknown) {
          if (stale()) {return;}
          set({status: 'error', error: message(fallbackErr)});
          return;
        }
      }
      set({status: 'error', error: message(e)});
    }
  },

  loadMore: async () => {
    const {cursor, status, rows, degraded} = get();
    // No cursor means the server said this was the last page; the legacy
    // fallback has no paging at all.
    if (!cursor || moreInFlight || degraded || status === 'loading') {return;}
    moreInFlight = true;
    const myFilterGen = filterGen;
    const mySeq = ++reqSeq;
    set({status: 'more', error: null});
    const stale = () => mySeq !== reqSeq || myFilterGen !== filterGen;
    try {
      const {data} = await bookingApi.history(paramsFor(get().filters, cursor));
      if (stale()) {return;}
      const incoming = Array.isArray(data?.bookings) ? data.bookings : [];
      // Belt and braces against a cursor that re-serves a row: the list keys on
      // id, and a duplicate key silently drops rows in a FlatList.
      const seen = new Set(rows.map(r => r.id));
      set({
        rows: [...rows, ...incoming.filter(r => !seen.has(r.id))],
        cursor: data?.next_cursor ?? null,
        total: data?.total ?? get().total,
        status: 'ready',
      });
    } catch (e: unknown) {
      if (stale()) {return;}
      // Keep what is already on screen — a failed "load more" must not empty
      // the list the user is reading.
      set({status: 'ready', error: message(e)});
    } finally {
      moreInFlight = false;
    }
  },

  setFilters: next => {
    const filters = {...get().filters, ...next};
    // Invalidate any in-flight reply for the previous filters and drop the old
    // page immediately, so the list can never show rows the chips exclude.
    filterGen++;
    set({filters, rows: [], cursor: null, total: 0, status: 'loading', error: null, degraded: false});
    void get().load();
  },

  clearFilters: () => get().setFilters(EMPTY_FILTERS),

  clearError: () => set({error: null}),

  reset: () => {
    filterGen++;
    reqSeq++;
    moreInFlight = false;
    set({...INITIAL});
  },
}));

/** True when anything narrows the list — drives the "Clear filters" affordance
 *  and the filtered-empty copy. The bucket is a segment, not a filter chip. */
export function hasActiveFilters(f: HistoryFilters): boolean {
  return f.services.length > 0 || f.from !== null || f.to !== null || f.payment !== null;
}
