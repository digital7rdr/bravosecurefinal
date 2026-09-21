/**
 * Media-parity M17 (2026-07-03) — attachment failure classification,
 * kept in its own tiny module (no RNFS/runtime imports) so it can be
 * unit-tested and reused without dragging in native modules.
 */

import {MediaHttpError} from './mediaClient';
import {NoFreeSpaceError} from './freeSpace';
import {MediaTooLargeError} from './mediaLimits';

export type AttachmentErrorReason =
  'forbidden' | 'gone' | 'offline' | 'no_space' | 'too_large' | 'unavailable';

/**
 * B-728 — reasons a retry can never resolve. The bubble must NOT invite a tap
 * for these: an oversized attachment re-downloads and re-decrypts tens of
 * megabytes to fail in exactly the same place, which is a bandwidth loop, not
 * a recovery. (`forbidden`/`gone` need the SENDER to act, so they are terminal
 * for the same reason — their copy already said so; this makes it checkable.)
 */
const TERMINAL: ReadonlySet<AttachmentErrorReason> = new Set<AttachmentErrorReason>([
  'forbidden', 'gone', 'too_large',
]);

export function isTerminalAttachmentError(reason: AttachmentErrorReason | null): boolean {
  return reason !== null && TERMINAL.has(reason);
}

/** Map a download failure to a user-facing reason class. */
export function classifyAttachmentError(e: unknown): AttachmentErrorReason {
  // B-728 — over the device's decrypt-write ceiling. Permanent on this phone,
  // so it must never classify as the retryable 'unavailable' default.
  if (e instanceof MediaTooLargeError) {return 'too_large';}
  // MD-08 — the proactive precheck, plus the reactive write failure the
  // filesystem reports when the disk fills mid-write.
  if (e instanceof NoFreeSpaceError) {return 'no_space';}
  if (e instanceof MediaHttpError) {
    if (e.status === 403) {return 'forbidden';}
    if (e.status === 404) {return 'gone';}
    if (e.status === 0)   {return 'offline';}
    return 'unavailable';
  }
  const msg = e instanceof Error ? e.message : '';
  if (/enospc|no space|disk full/i.test(msg)) {return 'no_space';}
  if (/network|abort|timeout|failed to fetch/i.test(msg)) {return 'offline';}
  return 'unavailable';
}

/** Human copy for each failure class — shared by bubble + viewer. */
export function attachmentErrorText(reason: AttachmentErrorReason | null): string {
  switch (reason) {
    case 'forbidden': return 'No access — ask the sender to resend';
    case 'gone':      return 'Expired — ask the sender to resend';
    case 'offline':   return 'No connection — tap to retry';
    case 'no_space':  return 'Not enough storage — free up space';
    // B-728 — deliberately NOT "tap to retry": no retry can make this phone
    // able to hold the file, and each attempt costs the whole download again.
    case 'too_large': return 'Too large to open on this phone';
    default:          return 'Tap to retry';
  }
}
