/**
 * Escape a user-typed search needle for `ILIKE … ESCAPE '\'`.
 *
 * B-636 lesson, now shared: backslash FIRST (or the escaper re-escapes its own
 * output), then the two LIKE metacharacters. Callers wrap the result in `%…%`
 * and MUST pair the predicate with `ESCAPE '\'` — Postgres' default escape is
 * already backslash, but stating it keeps the contract visible and survives a
 * session that changes `standard_conforming_strings`.
 */
export function escapeLike(needle: string): string {
  return needle.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
