/**
 * PG-M4 (2026-09-02) — the delivered / read receipt aggregate, applied to ONE
 * row as a pure function.
 *
 * The store's `recordDeliveredReceipt` / `recordReadReceipts` can only reach
 * a row that is HYDRATED (the 200/10-row window). A receipt for a row that has
 * scrolled out of that window matched nothing and was dropped — and the
 * relay's delivered replay is emit-then-delete, so the bubble stayed on a
 * single tick forever. This module is the same rule (B-116 / B-187: a group
 * row advances only when every shipped-to member has acked; a direct row on
 * its single peer; never demote a member who already read; never regress the
 * status ladder), expressed over a row object so the SQL fallback can apply it
 * to a row loaded straight from SQLCipher and write it back.
 *
 * `receiptSqlFallback.test.ts` runs the SAME inputs through the store action
 * and through these helpers and asserts the results agree — that differential
 * pin is what keeps the two copies from drifting.
 */
import type {LocalMessage} from '../store/types';
import {isStatusRegression} from '../store/messengerStore';

export interface ReceiptAggregateCtx {
  isGroup: boolean;
  /** Other participants (own uid already excluded). Ignored for a direct row. */
  participants: string[];
}

function requiredSet(row: LocalMessage, ctx: ReceiptAggregateCtx): string[] | null {
  if (!ctx.isGroup) {return null;}
  // B-187 / B-116 — only members we actually SHIPPED a leg to can ever ack it;
  // fall back to the full roster for rows predating envelope_ids.
  const shipped = Object.keys(row.envelope_ids ?? {});
  return shipped.length > 0 ? ctx.participants.filter(u => shipped.includes(u)) : ctx.participants;
}

/** Returns the patched row, or null when the receipt does not apply to it. */
export function applyDeliveredReceiptToRow(
  row: LocalMessage, userId: string, ts: number, ctx: ReceiptAggregateCtx,
): LocalMessage | null {
  if (!userId || row.sender_id !== 'self') {return null;}
  const receipts = {...(row.receipts ?? {})};
  // Never demote a member who already READ the message.
  if (receipts[userId]?.status !== 'read') {
    receipts[userId] = {status: 'delivered', ts};
  }
  const required = requiredSet(row, ctx);
  const allDelivered = required && required.length > 0
    ? required.every(u => {
        const st = receipts[u]?.status;
        return st === 'delivered' || st === 'read';
      })
    : true; // direct: the single peer's ack is sufficient
  let status = row.status;
  if (allDelivered && row.status === 'sent' && !isStatusRegression(row.status, 'delivered')) {
    status = 'delivered';
  }
  return {...row, receipts, status};
}

/** Returns the patched row, or null when the receipt does not apply to it. */
export function applyReadReceiptToRow(
  row: LocalMessage, userId: string, ts: number, ctx: ReceiptAggregateCtx,
): LocalMessage | null {
  if (!userId || row.sender_id !== 'self') {return null;}
  const receipts = {...(row.receipts ?? {})};
  receipts[userId] = {status: 'read', ts};
  const required = requiredSet(row, ctx);
  const allRead = required && required.length > 0
    ? required.every(u => receipts[u]?.status === 'read')
    : true; // direct: the single peer's receipt is sufficient
  let status = row.status;
  if (allRead && row.status !== 'read' && !isStatusRegression(row.status, 'read')) {
    status = 'read';
  }
  return {...row, receipts, status};
}
