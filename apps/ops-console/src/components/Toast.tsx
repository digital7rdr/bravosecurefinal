'use client';

import Link from 'next/link';
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';

/**
 * OP-17 — minimal toast system. `useToast().push({kind, text})`; each toast
 * auto-dismisses after 5 s. The stack is an `aria-live` region so screen
 * readers announce the outcome of an ack/approve without focus moving.
 *
 * B-817 — the live-feed popups ride this same stack, so a toast can now carry
 * a `title`, an `href` (the whole card becomes a link that dismisses itself
 * on click) and its own `ttlMs` (`null` = stays until the operator closes it;
 * sticky toasts always render a close control).
 */
export interface ToastInput {
  kind: 'ok' | 'err' | 'warn' | 'info';
  text: string;
  title?: string;
  href?: string;
  /** Milliseconds on screen; `null` = until dismissed. Default 5 s. */
  ttlMs?: number | null;
}

interface Toast extends ToastInput { id: number }

interface ToastCtx {
  push: (t: ToastInput) => void;
}

const TOAST_MS = 5000;
const PILL: Record<ToastInput['kind'], string> = {ok: 'pill-ok', err: 'pill-err', warn: 'pill-warn', info: 'pill-info'};
const GLYPH: Record<ToastInput['kind'], string> = {ok: '✓', err: '✗', warn: '!', info: '•'};

const Ctx = createContext<ToastCtx | null>(null);

export function ToastProvider({children}: {children: ReactNode}) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const dismiss = useCallback((id: number) => {
    setToasts(p => p.filter(x => x.id !== id));
  }, []);

  const push = useCallback((t: ToastInput) => {
    const id = ++seq.current;
    setToasts(p => [...p, {...t, id}]);
    const ttl = t.ttlMs === undefined ? TOAST_MS : t.ttlMs;
    if (ttl === null) return; // sticky — the close control is the only exit
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setToasts(p => p.filter(x => x.id !== id));
    }, ttl);
    timers.current.add(timer);
  }, []);

  useEffect(() => {
    const pending = timers.current;
    return () => { for (const t of pending) clearTimeout(t); };
  }, []);

  const value = useMemo(() => ({push}), [push]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        role="status"
        style={{
          position: 'fixed', right: 16, bottom: 16, zIndex: 1000,
          display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none',
        }}>
        {toasts.map(t => {
          const body = (
            <>
              {t.title && (
                <div style={{fontSize: 9.5, letterSpacing: 1, textTransform: 'uppercase', opacity: 0.85, marginBottom: 2}}>
                  {GLYPH[t.kind]} {t.title}{t.href ? ' →' : ''}
                </div>
              )}
              <div>{t.title ? '' : `${GLYPH[t.kind]} `}{t.text}</div>
            </>
          );
          const style = {
            pointerEvents: 'auto' as const, padding: '8px 12px', maxWidth: 360,
            fontSize: 11, letterSpacing: 0.4, textTransform: 'none' as const, whiteSpace: 'normal' as const,
            boxShadow: '0 8px 24px rgba(0,0,0,0.45)', display: 'flex', alignItems: 'flex-start', gap: 8,
            textDecoration: 'none',
          };
          const cls = `pill ${PILL[t.kind]}`;
          // The close control is a SIBLING of the link, never inside it — a
          // button inside an anchor is invalid interactive nesting, and a
          // sticky (ttlMs null) toast needs a working close on every kind.
          const close = (
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
              style={{background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '0 0 0 8px', fontSize: 13, lineHeight: 1, alignSelf: 'flex-start'}}>
              ×
            </button>
          );
          const inner = <div style={{flex: 1, minWidth: 0}}>{body}</div>;
          return (
            <div key={t.id} className={cls} style={style}>
              {t.href ? (
                <Link href={t.href} style={{flex: 1, minWidth: 0, color: 'inherit', textDecoration: 'none'}} onClick={() => dismiss(t.id)}>
                  {inner}
                </Link>
              ) : inner}
              {close}
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast called outside ToastProvider');
  return v;
}
