'use client';

/**
 * E2E-42 — "the operator is never silently blind".
 *
 * Several ops lists are capped server-side with no paging parameter at all
 * (`/ops/missions?status=active` hard-codes 200 and IGNORES the `limit` it
 * accepts — mission.service.ts:137-139). `usePagedList` cannot help there: it
 * needs an `offset` the endpoint does not have. What it can do is stop the cap
 * from being invisible.
 *
 * A truncated list that renders exactly like a complete one is the worst
 * failure mode a control room can have, because nothing about it looks wrong.
 * This says the number out loud, and — when the caller has a way to fetch more
 * — offers it.
 */
export function TruncationNotice({
  shown, cap, noun, onLoadMore, loadingMore, hint,
}: {
  /** Rows currently on screen. */
  shown: number;
  /** The cap the server applied. */
  cap: number;
  /** Plural noun for the copy, e.g. "active missions". */
  noun: string;
  /** Omit when the endpoint has no way to return more. */
  onLoadMore?: () => void;
  loadingMore?: boolean;
  /** What the operator should do instead when there is no LOAD MORE. */
  hint?: string;
}) {
  // Fewer rows than the cap means the server returned everything it had.
  //
  // At EXACTLY the cap this says "more may exist" even in the boundary case
  // where the table holds precisely `cap` rows and nothing beyond. That is
  // deliberate and unavoidable: none of these endpoints reports a total, so a
  // full page is genuinely indistinguishable from a truncated one. The copy is
  // hedged ("may exist") for that reason, and the error runs in the safe
  // direction — over-warning costs a glance, under-warning hides rows from an
  // operator who believes they are looking at everything.
  if (shown < cap) return null;
  return (
    <div
      role="status"
      style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '9px 12px',
        borderTop: '1px solid var(--bd-2)',
        background: 'rgba(245,165,36,0.08)',
        fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--tx-2)',
      }}>
      <span className="pill pill-warn" style={{fontSize: 9.5, fontWeight: 700}}>TRUNCATED</span>
      <span>
        Showing the first {shown.toLocaleString()} {noun} — the server caps this list at{' '}
        {cap.toLocaleString()} and more may exist.
      </span>
      {onLoadMore ? (
        <button className="btn btn-sm btn-ghost" onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? 'LOADING…' : 'LOAD MORE'}
        </button>
      ) : hint ? (
        <span style={{color: 'var(--tx-3)'}}>{hint}</span>
      ) : null}
    </div>
  );
}
