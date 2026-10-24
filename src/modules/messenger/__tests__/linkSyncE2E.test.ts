/**
 * Phone ↔ browser sync, both halves together (2026-10-24).
 *
 * Owner: "are they both synced — I should be able to create a user or group,
 * vice versa, on the app and the web app". This runs the REAL phone link
 * engine and the REAL browser LinkedRuntime against one in-memory relay (the
 * messenger-service link inbox: ciphertext items per side) and checks every
 * direction: a group or contact made on the phone reaches the browser, one
 * made in the browser is made by the phone and comes back, edits and removals
 * travel both ways, group messages flow both ways with their sender, and a
 * contact saved in the phone's address book after linking reaches the browser.
 */

// ── phone-side mocks (as linkEngine.test) ──────────────────────────────────
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {__esModule: true, default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => { store.set(k, v); },
    removeItem: async (k: string) => { store.delete(k); },
  }};
});
jest.mock('react-native', () => ({Platform: {OS: 'android'}, AppState: {currentState: 'active', addEventListener: jest.fn(() => ({remove: jest.fn()}))}}));
jest.mock('@utils/constants', () => ({__esModule: true, MSG_BASE_URL: 'https://relay.test', API_BASE_URL: 'https://auth.test', DIAL_CODES: [{dial: '+971'}, {dial: '+44'}]}));

const mockSecrets = new Map<string, string>();
jest.mock('../runtime/keychain', () => ({
  __esModule: true,
  saveLinkSecrets: async (u: string, j: string) => { mockSecrets.set(u, j); },
  loadLinkSecrets: async (u: string) => mockSecrets.get(u) ?? null,
  clearLinkSecrets: async (u: string) => { mockSecrets.delete(u); },
  saveSecureDoc: async (d: string, u: string, j: string) => { mockSecrets.set(`${d}:${u}`, j); },
  loadSecureDoc: async (d: string, u: string) => mockSecrets.get(`${d}:${u}`) ?? null,
}));

// The phone's runtime: group create / member add really change the store, as
// productionRuntime does, so the mirror has something real to forward.
const mockSendText = jest.fn(async () => undefined);
const mockRuntime = {
  sendText: mockSendText, markRead: jest.fn(), loadOlderMessages: jest.fn(),
  createGroupChat: jest.fn(async ({name, members}: {name: string; members: string[]}) => {
    const id = `g-${name.toLowerCase().replace(/\W+/g, '-')}`;
    mockAddGroup(id, name, members, true);
    return {conversationId: id, groupId: id};
  }),
  addGroupMember: jest.fn(async ({groupId, newMember}: {groupId: string; newMember: {userId: string}}) => {
    const {useMessengerStore: s} = require('../store/messengerStore');
    const g = s.getState().groups[groupId];
    s.getState().setGroupState({...g, members: {...g.members, [newMember.userId]: {deviceId: 1, admin: false, joinedAt: 2}}, epoch: g.epoch + 2});
    return {newEpoch: g.epoch + 2};
  }),
  removeGroupMember: jest.fn(), leaveGroup: jest.fn(),
  renameGroup: jest.fn(async ({groupId, name}: {groupId: string; name: string}) => {
    const {useMessengerStore: s} = require('../store/messengerStore');
    const st = s.getState();
    st.setGroupState({...st.groups[groupId], name, epoch: st.groups[groupId].epoch + 1});
    st.upsertConversation({...st.conversations[groupId], name});
    return {newEpoch: 0};
  }),
  setGroupDescription: jest.fn(async ({groupId, description}: {groupId: string; description: string}) => {
    const {useMessengerStore: s} = require('../store/messengerStore');
    const st = s.getState();
    st.setGroupState({...st.groups[groupId], description, epoch: st.groups[groupId].epoch + 1});
    return {newEpoch: 0};
  }),
};
function mockAddGroup(id: string, name: string, members: string[], selfAdmin: boolean) {
  const {useMessengerStore: s} = require('../store/messengerStore');
  const st = s.getState();
  st.upsertConversation({
    id, type: 'group', name, participants: ['me-1', ...members], peer: {userId: id, deviceId: 1},
    session_state: 'established', unread_count: 0, is_muted: false, created_at: new Date().toISOString(),
  });
  const m: Record<string, {deviceId: number; admin: boolean; joinedAt: number}> = {'me-1': {deviceId: 1, admin: selfAdmin, joinedAt: 1}};
  for (const u of members) {m[u] = {deviceId: 1, admin: false, joinedAt: 1};}
  st.setGroupState({groupId: id, name, owner: 'me-1', members: m, masterKeyB64: 'k', epoch: 1, createdAt: 1, updatedAt: 1, saltB64: 'salt'});
}
jest.mock('../runtime/runtime', () => ({
  __esModule: true,
  getActiveOwnerKey: () => 'owner-1',
  getMessengerRuntime: async () => mockRuntime,
}));
jest.mock('../runtime/transportRegistry', () => ({__esModule: true, onTransport: () => () => undefined}));
jest.mock('../contacts/directoryNames', () => ({__esModule: true, ensureDirectoryNames: jest.fn(), getDirectoryUsersClient: () => ({
  lookup: async (phones: string[]) => phones.filter(p => p === '+971500000009').map(p => ({userId: 'peer-9', phone: p, displayName: 'Hana'})),
})}));
// The phone's address book (mutable: "saved a contact in the phone's Contacts app").
const mockAddressBook: Array<{userId: string; displayName: string; localName: string; phoneE164: string; avatarUrl: null}> = [];
const mockDiscoveryListeners = new Set<() => void>();
jest.mock('../contacts/useDiscoveredContacts', () => ({
  __esModule: true,
  latestDiscoveredContacts: () => [...mockAddressBook],
  discoverContactsPassive: async () => [...mockAddressBook],
  onDiscoveredContactsChange: (fn: () => void) => { mockDiscoveryListeners.add(fn); return () => mockDiscoveryListeners.delete(fn); },
}));
jest.mock('@store/authStore', () => ({__esModule: true, useAuthStore: {getState: () => ({user: {full_name: 'Me', phone_e164: '+971501110000'}})}}));

