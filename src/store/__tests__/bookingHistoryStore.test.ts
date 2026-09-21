/**
 * B-786 — the booking-history paging store.
 *
 * This file exists because an adversarial review pointed out that the
 * highest-risk file in the change had NO coverage at all, and then found a P0
 * in it: the list could strand itself on a permanent skeleton.
 *
 * The mechanism, which the first case below pins: `load()` opened with a bare
 * `if (inFlight) {return;}` that touched no state, while a superseded reply was
 * dropped by a single shared generation counter that also touched no state. So
 * tapping two segments in quick succession made `setFilters` clear the rows and
 * set `status: 'loading'`, the second `load()` was refused by the latch, the
 * first reply was discarded by the generation check — and NOTHING ever moved
 * `status` off 'loading'. The only escapes were pull-to-refresh or a
 * three-second-old focus.
 */
import {useBookingHistoryStore, hasActiveFilters, EMPTY_FILTERS} from '../bookingHistoryStore';

jest.mock('@services/api', () => ({
  bookingApi: {history: jest.fn(), list: jest.fn()},
}));


const {bookingApi} = require('@services/api') as {
  bookingApi: {history: jest.Mock; list: jest.Mock};
};

/** A promise plus its resolvers, so a test controls exactly when a reply lands. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return {promise, resolve, reject};
}

const page = (ids: string[], cursor: string | null = null, total = ids.length) => ({
  data: {
    total,
    next_cursor: cursor,
    summary: null,
    bookings: ids.map(id => ({id, status: 'COMPLETED'})),
  },
});

const store = () => useBookingHistoryStore.getState();
const flush = () => new Promise(r => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  store().reset();
});

describe('the list never strands itself (the P0)', () => {
  it('settles after two filter changes in quick succession', async () => {
    const first = deferred<ReturnType<typeof page>>();
    const second = deferred<ReturnType<typeof page>>();
    bookingApi.history.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    store().setFilters({bucket: 'past'});
    store().setFilters({bucket: 'cancelled'});
    expect(store().status).toBe('loading');

    // Out of order on purpose: the superseded reply lands LAST.
    second.resolve(page(['b2']));
    await flush();
    first.resolve(page(['b1']));
    await flush();

    expect(store().status).toBe('ready');
    expect(store().rows.map(r => r.id)).toEqual(['b2']);
  });

  it('settles when the SECOND request is the slow one', async () => {
    const first = deferred<ReturnType<typeof page>>();
    const second = deferred<ReturnType<typeof page>>();
    bookingApi.history.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    store().setFilters({bucket: 'past'});
    store().setFilters({bucket: 'cancelled'});
    first.resolve(page(['b1']));
    await flush();
    // The stale reply must not settle the screen on the wrong rows...
    expect(store().rows.map(r => r.id)).not.toEqual(['b1']);
    second.resolve(page(['b2']));
    await flush();
    expect(store().status).toBe('ready');
    expect(store().rows.map(r => r.id)).toEqual(['b2']);
  });

  it('never leaves rows the active filter excludes', async () => {
    const slow = deferred<ReturnType<typeof page>>();
    bookingApi.history.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(page(['fresh']));

    void store().load();
    store().setFilters({bucket: 'cancelled'});
    await flush();
    slow.resolve(page(['stale']));
    await flush();

    expect(store().rows.map(r => r.id)).toEqual(['fresh']);
  });

  it('reports an error the user can retry from, rather than a silent skeleton', async () => {
    bookingApi.history.mockRejectedValueOnce(new Error('network down'));
    await store().load();
    expect(store().status).toBe('error');
    expect(store().error).toBe('network down');
  });

  it('recovers on the next load after an error', async () => {
    bookingApi.history.mockRejectedValueOnce(new Error('nope'));
    await store().load();
    bookingApi.history.mockResolvedValueOnce(page(['b1']));
    await store().load();
    expect(store().status).toBe('ready');
    expect(store().error).toBeNull();
  });
});

describe('paging', () => {
  it('appends the next page and keeps the true total', async () => {
    bookingApi.history.mockResolvedValueOnce(page(['a', 'b'], 'cur1', 57));
    await store().load();
    expect(store().total).toBe(57);

    bookingApi.history.mockResolvedValueOnce(page(['c'], null, 57));
    await store().loadMore();
    expect(store().rows.map(r => r.id)).toEqual(['a', 'b', 'c']);
    expect(store().cursor).toBeNull();
    expect(store().status).toBe('ready');
  });

  it('is a no-op with no cursor — the server said this was the last page', async () => {
    bookingApi.history.mockResolvedValueOnce(page(['a'], null));
    await store().load();
    bookingApi.history.mockClear();
    await store().loadMore();
    expect(bookingApi.history).not.toHaveBeenCalled();
  });

  it('collapses an onEndReached storm into ONE request', async () => {
    bookingApi.history.mockResolvedValueOnce(page(['a'], 'cur1'));
    await store().load();

    const slow = deferred<ReturnType<typeof page>>();
    bookingApi.history.mockClear();
    bookingApi.history.mockReturnValue(slow.promise);
    // Six synchronous calls, exactly as a fast scroll produces them.
    const all = [0, 1, 2, 3, 4, 5].map(() => store().loadMore());
    expect(bookingApi.history).toHaveBeenCalledTimes(1);
    slow.resolve(page(['b'], null));
    await Promise.all(all);
    expect(store().rows.map(r => r.id)).toEqual(['a', 'b']);
  });

  it('drops a duplicate row rather than letting the list lose keys', async () => {
    // A FlatList silently drops rows on a duplicate key.
    bookingApi.history.mockResolvedValueOnce(page(['a', 'b'], 'cur1'));
    await store().load();
    bookingApi.history.mockResolvedValueOnce(page(['b', 'c'], null));
    await store().loadMore();
    expect(store().rows.map(r => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the visible rows when loading more FAILS', async () => {
    bookingApi.history.mockResolvedValueOnce(page(['a'], 'cur1'));
    await store().load();
    bookingApi.history.mockRejectedValueOnce(new Error('flaky'));
    await store().loadMore();
    expect(store().rows.map(r => r.id)).toEqual(['a']);
    expect(store().status).toBe('ready');
    expect(store().error).toBe('flaky');
  });

  it('a filter change during a page fetch wins', async () => {
    bookingApi.history.mockResolvedValueOnce(page(['a'], 'cur1'));
    await store().load();

    const slowMore = deferred<ReturnType<typeof page>>();
    bookingApi.history.mockReturnValueOnce(slowMore.promise).mockResolvedValueOnce(page(['fresh']));
    void store().loadMore();
    store().setFilters({bucket: 'past'});
    await flush();
    slowMore.resolve(page(['late'], null));
    await flush();

    expect(store().rows.map(r => r.id)).toEqual(['fresh']);
    expect(store().status).toBe('ready');
  });
});

describe('the legacy-server fallback (deploy order, B-605/B-606)', () => {
  const notFound = Object.assign(new Error('Request failed with status code 404'), {
    response: {status: 404},
  });

  it('serves GET /bookings when the history route is absent', async () => {
    bookingApi.history.mockRejectedValueOnce(notFound);
    bookingApi.list.mockResolvedValueOnce({data: {bookings: [{id: 'legacy1'}], total: 1}});
    await store().load();
    expect(store().rows.map(r => r.id)).toEqual(['legacy1']);
    expect(store().degraded).toBe(true);
    expect(store().status).toBe('ready');
    expect(store().error).toBeNull();
  });

  it('does NOT fall back on a real failure', async () => {
    const boom = Object.assign(new Error('boom'), {response: {status: 500}});
    bookingApi.history.mockRejectedValueOnce(boom);
    await store().load();
    expect(bookingApi.list).not.toHaveBeenCalled();
    expect(store().status).toBe('error');
  });

  it('reports honestly when the fallback ALSO fails', async () => {
    bookingApi.history.mockRejectedValueOnce(notFound);
    bookingApi.list.mockRejectedValueOnce(new Error('offline'));
    await store().load();
    expect(store().status).toBe('error');
    expect(store().error).toBe('offline');
  });

  it('never tries to page a degraded list', async () => {
    bookingApi.history.mockRejectedValueOnce(notFound);
    bookingApi.list.mockResolvedValueOnce({data: {bookings: [{id: 'l1'}], total: 1}});
    await store().load();
    bookingApi.history.mockClear();
    await store().loadMore();
    expect(bookingApi.history).not.toHaveBeenCalled();
  });

  it('clears the degraded flag once the endpoint answers again', async () => {
    bookingApi.history.mockRejectedValueOnce(notFound);
    bookingApi.list.mockResolvedValueOnce({data: {bookings: [{id: 'l1'}], total: 1}});
    await store().load();
    expect(store().degraded).toBe(true);
    bookingApi.history.mockResolvedValueOnce(page(['a']));
    await store().load();
    expect(store().degraded).toBe(false);
  });
});

describe('robustness of the wire shape', () => {
  it('survives a null or absent bookings array', async () => {
    bookingApi.history.mockResolvedValueOnce({data: {}});
    await store().load();
    expect(store().rows).toEqual([]);
    expect(store().status).toBe('ready');
  });

  it('keeps a previously-loaded summary across a refresh that omits it', async () => {
    bookingApi.history.mockResolvedValueOnce({
      data: {total: 1, next_cursor: null, bookings: [{id: 'a'}], summary: {count_all: 9}},
    });
    await store().load();
    expect(store().summary?.count_all).toBe(9);
    bookingApi.history.mockResolvedValueOnce(page(['a']));
    await store().load('refresh');
    expect(store().summary?.count_all).toBe(9);
  });
});

describe('sign-out and filters', () => {
  it('reset clears every user-specific field', async () => {
    bookingApi.history.mockResolvedValueOnce(page(['a'], 'cur1', 12));
    await store().load();
    store().setFilters({payment: 'refunded'});
    store().reset();
    expect(store().rows).toEqual([]);
    expect(store().total).toBe(0);
    expect(store().cursor).toBeNull();
    expect(store().summary).toBeNull();
    expect(store().degraded).toBe(false);
    expect(store().filters).toEqual(EMPTY_FILTERS);
    expect(store().status).toBe('idle');
  });

  it('a reply that lands after reset is discarded', async () => {
    const slow = deferred<ReturnType<typeof page>>();
    bookingApi.history.mockReturnValueOnce(slow.promise);
    void store().load();
    store().reset();
    slow.resolve(page(['ghost']));
    await flush();
    expect(store().rows).toEqual([]);
  });

  it('sends only the filters that are set', async () => {
    bookingApi.history.mockResolvedValue(page([]));
    await store().load();
    expect(bookingApi.history).toHaveBeenLastCalledWith({bucket: 'all', limit: 30});

    store().setFilters({services: ['secure_transfer', 'recon_team'], payment: 'held'});
    await flush();
    expect(bookingApi.history).toHaveBeenLastCalledWith({
      bucket: 'all', service: 'secure_transfer,recon_team', payment: 'held', limit: 30,
    });
  });

  it('knows when something is actually narrowing the list', () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    // The bucket is a SEGMENT, not a filter chip — it must not light the chip row.
    expect(hasActiveFilters({...EMPTY_FILTERS, bucket: 'past'})).toBe(false);
    expect(hasActiveFilters({...EMPTY_FILTERS, services: ['recon_team']})).toBe(true);
    expect(hasActiveFilters({...EMPTY_FILTERS, payment: 'paid'})).toBe(true);
    expect(hasActiveFilters({...EMPTY_FILTERS, from: '2026-01-01'})).toBe(true);
  });
});
