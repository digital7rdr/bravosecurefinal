/**
 * Group invite links (2026-10-23) — "invite link / QR to join", Signal and
 * WhatsApp style, without telling the server anything about the group.
 *
 * An admin's phone mints a random token for one group and keeps it (keystore,
 * that phone only). The link carries the group id, the admin's user id, the
 * token and the group's name:
 *
 *     bravo-group:1:<b64u groupId>:<b64u adminUserId>:<token>:<b64u name>
 *
 * Whoever opens it sends the admin an ordinary end-to-end encrypted 1:1
 * message — a readable line plus a `bravo-join:1:<b64u groupId>:<token>`
 * marker. The admin's phone checks the token against the one it issued and,
 * when it matches, adds the sender to the group (normal add + rekey). The
 * server only ever relays a sealed 1:1 message. Resetting the link mints a
 * new token, so the old link stops working.
 *
 * Pure string code: shared by the app and the browser.
 */
export const GROUP_INVITE_PREFIX = 'bravo-group:1:';
export const GROUP_JOIN_MARKER = 'bravo-join:1:';
/** 18 random bytes → 24 base64url characters. */
export const GROUP_INVITE_TOKEN_BYTES = 18;

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const B64U_RE = /^[A-Za-z0-9_-]+$/;

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64u(s: string): string {
  const bytes = enc.encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64u(s: string): string | null {
  if (!B64U_RE.test(s)) return null;
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    if (typeof atob !== 'function') return Buffer.from(b64, 'base64').toString('utf8');
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return dec.decode(out);
  } catch { return null; }
}

export function newGroupInviteToken(): string {
  const b = new Uint8Array(GROUP_INVITE_TOKEN_BYTES);
  globalThis.crypto.getRandomValues(b);
  let bin = '';
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(b).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface GroupInvite {
  groupId:     string;
  adminUserId: string;
  token:       string;
  name:        string;
}

export function encodeGroupInvite(i: GroupInvite): string {
  if (!i.groupId || !i.adminUserId || !TOKEN_RE.test(i.token)) throw new Error('bad_group_invite');
  return `${GROUP_INVITE_PREFIX}${b64u(i.groupId)}:${b64u(i.adminUserId)}:${i.token}:${b64u(i.name.slice(0, 64))}`;
}

/** Null for anything that is not a well-formed invite link (whitespace is tolerated). */
export function parseGroupInvite(text: string): GroupInvite | null {
  const t = String(text ?? '').trim();
  const at = t.indexOf(GROUP_INVITE_PREFIX);
  if (at < 0) return null;
  const body = t.slice(at + GROUP_INVITE_PREFIX.length).split(/\s/)[0];
  const parts = body.split(':');
  if (parts.length !== 4) return null;
  const groupId = unb64u(parts[0]);
  const adminUserId = unb64u(parts[1]);
  const token = parts[2];
  const name = parts[3] ? unb64u(parts[3]) : '';
  if (!groupId || !adminUserId || !TOKEN_RE.test(token) || name === null) return null;
  return {groupId, adminUserId, token, name};
}

/** The 1:1 message a joiner sends the admin. */
export function joinRequestText(i: GroupInvite): string {
  const label = i.name ? `“${i.name}”` : 'your group';
  return `Asked to join ${label} with your invite link.\n\n${GROUP_JOIN_MARKER}${b64u(i.groupId)}:${i.token}`;
}

/** The group and token a received message asks for, or null. */
export function parseJoinRequest(text: string | null | undefined): {groupId: string; token: string} | null {
  const m = /(?:^|\n)bravo-join:1:([A-Za-z0-9_-]+):([A-Za-z0-9_-]{16,64})\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  const groupId = unb64u(m[1]);
  return groupId ? {groupId, token: m[2]} : null;
}

/** What a chat bubble / preview shows for a join request: the marker line is dropped. */
export function withoutJoinMarker(text: string): string {
  if (!text || text.indexOf(GROUP_JOIN_MARKER) < 0) return text;
  return text.replace(/\n*bravo-join:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]{16,64}\s*$/, '').trimEnd();
}
