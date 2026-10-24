/**
 * "Calling…" but the other phone never rings (2026-10-24, VPS logs).
 *
 *  1. A 1:1 chat whose participant list still named the previous account's
 *     self id (same number deleted and registered again on this phone) was
 *     rung as a GROUP call through the SFU — server log `room.create
 *     cid=direct:…` with two ring targets, one of them a dead account.
 *     A 1:1 chat must always place a 1:1 call.
 *  2. When the messenger socket is down the offer waited for the background
 *     reconnect; text does not use that socket, so only calls broke. The call
 *     now asks for a fresh connection at once.
 *  3. A new account on a number this phone already used gets a clean
 *     messenger (the old account's local data is wiped), so its chats and
 *     calls point at live accounts.
 */
import fs from 'fs';
import path from 'path';

const mockStorage = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async (k: string) => mockStorage.get(k) ?? null,
    setItem: async (k: string, v: string) => { mockStorage.set(k, v); },
    removeItem: async (k: string) => { mockStorage.delete(k); },
  },
}));

import {CallSignalling} from '../webrtc/signallingClient';
import type {TransportClient} from '@bravo/messenger-core';
import {foreignSelfIds, sliceBelongsToAnotherAccount, guardOwnerAccount} from '../runtime/ownerAccountGuard';
import type {LocalConversation} from '../store/types';

const direct = (id: string, peer: string, participants: string[]) => ({
  id, type: 'direct', name: 'x', participants, peer: {userId: peer, deviceId: 1},
  session_state: 'established', unread_count: 0, is_muted: false, created_at: '2026-10-24T00:00:00Z',
}) as unknown as LocalConversation;

describe('a 1:1 chat places a 1:1 call', () => {
  it('launchCall never routes a direct conversation through the SFU', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'webrtc', 'launchCall.ts'), 'utf8');
    const body = src.slice(src.indexOf('export function shouldRouteCallViaSfu'));
    const fn = body.slice(0, body.indexOf('\n}\n') + 2);
    const directAt = fn.indexOf("if (convo.type === 'direct') {return false;}");
    expect(directAt).toBeGreaterThan(-1);
    expect(directAt).toBeLessThan(fn.indexOf('otherMembers(conversationId).length >= 2'));
  });
});

describe('placing a call while the messenger socket is down', () => {
  it('asks for a fresh connection once and sends the offer when it is back', async () => {
    const sent: unknown[] = [];
    const t = {
      state: 'reconnecting',
      forceReconnect: jest.fn(async () => { setTimeout(() => { t.state = 'connected'; }, 150); }),
      send: (f: unknown) => { if (t.state !== 'connected') {throw new Error('transport not open');} sent.push(f); },
    };
    const s = new CallSignalling(t as unknown as TransportClient);
    const ok = await s.sendOffer('c1', {userId: 'bob', deviceId: 1}, 'v=0', 'voice');
    expect(ok).toBe(true);
    expect(t.forceReconnect).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([expect.objectContaining({event: 'call.offer'})]);
  });

  it('does not reconnect when the socket is already up', async () => {
    const t = {state: 'connected', forceReconnect: jest.fn(async () => undefined), send: jest.fn()};
    const s = new CallSignalling(t as unknown as TransportClient);
    expect(await s.sendOffer('c2', {userId: 'bob', deviceId: 1}, 'v=0', 'video')).toBe(true);
    expect(t.forceReconnect).not.toHaveBeenCalled();
  });
});

describe('a new account on a number this phone already used', () => {
  beforeEach(() => mockStorage.clear());

  it('recognises another account\'s chats', () => {
    const old = {a: direct('direct:p1', 'p1', ['old-me', 'p1']), b: direct('direct:p2', 'p2', ['old-me', 'p2'])};
    expect(foreignSelfIds(old, 'new-me')).toEqual(['old-me']);
    expect(sliceBelongsToAnotherAccount(old, 'new-me')).toBe(true);
    const mine = {a: direct('direct:p1', 'p1', ['new-me', 'p1']), b: direct('direct:p2', 'p2', ['self', 'p2']), c: direct('direct:p3', 'p3', ['p3'])};
    expect(foreignSelfIds(mine, 'new-me')).toEqual([]);
    expect(sliceBelongsToAnotherAccount(mine, 'new-me')).toBe(false);
  });

  it('wipes the previous account\'s local data when the account behind the number changes', async () => {
    const wipe = jest.fn(async () => undefined);
    const dropInMemory = jest.fn();
    const slice = () => ({});
    expect(await guardOwnerAccount('+971500000001', 'acct-1', {slice, wipe, dropInMemory})).toBe('first-seen');
    expect(await guardOwnerAccount('+971500000001', 'acct-1', {slice, wipe, dropInMemory})).toBe('same-account');
    expect(wipe).not.toHaveBeenCalled();
    expect(await guardOwnerAccount('+971500000001', 'acct-2', {slice, wipe, dropInMemory})).toBe('wiped-other-account');
    expect(wipe).toHaveBeenCalledWith('+971500000001');
    expect(dropInMemory).toHaveBeenCalledWith('+971500000001');
    expect(await guardOwnerAccount('+971500000001', 'acct-2', {slice, wipe, dropInMemory})).toBe('same-account');
  });

  it('on a phone from before this check, decides from the chats', async () => {
    const wipe = jest.fn(async () => undefined);
    const dropInMemory = jest.fn();
    const stale = {a: direct('direct:p1', 'p1', ['old-me', 'p1'])};
    expect(await guardOwnerAccount('owner@x', 'new-me', {slice: () => stale, wipe, dropInMemory})).toBe('wiped-other-account');
    const fresh = {a: direct('direct:p1', 'p1', ['me', 'p1'])};
    expect(await guardOwnerAccount('owner@y', 'me', {slice: () => fresh, wipe, dropInMemory})).toBe('first-seen');
    expect(wipe).toHaveBeenCalledTimes(1);
  });
});