// ── the relay: one inbox per side, ciphertext only ─────────────────────────
const mockRelay = {phone: [] as Array<{seq: number; data: string}>, web: [] as Array<{seq: number; data: string}>, seq: 0, wire: [] as string[]};
jest.mock('@/services/api', () => ({
  __esModule: true,
  fetchWithRefresh: async (url: string, init: {method?: string; body?: string}) => {
    const json = (v: unknown, status = 200) => ({ok: status < 300, status, json: async () => v});
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (url.endsWith('/link/approve')) {return json({linkId: 'LLLLLLLLLLLLLLLLLLLLLL', label: 'Chrome on Mac', approvedAt: 1, role: 'phone'});}
    if (url.includes('/inbox')) {
      const after = Number(new URL(url).searchParams.get('after') ?? 0);
      return json({items: mockRelay.phone.filter(i => i.seq > after), more: false});
    }
    if (url.endsWith('/send')) {
      for (const data of body.items as string[]) {mockRelay.web.push({seq: ++mockRelay.seq, data}); mockRelay.wire.push(data);}
      return json({seq: mockRelay.seq});
    }
    if (url.endsWith('/link/mine')) {return json({links: []});}
    return {ok: true, status: 204, json: async () => ({})};
  },
}));

// ── browser-side mocks (the console's modules, loaded from apps/ops-console) ──
jest.mock('../../../../apps/ops-console/src/lib/messenger/linkClient', () => ({
  __esModule: true,
  messengerBase: () => 'https://relay.test',
  browserLabel: () => 'Chrome on Mac',
  LinkHttpError: class extends Error {},
  linkApi: {
    inbox: async (_l: string, _d: number, after: number) => ({items: mockRelay.web.filter(i => i.seq > after), more: false}),
    ack: async () => undefined,
    send: async (_l: string, _d: number, items: string[]) => {
      for (const data of items) {mockRelay.phone.push({seq: ++mockRelay.seq, data}); mockRelay.wire.push(data);}
      return {seq: mockRelay.seq};
    },
    revoke: async () => undefined,
  },
}));
jest.mock('@/lib/api', () => ({__esModule: true, getMessengerTicket: async () => 't'}), {virtual: true});
jest.mock('socket.io-client', () => ({__esModule: true, io: () => ({on: () => undefined, disconnect: () => undefined})}));
jest.mock('../../../../apps/ops-console/src/lib/messenger/crypto', () => ({
  __esModule: true,
  wrapString: async (_k: unknown, s: string) => new TextEncoder().encode(s),
  unwrapString: async (_k: unknown, b: Uint8Array) => new TextDecoder().decode(b),
}));
jest.mock('../../../../apps/ops-console/src/lib/messenger/messageStore', () => {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    __esModule: true,
    MessageStore: class {
      async upsert(r: {conversationId: string; id: string}) { rows.set(`${r.conversationId}|${r.id}`, {...r}); }
      async patch(cid: string, id: string, p: object) { const k = `${cid}|${id}`; if (rows.has(k)) {rows.set(k, {...rows.get(k), ...p});} }
      async remove(cid: string, id: string) { rows.delete(`${cid}|${id}`); }
      async loadConversation(cid: string) { return [...rows.values()].filter(r => r.conversationId === cid); }
      async listSummaries() { return []; }
    },
  };
});

