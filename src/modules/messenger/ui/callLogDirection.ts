/**
 * PG-C5 (2026-09-02) — the Calls log's direction/outcome mapping, pure.
 *
 * The row used to fold outcome INTO direction: any `missed`/`declined` outcome
 * became direction `'missed'` — the red inbound arrow and a "Missed" label — so
 * a call YOU placed that rang out (or that you cancelled) was drawn as a call
 * you failed to pick up. `CallScreen` records an outgoing unanswered call as
 * outcome `'declined'` (the caller cannot tell decline from no-answer, so that
 * is the honest generic), and the log must keep the outgoing arrow for it.
 */
export type CallLogDirection = 'in' | 'out' | 'missed';

export interface CallMetaLike {
  direction?: 'incoming' | 'outgoing';
  outcome?: string;
}

function unanswered(meta: CallMetaLike): boolean {
  return meta.outcome === 'missed' || meta.outcome === 'declined';
}

/** Arrow + filter bucket. Only an INBOUND unanswered call is a "missed" call. */
export function callLogDirection(meta: CallMetaLike): CallLogDirection {
  if (meta.direction === 'incoming') {return unanswered(meta) ? 'missed' : 'in';}
  return 'out';
}

/**
 * What the meta slot says instead of a duration. `null` means "show the
 * duration" (an answered call, or a failed one — those keep their own glyph).
 */
export function callLogOutcomeLabel(meta: CallMetaLike): 'Missed' | 'Not answered' | null {
  if (!unanswered(meta)) {return null;}
  return meta.direction === 'incoming' ? 'Missed' : 'Not answered';
}
