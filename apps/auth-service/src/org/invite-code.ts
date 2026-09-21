import {randomBytes} from 'node:crypto';

/**
 * B-812 — provider roster invitation codes: the pure rules shared by the
 * agency mint path (`OrgCpoService`) and the ops-console mint path
 * (`OpsDataService`). OpsModule cannot import OrgModule (OrgModule imports
 * OpsModule), so the shared part is this dependency-free file, not a service.
 *
 * Format: `BRAVO-XXXXXX`, six characters from a 32-symbol alphabet with the
 * look-alikes (0/O, 1/I) removed — about 1.07e9 codes, behind the global
 * throttler on the redeem route. The joining screen's placeholder shows the
 * older 4-character shape; a 4-character code space (1e6) is guessable.
 */
export const INVITE_CODE_PREFIX = 'BRAVO';
export const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 6;
export const INVITE_CODE_RE = /^BRAVO-[A-HJ-NP-Z2-9]{4,8}$/;

export const DEFAULT_INVITE_TTL_DAYS = 7;
export const MAX_INVITE_TTL_DAYS = 30;
/** How many unique-violation retries a mint tolerates before giving up. */
export const MINT_MAX_ATTEMPTS = 5;
/**
 * Open (unredeemed, unrevoked, unexpired) codes an org may hold at once. The
 * list windows at 200 rows; a code past the window would be redeemable but
 * invisible and un-revocable, so the mint refuses well before that.
 */
export const MAX_OPEN_INVITES = 50;

export function generateInviteCode(random: (n: number) => Buffer = randomBytes): string {
  const bytes = random(INVITE_CODE_LENGTH);
  let body = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    body += INVITE_CODE_ALPHABET[bytes[i] % INVITE_CODE_ALPHABET.length];
  }
  return `${INVITE_CODE_PREFIX}-${body}`;
}

/** Upper-cases, trims, and tolerates a missing dash or surrounding spaces. */
export function normalizeInviteCode(raw: string | null | undefined): string {
  const s = (raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!s) {return '';}
  if (s.startsWith(`${INVITE_CODE_PREFIX}-`)) {return s;}
  if (s.startsWith(INVITE_CODE_PREFIX)) {return `${INVITE_CODE_PREFIX}-${s.slice(INVITE_CODE_PREFIX.length)}`;}
  return s;
}

export function clampTtlDays(days: number | null | undefined): number {
  if (typeof days !== 'number' || !Number.isFinite(days)) {return DEFAULT_INVITE_TTL_DAYS;}
  return Math.min(MAX_INVITE_TTL_DAYS, Math.max(1, Math.round(days)));
}

export type InviteStatus = 'open' | 'redeemed' | 'revoked' | 'expired';

export function inviteStatus(
  row: {redeemed_at: Date | string | null; revoked_at: Date | string | null; expires_at: Date | string | null},
  now: number = Date.now(),
): InviteStatus {
  if (row.redeemed_at) {return 'redeemed';}
  if (row.revoked_at) {return 'revoked';}
  if (row.expires_at && new Date(row.expires_at).getTime() <= now) {return 'expired';}
  return 'open';
}

export type InviteMemberRole = 'cpo' | 'manager';

export function normalizeInviteRole(raw: string | null | undefined): InviteMemberRole {
  return raw === 'manager' ? 'manager' : 'cpo';
}

/** Call signs are short, upper-cased, and never carry PII by construction (letters/digits/dash/space). */
export function normalizeCallSign(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim().toUpperCase().replace(/[^A-Z0-9 -]/g, '').slice(0, 24).trim();
  return s ? s : null;
}
