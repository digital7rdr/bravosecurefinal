/**
 * 2026-10-24 — a call that can never ring ends with a reason instead of
 * "Calling…" until timeout. The server sends `call.unreachable` to the caller
 * when the callee has no live connection and no phone to wake:
 *   account_gone → the account was deleted
 *   no_device    → nobody is signed in to it on a phone
 */
import fs from 'fs';
import path from 'path';
import {registerSignalling, dispatchCallFrame, clearAllCallDispatchState} from '../webrtc/callDispatcher';
import {CallSignalling} from '../webrtc/signallingClient';
import {isCallFrame} from '../runtime/callFrameRouter';
import type {ServerFrame, TransportClient} from '@bravo/messenger-core';

const frame = (callId: string, reason: 'account_gone' | 'no_device') =>
  ({event: 'call.unreachable', data: {callId, reason}}) as unknown as ServerFrame;

describe('call.unreachable reaches the screen placing the call', () => {
  beforeEach(() => clearAllCallDispatchState());

  it('the runtime routes it to the call dispatcher', () => {
    expect(isCallFrame('call.unreachable')).toBe(true);
  });

  it('the dispatcher delivers it to that call\'s signalling only', () => {
    const mine = new CallSignalling({} as unknown as TransportClient);
    const other = new CallSignalling({} as unknown as TransportClient);
    const got: unknown[] = [];
    const otherGot: unknown[] = [];
    mine.onUnreachable(d => got.push(d));
    other.onUnreachable(d => otherGot.push(d));
    registerSignalling('call-1', mine);
    registerSignalling('call-2', other);
    expect(dispatchCallFrame(frame('call-1', 'account_gone'))).toBe(true);
    expect(got).toEqual([{callId: 'call-1', reason: 'account_gone'}]);
    expect(otherGot).toEqual([]);
  });

  it('with no screen for the call it is dropped, not queued', () => {
    expect(dispatchCallFrame(frame('call-x', 'no_device'))).toBe(true);
    const late = new CallSignalling({} as unknown as TransportClient);
    const got: unknown[] = [];
    late.onUnreachable(d => got.push(d));
    registerSignalling('call-x', late);
    expect(got).toEqual([]);
  });

  it('unsubscribing stops delivery', () => {
    const s = new CallSignalling({} as unknown as TransportClient);
    const got: unknown[] = [];
    const off = s.onUnreachable(d => got.push(d));
    off();
    s.ingest(frame('call-1', 'no_device'));
    expect(got).toEqual([]);
  });
});

describe('the caller sees why and the call ends', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'webrtc', 'useCall.ts'), 'utf8');

  it('an outgoing call still ringing shows the reason and hangs up', () => {
    const at = src.indexOf('signalling.onUnreachable(');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 900);
    expect(block).toMatch(/d\.callId !== callId/);
    expect(block).toMatch(/currentState !== 'calling' && c\.currentState !== 'idle'/);
    expect(block).toMatch(/Alert\.alert\(copy\.title, copy\.message\)/);
    expect(block).toMatch(/c\.hangup\('ended'\)/);
    expect(src.slice(at - 120, at)).toMatch(/direction === 'outgoing'/);
    expect(src).toMatch(/try \{ unregisterUnreachable\(\); \}/);
  });

  it('the wording names the reason', () => {
    const fn = src.slice(src.indexOf('export function unreachableCopy'));
    expect(fn).toMatch(/account_gone/);
    expect(fn).toMatch(/Account no longer exists/);
    expect(fn).toMatch(/Not reachable/);
    expect(fn).toMatch(/signed in to Bravo on any phone/);
  });
});
