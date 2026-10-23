/**
 * Linked devices (2026-10-12) — the phone side of the browser mirror.
 *
 * Pins: approving a scanned QR posts /link/approve and sends the browser a
 * sealed snapshot (hello, contacts, conversations, recent messages); a new
 * direct-chat message is forwarded sealed; the browser's `send` command goes
 * out through runtime.sendText with the browser's id as the message id and is
 * answered; nothing on the wire is plaintext; unlink forgets the key.
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem:    async (k: string) => store.get(k) ?? null,
      setItem:    async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
    },
  };
});

jest.mock('react-native', () => ({
  Platform: {OS: 'android'},
  AppState: {currentState: 'active', addEventListener: jest.fn(() => ({remove: jest.fn()}))},
}));

jest.mock('@utils/constants', () => ({__esModule: true, MSG_BASE_URL: 'https://relay.test', API_BASE_URL: 'https://auth.test', DIAL_CODES: [{dial: '+971'}, {dial: '+44'}]}));

const mockSecrets = new Map<string, string>();
jest.mock('../runtime/keychain', () => ({
  __esModule: true,
  saveLinkSecrets:  async (u: string, j: string) => { mockSecrets.set(u, j); },
  loadLinkSecrets:  async (u: string) => mockSecrets.get(u) ?? null,
  clearLinkSecrets: async (u: string) => { mockSecrets.delete(u); },
  saveSecureDoc:    async (d: string, u: string, j: string) => { mockSecrets.set(`${d}:${u}`, j); },
  loadSecureDoc:    async (d: string, u: string) => mockSecrets.get(`${d}:${u}`) ?? null,
}));

const mockSendText = jest.fn(async () => undefined);
const mockCreateGroup = jest.fn(async () => ({conversationId: 'g-new', groupId: 'g-new'}));
const mockAddMember = jest.fn(async () => ({newEpoch: 3}));
const mockSetDescription = jest.fn(async () => ({newEpoch: 2}));
jest.mock('../runtime/runtime', () => ({
  __esModule: true,
  getActiveOwnerKey: () => 'owner-1',
  getMessengerRuntime: async () => ({
    sendText: mockSendText, markRead: jest.fn(), loadOlderMessages: jest.fn(),
    createGroupChat: mockCreateGroup, addGroupMember: mockAddMember, setGroupDescription: mockSetDescription,
    removeGroupMember: jest.fn(), renameGroup: jest.fn(), leaveGroup: jest.fn(),
  }),
}));

jest.mock('../runtime/transportRegistry', () => ({__esModule: true, onTransport: () => () => undefined}));

jest.mock('../contacts/directoryNames', () => ({__esModule: true, ensureDirectoryNames: jest.fn(), getDirectoryUsersClient: () => null}));
jest.mock('../contacts/useDiscoveredContacts', () => ({
  __esModule: true,
  latestDiscoveredContacts: () => [{userId: 'peer-2', displayName: 'Bob', localName: 'Bobby', phoneE164: '+971500000002', avatarUrl: null}],
  discoverContactsPassive: async () => [],
}));
jest.mock('@store/authStore', () => ({__esModule: true, useAuthStore: {getState: () => ({user: {full_name: 'Me'}})}}));

type Call = {url: string; method: string; body: unknown};
const calls: Call[] = [];
let inbox: Array<{seq: number; data: string}> = [];
const mockFetchWithRefresh = jest.fn(async (url: string, init: {method?: string; body?: string}) => {
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({url, method: init.method ?? 'GET', body});
  const json = (v: unknown, status = 200) => ({ok: status < 300, status, json: async () => v});
  if (url.endsWith('/link/approve')) {return json({linkId: LINK, label: 'Chrome on Mac', approvedAt: 1, role: 'phone'});}
  if (url.includes('/inbox')) {const items = inbox; inbox = []; return json({items, more: false});}
  if (url.endsWith('/link/mine')) {return json({links: []});}
  if (url.endsWith('/users/lookup')) {return json({matches: [{userId: 'peer-9', phone: '+971500000009', displayName: 'Nine'}]});}
  if (init.method === 'DELETE' || url.endsWith('/ack')) {return {ok: true, status: 204, json: async () => ({})};}
  return json({seq: 1});
});
jest.mock('@/services/api', () => ({
  __esModule: true,
  fetchWithRefresh: (url: string, init: {method?: string; body?: string}) => mockFetchWithRefresh(url, init),
}));

import {useMessengerStore} from '../store/messengerStore';
import type {LocalConversation, LocalMessage} from '../store/types';
import {linkCipher, encodeLinkQr, newLinkKey, type LinkCipher, type PhoneToWeb} from '@bravo/messenger-core/link/linkProtocol';
import {approveLinkFromQr, drainLinkInboxes, startLinkEngine, stopLinkEngine, unlinkDevice, flushLinkBounded} from '../link/linkEngine';

const LINK = 'LLLLLLLLLLLLLLLLLLLLLL';
const PEER = 'peer-2';

function msg(id: string, extra?: Partial<LocalMessage>): LocalMessage {
  return {
    id, conversation_id: `direct:${PEER}`, sender_id: PEER, type: 'text', content: `body ${id}`,
    status: 'delivered', is_encrypted: true, created_at: new Date(1_760_000_000_000 + Number(id.replace(/\D/g, '') || 0) * 1000).toISOString(),
    peer: {userId: PEER, deviceId: 1}, ...extra,
  } as LocalMessage;
}

async function sentFrames(web: LinkCipher): Promise<PhoneToWeb[]> {
  const out: PhoneToWeb[] = [];
  for (const c of calls.filter(x => x.url.endsWith(`/link/${LINK}/send`))) {
    const b = c.body as {to: string; items: string[]};
    expect(b.to).toBe('web');
    for (const it of b.items) {
      expect(it).not.toContain('body ');
      const m = await web.open('p2w', it);
      expect(m).not.toBeNull();
      out.push(m as PhoneToWeb);
    }
  }
  return out;
}

const settle = () => new Promise(r => setTimeout(r, 0));

describe('linkEngine (phone side of linked devices)', () => {
  let key: Uint8Array;
  let web: LinkCipher;

  beforeEach(async () => {
    calls.length = 0; inbox = []; mockSecrets.clear(); mockSendText.mockClear();
    mockCreateGroup.mockClear(); mockAddMember.mockClear(); mockSetDescription.mockClear();
    stopLinkEngine();
    const st = useMessengerStore.getState();
    st.reset();
    st.setOwner('owner-1', 'me-1');
    st.upsertConversation({
      id: `direct:${PEER}`, type: 'direct', name: 'Bobby', participants: [PEER], peer: {userId: PEER, deviceId: 1},
      session_state: 'established', unread_count: 2, is_muted: false, created_at: new Date(1_760_000_000_000).toISOString(),
    } as LocalConversation);
    st.appendMessage(`direct:${PEER}`, msg('m1')); // inbound → unread 3
    key = newLinkKey();
    web = await linkCipher(LINK, key);
  });

  afterEach(() => stopLinkEngine());

  it('approves the scanned code and sends a sealed snapshot', async () => {
    const res = await approveLinkFromQr(encodeLinkQr(LINK, key));
    expect(res.label).toBe('Chrome on Mac');
    expect(calls.find(c => c.url.endsWith('/link/approve'))?.body).toEqual({linkId: LINK});
    await flushLinkBounded(2000);
    for (let i = 0; i < 5; i++) {await settle();}
    const frames = await sentFrames(web);
    const kinds = frames.map(f => f.t);
    expect(kinds).toEqual(expect.arrayContaining(['hello', 'contacts', 'convs', 'msgs']));
    const hello = frames.find(f => f.t === 'hello') as Extract<PhoneToWeb, {t: 'hello'}>;
    expect(hello.self.userId).toBe('me-1');
    const convs = frames.find(f => f.t === 'convs') as Extract<PhoneToWeb, {t: 'convs'}>;
    expect(convs.conversations[0]).toMatchObject({cid: `direct:${PEER}`, unread: 3, peer: {userId: PEER, name: 'Bobby'}});
    const contacts = frames.find(f => f.t === 'contacts') as Extract<PhoneToWeb, {t: 'contacts'}>;
    expect(contacts.contacts).toEqual(expect.arrayContaining([expect.objectContaining({userId: PEER, name: 'Bobby'})]));
    const m = frames.find(f => f.t === 'msgs') as Extract<PhoneToWeb, {t: 'msgs'}>;
    expect(m.rows).toEqual([expect.objectContaining({id: 'm1', dir: 'in', body: 'body m1', status: 'delivered'})]);
    // The key never leaves the phone except in the keychain.
    expect(JSON.stringify(calls)).not.toContain(Buffer.from(key).toString('base64').slice(0, 20));
    expect(mockSecrets.get('owner-1')).toContain(LINK);
  });

  it('forwards a new message and a status change', async () => {
    await approveLinkFromQr(encodeLinkQr(LINK, key));
    await flushLinkBounded(2000);
    calls.length = 0;
    useMessengerStore.getState().appendMessage(`direct:${PEER}`, msg('m2', {sender_id: 'self', status: 'sending'}));
    useMessengerStore.getState().updateMessageStatus(`direct:${PEER}`, 'm2', 'sent');
    await flushLinkBounded(2000);
    const frames = await sentFrames(web);
    const rows = frames.filter(f => f.t === 'msgs').flatMap(f => (f as Extract<PhoneToWeb, {t: 'msgs'}>).rows);
    expect(rows.find(r => r.id === 'm2')).toMatchObject({dir: 'out', body: 'body m2', status: 'sent'});
    expect(rows.some(r => r.id === 'm1')).toBe(false);
  });

  it('runs a browser send command through the runtime and answers it', async () => {
    await approveLinkFromQr(encodeLinkQr(LINK, key));
    await flushLinkBounded(2000);
    calls.length = 0;
    const cmd = await web.seal('w2p', {t: 'send', id: 'c1', ts: 1, ref: 'ref-1', peerUserId: PEER, text: 'from browser'});
    inbox = [{seq: 7, data: cmd}];
    await drainLinkInboxes();
    expect(mockSendText).toHaveBeenCalledWith(`direct:${PEER}`, 'from browser', expect.objectContaining({stableMsgId: 'ref-1', peer: {userId: PEER, deviceId: 1}}));
    expect(calls.find(c => c.url.endsWith('/ack'))?.body).toEqual({side: 'phone', upTo: 7});
    const frames = await sentFrames(web);
    expect(frames.find(f => f.t === 'sent')).toMatchObject({ref: 'ref-1', ok: true});
    // A replayed command is not sent twice.
    inbox = [{seq: 8, data: cmd}];
    await drainLinkInboxes();
    expect(mockSendText).toHaveBeenCalledTimes(1);
  });

  it('a snapshot still sealing when the engine stops is never sent (no leak into the next session)', async () => {
    // Pre-push 2026-10-17: on a loaded machine the background snapshot of
    // one test landed in the next test's calls, sealed with the old key.
    await approveLinkFromQr(encodeLinkQr(LINK, key));
    stopLinkEngine();
    await flushLinkBounded(2000);
    expect(calls.filter(c => c.url.endsWith(`/link/${LINK}/send`))).toHaveLength(0);
  });

  it('ignores items not sealed with the link key', async () => {
    await approveLinkFromQr(encodeLinkQr(LINK, key));
    const forged = await (await linkCipher(LINK, newLinkKey())).seal('w2p', {t: 'send', id: 'x', ts: 1, ref: 'r', peerUserId: PEER, text: 'evil'});
    inbox = [{seq: 3, data: forged}];
    await drainLinkInboxes();
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('unlink tells the browser, deletes the link and forgets the key', async () => {
    startLinkEngine();
    await approveLinkFromQr(encodeLinkQr(LINK, key));
    await flushLinkBounded(2000);
    calls.length = 0;
    await unlinkDevice(LINK);
    const frames = await sentFrames(web);
    expect(frames.map(f => f.t)).toContain('bye');
    expect(calls.some(c => c.method === 'DELETE' && c.url.endsWith(`/link/${LINK}`))).toBe(true);
    expect(mockSecrets.has('owner-1')).toBe(false);
  });

  describe('groups and contacts (2026-10-23)', () => {
    const GROUP = 'g-1';
    const groupState = (admin: boolean, extra: Record<string, unknown> = {}) => ({
      groupId: GROUP, name: 'Ops Team', owner: admin ? 'me-1' : PEER,
      members: {'me-1': {deviceId: 1, admin, joinedAt: 1}, [PEER]: {deviceId: 1, admin: !admin, joinedAt: 1}},
      masterKeyB64: 'k', epoch: 1, createdAt: 1, updatedAt: 1, saltB64: 'salt', description: 'Night shift', ...extra,
    });
    function addGroup(admin = true, extra: Record<string, unknown> = {}) {
      const st = useMessengerStore.getState();
      st.upsertConversation({
        id: GROUP, type: 'group', name: 'Ops Team', participants: ['me-1', PEER], peer: {userId: GROUP, deviceId: 1},
        session_state: 'established', unread_count: 1, is_muted: false, created_at: new Date(1_760_000_000_000).toISOString(),
      } as LocalConversation);
      st.setGroupState(groupState(admin, extra) as never);
      st.appendMessage(GROUP, msg('g1', {conversation_id: GROUP, sender_id: PEER} as Partial<LocalMessage>));
    }
    async function command(c: Record<string, unknown>, seq: number) {
      inbox = [{seq, data: await web.seal('w2p', {id: `c${seq}`, ts: 1, ...c} as never)}];
      await drainLinkInboxes();
      await flushLinkBounded(2000);
    }

    it('the snapshot carries the groups, their members and description, and group messages with their sender', async () => {
      addGroup();
      await approveLinkFromQr(encodeLinkQr(LINK, key));
      await flushLinkBounded(2000);
      for (let i = 0; i < 5; i++) {await settle();}
      const frames = await sentFrames(web);
      const hello = frames.find(f => f.t === 'hello') as Extract<PhoneToWeb, {t: 'hello'}>;
      expect(hello.features).toEqual(expect.arrayContaining(['groups', 'contacts.manual', 'groups.manage', 'groups.invite']));
      const g = frames.find(f => f.t === 'groups') as Extract<PhoneToWeb, {t: 'groups'}>;
      expect(g.groups).toEqual([expect.objectContaining({
        cid: `group:${GROUP}`, name: 'Ops Team', description: 'Night shift', admin: true, manageable: true,
      })]);
      expect(g.groups[0].members).toEqual(expect.arrayContaining([
        expect.objectContaining({userId: PEER, name: 'Bobby', admin: false}),
        expect.objectContaining({userId: 'me-1', admin: true}),
      ]));
      const gm = frames.find(f => f.t === 'msgs' && f.cid === `group:${GROUP}`) as Extract<PhoneToWeb, {t: 'msgs'}>;
      expect(gm.rows).toEqual([expect.objectContaining({id: 'g1', dir: 'in', from: PEER})]);
    });

    it('a department channel is not mirrored', async () => {
      addGroup();
      useMessengerStore.setState(s => ({...s, deptConversationIds: {[GROUP]: true}}));
      await approveLinkFromQr(encodeLinkQr(LINK, key));
      await flushLinkBounded(2000);
      for (let i = 0; i < 5; i++) {await settle();}
      const frames = await sentFrames(web);
      expect((frames.find(f => f.t === 'groups') as Extract<PhoneToWeb, {t: 'groups'}>).groups).toEqual([]);
      expect(frames.some(f => f.t === 'msgs' && f.cid === `group:${GROUP}`)).toBe(false);
    });

    it('sends to a group, creates a group and answers each command', async () => {
      addGroup();
      await approveLinkFromQr(encodeLinkQr(LINK, key));
      await flushLinkBounded(2000);
      calls.length = 0;
      await command({t: 'send', ref: 'r-g', peerUserId: '', cid: `group:${GROUP}`, text: 'hello team'}, 11);
      expect(mockSendText).toHaveBeenCalledWith(GROUP, 'hello team', expect.objectContaining({isGroup: true, stableMsgId: 'r-g'}));
      await command({t: 'groupCreate', ref: 'r-c', name: 'Night crew', members: [PEER], description: 'Gate 3'}, 12);
      expect(mockCreateGroup).toHaveBeenCalledWith({name: 'Night crew', members: [PEER]});
      expect(mockSetDescription).toHaveBeenCalledWith({groupId: 'g-new', description: 'Gate 3'});
      const frames = await sentFrames(web);
      expect(frames.find(f => f.t === 'sent')).toMatchObject({ref: 'r-g', ok: true});
      expect(frames.find(f => f.t === 'result' && f.ref === 'r-c')).toMatchObject({ok: true, cid: 'group:g-new'});
    });

    it('refuses member changes when this account is not an admin, without calling the runtime', async () => {
      addGroup(false);
      await approveLinkFromQr(encodeLinkQr(LINK, key));
      await flushLinkBounded(2000);
      calls.length = 0;
      await command({t: 'groupAdd', ref: 'r-a', cid: `group:${GROUP}`, userIds: ['peer-9']}, 21);
      expect(mockAddMember).not.toHaveBeenCalled();
      const frames = await sentFrames(web);
      expect(frames.find(f => f.t === 'result')).toMatchObject({ref: 'r-a', ok: false, error: 'Only a group admin can do that.'});
    });

    it('refuses member changes in a mission room (crew set by dispatch)', async () => {
      addGroup(true, {saltB64: undefined});
      await approveLinkFromQr(encodeLinkQr(LINK, key));
      await flushLinkBounded(2000);
      calls.length = 0;
      await command({t: 'groupAdd', ref: 'r-m', cid: `group:${GROUP}`, userIds: ['peer-9']}, 31);
      expect(mockAddMember).not.toHaveBeenCalled();
      const frames = await sentFrames(web);
      expect(frames.find(f => f.t === 'result')).toMatchObject({ref: 'r-m', ok: false, error: 'Members of this group are managed by dispatch.'});
    });

    it('saves a contact added in the browser on the phone (sealed, never on the server) and sends it back', async () => {
      await approveLinkFromQr(encodeLinkQr(LINK, key));
      await flushLinkBounded(2000);
      calls.length = 0;
      await command({t: 'contactSave', ref: 'r-s', name: 'Hana', phone: '+971 50 000 0009'}, 41);
      const stored = JSON.parse(mockSecrets.get('contacts:owner-1') ?? '[]');
      expect(stored).toEqual([expect.objectContaining({name: 'Hana', phoneE164: '+971500000009'})]);
      const frames = await sentFrames(web);
      expect(frames.find(f => f.t === 'result')).toMatchObject({ref: 'r-s', ok: true});
      const contacts = frames.filter(f => f.t === 'contacts').pop() as Extract<PhoneToWeb, {t: 'contacts'}>;
      expect(contacts.contacts).toEqual(expect.arrayContaining([expect.objectContaining({name: 'Hana', source: 'manual'})]));
      // The name only ever travelled sealed.
      expect(JSON.stringify(calls.filter(c => c.url.includes('/link/')))).not.toContain('Hana');
    });
  });
});
