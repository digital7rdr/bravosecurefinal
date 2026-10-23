/**
 * Contacts added by hand (2026-10-23): kept per account in the keystore
 * document only, validated, de-duplicated by number, looked up on Bravo, and
 * forgotten from memory on sign-out.
 */
jest.mock('@utils/constants', () => ({__esModule: true, DIAL_CODES: [{dial: '+971'}, {dial: '+44'}, {dial: '+1'}]}));
const mockDocs = new Map<string, string>();
jest.mock('../runtime/keychain', () => ({
  __esModule: true,
  saveSecureDoc: async (d: string, u: string, j: string) => { mockDocs.set(`${d}:${u}`, j); },
  loadSecureDoc: async (d: string, u: string) => mockDocs.get(`${d}:${u}`) ?? null,
}));

import {
  loadManualContacts, manualContacts, upsertManualContact, removeManualContact, refreshManualContacts,
  resetManualContacts, ContactInputError,
} from '../contacts/manualContacts';

const lookup = jest.fn(async (phones: string[]) => phones.filter(p => p.endsWith('9')).map(p => ({userId: `u${p.slice(-4)}`, phone: p})));

beforeEach(async () => { mockDocs.clear(); lookup.mockClear(); resetManualContacts(); await loadManualContacts('owner-a'); });

it('saves a contact with its Bravo account, local numbers in the own country', async () => {
  const c = await upsertManualContact({name: '  Hana   K ', phone: '050 000 0009'}, {ownPhoneE164: '+971501112222', lookup});
  expect(c).toMatchObject({name: 'Hana K', phoneE164: '+971500000009', userId: 'u0009'});
  expect(JSON.parse(mockDocs.get('contacts:owner-a')!)).toEqual([expect.objectContaining({name: 'Hana K'})]);
});

it('keeps a number that is not on Bravo yet and links it on refresh', async () => {
  const c = await upsertManualContact({name: 'Sam', phone: '+44 7700 900120'}, {lookup});
  expect(c.userId).toBeNull();
  lookup.mockImplementationOnce(async (phones: string[]) => phones.map(p => ({userId: 'u-sam', phone: p})));
  await refreshManualContacts(lookup);
  expect(manualContacts()[0].userId).toBe('u-sam');
});

it('one entry per number: saving the same number renames it', async () => {
  await upsertManualContact({name: 'A', phone: '+971500000009'}, {lookup});
  await upsertManualContact({name: 'B', phone: '+971 50 000 0009'}, {lookup});
  expect(manualContacts().map(c => c.name)).toEqual(['B']);
});

it('refuses an empty name, a bad number and the own number', async () => {
  await expect(upsertManualContact({name: '', phone: '+971500000009'})).rejects.toBeInstanceOf(ContactInputError);
  await expect(upsertManualContact({name: 'X', phone: 'abc'})).rejects.toBeInstanceOf(ContactInputError);
  await expect(upsertManualContact({name: 'X', phone: '+971501112222'}, {ownPhoneE164: '+971501112222'})).rejects.toThrow(/own number/);
});

it('removes by id or account; each account has its own list', async () => {
  const c = await upsertManualContact({name: 'Hana', phone: '+971500000009'}, {lookup});
  expect(await removeManualContact(c.userId!)).toBe(true);
  expect(manualContacts()).toEqual([]);
  await upsertManualContact({name: 'Only A', phone: '+971500000009'}, {lookup});
  resetManualContacts();
  expect(manualContacts()).toEqual([]);
  await loadManualContacts('owner-b');
  expect(manualContacts()).toEqual([]);
  await loadManualContacts('owner-a');
  expect(manualContacts().map(x => x.name)).toEqual(['Only A']);
});
