'use client';

import {useEffect, useState, type ReactNode} from 'react';
import {
  ApiError, opsDataApi, type OpsIdentityDocumentRead, type OpsIdentityDocumentVersion,
  type OpsIdentityDocumentVersionRead,
} from '@/lib/api';
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
    <>
      {renderActive()}
      {canReveal ? <EarlierUploads userId={userId} Card={Card} /> : null}
    </>
  );

  function renderActive() {

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
}

/**
 * 2026-10-10 — every earlier (replaced) upload. The list is facts only and is
 * fetched once for SUPERVISOR+; each image set opens on an explicit click
 * through the audited per-version route — the same posture as the active
 * document. Renders nothing when there is no history (or the API predates it).
 */
function EarlierUploads({userId, Card}: {
  userId: string;
  Card: (p: {title: string; right?: ReactNode; children: ReactNode}) => ReactNode;
}) {
  const [versions, setVersions] = useState<OpsIdentityDocumentVersion[] | null>(null);
  const [opened, setOpened] = useState<Record<string, OpsIdentityDocumentVersionRead>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    opsDataApi.listUserIdentityDocumentVersions(userId)
      .then(v => { if (live) setVersions(Array.isArray(v) ? v : []); })
      // 404 = an API without the history route; nothing to show either way.
      .catch(() => { if (live) setVersions([]); });
    return () => { live = false; };
  }, [userId]);

  async function open(versionId: string) {
    if (busy) return;
    setBusy(versionId);
    setErr(null);
    try {
      const doc = await opsDataApi.getUserIdentityDocumentVersion(userId, versionId);
      setOpened(o => ({...o, [versionId]: doc}));
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 404 ? 'That upload is no longer on file.' : (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!versions || versions.length === 0) return null;

  return (
    <Card title="Earlier identity uploads" right={<span className="pill">{versions.length}</span>}>
      <ul className="space-y-3" data-testid="identity-versions">
        {versions.map(v => {
          const doc = opened[v.id];
          return (
            <li key={v.id} className="rounded-lg border border-bd2 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm text-t2">
                  {docTypeLabel(v.doc_type)}
                  <span className="text-t3"> · uploaded {formatDateTimeUtc(v.submitted_at)}</span>
                  <span className="text-t3"> · replaced {formatDateTimeUtc(v.superseded_at)}</span>
                  {v.has_back ? <span className="text-t3"> · front + back</span> : null}
                </div>
                {!doc ? (
                  <button type="button" className="btn btn-sec" onClick={() => { void open(v.id); }} disabled={busy !== null}
                    title="Opens this earlier upload — audited">
                    {busy === v.id ? 'Opening…' : 'Reveal (audited)'}
                  </button>
                ) : null}
              </div>
              {doc ? (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {doc.images.map(img => (
                    <figure key={img.side} className="overflow-hidden rounded-lg border border-bd2 bg-s2">
                      {/* eslint-disable-next-line @next/next/no-img-element -- data URL from the audited read; never a remote host */}
                      <img src={img.data_url} alt={`${img.side} of earlier ${docTypeLabel(doc.doc_type).toLowerCase()}`} className="block w-full" />
                      <figcaption className="px-3 py-1.5 text-xs uppercase tracking-wider text-t3">{img.side}</figcaption>
                    </figure>
                  ))}
                  <p className="text-xs text-t3 sm:col-span-2">
                    Viewed {doc.view_count} {doc.view_count === 1 ? 'time' : 'times'} · this view is on the audit trail.
                  </p>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {err && <p className="mt-2 text-sm text-err">{err}</p>}
    </Card>
  );
}
