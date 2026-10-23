/**
 * Contacts added by hand in Messenger (2026-10-23).
 *
 * Owner: "keep chats and contacts — individual contacts that can be synced
 * from the phone or added manually". Phone-book contacts come from the
 * address book (useDiscoveredContacts); these are the ones typed in on the
 * Contacts tab (or from a linked browser): a name and a number.
 *
 * Signal-style: they live on THIS phone only — the server never stores a
 * contact name. The list is a keystore-protected document per account (same
 * protection as the link keys), wiped on sign-out with the rest of the
 * messenger. A linked browser receives them through the sealed phone link.
 *
 * A number that is not on Bravo yet can still be saved; it shows as "not on
 * Bravo yet" and is looked up again on every refresh.
 */
import {loadSecureDoc, saveSecureDoc} from '../runtime/keychain';
import {normalizeToE164, callingCodeFromOwnPhone} from './phoneNormalize';

export interface ManualContact {
  /** Stable local id. */
  id:        string;
  name:      string;
  phoneE164: string;
  /** Bravo account behind the number, null while it is not on Bravo. */
  userId:    string | null;
  addedAt:   number;
  updatedAt: number;
}

export const MANUAL_CONTACTS_MAX = 2000;
export const CONTACT_NAME_MAX = 80;

type Lookup = (phones: string[]) => Promise<Array<{userId: string; phone: string}>>;

let owner: string | null = null;
let rows: ManualContact[] = [];
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of [...listeners]) {try { fn(); } catch { /* ignore */ }}
}

function genId(): string {
  const b = new Uint8Array(12);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

export function cleanContactName(raw: string): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, CONTACT_NAME_MAX);
}

/** "+971 50 123 4567", "00971…" or a local number in the user's own country. */
export function toContactE164(raw: string, ownPhoneE164?: string | null): string | null {
  const t = String(raw ?? '').trim();
  if (!t) {return null;}
  return normalizeToE164(t, callingCodeFromOwnPhone(ownPhoneE164 ?? null));
}

function sanitize(list: unknown): ManualContact[] {
  if (!Array.isArray(list)) {return [];}
  const out: ManualContact[] = [];
  for (const r of list as Array<Partial<ManualContact>>) {
    if (!r || typeof r.id !== 'string' || typeof r.phoneE164 !== 'string' || typeof r.name !== 'string') {continue;}
    out.push({
      id: r.id, name: r.name, phoneE164: r.phoneE164,
      userId: typeof r.userId === 'string' && r.userId ? r.userId : null,
      addedAt: Number(r.addedAt) || 0, updatedAt: Number(r.updatedAt) || 0,
    });
  }
  return out;
}

/** Load the list for this account (idempotent per owner). */
export async function loadManualContacts(ownerKey: string | null): Promise<ManualContact[]> {
  if (!ownerKey) {owner = null; rows = []; return rows;}
  if (owner === ownerKey && !loading) {return rows;}
  if (loading && owner === ownerKey) {await loading; return rows;}
  owner = ownerKey;
  rows = [];
  loading = (async () => {
    try {
      const raw = await loadSecureDoc('contacts', ownerKey);
      if (owner === ownerKey) {rows = sanitize(raw ? JSON.parse(raw) : []);}
    } catch (e) {
      console.warn('[contacts] manual list unreadable:', (e as Error).message);
    } finally {
      loading = null;
    }
  })();
  await loading;
  emit();
  return rows;
}

async function persist(): Promise<void> {
  if (!owner) {throw new Error('not_signed_in');}
  await saveSecureDoc('contacts', owner, JSON.stringify(rows));
  emit();
}

export function manualContacts(): ManualContact[] {
  return rows;
}

export function onManualContactsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export class ContactInputError extends Error {}

/**
 * Add a contact, or rename the one already saved under that number. Looks the
 * number up on Bravo (a failed lookup still saves it, as "not on Bravo yet").
 */
export async function upsertManualContact(
  input: {name: string; phone: string},
  opts: {ownPhoneE164?: string | null; lookup?: Lookup | null} = {},
): Promise<ManualContact> {
  const name = cleanContactName(input.name);
  const phoneE164 = toContactE164(input.phone, opts.ownPhoneE164);
  if (!name) {throw new ContactInputError('Enter a name.');}
  if (!phoneE164) {throw new ContactInputError('Enter the number with its country code, e.g. +971 50 123 4567.');}
  if (opts.ownPhoneE164 && phoneE164 === opts.ownPhoneE164) {throw new ContactInputError('That is your own number.');}
  let userId: string | null = null;
  if (opts.lookup) {
    try {
      const hit = (await opts.lookup([phoneE164])).find(m => m.phone === phoneE164);
      userId = hit?.userId ?? null;
    } catch { /* saved anyway; looked up again on refresh */ }
  }
  const now = Date.now();
  const prev = rows.find(r => r.phoneE164 === phoneE164);
  let saved: ManualContact;
  if (prev) {
    saved = {...prev, name, userId: userId ?? prev.userId, updatedAt: now};
    rows = rows.map(r => (r.id === prev.id ? saved : r));
  } else {
    if (rows.length >= MANUAL_CONTACTS_MAX) {throw new ContactInputError('Your contact list is full.');}
    saved = {id: genId(), name, phoneE164, userId, addedAt: now, updatedAt: now};
    rows = [...rows, saved];
  }
  await persist();
  return saved;
}

export async function renameManualContact(id: string, name: string): Promise<void> {
  const clean = cleanContactName(name);
  if (!clean) {throw new ContactInputError('Enter a name.');}
  rows = rows.map(r => (r.id === id ? {...r, name: clean, updatedAt: Date.now()} : r));
  await persist();
}

export async function removeManualContact(idOrUserId: string): Promise<boolean> {
  const before = rows.length;
  rows = rows.filter(r => r.id !== idOrUserId && r.userId !== idOrUserId);
  if (rows.length === before) {return false;}
  await persist();
  return true;
}

/** Look every saved number up again (people join Bravo after being saved). */
export async function refreshManualContacts(lookup: Lookup | null): Promise<void> {
  if (!lookup || rows.length === 0) {return;}
  const phones = rows.map(r => r.phoneE164);
  const byPhone = new Map<string, string>();
  try {
    for (let i = 0; i < phones.length; i += 500) {
      for (const m of await lookup(phones.slice(i, i + 500))) {byPhone.set(m.phone, m.userId);}
    }
  } catch { return; }
  let changed = false;
  rows = rows.map(r => {
    const userId = byPhone.get(r.phoneE164) ?? null;
    if (userId === r.userId) {return r;}
    changed = true;
    return {...r, userId};
  });
  if (changed) {await persist();}
}

/** Sign-out: forget the in-memory copy (wipeAtRest clears the keystore). */
export function resetManualContacts(): void {
  owner = null; rows = []; loading = null;
  emit();
}

/** Test seam. */
export const _manualContactsInternals = {sanitize};
