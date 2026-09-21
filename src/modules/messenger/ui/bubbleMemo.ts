/**
 * PG-M5 (2026-09-02) — the ONE rule for "does this bubble need to re-render".
 *
 * `MessageBubble` is `React.memo`'d with a field-level comparator so a receipt
 * landing on one row cannot re-render the whole thread (CLAUDE.md "the app
 * feels laggy": the cost is mounting, not drawing). The comparator used to
 * compare `id/status/content/expires_at/reactions/reply_to_msg_id` only — and
 * `applyDeleteForEveryone` retracts a message by setting `deleted_for_all`,
 * blanking `content` and flipping `type` to 'text'. A caption-less photo
 * already had `content === ''`, so after "Delete for everyone" every compared
 * field was unchanged, memo bailed out, and the retracted photo stayed on
 * screen until something else touched the row. A privacy-shaped repaint bug.
 *
 * Pure (no React) so the node project pins it directly; ChatScreen passes it
 * to `React.memo` verbatim.
 */
import type {LocalMessage} from '../store/types';

export interface BubbleMemoProps {
  msg: LocalMessage;
  isFirstInGroup?: boolean;
  isLastInGroup?: boolean;
  highlighted?: boolean;
  quotedSenderLabel?: unknown;
  senderLabel?: unknown;
  senderColor?: unknown;
  /** B-288 — compared by REFERENCE on purpose (memoised upstream on the array identity). */
  album?: unknown;
}

export function bubblePropsEqual(prev: BubbleMemoProps, next: BubbleMemoProps): boolean {
  const a = prev.msg;
  const b = next.msg;
  return (
    a.id               === b.id &&
    a.status           === b.status &&
    a.content          === b.content &&
    a.expires_at       === b.expires_at &&
    a.reactions        === b.reactions &&
    a.reply_to_msg_id  === b.reply_to_msg_id &&
    // PG-M5 — the retraction fields. `type` and `media_object_key` change on a
    // tombstone even when `content` does not; `edited_at` marks an edit whose
    // body happens to be byte-identical (the "edited" tag must still appear).
    a.deleted_for_all  === b.deleted_for_all &&
    a.type             === b.type &&
    a.media_object_key === b.media_object_key &&
    a.edited_at        === b.edited_at &&
    prev.isFirstInGroup    === next.isFirstInGroup &&
    prev.isLastInGroup     === next.isLastInGroup &&
    prev.highlighted       === next.highlighted &&
    prev.quotedSenderLabel === next.quotedSenderLabel &&
    prev.senderLabel       === next.senderLabel &&
    prev.senderColor       === next.senderColor &&
    prev.album             === next.album
  );
}
