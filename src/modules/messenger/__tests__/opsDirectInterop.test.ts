/**
 * 2026-09-30 — ops console 1:1 chat ↔ mobile messenger wire interop.
 *
 * The console's `sealDirectText` (apps/ops-console/src/lib/messenger/directSeal.ts)
 * must produce a 1:1 envelope the MOBILE receiver accepts: Signal session
 * round-trip, then `verifySealedAad` with exactly the arguments mobile's
 * productionRuntime passes (expected sender + expectedAadConversationId).
 * And the reverse: a mobile-shaped 1:1 must pass the console's own check.
 */
import {
  SessionManager, InMemoryProtocolStore, installIdentity, buildOwnPreKeyBundle,
  unsealPayload, verifySealedAad, sealPayload, type SessionAddress,
} from '@bravo/messenger-core';
import {sealDirectText, directConvoAadId as opsDirectId} from '../../../../apps/ops-console/src/lib/messenger/directSeal';
import {expectedAadConversationId, directConvoAadId as mobileDirectId} from '../runtime/aadBinding';

async function party(address: SessionAddress) {
  const store = new InMemoryProtocolStore();
  await installIdentity(store, {preKeyCount: 1});
  const bundle = await buildOwnPreKeyBundle(store, address, 1, 1);
  return {store, address, bundle, mgr: new SessionManager(store)};
}

const OPS: SessionAddress    = {userId: 'a1a1a1a1-0000-4000-8000-000000000001', deviceId: 1};
const MOBILE: SessionAddress = {userId: '11111111-2222-4333-8444-555555555555', deviceId: 1};

describe('ops console 1:1 ↔ mobile', () => {
  it('uses the same symmetric AAD conversation id as mobile', () => {
    expect(opsDirectId(OPS.userId, MOBILE.userId)).toBe(mobileDirectId(OPS.userId, MOBILE.userId));
    expect(opsDirectId(MOBILE.userId, OPS.userId)).toBe(mobileDirectId(OPS.userId, MOBILE.userId));
  });

  it('a console-sent text decrypts on mobile and passes the mobile AAD check', async () => {
    const ops = await party(OPS);
    const mob = await party(MOBILE);
    await ops.mgr.initOutgoingSession(mob.bundle);
    const sealed = sealDirectText({
      cert: 'test-cert', text: 'Your driver is 5 minutes away.', self: OPS, peer: MOBILE,
      clientMsgId: 'cmid-1', ts: Date.now(),
    });
    const ct = await ops.mgr.encrypt(MOBILE, sealed);
    const plain = await mob.mgr.decrypt(OPS, ct);
    const unwrapped = unsealPayload(plain);
    expect(unwrapped.body).toBe('Your driver is 5 minutes away.');
    expect(unwrapped.clientMsgId).toBe('cmid-1');
    expect(unwrapped.group).toBeUndefined();

    const check = verifySealedAad({
      sealed:                 unwrapped,
      selfUserId:             MOBILE.userId,
      selfDeviceId:           1,
      requireAad:             true,
      expectedSender:         OPS,
      expectedConversationId: expectedAadConversationId({ownUserId: MOBILE.userId, peerUserId: OPS.userId}),
      expectedGroupId:        undefined,
    });
    expect(check).toEqual(expect.objectContaining({ok: true}));
  });

  it('is rejected by mobile if addressed to someone else (replay guard intact)', async () => {
    const sealed = sealDirectText({
      cert: 'test-cert', text: 'x', self: OPS, peer: {userId: 'someone-else', deviceId: 1},
      clientMsgId: 'c', ts: Date.now(),
    });
    const check = verifySealedAad({
      sealed: unsealPayload(sealed), selfUserId: MOBILE.userId, selfDeviceId: 1, requireAad: true,
      expectedSender: OPS,
      expectedConversationId: expectedAadConversationId({ownUserId: MOBILE.userId, peerUserId: OPS.userId}),
      expectedGroupId: undefined,
    });
    expect(check.ok).toBe(false);
  });

  it('a mobile-shaped 1:1 passes the console receiver check', () => {
    const sealed = sealPayload('test-cert', 'Thanks, received.', {
      clientMsgId: 'm1',
      aad: {to: OPS, ts: Date.now(), sender: MOBILE, conversationId: mobileDirectId(MOBILE.userId, OPS.userId)},
    });
    const check = verifySealedAad({
      sealed: unsealPayload(sealed), selfUserId: OPS.userId, selfDeviceId: 1, requireAad: true,
      expectedSender: MOBILE, expectedConversationId: opsDirectId(OPS.userId, MOBILE.userId), expectedGroupId: undefined,
    });
    expect(check).toEqual(expect.objectContaining({ok: true}));
  });
});
