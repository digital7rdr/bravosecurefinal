/**
 * PG-G2 / PG-G2r (2026-09-02) — a host cancelling a group ring is the group
 * twin of the 1:1 "caller gave up": a genuinely-unreached recipient must still
 * LEARN they were called, and NOBODY else may be told they "missed" it.
 *
 * Round 1 pushed `missed:true` unconditionally — a critic showed that
 * over-reports: a DECLINER (artifacts cleared at decline) and a member who
 * ANSWERED (cleared at join) would get a phantom "Missed call". Round 2 keys
 * `missed` on whether a missed-marker for THIS fan-out still exists, which is
 * exactly "this member neither declined nor answered".
 *
 * Same harness style as messenger.gateway.calls.spec: handlers invoked off the
 * prototype with a hand-built `this`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type {Socket} from 'socket.io';
import {MessengerGateway} from './messenger.gateway';

const proto: any = MessengerGateway.prototype;

function fakeClient(sub: string, deviceId = 7): Socket {
  return {
    id:   `sock-${sub}`,
    data: {claims: {sub}, signalDeviceId: deviceId, sessionId: `s-${sub}`},
    connected: true,
    emit: jest.fn(),
    join: jest.fn(async () => undefined),
  } as unknown as Socket;
}

const flush = (): Promise<void> => new Promise(r => setImmediate(r));

describe('PG-G2r — handleSfuRingCancel keys `missed` on the recipient\'s marker', () => {
  function cancelThis() {
    const emit = jest.fn();
    const self = {
      rateGate:                 () => null,
      verifySfuRingAuthority:   () => null,
      sfu:                      {endRoomIfEmptyByHost: jest.fn()},
      hub:                      {server: {to: () => ({emit})}, userRoom: (u: string) => `user:${u}`},
      push:                     {sendCallCancel: jest.fn(async () => 1)},
      // u2 still holds a missed-marker (never declined, never joined);
      // u3's was cleared at decline/join.
      clearPendingGroupRingArtifacts: jest.fn(async (uid: string) => ({markerMatched: uid === 'u2'})),
    };
    return {self, emit};
  }

  it('marker present → missed:TRUE with the thread id; marker absent (decliner/answered) → missed:false', async () => {
    const {self, emit} = cancelThis();
    const res = proto.handleSfuRingCancel.call(
      self,
      {roomId: 'room-1', conversationId: 'g-1', recipientUserIds: ['u2', 'u3', 'host'], ringId: 'ring-1'},
      fakeClient('host'),
    );
    expect(res).toEqual({ok: true});
    await flush();
    // The WS cancel still reaches connected devices; self is stripped.
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith('sfu.ring.cancelled', {roomId: 'room-1', conversationId: 'g-1', ringId: 'ring-1'});
    expect(self.push.sendCallCancel).toHaveBeenCalledTimes(2);
    expect(self.push.sendCallCancel).toHaveBeenCalledWith('u2', 'room-1', 'host', 'voice', /*missed*/ true, 'ring-1', 'g-1');
    expect(self.push.sendCallCancel).toHaveBeenCalledWith('u3', 'room-1', 'host', 'voice', /*missed*/ false, 'ring-1', 'g-1');
    for (const uid of ['u2', 'u3']) {
      // The marker is KEPT either way — the reconnect drain owns the replay.
      expect(self.clearPendingGroupRingArtifacts).toHaveBeenCalledWith(uid, 'room-1', {onlyRingId: 'ring-1', keepMarker: true});
    }
  });
});

describe('PG-G2 — clearPendingGroupRingArtifacts: keepMarker + markerMatched', () => {
  function artifactsThis(stored: {ringId?: string} | null, markerStored: {ringId?: string} | null = stored) {
    const del  = jest.fn();
    const srem = jest.fn();
    const chain = {del, srem, exec: jest.fn(async () => [[null, 1]])};
    const rawRing   = stored ? JSON.stringify(stored) : null;
    const rawMarker = markerStored ? JSON.stringify(markerStored) : null;
    const self = {
      redis:  {client: {mget: jest.fn(async () => [rawRing, rawMarker]), multi: () => chain}},
      logger: {warn: jest.fn()},
    };
    return {self, del, srem};
  }

  it('keepMarker: the queued ring drops, the marker AND the index survive, markerMatched reports true', async () => {
    const {self, del, srem} = artifactsThis({ringId: 'ring-1'});
    const r = await proto.clearPendingGroupRingArtifacts.call(self, 'u2', 'room-1', {onlyRingId: 'ring-1', keepMarker: true});
    expect(r).toEqual({markerMatched: true});
    expect(del).toHaveBeenCalledWith('pending-group-ring:u2:room-1');
    expect(del).not.toHaveBeenCalledWith('missed-group-call-marker:u2:room-1');
    // P1-15's lesson, group flavour: the drain enumerates only the index, so it
    // must stay reachable while the marker lives.
    expect(srem).not.toHaveBeenCalled();
  });

  it('no marker at all (decliner/answered): markerMatched false, nothing phantom to keep', async () => {
    const {self, del, srem} = artifactsThis({ringId: 'ring-1'}, null);
    const r = await proto.clearPendingGroupRingArtifacts.call(self, 'u3', 'room-1', {onlyRingId: 'ring-1', keepMarker: true});
    expect(r).toEqual({markerMatched: false});
    expect(del).toHaveBeenCalledWith('pending-group-ring:u3:room-1');
    expect(del).not.toHaveBeenCalledWith('missed-group-call-marker:u3:room-1');
    expect(srem).not.toHaveBeenCalled();
  });

  it('without keepMarker the pre-existing behaviour is unchanged (both cleared, index dropped)', async () => {
    const {self, del, srem} = artifactsThis({ringId: 'ring-1'});
    const r = await proto.clearPendingGroupRingArtifacts.call(self, 'u2', 'room-1', {onlyRingId: 'ring-1'});
    expect(r).toEqual({markerMatched: true});
    expect(del).toHaveBeenCalledWith('pending-group-ring:u2:room-1');
    expect(del).toHaveBeenCalledWith('missed-group-call-marker:u2:room-1');
    expect(srem).toHaveBeenCalledWith('pending-group-ring-idx:u2', 'room-1');
  });

  it("WI-6.7 still holds: a NEWER ring's artifacts survive a stale cancel, and its marker does not count as matched", async () => {
    const {self, del, srem} = artifactsThis({ringId: 'ring-2'});
    const r = await proto.clearPendingGroupRingArtifacts.call(self, 'u2', 'room-1', {onlyRingId: 'ring-1', keepMarker: true});
    expect(r).toEqual({markerMatched: false});
    expect(del).not.toHaveBeenCalled();
    expect(srem).not.toHaveBeenCalled();
  });
});
