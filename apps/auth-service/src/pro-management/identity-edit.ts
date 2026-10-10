import {ConflictException, NotFoundException} from '@nestjs/common';
import type {DatabaseService, Tx} from '../database/database.service';

/**
 * Edit a person's contact details from the ops console (2026-10-10): name,
 * email and login phone. Used by People → Users (any account) and Internal →
 * Admins (console accounts, which also carry a call sign and region).
 *
 * Rules:
 *   - an erased (deleted) account cannot be edited;
 *   - email and phone stay unique across live accounts (and the console's own
 *     phone index): a clash is 409 email_taken / phone_taken, never a 500;
 *   - a changed email or phone is no longer "verified" (the person proves the
 *     new one the next time they receive a code);
 *   - admin_users keeps its copies of the name and phone in step;
 *   - the audit row gets which fields changed, with email/phone MASKED.
 */
export interface IdentityPatch {
  display_name?: string;
  email?: string | null;
  phone_e164?: string;
}

export interface IdentityChange {
  changed: string[];
  audit: Record<string, {from: string | null; to: string | null}>;
}

const maskEmail = (e: string | null) => {
  if (!e) return null;
  const [l, d] = e.split('@');
  return `${(l ?? '').slice(0, 2)}***@${d ?? ''}`;
};
const maskPhone = (p: string | null) => (p ? (p.length > 6 ? `${p.slice(0, 4)}***${p.slice(-2)}` : '***') : null);

export function normaliseIdentityPatch(p: IdentityPatch): IdentityPatch {
  const out: IdentityPatch = {};
  if (p.display_name !== undefined) out.display_name = p.display_name.trim();
  if (p.email !== undefined) out.email = p.email === null || p.email.trim() === '' ? null : p.email.trim().toLowerCase();
  if (p.phone_e164 !== undefined) out.phone_e164 = p.phone_e164.trim().replace(/[\s\-().]/g, '');
  return out;
}

async function apply(db: Pick<Tx, 'q' | 'qOne'>, userId: string, raw: IdentityPatch): Promise<IdentityChange> {
  const patch = normaliseIdentityPatch(raw);
  const cur = await db.qOne<{display_name: string | null; email: string | null; phone_e164: string | null}>(
    `SELECT display_name, email::text AS email, phone_e164 FROM public.users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
    [userId]);
  if (!cur) throw new NotFoundException('user_not_found');

  const next = {
    display_name: patch.display_name ?? cur.display_name,
    email: patch.email !== undefined ? patch.email : cur.email,
    phone_e164: patch.phone_e164 ?? cur.phone_e164,
  };
  const emailChanged = (next.email ?? '') !== (cur.email ?? '').toLowerCase();
  const phoneChanged = next.phone_e164 !== cur.phone_e164;
  const nameChanged = next.display_name !== cur.display_name;
  const changed = [nameChanged && 'display_name', emailChanged && 'email', phoneChanged && 'phone_e164'].filter(Boolean) as string[];
  if (changed.length === 0) return {changed, audit: {}};

  if (emailChanged && next.email) {
    const clash = await db.qOne(`SELECT 1 FROM public.users WHERE email=$1 AND id<>$2 AND deleted_at IS NULL`, [next.email, userId]);
    if (clash) throw new ConflictException('email_taken');
  }
  if (phoneChanged) {
    const clash = await db.qOne(
      `SELECT 1 FROM public.users WHERE phone_e164=$1 AND id<>$2 AND deleted_at IS NULL
       UNION ALL SELECT 1 FROM admin_users WHERE phone_e164=$1 AND user_id<>$2`, [next.phone_e164, userId]);
    if (clash) throw new ConflictException('phone_taken');
  }

  try {
    await db.q(
      `UPDATE public.users
          SET display_name=$2, email=$3, phone_e164=$4,
              email_verified_at = CASE WHEN $5 THEN NULL ELSE email_verified_at END,
              phone_verified_at = CASE WHEN $6 THEN NULL ELSE phone_verified_at END
        WHERE id=$1`,
      [userId, next.display_name, next.email, next.phone_e164, emailChanged, phoneChanged]);
    if (nameChanged || phoneChanged) {
      await db.q(
        `UPDATE admin_users SET display_name=COALESCE($2, display_name), phone_e164=$3 WHERE user_id=$1`,
        [userId, next.display_name, next.phone_e164]);
    }
  } catch (e) {
    if ((e as {code?: string})?.code === '23505') {
      const c = String((e as {constraint?: string})?.constraint ?? '');
      throw new ConflictException(/email/.test(c) ? 'email_taken' : 'phone_taken');
    }
    throw e;
  }

  const audit: IdentityChange['audit'] = {};
  if (nameChanged) audit.display_name = {from: cur.display_name, to: next.display_name};
  if (emailChanged) audit.email = {from: maskEmail(cur.email), to: maskEmail(next.email)};
  if (phoneChanged) audit.phone_e164 = {from: maskPhone(cur.phone_e164), to: maskPhone(next.phone_e164)};
  return {changed, audit};
}

/** Run the edit in one transaction (or inside the caller's). */
export function applyIdentityEdit(db: DatabaseService | Pick<Tx, 'q' | 'qOne'>, userId: string, patch: IdentityPatch): Promise<IdentityChange> {
  if ('withTransaction' in db) return db.withTransaction(tx => apply(tx, userId, patch));
  return apply(db, userId, patch);
}
