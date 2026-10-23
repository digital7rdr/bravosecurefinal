/**
 * Group invite links / QR (2026-10-23) and group description.
 *
 * Pins: the link format round-trips and rejects junk; a join request is a
 * readable 1:1 message whose marker the UI hides; the admin's phone adds the
 * sender only for the token it issued, once per request, never after a reset
 * or turn-off, never for a group it does not admin or did not create; the
 * joiner's request goes to the admin over the normal encrypted send; and the
 * description rides on `rename` without changing how a plain rename hashes.
 */
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {__esModule: true, default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => { store.set(k, v); },
    removeItem: async (k: string) => { store.delete(k); },
  }};
});
jest.mock('react-native', () => ({Platform: {OS: 'android'}, AppState: {currentState: 'active', addEventListener: jest.fn(() => ({remove: jest.fn()}))}}));

const mockDocs = new Map<string, string>();
jest.mock('../runtime/keychain', () => ({
  __esModule: true,
  saveSecureDoc: async (d: string, u: string, j: string) => { mockDocs.set(`${d}:${u}`, j); },
  loadSecureDoc: async (d: string, u: string) => mockDocs.get(`${d}:${u}`) ?? null,
}));
const mockAdd = jest.fn(async () => ({newEpoch: 3}));
const mockSendText = jest.fn(async () => undefined);
jest.mock('../runtime/runtime', () => ({
  __esModule: true,
  getActiveOwnerKey: () => 'owner-1',
  getMessengerRuntime: async () => ({addGroupMember: mockAdd, sendText: mockSendText}),
}));

import {
  encodeGroupInvite, parseGroupInvite, joinRequestText, parseJoinRequest, withoutJoinMarker, newGroupInviteToken,
} from '@bravo/messenger-core/link/groupInvite';
import {applyAdminAction} from '@bravo/messenger-core';
import {useMessengerStore} from '../store/messengerStore';
import type {LocalConversation, LocalMessage} from '../store/types';
import {
  issueGroupInvite, resetGroupInvite, revokeGroupInvite, requestToJoinGroup, startGroupInvites, stopGroupInvites,
  canInviteToGroup,
} from '../groups/groupInvites';

const ME = 'me-1';
const PEER = 'peer-2';
const GROUP = 'grp-1';
const settle = async () => { for (let i = 0; i < 8; i++) {await new Promise(r => setTimeout(r, 0));} };

describe('invite link format', () => {
  const inv = {groupId: 'abc:def/ghi', adminUserId: '0b5e-uuid', token: newGroupInviteToken(), name: 'Ops · Night'};

  it('round-trips, tolerates whitespace and surrounding text', () => {
    const link = encodeGroupInvite(inv);
    expect(link.startsWith('bravo-group:1:')).toBe(true);
    expect(parseGroupInvite(link)).toEqual(inv);
    expect(parseGroupInvite(`Join us: ${link}\n`)).toEqual(inv);
  });

  it('rejects anything else', () => {
    for (const bad of ['', 'hello', 'bravo-group:1:', 'bravo-group:1:a:b:short:c', 'bravo-link:1:x:y', `bravo-group:1:${'!'.repeat(5)}:a:${'a'.repeat(24)}:b`]) {
      expect(parseGroupInvite(bad)).toBeNull();
    }
  });

  it('the join request reads as a sentence; the marker is parseable and hidden from display', () => {
    const text = joinRequestText(inv);
    expect(text.startsWith('Asked to join “Ops · Night” with your invite link.')).toBe(true);
    expect(parseJoinRequest(text)).toEqual({groupId: inv.groupId, token: inv.token});
    expect(withoutJoinMarker(text)).toBe('Asked to join “Ops · Night” with your invite link.');
    expect(withoutJoinMarker('plain text')).toBe('plain text');
    expect(parseJoinRequest('plain text')).toBeNull();
  });
});

describe('group description rides on rename', () => {
  const base = {
    groupId: GROUP, name: 'Ops', owner: ME, members: {[ME]: {deviceId: 1, admin: true, joinedAt: 1}, [PEER]: {deviceId: 1, admin: false, joinedAt: 1}},
    masterKeyB64: 'k', epoch: 4, createdAt: 1, updatedAt: 1, transcriptHash: 'h0',
  };

  it('an admin sets, keeps and clears it; the epoch advances like a rename', () => {
    const a = applyAdminAction(base, {type: 'rename', name: 'Ops', description: 'Gate 3 night shift', atEpoch: 4}, ME);
    expect(a.description).toBe('Gate 3 night shift');
    expect(a.epoch).toBe(5);
    const b = applyAdminAction(a, {type: 'rename', name: 'Ops North', atEpoch: 5}, ME);
    expect(b.description).toBe('Gate 3 night shift');
    const c = applyAdminAction(b, {type: 'rename', name: 'Ops North', description: '', atEpoch: 6}, ME);
    expect(c.description).toBeNull();
  });

  it('a member who is not an admin cannot change it', () => {
    const a = applyAdminAction(base, {type: 'rename', name: 'Ops', description: 'x', atEpoch: 4}, PEER);
    expect(a).toBe(base);
  });

  it('a plain rename hashes exactly as before (older phones stay in step)', () => {
    const plain = applyAdminAction(base, {type: 'rename', name: 'Ops 2', atEpoch: 4}, ME);
    const withUndefined = applyAdminAction(base, {type: 'rename', name: 'Ops 2', atEpoch: 4, description: undefined}, ME);
    expect(plain.transcriptHash).toBe(withUndefined.transcriptHash);
    const described = applyAdminAction(base, {type: 'rename', name: 'Ops 2', atEpoch: 4, description: 'd'}, ME);
    expect(described.transcriptHash).not.toBe(plain.transcriptHash);
  });
});

