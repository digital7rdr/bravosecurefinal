'use client';

import {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';

/**
 * In-console document viewer (owner, 2026-10-17: "open the documents in the
 * popup modal"). Every VIEW on a provider / officer document used to open a
 * new browser tab; reviewers now see the file in a modal over the page they
 * are reviewing from.
 *
 * How the bytes get here: uploads are served by auth-service
 * (`${PUBLIC_BASE_URL}/uploads/…` = the console's API host, which already
 * answers this origin's CORS). The file is fetched and shown from a blob: URL,
 * so the console CSP only has to allow blob: for images and the PDF frame —
 * no third-party host is ever framed. A link on any other host (old local
 * uploads, outside links) is not fetched: the modal says so and offers a new
 * tab, as before.
 */
export interface ViewerDoc {
  url: string;
  title: string;
  subtitle?: string;
}

type Kind = 'image' | 'pdf' | 'other';
type State =
  | {status: 'loading'}
  | {status: 'ready'; kind: Kind; blobUrl: string; name: string}
  | {status: 'error'; message: string}
  | {status: 'external'};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';

/** Same origin as the API host — the only place uploads are fetched from. */
export function isApiHostedFile(url: string, apiBase = API_BASE): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === new URL(apiBase).origin;
  } catch {
    return false;
  }
}

export function kindOf(contentType: string, url: string): Kind {
  const ct = contentType.toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct === 'application/pdf') return 'pdf';
  const ext = (url.split('?')[0].split('.').pop() ?? '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  return 'other';
}

function fileNameOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'document');
  } catch {
    return 'document';
  }
}

export function DocumentViewerModal({doc, onClose}: {doc: ViewerDoc | null; onClose: () => void}) {
  const [state, setState] = useState<State>({status: 'loading'});
  const [rotate, setRotate] = useState(0);
  const [actual, setActual] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!doc) return;
    setRotate(0);
    setActual(false);
    if (!isApiHostedFile(doc.url)) {
      setState({status: 'external'});
      return;
    }
    setState({status: 'loading'});
    const ctrl = new AbortController();
    let blobUrl: string | null = null;
    void (async () => {
      try {
        const res = await fetch(doc.url, {credentials: 'omit', cache: 'no-store', signal: ctrl.signal});
        if (!res.ok) {
          setState({status: 'error', message: res.status === 404
            ? 'This file is no longer on the server.'
            : `The server answered ${res.status}.`});
          return;
        }
        const blob = await res.blob();
        blobUrl = URL.createObjectURL(blob);
        setState({status: 'ready', kind: kindOf(blob.type || res.headers.get('content-type') || '', doc.url), blobUrl, name: fileNameOf(doc.url)});
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        setState({status: 'error', message: 'The file could not be loaded. Check your connection and try again.'});
      }
    })();
    return () => {
      ctrl.abort();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [doc]);

  useEffect(() => {
    if (!doc) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [doc, onClose]);

  if (!doc) return null;

  const ready = state.status === 'ready' ? state : null;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={doc.title}
        onClick={e => e.stopPropagation()}
        className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-bd1 bg-s2 shadow-2xl">
        <div className="flex flex-wrap items-center gap-2 border-b border-bd2 px-4 py-3">
          {/* Phone: the title takes its own row and the tools wrap under it. */}
          <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
            <div className="text-[10px] font-bold uppercase tracking-widest text-t3">Bravo Ops · Document</div>
            <div className="truncate text-base font-bold text-t1">{doc.title}</div>
            {doc.subtitle && <div className="truncate text-xs text-t3">{doc.subtitle}</div>}
          </div>
          {ready?.kind === 'image' && (
            <>
              <ToolButton onClick={() => setRotate(r => (r + 90) % 360)} label="Rotate">ROTATE</ToolButton>
              <ToolButton onClick={() => setActual(a => !a)} label={actual ? 'Fit to window' : 'Actual size'}>
                {actual ? 'FIT' : '100%'}
              </ToolButton>
            </>
          )}
          {ready && (
            <a href={ready.blobUrl} download={ready.name}
              className="rounded-md border border-bd1 px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-s1">
              DOWNLOAD
            </a>
          )}
          <button ref={closeRef} type="button" onClick={onClose}
            className="rounded-md border border-bd1 px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-s1">
            CLOSE
          </button>
        </div>

        <div className="flex min-h-[40vh] flex-1 items-center justify-center overflow-auto bg-s3">
          {state.status === 'loading' && <Note>Loading document…</Note>}
          {state.status === 'error' && <Note tone="err">{state.message}</Note>}
          {state.status === 'external' && (
            <Note>
              This file is not stored on Bravo, so it cannot be shown here.{' '}
              <a href={doc.url} target="_blank" rel="noreferrer noopener" className="font-semibold text-acc hover:underline">
                Open it in a new tab
              </a>
            </Note>
          )}
          {ready?.kind === 'image' && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={ready.blobUrl}
              alt={doc.title}
              style={{
                transform: `rotate(${rotate}deg)`,
                maxWidth: actual ? 'none' : '100%',
                maxHeight: actual ? 'none' : '75vh',
                objectFit: 'contain',
              }}
            />
          )}
          {ready?.kind === 'pdf' && (
            <iframe src={ready.blobUrl} title={doc.title} className="h-[75vh] w-full border-0 bg-white" />
          )}
          {ready?.kind === 'other' && (
            <Note>This file type cannot be previewed. Use DOWNLOAD to open it.</Note>
          )}
        </div>
      </div>
    </div>
  );
}

function ToolButton({onClick, label, children}: {onClick: () => void; label: string; children: ReactNode}) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label}
      className="rounded-md border border-bd1 px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-s1">
      {children}
    </button>
  );
}

function Note({children, tone}: {children: ReactNode; tone?: 'err'}) {
  return <p className={`max-w-md p-6 text-center text-sm ${tone === 'err' ? 'text-err' : 'text-t3'}`}>{children}</p>;
}

/** `const viewer = useDocumentViewer();` → `viewer.open({...})` and render `{viewer.modal}`. */
export function useDocumentViewer(): {open: (doc: ViewerDoc) => void; modal: ReactNode} {
  const [doc, setDoc] = useState<ViewerDoc | null>(null);
  const close = useCallback(() => setDoc(null), []);
  return {open: setDoc, modal: <DocumentViewerModal doc={doc} onClose={close} />};
}