import {encodeLinkQr, newLinkKey, b64uEncode} from '@bravo/messenger-core/link/linkProtocol';
import {useMessengerStore} from '../store/messengerStore';
import type {LocalConversation, LocalMessage} from '../store/types';
import {approveLinkFromQr, drainLinkInboxes, flushLinkBounded, stopLinkEngine, refreshLinkedContacts} from '../link/linkEngine';
import {loadManualContacts, upsertManualContact, removeManualContact, manualContacts} from '../contacts/manualContacts';
import {LinkedRuntime} from '../../../../apps/ops-console/src/lib/messenger/linkedRuntime';

const LINK = 'LLLLLLLLLLLLLLLLLLLLLL';
const PEER = 'peer-2';
const settle = async () => { for (let i = 0; i < 6; i++) {await new Promise(r => setTimeout(r, 0));} };

function fakeDb() {
  const meta = new Map<string, unknown>();
  return {
    get: async (_s: string, k: string) => meta.get(k),
    put: async (_s: string, v: {key: string}) => { meta.set(v.key, v); },
    getKey: async () => undefined,
    transaction: () => ({objectStore: () => ({clear: async () => undefined, delete: async (k: string) => { meta.delete(k); }}), done: Promise.resolve()}),
    close: () => undefined,
  };
}

