/**
 * Linked devices — the private channel between a phone and a browser that
 * mirrors it (2026-10-12).
 *
 * The phone stays the account's only Signal device. A linked browser does not
 * talk Signal to anybody: the phone forwards it the decrypted conversations
 * and sends what the browser asks it to send. Everything between the two goes
 * through the messenger-service link inbox (`/link/:id/*`), sealed here with a
 * key the server never sees:
 *
 *   1. The browser opens a pending link (POST /link/start → linkId) and makes
 *      a fresh 32-byte link key. It shows `bravo-link:1:<linkId>:<key>` as a
 *      QR code. The key exists only in that QR and in the two endpoints.
 *   2. The phone scans it, the server checks both belong to the same account
 *      (POST /link/approve), and both sides derive one AES-256-GCM key per
 *      direction from the link key (HKDF-SHA256, salt = linkId).
 *   3. Every item is `lnk1.` + base64url(iv ‖ ciphertext ‖ tag), with the link
 *      id and direction bound as AAD, carrying one JSON LinkMessage.
 *
 * Pure WebCrypto (AES-GCM) + @noble/hashes (HKDF), so the same file runs in
 * React Native (react-native-quick-crypto's subtle) and in the browser.
 */
import {hkdf} from '@noble/hashes/hkdf.js';
import {sha256} from '@noble/hashes/sha2.js';

export const LINK_QR_PREFIX = 'bravo-link:1:';
export const LINK_ITEM_PREFIX = 'lnk1.';
/** Keep each sealed item well under the server's 512 KB item cap. */
export const LINK_ITEM_MAX_JSON = 200_000;
export const LINK_KEY_BYTES = 32;

/** p2w = phone → web, w2p = web → phone. */
export type LinkDir = 'p2w' | 'w2p';

export type LinkMsgStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

/** One message row as the browser stores it. `at` is epoch ms. */
export interface LinkMsgRow {
  id:         string;
  dir:        'in' | 'out';
  body:       string;
  at:         number;
  status:     LinkMsgStatus;
  kind?:      'text' | 'image' | 'audio' | 'video' | 'file' | 'call' | 'system';
  replyToId?: string | null;
}

export interface LinkPeer {
  userId:     string;
  name?:      string | null;
  phone?:     string | null;
}

export interface LinkConversation {
  /** Browser-side thread id: always `direct:<peerUserId>`. */
  cid:     string;
  peer:    LinkPeer;
  unread:  number;
  lastAt:  number;
  pinned?: boolean;
}

interface Base { id: string; ts: number }

/** Phone → browser. */
export type PhoneToWeb =
  | (Base & {t: 'hello'; self: {userId: string; name?: string | null}; phoneLabel?: string | null})
  | (Base & {t: 'contacts'; contacts: LinkPeer[]})
  | (Base & {t: 'convs'; conversations: LinkConversation[]; full: boolean})
  | (Base & {t: 'msgs'; cid: string; peerUserId: string; rows: LinkMsgRow[]; history?: boolean})
  | (Base & {t: 'status'; cid: string; msgId: string; status: LinkMsgStatus})
  | (Base & {t: 'sent'; ref: string; ok: boolean; error?: string | null})
  | (Base & {t: 'bye'});

/** Browser → phone. */
export type WebToPhone =
  | (Base & {t: 'sync'; perConversation?: number})
  | (Base & {t: 'send'; ref: string; peerUserId: string; text: string; replyToId?: string | null})
  | (Base & {t: 'read'; cid: string})
  | (Base & {t: 'history'; cid: string; before: number; limit: number});

export type LinkMessage = PhoneToWeb | WebToPhone;

// ── encoding ────────────────────────────────────────────────────────────────

export function b64uEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  const b64 = typeof btoa === 'function' ? btoa(s) : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad_base64url');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  if (typeof atob !== 'function') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** TS 5.7+ narrows BufferSource to ArrayBuffer-backed views; these always are. */
function bs(u: Uint8Array): BufferSource { return u as unknown as BufferSource; }

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('webcrypto_unavailable');
  return s;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function newLinkKey(): Uint8Array { return randomBytes(LINK_KEY_BYTES); }

export function newLinkMsgId(): string { return b64uEncode(randomBytes(12)); }

// ── QR ──────────────────────────────────────────────────────────────────────

const LINK_ID_RE = /^[A-Za-z0-9_-]{22}$/;

