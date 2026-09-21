/**
 * B-867 — the identity-document facts on a user, normalised.
 *
 * Same reason `userLocation.ts` exists: the console and the auth-service deploy
 * separately, so a console shipped ahead of the API receives NO
 * `identity_document` field at all. Every reader goes through here so a missing
 * field renders as "not reported", never throws, and never claims "missing"
 * about an account the API has not actually described.
 */

export type IdentityDocType = 'national_id' | 'passport';

export interface OpsIdentityDocumentFacts {
  status: 'missing' | 'submitted';
  required: boolean;
  doc_type: IdentityDocType | null;
  submitted_at: string | null;
  has_back: boolean;
}

export type IdentityDocumentView =
  | {kind: 'unknown'}
  | {kind: 'not_required'}
  | {kind: 'missing'}
  | {kind: 'submitted'; doc_type: IdentityDocType | null; submitted_at: string | null; has_back: boolean};

export function resolveIdentityDocument(raw: unknown): IdentityDocumentView {
  if (!raw || typeof raw !== 'object') return {kind: 'unknown'};
  const f = raw as Partial<OpsIdentityDocumentFacts>;
  if (f.status === 'submitted') {
    return {
      kind: 'submitted',
      doc_type: f.doc_type === 'passport' || f.doc_type === 'national_id' ? f.doc_type : null,
      submitted_at: typeof f.submitted_at === 'string' ? f.submitted_at : null,
      has_back: f.has_back === true,
    };
  }
  if (f.status === 'missing') return f.required === false ? {kind: 'not_required'} : {kind: 'missing'};
  return {kind: 'unknown'};
}

export function docTypeLabel(t: IdentityDocType | null | undefined): string {
  return t === 'passport' ? 'Passport' : t === 'national_id' ? 'National ID' : 'Document';
}

/** The pill an operator sees at a glance: text + the console's pill class. */
export function identityPill(v: IdentityDocumentView): {text: string; className: string} {
  switch (v.kind) {
    case 'submitted': return {text: `ON FILE · ${docTypeLabel(v.doc_type).toUpperCase()}`, className: 'pill pill-ok'};
    case 'missing': return {text: 'NOT SUBMITTED', className: 'pill pill-warn'};
    case 'not_required': return {text: 'NOT REQUIRED', className: 'pill'};
    default: return {text: 'NOT REPORTED', className: 'pill'};
  }
}