describe('phone ↔ browser stay in sync both ways', () => {
  let web: LinkedRuntime;

  /** Let both sides process everything queued (phone commands, then the mirror). */
  async function pump() {
    for (let i = 0; i < 3; i++) {
      await settle();
      await drainLinkInboxes();
      await flushLinkBounded(2000);
      await web.drain();
    }
  }

  beforeAll(async () => {
    stopLinkEngine();
    const st = useMessengerStore.getState();
    st.reset();
    st.setOwner('owner-1', 'me-1');
    st.upsertConversation({
      id: `direct:${PEER}`, type: 'direct', name: 'Bobby', participants: [PEER], peer: {userId: PEER, deviceId: 1},
      session_state: 'established', unread_count: 0, is_muted: false, created_at: new Date().toISOString(),
    } as LocalConversation);
    mockAddressBook.push({userId: PEER, displayName: 'Bob', localName: 'Bobby', phoneE164: '+971500000002', avatarUrl: null});
    mockAddGroup('g-existing', 'Existing team', [PEER], true);
    await loadManualContacts('owner-1');

    const key = newLinkKey();
    await approveLinkFromQr(encodeLinkQr(LINK, key));
    web = new LinkedRuntime('me-1', fakeDb() as never, {} as never, {linkId: LINK, key: b64uEncode(key), wsDeviceId: 101, label: 'Chrome', linkedAt: 1});
    await web.startListening();
    await pump();
  });

  afterAll(() => { stopLinkEngine(); web.close(); });

  it('after linking, the browser has the phone\'s groups and contacts', () => {
    expect(web.groups().map(g => g.name)).toEqual(['Existing team']);
    expect(web.contactList()).toEqual(expect.arrayContaining([expect.objectContaining({userId: PEER, name: 'Bobby'})]));
  });

  it('a group created on the phone appears in the browser', async () => {
    mockAddGroup('g-from-phone', 'Made on phone', [PEER], true);
    await pump();
    expect(web.groups().map(g => g.name)).toEqual(expect.arrayContaining(['Made on phone']));
  });

  it('a group created in the browser is created by the phone and comes back', async () => {
    const created = web.createGroup('Made on web', [PEER], 'From the browser');
    await pump();
    const cid = await created;
    expect(cid).toBe('group:g-made-on-web');
    expect(useMessengerStore.getState().conversations['g-made-on-web']?.name).toBe('Made on web');
    expect(useMessengerStore.getState().groups['g-made-on-web']?.description).toBe('From the browser');
    expect(web.group(cid)).toMatchObject({name: 'Made on web', description: 'From the browser', admin: true, manageable: true});
  });

  it('members and the name changed in the browser reach the phone, and back', async () => {
    const p = web.addGroupMembers('group:g-made-on-web', ['peer-9']);
    const q = web.editGroup('group:g-made-on-web', {name: 'Renamed on web'});
    await pump();
    await Promise.all([p, q]);
    expect(Object.keys(useMessengerStore.getState().groups['g-made-on-web'].members)).toEqual(expect.arrayContaining(['peer-9']));
    expect(web.group('group:g-made-on-web')?.name).toBe('Renamed on web');
    expect(web.group('group:g-made-on-web')?.members.map(m => m.userId)).toEqual(expect.arrayContaining(['peer-9']));
  });

  it('a contact added in the browser is saved on the phone; one added on the phone reaches the browser', async () => {
    const saved = web.saveContact('Hana', '+971 50 000 0009');
    await pump();
    expect(await saved).toBe('direct:peer-9');
    expect(manualContacts()).toEqual(expect.arrayContaining([expect.objectContaining({name: 'Hana', userId: 'peer-9'})]));

    await upsertManualContact({name: 'Sam Phone', phone: '+44 7700 900120'});
    await pump();
    expect(web.contactList()).toEqual(expect.arrayContaining([
      expect.objectContaining({name: 'Hana', source: 'manual'}),
      expect.objectContaining({name: 'Sam Phone', userId: '', source: 'manual'}),
    ]));
  });

  it('removals travel both ways', async () => {
    const sam = manualContacts().find(c => c.name === 'Sam Phone')!;
    const removed = web.removeContact(sam.id);
    await pump();
    await removed;
    expect(manualContacts().some(c => c.name === 'Sam Phone')).toBe(false);
    await removeManualContact('peer-9'); // Hana, on the phone
    await pump();
    expect(web.contactList().some(c => c.name === 'Hana' || c.name === 'Sam Phone')).toBe(false);
  });

  it('a contact saved in the phone\'s address book after linking reaches the browser', async () => {
    mockAddressBook.push({userId: 'peer-7', displayName: 'Mona', localName: 'Mona S', phoneE164: '+971500000007', avatarUrl: null});
    await refreshLinkedContacts(true); // the app came to the foreground
    await pump();
    expect(web.contactList()).toEqual(expect.arrayContaining([expect.objectContaining({userId: 'peer-7', name: 'Mona S'})]));
    // …and a sweep inside the app (Contacts tab) does the same.
    mockAddressBook.push({userId: 'peer-8', displayName: 'Ravi', localName: 'Ravi P', phoneE164: '+971500000008', avatarUrl: null});
    for (const fn of mockDiscoveryListeners) {fn();}
    await pump();
    expect(web.contactList()).toEqual(expect.arrayContaining([expect.objectContaining({userId: 'peer-8', name: 'Ravi P'})]));
  });

  it('group messages flow both ways with their sender', async () => {
    await web.sendGroup('group:g-existing', 'from the browser');
    await pump();
    expect(mockSendText).toHaveBeenCalledWith('g-existing', 'from the browser', expect.objectContaining({isGroup: true}));
    useMessengerStore.getState().appendMessage('g-existing', {
      id: 'in-1', conversation_id: 'g-existing', sender_id: PEER, type: 'text', content: 'from the phone side',
      status: 'delivered', is_encrypted: true, created_at: new Date().toISOString(), peer: {userId: PEER, deviceId: 1},
    } as LocalMessage);
    await pump();
    const rows = await web.loadConversation('group:g-existing');
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({body: 'from the phone side', senderUserId: PEER, direction: 'in'})]));
  });

  it('nothing readable crossed the relay', () => {
    const wire = mockRelay.wire.join('\n');
    for (const plain of ['Made on web', 'Hana', 'Sam Phone', 'from the browser', 'from the phone side', 'Mona S']) {
      expect([plain, wire.includes(plain)]).toEqual([plain, false]);
    }
  });
});
