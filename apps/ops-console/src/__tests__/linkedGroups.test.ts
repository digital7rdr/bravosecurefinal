/**
 * Groups and contacts in a browser linked to the phone (2026-10-23).
 *
 * Pins the browser half of the phone link: group lists and group messages
 * (with their sender) from the phone are kept; sending to a group, creating a
 * group and saving a contact go to the phone as sealed commands and resolve
 * with the phone's answer; a refusal surfaces the phone's sentence; contacts
 * added by hand (even not on Bravo yet) are listed. Plus the UI wiring: the
 * Groups tab, linking from the lock card, and the mission panel in linked mode.
 */
import fs from 'fs';
import path from 'path';

const mockSent: string[] = [];
let mockInbox: Array<{seq: number; data: string}> = [];
jest.mock('../lib/messenger/linkClient', () => ({
  __esModule: true,
  messengerBase: () => 'http://relay.test',
  browserLabel: () => 'Chrome on Mac',
  LinkHttpError: class extends Error {},
  linkApi: {
    inbox: async () => { const items = mockInbox; mockInbox = []; return {items, more: false}; },
    ack: async () => undefined,
    send: async (_l: string, _d: number, items: string[]) => { mockSent.push(...items); return {seq: 1}; },
    revoke: async () => undefined,
  },
}));
jest.mock('../lib/api', () => ({__esModule: true, getMessengerTicket: async () => 't'}));
jest.mock('socket.io-client', () => ({__esModule: true, io: () => ({on: () => undefined, disconnect: () => undefined})}));
jest.mock('../lib/messenger/crypto', () => ({
  __esModule: true,
  wrapString: async (_k: unknown, s: string) => new TextEncoder().encode(s),
  unwrapString: async (_k: unknown, b: Uint8Array) => new TextDecoder().decode(b),
}));
jest.mock('../lib/messenger/messageStore', () => {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    __esModule: true,
    MessageStore: class {
      async upsert(r: {conversationId: string; id: string}) { rows.set(`${r.conversationId}|${r.id}`, {...r}); }
      async patch(cid: string, id: string, p: object) { const k = `${cid}|${id}`; if (rows.has(k)) rows.set(k, {...rows.get(k), ...p}); }
      async remove(cid: string, id: string) { rows.delete(`${cid}|${id}`); }
      async loadConversation(cid: string) { return [...rows.values()].filter(r => r.conversationId === cid); }
      async listSummaries() { return []; }
    },
    __rows: rows,
  };
});

import {linkCipher, newLinkKey, b64uEncode, type LinkCipher, type WebToPhone, type PhoneToWeb} from '@bravo/messenger-core/link/linkProtocol';
import {LinkedRuntime, LinkCommandError} from '../lib/messenger/linkedRuntime';

const LINK = 'LLLLLLLLLLLLLLLLLLLLLL';
const SRC = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf8');

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

let seq = 0;
async function phoneSays(phone: LinkCipher, m: Record<string, unknown>) {
  mockInbox.push({seq: ++seq, data: await phone.seal('p2w', {id: `p${seq}`, ts: 1, ...m} as PhoneToWeb)});
}
async function lastCommand(phone: LinkCipher): Promise<WebToPhone> {
  return (await phone.open('w2p', mockSent[mockSent.length - 1])) as WebToPhone;
}

