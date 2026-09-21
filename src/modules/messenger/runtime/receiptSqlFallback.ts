/**
 * PG-M4 (2026-09-02) — receipts for rows OUTSIDE the hydrated window.
 *
 * `applyEnvelopeDelivered` and the `read-receipt` frame case scan
 * `store.messages`, which holds the 200/10-row hydration window. A receipt for
 * an older row matched nothing and was dropped; the relay's delivered replay
 * is emit-then-delete, so there was no second chance and the bubble sat on a
 * single tick forever. These lanes look the row up by envelope id in SQLCipher,
 * apply the same aggregate (`receiptRow.ts`) and write it back; the next
 * hydration / older-page load reads the advanced status.
 *
 * Ownership guards are the SAME ones the in-memory read lane applies
 * (`readReceiptEnvelopeMatch`, `readReceiptAccepted`, `sender_id === 'self'`):
 * a peer can neither receipt a message they did not receive nor one that did
 * not travel through their thread.
 *
 * Injected SQL + state so the node project tests it without the runtime.
 */
import type {LocalMessage} from '../store/types';
import {isGroupConversation, readReceiptAccepted, readReceiptEnvelopeMatch, type MessagingStateLike} from './messagingLogic';
import {applyDeliveredReceiptToRow, applyReadReceiptToRow, type ReceiptAggregateCtx} from './receiptRow';

export interface ReceiptSql {
  findByEnvelopeId(envelopeId: string): Promise<LocalMessage | null>;
  upsertCoalesced(msg: LocalMessage): void;
}

export type ReceiptStateLike = MessagingStateLike & {
  _ownAuthUserId?: string | null;
  _ownUserId?:     string | null;
};

/** One read-receipt frame may name many ids; bound the SQL work per frame. */
const READ_RECEIPT_SQL_FALLBACK_CAP = 200;

function ctxFor(state: ReceiptStateLike, conversationId: string): ReceiptAggregateCtx {
  const isGroup = isGroupConversation(state, conversationId);
  const own = state._ownAuthUserId ?? state._ownUserId ?? null;
  const participants = isGroup
    ? (state.conversations[conversationId]?.participants ?? []).filter(u => !!u && u !== own)
    : [];
  return {isGroup, participants};
}

/**
 * Mirror of `applyEnvelopeDelivered`'s two branches (leg match first, scalar
 * second) over the SQL row. Returns the number of rows whose STATUS advanced.
 */
export async function applyDeliveredToSql(
  envelopeId: string,
  deps: {
    sql: ReceiptSql;
    state: ReceiptStateLike;
    now?: () => number;
    /**
     * PG-M4r — re-checked AFTER the async SQL read: a hydration (older-page
     * load) landing inside the await means the store owns the row now, and a
     * disk-snapshot write here would clobber its newer state.
     */
    isRowHydrated?: (conversationId: string, messageId: string) => boolean;
  },
): Promise<number> {
  if (!envelopeId) {return 0;}
  const row = await deps.sql.findByEnvelopeId(envelopeId);
  if (!row) {return 0;}
  if (deps.isRowHydrated?.(row.conversation_id, row.id)) {return 0;}
  const ts = (deps.now ?? Date.now)();
  const leg = Object.entries(row.envelope_ids ?? {}).find(([, id]) => id === envelopeId);
  if (leg) {
    if (row.status !== 'sent') {return 0;}
    const next = applyDeliveredReceiptToRow(row, leg[0], ts, ctxFor(deps.state, row.conversation_id));
    if (!next) {return 0;}
    deps.sql.upsertCoalesced(next);
    return next.status === 'delivered' ? 1 : 0;
  }
  if (row.envelope_id !== envelopeId) {return 0;}
  if (row.status !== 'sent') {return 0;}
  deps.sql.upsertCoalesced({...row, status: 'delivered'});
  return 1;
}

/**
 * Mirror of the `read-receipt` frame lane over SQL rows, for the envelope ids
 * that matched no hydrated bubble. Returns the number of rows patched.
 */
export async function applyReadReceiptsToSql(
  args: {envelopeIds: readonly string[]; receipterUid: string; ts: number},
  deps: {sql: ReceiptSql; state: ReceiptStateLike; isRowHydrated?: (conversationId: string, messageId: string) => boolean},
): Promise<number> {
  const {receipterUid, ts} = args;
  if (!receipterUid) {return 0;}
  let patched = 0;
  for (const envelopeId of args.envelopeIds.slice(0, READ_RECEIPT_SQL_FALLBACK_CAP)) {
    if (!envelopeId) {continue;}
    const row = await deps.sql.findByEnvelopeId(envelopeId);
    if (!row) {continue;}
    if (deps.isRowHydrated?.(row.conversation_id, row.id)) {continue;}
    if (!readReceiptEnvelopeMatch({
      envelopeId:  row.envelope_id,
      envelopeIds: row.envelope_ids,
      receipterUid,
      ids:         new Set([envelopeId]),
    })) {continue;}
    if (row.status === 'read') {continue;}
    if (row.sender_id !== 'self') {continue;}
    if (!readReceiptAccepted({
      state:             deps.state,
      conversationId:    row.conversation_id,
      receipterUid,
      messagePeerUserId: row.peer?.userId,
    })) {continue;}
    const next = applyReadReceiptToRow(row, receipterUid, ts, ctxFor(deps.state, row.conversation_id));
    if (!next) {continue;}
    deps.sql.upsertCoalesced(next);
    patched += 1;
  }
  return patched;
}
