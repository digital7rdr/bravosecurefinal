/**
 * The one place the ops console shapes a 1:1 text for the wire (2026-09-30).
 *
 * Byte-shaped like the mobile live send (productionRuntime `sealPayload` for a
 * direct message): body + clientMsgId, and the full P0-N2 AAD — recipient,
 * compose time, sender, and the SYMMETRIC `direct:<lo>|<hi>` conversation id
 * the mobile receiver recomputes from (self, peer) in `expectedAadConversationId`.
 * Kept pure (messenger-core only, no IDB) so the interop test can run it
 * against the mobile verifier: src/modules/messenger/__tests__/opsDirectInterop.test.ts.
 */
import {sealPayload, type SessionAddress} from '@bravo/messenger-core';

/** Same grammar as mobile `aadBinding.directConvoAadId`. */
export function directConvoAadId(a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `direct:${lo}|${hi}`;
}

export function sealDirectText(p: {
  cert:        string;
  text:        string;
  self:        SessionAddress;
  peer:        SessionAddress;
  clientMsgId: string;
  ts:          number;
}): string {
  return sealPayload(p.cert, p.text, {
    clientMsgId: p.clientMsgId,
    aad: {
      to:             p.peer,
      ts:             p.ts,
      sender:         p.self,
      conversationId: directConvoAadId(p.self.userId, p.peer.userId),
    },
  });
}
