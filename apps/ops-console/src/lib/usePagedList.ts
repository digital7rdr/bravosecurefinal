import {useCallback, useMemo} from 'react';
import useSWRInfinite, {type SWRInfiniteConfiguration, type SWRInfiniteKeyedMutator} from 'swr/infinite';

/**
 * OP-14 / OP-17 — page-index LOAD MORE on top of `useSWRInfinite`.
 *
 * Replaces the growing-`limit` pattern (page N re-downloaded pages 1..N, and
 * the 5 s poll then re-polled the whole window). Here every page is its own
 * SWR key, so LOAD MORE fetches ONE more page and the poll revalidates ONLY
 * the first page (`revalidateFirstPage`, SWR's default); later pages are
 * served from cache until the operator changes a filter.
 *
 * Two paging flavours share this hook:
 *   • offset  — `fetchPage` receives `{offset, limit}` (bookings, agents,
 *               users, pro-applications, dispatch requests);
 *   • cursor  — pass `cursorOf(lastRow)` and `fetchPage` also receives the
 *               previous page's cursor (departments, finance ledger).
 *
 * Rows are de-duplicated by `idOf` across pages. That is the end-of-list
 * fail-safe on a server that has not learned `offset` yet (it would return
 * page 1 again): the page adds zero new ids, `hasMore` drops to false, and
 * nothing renders twice.
 *
 * Every loaded page is revalidated on the poll (`revalidateAll`), not only the
 * first: with offset paging a row that shifts across the page seam after an
 * insert would otherwise vanish from a cached later page, and a status change
 * on page 2 would sit stale until a filter change. The cost is bounded by the
 * per-list caps (≤ 500 rows), which is what the growing-limit hooks fetched.
 */
export interface PagedFetchArgs {
  offset: number;
  limit: number;
  cursor?: string;
}

export interface PagedListOptions<T> {
  /** Base SWR key (filters go here). `null` disables the hook. */
  key: readonly unknown[] | null;
  pageSize: number;
  /** Existing per-list caps (500 / 200) — LOAD MORE hides at the cap. */
  maxRows?: number;
  fetchPage: (args: PagedFetchArgs) => Promise<T[]>;
  idOf: (row: T) => string;
  /** Cursor paging: derive the next page's cursor from the previous page's last row. */
  cursorOf?: (lastRow: T) => string;
  swr?: SWRInfiniteConfiguration<T[]>;
}

export interface PagedList<T> {
  rows: T[];
  /** True only on the very first load with nothing to show (keepPreviousData is global). */
  isLoading: boolean;
  /** A LOAD MORE page is in flight. */
  isLoadingMore: boolean;
  error: Error | undefined;
  hasMore: boolean;
  loadMore: () => void;
  /** Pages currently loaded. */
  pages: number;
  /** The newest page came back full — the server may hold more rows. */
  lastPageFull: boolean;
  mutate: SWRInfiniteKeyedMutator<T[][]>;
}

export function usePagedList<T>(opts: PagedListOptions<T>): PagedList<T> {
  const {key, pageSize, maxRows, fetchPage, idOf, cursorOf, swr} = opts;

  const getKey = useCallback((index: number, prev: T[] | null): readonly unknown[] | null => {
    if (!key) return null;
    if (index > 0 && (!prev || prev.length < pageSize)) return null;
    if (maxRows !== undefined && index * pageSize >= maxRows) return null;
    const cursor = cursorOf && prev && prev.length > 0 ? cursorOf(prev[prev.length - 1]) : '';
    return [...key, index, cursor];
  }, [key, pageSize, maxRows, cursorOf]);

  // The last page before the cap is clipped so the list never overshoots it.
  const limitFor = useCallback((index: number): number => {
    const offset = index * pageSize;
    return maxRows === undefined ? pageSize : Math.max(1, Math.min(pageSize, maxRows - offset));
  }, [pageSize, maxRows]);

  const {data, error, isLoading, isValidating, size, setSize, mutate} = useSWRInfinite<T[], Error>(
    getKey,
    (k: readonly unknown[]) => {
      const index = k[k.length - 2] as number;
      const cursor = k[k.length - 1] as string;
      return fetchPage({offset: index * pageSize, limit: limitFor(index), cursor: cursor || undefined});
    },
    {revalidateAll: true, ...swr},
  );

  const {rows, lastPageFull, lastPageAddedRows} = useMemo(() => {
    const seen = new Set<string>();
    const out: T[] = [];
    let added = 0;
    const pages = data ?? [];
    pages.forEach((page, pi) => {
      let addedHere = 0;
      for (const r of page) {
        const id = idOf(r);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(r);
        addedHere += 1;
      }
      if (pi === pages.length - 1) added = addedHere;
    });
    const last = pages[pages.length - 1];
    return {
      rows: out,
      lastPageFull: !!last && last.length >= limitFor(pages.length - 1),
      lastPageAddedRows: added,
    };
  }, [data, idOf, limitFor]);

  const pageCount = data?.length ?? 0;
  const hasMore = lastPageFull && lastPageAddedRows > 0
    && (maxRows === undefined || (rows.length < maxRows && pageCount * pageSize < maxRows));
  const isLoadingMore = isValidating && size > 1 && (data?.length ?? 0) < size;
  const loadMore = useCallback(() => { void setSize(s => s + 1); }, [setSize]);

  return {
    rows,
    isLoading: isLoading && !data,
    isLoadingMore,
    error,
    hasMore,
    loadMore,
    pages: data?.length ?? 0,
    lastPageFull,
    mutate,
  };
}
