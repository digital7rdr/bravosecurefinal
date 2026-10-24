/**
 * 2026-10-24 — "Calling…" forever when the other person can never ring.
 *
 * When the callee has no live connection AND the VoIP wake finds no phone to
 * wake (no device signed in, or the account was deleted), the caller gets a
 * `call.unreachable` frame with the reason, instead of ringing out for 45s.
 * A callee with a live socket, or with a phone to wake, is never reported.
 *
 * Same harness style as messenger.gateway.missed-call-ttl.spec.ts: the handler
 * is invoked off the prototype with a hand-built `this`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type {Socket} from 'socket.io';
import {MessengerGateway} from './messenger.gateway';

const proto: any = MessengerGateway.prototype;

function fakeClient(): Socket & {emit: jest.Mock} {
  return {
    id: 'sock-A',
    data: {claims: {sub: 'aaaaaaaa-0000-0000-0000-000000000001'}, signalDeviceId: 1, sessionId: 's-A'},
    connected: true,
    emit: jest.fn(),
    join: jest.fn(async () => undefined),
  } as unknown as Socket & {emit: jest.Mock};
}

function redisClient() {
  const c: any = {
    set: jest.fn(async () => 'OK'),
    sadd: jest.fn(async () => 1),
    expire: jest.fn(async () => 1),
  };
  c.multi = () => {
    const chain: any = {
      set: () => chain, sadd: () => chain, expire: () => chain,
      exec: async () => [[null, 'OK'], [null, 'OK'], [null, 1], [null, 1]],
    };
    return chain;
  };
  return c;
}

async function placeCall(opts: {
  online: boolean;
  wake: {sent: number; stubbed: boolean; noDevices?: boolean};
  gone?: boolean;
  hangUpFirst?: boolean;
}) {
  const client = fakeClient();
  const isAccountGone = jest.fn(async () => !!opts.gone);
  const self: any = {
    rateGate: () => null,
    privacy: {isBlockedEither: jest.fn(async () => false), isAccountGone},
    callSessions: new Map(),
    socketCalls: new WeakMap(),
    gcCallTombstones: proto.gcCallTombstones,
    untrackCallSilently: proto.untrackCallSilently,
    privacyGateBounded: proto.privacyGateBounded,
    trackCallStart: jest.fn(proto.trackCallStart),
    notifyUnreachable: proto.notifyUnreachable,
    forwardToDevice: jest.fn(async () => (opts.online
      ? undefined
      : {event: 'error', data: {code: 'peer_offline', message: 'callee not connected'}})),
    push: {sendVoipWake: jest.fn(async () => {
      if (opts.hangUpFirst) { for (const s of self.callSessions.values()) s.state = 'ended'; }
      return opts.wake;
    })},
    redis: {client: redisClient()},
  };
  const callId = 'cccccccc-0000-0000-0000-000000000001';
  const ret = await proto.handleCallOffer.call(
    self,
    {callId, to: {userId: 'bbbbbbbb-0000-0000-0000-000000000002', deviceId: 1}, sdp: 'v=0', kind: 'video', auth: {v: 1}},
    client,
  );
  // the wake result is handled off the offer's return path
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  const unreachable = client.emit.mock.calls.filter(c => c[0] === 'call.unreachable');
  return {ret, unreachable, isAccountGone, callId};
}

describe('call.unreachable', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { logSpy.mockRestore(); warnSpy.mockRestore(); });

  it('tells the caller the account no longer exists', async () => {
    const {unreachable, callId} = await placeCall({online: false, wake: {sent: 0, stubbed: false, noDevices: true}, gone: true});
    expect(unreachable).toEqual([['call.unreachable', {callId, reason: 'account_gone'}]]);
  });

  it('tells the caller nobody is signed in on a phone', async () => {
    const {unreachable, callId} = await placeCall({online: false, wake: {sent: 0, stubbed: false, noDevices: true}, gone: false});
    expect(unreachable).toEqual([['call.unreachable', {callId, reason: 'no_device'}]]);
  });

  it('says nothing when a phone was woken', async () => {
    const {unreachable, isAccountGone} = await placeCall({online: false, wake: {sent: 1, stubbed: false}});
    expect(unreachable).toEqual([]);
    expect(isAccountGone).not.toHaveBeenCalled();
  });

  it('says nothing when the callee is connected, even with no push token', async () => {
    const {unreachable} = await placeCall({online: true, wake: {sent: 0, stubbed: false, noDevices: true}});
    expect(unreachable).toEqual([]);
  });

  it('says nothing when the caller already hung up', async () => {
    const {unreachable} = await placeCall({online: false, wake: {sent: 0, stubbed: false, noDevices: true}, hangUpFirst: true});
    expect(unreachable).toEqual([]);
  });

  it('falls back to no_device when the account lookup fails', async () => {
    const client = fakeClient();
    const self: any = {
      callSessions: new Map([['cid-1', {state: 'ringing'}]]),
      privacy: {isAccountGone: jest.fn(async () => { throw new Error('db down'); })},
    };
    await proto.notifyUnreachable.call(self, client, 'cid-1', 'bbbbbbbb');
    expect(client.emit).toHaveBeenCalledWith('call.unreachable', {callId: 'cid-1', reason: 'no_device'});
  });
});
