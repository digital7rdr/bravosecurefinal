'use client';

import {useState, type ReactNode} from 'react';
import {ApiError, opsDataApi, type OpsIdentityDocumentRead} from '@/lib/api';
import {formatDateTimeUtc} from '@/lib/datetime';
import {docTypeLabel, identityPill, resolveIdentityDocument} from '@/lib/identityDocument';

/**
 * B-867 — the ID / passport an individual submitted, on the user page.
 *
 * The detail body carries FACTS only (type / date / back side); the images
 * are fetched on an explicit click through `/ops/users/:id/identity-document`,
 * which is SUPERVISOR+ and writes an ops_audit row per read — the same
 * click-to-reveal posture as the phone/email `Redacted` wrapper, made
 * visible in the button copy so nobody opens a document idly.
 */
export function IdentityDocumentCard({
  userId, role, rawFacts, canReveal, Card,
}: {
  userId: string;
  /** users.role — the row is an individual-account concern. */
  role: string;
  rawFacts: unknown;
  canReveal: boolean;
  /** The page's own card primitive, so this stays visually identical to its siblings. */
  Card: (p: {title: string; right?: ReactNode; children: ReactNode}) => ReactNode;
}) {
  const view = resolveIdentityDocument(rawFacts);
  const pill = identityPill(view);
  const [doc, setDoc] = useState<OpsIdentityDocumentRead | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function reveal() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      setDoc(await opsDataApi.getUserIdentityDocument(userId));
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 404
        ? 'No document on file.'
        : e instanceof ApiError && e.status === 403
          ? 'Requires an operations-domain SUPERVISOR or ADMIN role.'
          : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (role !== 'individual' && view.kind !== 'submitted') return null;

  return (
    <Card title="Identity document" right={<span className={pill.className}>{pill.text}</span>}>
      {view.kind === 'submitted' ? (
        <div className="space-y-3">
          <div className="text-sm text-t2">
            {docTypeLabel(view.doc_type)}
            {view.submitted_at ? <span className="text-t3"> · submitted {formatDateTimeUtc(view.submitted_at)}</span> : null}
            {view.has_back ? <span className="text-t3"> · front + back</span> : null}
          </div>
          {doc ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {doc.images.map(img => (
                <figure key={img.side} className="overflow-hidden rounded-lg border border-bd2 bg-s2">
                  {/* eslint-disable-next-line @next/next/no-img-element -- data URL from the audited read; never a remote host */}
                  <img src={img.data_url} alt={`${img.side} of ${docTypeLabel(doc.doc_type).toLowerCase()}`} className="block w-full" />
                  <figcaption className="px-3 py-1.5 text-xs uppercase tracking-wider text-t3">{img.side}</figcaption>
                </figure>
              ))}
              <p className="text-xs text-t3 sm:col-span-2">
                Viewed {doc.view_count} {doc.view_count === 1 ? 'time' : 'times'} · this view is on the audit trail.
              </p>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-sec"
              onClick={() => { void reveal(); }}
              disabled={!canReveal || busy}
              title={canReveal ? 'Opens the document images — audited' : 'Requires an operations-domain SUPERVISOR or ADMIN role'}>
              {busy ? 'Opening…' : 'Reveal document (audited)'}
            </button>
          )}
          {err && <p className="text-sm text-err">{err}</p>}
        </div>
      ) : view.kind === 'missing' ? (
        <p className="text-sm text-t3">
          This client has not submitted an ID or passport yet. Secure bookings and Pro applications stay locked
          until they do (the app routes them to Profile → Identity verification).
        </p>
      ) : view.kind === 'not_required' ? (
        <p className="text-sm text-t3">Not required for this account.</p>
      ) : (
        <p className="text-sm text-t3">Not reported by this API version.</p>
      )}
    </Card>
  );
}
