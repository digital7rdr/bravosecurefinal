/**
 * OP-17 — placeholder bars for a list's TRUE first load. With
 * `keepPreviousData` global, a filter change keeps the old rows on screen,
 * so callers gate this on `isLoading && !data` (or `usePagedList().isLoading`).
 */
export function SkeletonRows({rows = 6, height = 14}: {rows?: number; height?: number}) {
  return (
    <div aria-busy="true" aria-label="Loading" className="animate-pulse" style={{display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 16px'}}>
      {Array.from({length: rows}, (_, i) => (
        <div
          key={i}
          style={{
            height, borderRadius: 4, background: 'var(--surf-3)',
            width: `${[92, 78, 85, 64, 88, 71][i % 6]}%`,
          }}
        />
      ))}
    </div>
  );
}
