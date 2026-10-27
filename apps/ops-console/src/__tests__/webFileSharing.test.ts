/**
 * 2026-10-27 (owner) — "The Web Messenger needs to have the function of
 * adding and sharing files in the chat."
 *
 * Pins: a linked browser uploads the file itself and asks the phone to send
 * it (the key travels only inside the sealed link command); a file row from
 * the phone keeps its attachment so the browser can open it; an old phone
 * app is refused politely; the composer has the 📎 button and bubbles show
 * a file card; the media host is allowed by the page's CSP.
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
const mockUpload = jest.fn();
jest.mock('../lib/messenger/mediaClient', () => {
  const actual = jest.requireActual('../lib/messenger/mediaClient');
  return {...actual, __esModule: true, uploadFile: (...a: unknown[]) => mockUpload(...a), downloadFile: jest.fn()};
});
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
  };
});

import {linkCipher, newLinkKey, b64uEncode, type LinkCipher, type WebToPhone, type PhoneToWeb} from '@bravo/messenger-core/link/linkProtocol';
import {LinkedRuntime} from '../lib/messenger/linkedRuntime';
import {kindForMime, safeMime} from '../lib/messenger/mediaClient';

const LINK = 'LLLLLLLLLLLLLLLLLLLLLL';
const SRC = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf8');
const ATT = {objectKey: 'att/abc', keyB64: 'k'.repeat(44), ivB64: 'i'.repeat(24), mimeType: 'application/pdf',
  size: 12, name: 'Report.pdf', kind: 'file' as const};

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

async function start(features: string[]) {
  mockSent.length = 0; mockInbox = []; mockUpload.mockReset();
  const key = newLinkKey();
  const phone = await linkCipher(LINK, key);
  const rt = new LinkedRuntime('me-1', fakeDb() as never, {} as never, {linkId: LINK, key: b64uEncode(key), wsDeviceId: 101, label: 'x', linkedAt: 1});
  await rt.startListening();
  await phoneSays(phone, {t: 'hello', self: {userId: 'me-1'}, features});
  await rt.drain();
  return {rt, phone};
}

describe('web file sharing — linked browser', () => {
  it('uploads in the browser, then asks the phone to send it (key only inside the sealed command)', async () => {
    const {rt, phone} = await start(['groups', 'files']);
    mockUpload.mockResolvedValue(ATT);
    const file = new File([new Uint8Array(12)], 'Report.pdf', {type: 'application/pdf'});
    await rt.sendFile('direct:u2', file);
    expect(mockUpload).toHaveBeenCalledWith(file, 101);
    const cmd = (await phone.open('w2p', mockSent[mockSent.length - 1])) as WebToPhone;
    expect(cmd).toMatchObject({t: 'send', peerUserId: 'u2', text: '', attachment: ATT});
    expect(mockSent[mockSent.length - 1]).not.toContain(ATT.keyB64);
    const rows = await rt.loadConversation('direct:u2');
    expect(rows).toEqual([expect.objectContaining({body: '📎 Report.pdf', status: 'sending', attachment: ATT})]);
    rt.close();
  });

  it('a group file goes to the group', async () => {
    const {rt, phone} = await start(['groups', 'files']);
    mockUpload.mockResolvedValue(ATT);
    await rt.sendFile('group:g1', new File([new Uint8Array(3)], 'a.png', {type: 'image/png'}));
    const cmd = (await phone.open('w2p', mockSent[mockSent.length - 1])) as WebToPhone;
    expect(cmd).toMatchObject({t: 'send', cid: 'group:g1', peerUserId: '', attachment: ATT});
    rt.close();
  });

  it('an old phone app is refused before anything is uploaded', async () => {
    const {rt} = await start(['groups']);
    expect(rt.canSendFiles()).toBe(false);
    await expect(rt.sendFile('direct:u2', new File([new Uint8Array(1)], 'x.txt'))).rejects.toThrow('phone_app_too_old_for_files');
    expect(mockUpload).not.toHaveBeenCalled();
    rt.close();
  });

  it('a file row from the phone keeps its attachment; a malformed one is dropped', async () => {
    const {rt, phone} = await start(['files']);
    await phoneSays(phone, {t: 'msgs', cid: 'direct:u2', peerUserId: 'u2', rows: [
      {id: 'f1', dir: 'in', body: '📎 Report.pdf', at: 10, status: 'delivered', kind: 'file', att: ATT},
      {id: 'f2', dir: 'in', body: '📎 x', at: 11, status: 'delivered', kind: 'file', att: {objectKey: 1}},
    ]});
    await rt.drain();
    const rows = await rt.loadConversation('direct:u2');
    expect(rows.find(r => r.id === 'f1')?.attachment).toEqual(ATT);
    expect(rows.find(r => r.id === 'f2')?.attachment).toBeNull();
    rt.close();
  });
});

describe('web file sharing — helpers and wiring', () => {
  it('maps MIME types the way the app renders them, and never signs an invalid type', () => {
    expect(kindForMime('image/jpeg')).toBe('image');
    expect(kindForMime('application/pdf')).toBe('file');
    expect(safeMime('')).toBe('application/octet-stream');
    expect(safeMime('text/plain; charset=utf-8')).toBe('application/octet-stream');
    expect(safeMime('application/pdf')).toBe('application/pdf');
  });

  it('both chat views have the attach button and render file cards', () => {
    for (const f of ['features/messenger/ChatWorkspace.tsx', 'features/messenger/LinkedGroups.tsx']) {
      const src = read(f);
      expect(src).toMatch(/<AttachButton onPick=/);
      expect(src).toMatch(/<FileCard att=\{m\.attachment\}/);
      // A failed file is never re-sent as text.
      expect(src).toMatch(/isFileRow\(m\)/);
    }
  });

  it('the page CSP allows the media host the presigned URLs point at', () => {
    const mw = read('middleware.ts');
    expect(mw).toMatch(/NEXT_PUBLIC_MEDIA_BASE_URL/);
    expect(mw).toMatch(/connect-src[^`]*MEDIA_ORIGIN/);
  });
});
