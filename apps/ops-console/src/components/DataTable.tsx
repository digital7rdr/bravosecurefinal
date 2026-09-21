'use client';

/**
 * OC-14 / IA-12 — the shared table primitive.
 *
 * Every list in the console hand-rolled a `<table className="dt">` with its own
 * loading string, its own empty cell and no sorting anywhere. This is the
 * minimal shared version: sortable headers, real loading/empty/error states,
 * a stable key, and one place to grow virtualization/pagination later.
 *
 * Deliberately NOT included yet (each needs its own decision, see the audit):
 * virtualization, server-side sort, column pinning. Sorting here is
 * client-side over the loaded rows and says so in the header title.
 */

import {useCallback, useMemo, useState, type ReactNode} from 'react';
import {useRouter} from 'next/navigation';

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Cell renderer. */
  cell: (row: T) => ReactNode;
  /** Returns the sort value. Omit to make the column unsortable. */
  sortValue?: (row: T) => string | number | null | undefined;
  align?: 'left' | 'right';
  width?: string;
  /** Hidden below this viewport width (px) — responsive column dropping. */
  hideBelow?: number;
}

export interface DataTableProps<T> {
  rows: T[];
  columns: Array<Column<T>>;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Link target per row — renders the row as a real anchor for keyboard users. */
  rowHref?: (row: T) => string;
  loading?: boolean;
  error?: boolean;
  empty?: ReactNode;
  /** Initial sort column key + direction. */
  initialSort?: {key: string; dir: 'asc' | 'desc'};
  footer?: ReactNode;
  ariaLabel: string;
}

export function DataTable<T>({
  rows, columns, rowKey, onRowClick, rowHref, loading, error, empty,
  initialSort, footer, ariaLabel,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{key: string; dir: 'asc' | 'desc'} | null>(initialSort ?? null);
  const router = useRouter();

  const activate = useCallback((row: T) => {
    if (onRowClick) { onRowClick(row); return; }
    if (rowHref) { router.push(rowHref(row)); }
  }, [onRowClick, rowHref, router]);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find(c => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    // Copy — never sort the SWR array in place, it is the cache.
    return [...rows].sort((a, b) => {
      const va = col.sortValue!(a), vb = col.sortValue!(b);
      if (va === vb) return 0;
      if (va === null || va === undefined) return 1;   // blanks last, both directions
      if (vb === null || vb === undefined) return -1;
      return (va < vb ? -1 : 1) * dir;
    });
  }, [rows, columns, sort]);

  function toggle(key: string) {
    setSort(s => s?.key === key
      ? {key, dir: s.dir === 'asc' ? 'desc' : 'asc'}
      : {key, dir: 'asc'});
  }

  return (
    <div className="dt-wrap">
      <div className="dt-scroll">
        <table className="dt" aria-label={ariaLabel}>
          <thead>
            <tr>
              {columns.map(c => {
                const sortable = Boolean(c.sortValue);
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    className={c.align === 'right' ? 'num' : undefined}
                    style={{width: c.width}}
                    data-hide-below={c.hideBelow}
                    aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                    {sortable ? (
                      <button
                        type="button"
                        className={`dt-sort ${active ? 'on' : ''}`}
                        onClick={() => toggle(c.key)}
                        title="Sort the loaded rows">
                        {c.header}
                        <span className="dt-sort-ic" aria-hidden="true">
                          {active ? (sort!.dir === 'asc' ? '▲' : '▼') : '↕'}
                        </span>
                      </button>
                    ) : c.header}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {error && (
              <tr><td colSpan={columns.length} className="dt-state dt-state-err">
                Could not load this list. It will retry on the next poll.
              </td></tr>
            )}
            {!error && loading && sorted.length === 0 && (
              [0, 1, 2, 3, 4].map(i => (
                <tr key={`sk-${i}`} className="dt-skel">
                  {columns.map(c => <td key={c.key}><span className="skel-cell" /></td>)}
                </tr>
              ))
            )}
            {!error && !loading && sorted.length === 0 && (
              <tr><td colSpan={columns.length} className="dt-state">{empty ?? 'Nothing here.'}</td></tr>
            )}
            {sorted.map(row => {
              const key = rowKey(row);
              const clickable = Boolean(onRowClick || rowHref);
              return (
                <tr
                  key={key}
                  className={clickable ? 'dt-clickable' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  role={clickable ? 'link' : undefined}
                  onClick={clickable ? () => activate(row) : undefined}
                  onKeyDown={clickable ? e => {
                    // OC-16 — clickable <tr> used to be mouse-only everywhere.
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      activate(row);
                    }
                  } : undefined}>
                  {columns.map(c => (
                    <td key={c.key} className={c.align === 'right' ? 'num' : undefined} data-hide-below={c.hideBelow}>
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {footer && <div className="dt-footer">{footer}</div>}
    </div>
  );
}