describe('the admin phone honours its own invite links', () => {
  function seed(opts: {admin?: boolean; salt?: boolean} = {}) {
    const st = useMessengerStore.getState();
    st.reset();
    st.setOwner('owner-1', ME);
    st.upsertConversation({
      id: GROUP, type: 'group', name: 'Ops Team', participants: [ME], peer: {userId: GROUP, deviceId: 1},
      session_state: 'established', unread_count: 0, is_muted: false, created_at: new Date().toISOString(),
    } as LocalConversation);
    st.setGroupState({
      groupId: GROUP, name: 'Ops Team', owner: ME, members: {[ME]: {deviceId: 1, admin: opts.admin ?? true, joinedAt: 1}},
      masterKeyB64: 'k', epoch: 1, createdAt: 1, updatedAt: 1, ...(opts.salt === false ? {} : {saltB64: 'salt'}),
    });
    st.upsertConversation({
      id: `direct:${PEER}`, type: 'direct', name: 'Bob', participants: [PEER], peer: {userId: PEER, deviceId: 1},
      session_state: 'established', unread_count: 0, is_muted: false, created_at: new Date().toISOString(),
    } as LocalConversation);
  }
  let n = 0;
  function receive(text: string): string {
    const id = `in-${++n}`;
    useMessengerStore.getState().appendMessage(`direct:${PEER}`, {
      id, conversation_id: `direct:${PEER}`, sender_id: PEER, type: 'text', content: text, status: 'delivered',
      is_encrypted: true, created_at: new Date().toISOString(), peer: {userId: PEER, deviceId: 1},
    } as LocalMessage);
    return id;
  }

  beforeEach(() => { mockDocs.clear(); mockAdd.mockClear(); mockSendText.mockClear(); stopGroupInvites(); });
  afterEach(() => stopGroupInvites());

  it('adds the sender once for the token it issued', async () => {
    seed();
    const link = await issueGroupInvite(GROUP);
    startGroupInvites();
    await settle();
    const inv = parseGroupInvite(link)!;
    expect(inv.adminUserId).toBe(ME);
    receive(joinRequestText(inv));
    await settle();
    expect(mockAdd).toHaveBeenCalledWith({groupId: GROUP, newMember: {userId: PEER, deviceId: 1}});
    // The token is kept on this phone only, in the keystore document.
    expect(mockDocs.get('invites:owner-1')).toContain(inv.token);
    // A restart re-scans recent messages: the same request is not honoured twice.
    stopGroupInvites();
    startGroupInvites();
    await settle();
    expect(mockAdd).toHaveBeenCalledTimes(1);
  });

  it('ignores a wrong token, a reset link and a link that was turned off', async () => {
    seed();
    const old = parseGroupInvite(await issueGroupInvite(GROUP))!;
    startGroupInvites();
    await settle();
    receive(joinRequestText({...old, token: newGroupInviteToken()}));
    await settle();
    const fresh = parseGroupInvite(await resetGroupInvite(GROUP))!;
    expect(fresh.token).not.toBe(old.token);
    receive(joinRequestText(old));
    await settle();
    await revokeGroupInvite(GROUP);
    receive(joinRequestText(fresh));
    await settle();
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('only an admin of a group people made can issue a link (no mission rooms)', async () => {
    seed({admin: false});
    await expect(issueGroupInvite(GROUP)).rejects.toThrow(/admin/);
    seed({salt: false});
    expect(canInviteToGroup(useMessengerStore.getState(), GROUP, ME)).toBe(false);
    await expect(issueGroupInvite(GROUP)).rejects.toThrow(/admin/);
  });

  it('the joiner sends the request to the admin over the normal encrypted 1:1 send', async () => {
    seed();
    const link = encodeGroupInvite({groupId: 'other-group', adminUserId: PEER, token: newGroupInviteToken(), name: 'Their group'});
    const r = await requestToJoinGroup(link);
    expect(r).toEqual({groupName: 'Their group', alreadyMember: false});
    expect(mockSendText).toHaveBeenCalledWith(`direct:${PEER}`, expect.stringContaining('bravo-join:1:'), {peer: {userId: PEER, deviceId: 1}});
    await expect(requestToJoinGroup('not a link')).rejects.toThrow(/not a Bravo group invite/);
  });
});