export function encodeLinkQr(linkId: string, key: Uint8Array): string {
  if (!LINK_ID_RE.test(linkId)) throw new Error('bad_link_id');
  if (key.length !== LINK_KEY_BYTES) throw new Error('bad_link_key');
  return `${LINK_QR_PREFIX}${linkId}:${b64uEncode(key)}`;
}

export function parseLinkQr(text: string): {linkId: string; key: Uint8Array} | null {
  const t = String(text ?? '').trim();
  if (!t.startsWith(LINK_QR_PREFIX)) return null;
  const [linkId, keyPart, ...rest] = t.slice(LINK_QR_PREFIX.length).split(':');
  if (rest.length || !LINK_ID_RE.test(linkId ?? '') || !keyPart) return null;
  try {
    const key = b64uDecode(keyPart);
    return key.length === LINK_KEY_BYTES ? {linkId, key} : null;
  } catch { return null; }
}

// ── sealing ─────────────────────────────────────────────────────────────────

export interface LinkCipher {
  readonly linkId: string;
  seal(dir: LinkDir, msg: LinkMessage): Promise<string>;
  /** Null for anything that is not an authentic item for this link + direction. */
  open(dir: LinkDir, item: string): Promise<LinkMessage | null>;
}

function aad(linkId: string, dir: LinkDir): Uint8Array {
  return enc.encode(`bravo-link|1|${linkId}|${dir}`);
}

async function dirKey(linkId: string, key: Uint8Array, dir: LinkDir): Promise<CryptoKey> {
  const raw = hkdf(sha256, key, enc.encode(linkId), enc.encode(`bravo-link v1 ${dir}`), 32);
  return subtle().importKey('raw', bs(raw), {name: 'AES-GCM'}, false, ['encrypt', 'decrypt']);
}

export async function linkCipher(linkId: string, key: Uint8Array): Promise<LinkCipher> {
  if (key.length !== LINK_KEY_BYTES) throw new Error('bad_link_key');
  const keys: Record<LinkDir, CryptoKey> = {
    p2w: await dirKey(linkId, key, 'p2w'),
    w2p: await dirKey(linkId, key, 'w2p'),
  };
  return {
    linkId,
    async seal(dir, msg) {
      const iv = randomBytes(12);
      const pt = enc.encode(JSON.stringify(msg));
      const ct = new Uint8Array(await subtle().encrypt({name: 'AES-GCM', iv: bs(iv), additionalData: bs(aad(linkId, dir))}, keys[dir], bs(pt)));
      const out = new Uint8Array(iv.length + ct.length);
      out.set(iv, 0); out.set(ct, iv.length);
      return LINK_ITEM_PREFIX + b64uEncode(out);
    },
    async open(dir, item) {
      if (typeof item !== 'string' || !item.startsWith(LINK_ITEM_PREFIX)) return null;
      try {
        const blob = b64uDecode(item.slice(LINK_ITEM_PREFIX.length));
        if (blob.length < 12 + 16) return null;
        const pt = await subtle().decrypt(
          {name: 'AES-GCM', iv: bs(blob.slice(0, 12)), additionalData: bs(aad(linkId, dir))},
          keys[dir], bs(blob.slice(12)),
        );
        const msg = JSON.parse(dec.decode(new Uint8Array(pt))) as LinkMessage;
        if (!msg || typeof msg !== 'object' || typeof (msg as {t?: unknown}).t !== 'string') return null;
        return msg;
      } catch { return null; }
    },
  };
}

/**
 * Split message rows into `msgs` frames that each stay under the item cap
 * (a long thread is sent as several frames; the browser upserts by id).
 */
export function chunkRows(rows: LinkMsgRow[], maxJson = LINK_ITEM_MAX_JSON): LinkMsgRow[][] {
  const out: LinkMsgRow[][] = [];
  let cur: LinkMsgRow[] = [];
  let size = 0;
  for (const r of rows) {
    const n = JSON.stringify(r).length + 1;
    if (cur.length && size + n > maxJson) { out.push(cur); cur = []; size = 0; }
    cur.push(r); size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Remembers recently seen message ids so a replayed item is applied once. */
export class LinkReplayGuard {
  private seen = new Set<string>();
  private order: string[] = [];
  constructor(private readonly max = 4000) {}
  /** True the first time an id is seen. */
  fresh(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id); this.order.push(id);
    if (this.order.length > this.max) this.seen.delete(this.order.shift()!);
    return true;
  }
}