describe('LinkedRuntime — groups and contacts from the phone', () => {
  let rt: LinkedRuntime;
  let phone: LinkCipher;

  beforeEach(async () => {
    mockSent.length = 0; mockInbox = [];
    const key = newLinkKey();
    phone = await linkCipher(LINK, key);
    rt = new LinkedRuntime('me-1', fakeDb() as never, {} as never, {linkId: LINK, key: b64uEncode(key), wsDeviceId: 101, label: 'x', linkedAt: 1});
    await rt.startListening();
    await phoneSays(phone, {t: 'hello', self: {userId: 'me-1'}, features: ['groups', 'contacts.manual', 'groups.manage', 'groups.invite']});
    await phoneSays(phone, {t: 'groups', full: true, groups: [{
      cid: 'group:g1', name: 'Ops Team', description: 'Night shift', admin: true, manageable: true, unread: 0, lastAt: 5,
      members: [{userId: 'me-1', admin: true}, {userId: 'u2', name: 'Bob', phone: '+971500000002', admin: false}],
    }]});
    await phoneSays(phone, {t: 'msgs', cid: 'group:g1', peerUserId: '', rows: [{id: 'm1', dir: 'in', body: 'hi team', at: 10, status: 'delivered', from: 'u2'}]});
    await phoneSays(phone, {t: 'contacts', contacts: [
      {userId: 'u2', name: 'Bob', phone: '+971500000002', source: 'phone'},
      {userId: '', name: 'Sam', phone: '+447700900120', source: 'manual', contactId: 'c9'},
    ]});
    await rt.drain();
  });

  afterEach(() => rt.close());

  it('keeps the phone\'s groups, members, features and group messages with their sender', async () => {
    expect(rt.hasFeature('groups')).toBe(true);
    expect(rt.groups().map(g => [g.cid, g.name, g.description])).toEqual([['group:g1', 'Ops Team', 'Night shift']]);
    expect(rt.peer('u2')?.name).toBe('Bob');
    const rows = await rt.loadConversation('group:g1');
    expect(rows).toEqual([expect.objectContaining({id: 'm1', senderUserId: 'u2', direction: 'in', body: 'hi team'})]);
    expect(rt.contactList()).toEqual(expect.arrayContaining([expect.objectContaining({name: 'Sam', userId: '', source: 'manual'})]));
  });

  it('sends to a group through the phone, sealed', async () => {
    await rt.sendGroup('group:g1', 'on my way');
    const cmd = await lastCommand(phone);
    expect(cmd).toMatchObject({t: 'send', cid: 'group:g1', peerUserId: '', text: 'on my way'});
    expect(mockSent[mockSent.length - 1]).not.toContain('on my way');
    expect((await rt.loadConversation('group:g1')).some(r => r.body === 'on my way' && r.status === 'sending')).toBe(true);
  });

  it('a group command resolves with the phone\'s answer', async () => {
    const p = rt.createGroup('Night crew', ['u2'], 'Gate 3');
    await new Promise(r => setTimeout(r, 0));
    const cmd = await lastCommand(phone) as Extract<WebToPhone, {t: 'groupCreate'}>;
    expect(cmd).toMatchObject({t: 'groupCreate', name: 'Night crew', members: ['u2'], description: 'Gate 3'});
    await phoneSays(phone, {t: 'result', ref: cmd.ref, ok: true, cid: 'group:g-new'});
    await rt.drain();
    await expect(p).resolves.toBe('group:g-new');
  });

  it('a refusal carries the phone\'s sentence', async () => {
    const p = rt.addGroupMembers('group:g1', ['u3']);
    await new Promise(r => setTimeout(r, 0));
    const cmd = await lastCommand(phone) as Extract<WebToPhone, {t: 'groupAdd'}>;
    await phoneSays(phone, {t: 'result', ref: cmd.ref, ok: false, error: 'Only a group admin can do that.'});
    await rt.drain();
    await expect(p).rejects.toEqual(new LinkCommandError('Only a group admin can do that.'));
  });

  it('a contact is saved on the phone (the name only travels sealed)', async () => {
    const p = rt.saveContact('Hana', '+971500000009');
    await new Promise(r => setTimeout(r, 0));
    const cmd = await lastCommand(phone) as Extract<WebToPhone, {t: 'contactSave'}>;
    expect(cmd).toMatchObject({t: 'contactSave', name: 'Hana', phone: '+971500000009'});
    expect(mockSent.join('')).not.toContain('Hana');
    await phoneSays(phone, {t: 'result', ref: cmd.ref, ok: true, cid: 'direct:u9'});
    await rt.drain();
    await expect(p).resolves.toBe('direct:u9');
  });
});

describe('the browser messenger UI (2026-10-23)', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('has Chats, Contacts and Groups tabs; groups open in the group thread', () => {
    const ws = strip(read('features/messenger/ChatWorkspace.tsx'));
    expect(ws).toMatch(/export type ChatTab = 'chats' \| 'contacts' \| 'groups'/);
    expect(ws).toMatch(/<GroupsList linked=\{linked\}/);
    expect(ws).toMatch(/<GroupThread key=\{active\} linked=\{linked\}/);
    expect(ws).toMatch(/<AddContactDialog/);
  });

  it('every console can link the browser to the phone and unlink it', () => {
    const ws = strip(read('features/messenger/ChatWorkspace.tsx'));
    expect(ws).toMatch(/messenger\.canLink/);
    expect(ws).toMatch(/messenger\.linkInstead\(\)/);
    expect(ws).toMatch(/unlinkBrowser\(\)/);
    const prov = strip(read('components/messenger/MessengerProvider.tsx'));
    expect(prov).toMatch(/linkInstead = useCallback/);
    expect(prov).toMatch(/createDeviceVault\(userId\)/);
  });

  it('the mission group panel reads and sends through the phone in linked mode', () => {
    const p = strip(read('components/messenger/MissionGroupPanel.tsx'));
    expect(p).toMatch(/groupCid\(conversationId\)/);
    expect(p).toMatch(/linked\.sendGroup\(threadId, body\)/);
    expect(p).not.toMatch(/Mission group chat is in the Bravo app/);
  });
});
