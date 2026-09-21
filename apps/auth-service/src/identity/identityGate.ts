import {ForbiddenException} from '@nestjs/common';
import type {DatabaseService} from '../database/database.service';

/**
 * B-867 — the identity-document gate, as PURE db helpers (the account-kind.ts
 * shape) rather than an injected service, so the two spend paths that call it
 * (BookingService.create, ProApplicationsService.create) need no constructor
 * change and the dozens of specs that build those services by hand keep
 * working.
 *
 * WHO is gated: `users.role = 'individual'` — the founder's "all individual
 * users". Corporate / agent / ops accounts never book for themselves through
 * these paths and are not asked.
 *
 * WHAT satisfies it: a row in identity_documents (row exists ⇔ submitted —
 * the migration note). There is no review step: the founder asked for
 * submission before booking and for ops to be able to SEE the document, not
 * for ops approval to unlock booking.
 *
 * Fail-OPEN on an unknown user: the caller is authenticated, so a missing
 * users row is a fixture or a race, never a real client — and a gate that
 * refused on "no row" would also refuse every existing unit spec whose db
 * double returns undefined for SQL it does not model.
 */

export const IDENTITY_DOCUMENT_REQUIRED = 'identity_document_required';

export type IdentityDocumentStatus = 'missing' | 'submitted';

export interface IdentityDocumentFacts {
  /** Row-existence truth, for every account kind. */
  status: IdentityDocumentStatus;
  /** Whether THIS account is asked for one at all (role-based). */
  required: boolean;
  doc_type: 'national_id' | 'passport' | null;
  submitted_at: string | null;
  has_back: boolean;
}

interface FactsRow {
  gated: boolean;
  has_doc: boolean;
  doc_type: 'national_id' | 'passport' | null;
  submitted_at: Date | string | null;
  has_back: boolean | null;
}

/** Ops kill-switch — `IDENTITY_DOCUMENT_GATE=off` lets bookings through while
 *  keeping the submission lane live (a rollout / incident valve, not a feature). */
export function identityGateEnabled(): boolean {
  return (process.env.IDENTITY_DOCUMENT_GATE ?? 'on').trim().toLowerCase() !== 'off';
}

const FACTS_SQL = `
  SELECT (u.role = 'individual') AS gated,
         (d.user_id IS NOT NULL) AS has_doc,
         d.doc_type,
         d.submitted_at,
         (d.back_sealed IS NOT NULL) AS has_back
    FROM public.users u
    LEFT JOIN public.identity_documents d ON d.user_id = u.id
   WHERE u.id = $1 AND u.deleted_at IS NULL`;

/** The "API cannot say" value: not required, not submitted — never a gate. */
export const IDENTITY_FACTS_UNKNOWN: IdentityDocumentFacts =
  Object.freeze({status: 'missing', required: false, doc_type: null, submitted_at: null, has_back: false});

export async function resolveIdentityDocument(db: DatabaseService, userId: string): Promise<IdentityDocumentFacts> {
  const row = await db.qOne<FactsRow>(FACTS_SQL, [userId]);
  if (!row) return {status: 'missing', required: false, doc_type: null, submitted_at: null, has_back: false};
  return {
    status: row.has_doc ? 'submitted' : 'missing',
    required: !!row.gated && identityGateEnabled(),
    doc_type: row.has_doc ? row.doc_type : null,
    submitted_at: row.has_doc && row.submitted_at ? new Date(row.submitted_at).toISOString() : null,
    has_back: !!row.has_back,
  };
}

/**
 * Refuse a spend path for an individual with no document on file. 403 with a
 * machine code the app routes on (Profile → Identity verification) and a
 * message it can show verbatim.
 */
export async function assertIdentityDocumentForBooking(db: DatabaseService, userId: string): Promise<void> {
  if (!identityGateEnabled()) return;
  const row = await db.qOne<FactsRow>(FACTS_SQL, [userId]);
  if (!row || !row.gated || row.has_doc) return;
  throw new ForbiddenException({
    code: IDENTITY_DOCUMENT_REQUIRED,
    message: 'Add your ID or passport under Profile → Identity verification before booking.',
  });
}
