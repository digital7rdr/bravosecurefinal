'use client';

import {useEffect, useRef} from 'react';
import {useRouter} from 'next/navigation';
import {useActivity, useOpsMe} from '@/lib/api';
import {useToast} from './Toast';
import {
  diffNewItems, isPopupWorthy, notificationHref, notificationTitle, popupTtlMs, type FeedItem,
} from '@/lib/notifications';

/**
 * B-817 — the console-wide popup lane for the live feed.
 *
 * Founder (2026-09-07): a new booking (and every other meaningful event) must
 * announce itself — an in-console popup, a browser (overlay) notification when
 * the tab is not in view, and a click that lands on the page that needs the
 * operator. Before this the feed was a passive dropdown behind the bell: an
 * operator on /finance learned of a new booking from a badge count, if at all.
 *
 * Mounted once in the Shell. It renders nothing itself: popups go through the
 * shared toast stack (now link-capable), overlays through the Notification
 * API. The FIRST poll only seeds the seen-set — opening the console is not
 * "fifty new things happened" — and a burst is capped per tick.
 *
 * SOS rows are deliberately NOT popped here: `SosAlertBar` owns the persistent
 * banner, the chime and the browser notification for life-safety alerts, and a
 * second overlay for the same event would be noise on the one alert that must
 * stay legible. They still appear in the bell with a link to the SOS log.
 */
export default function OpsNotifier() {
  const {data} = useActivity(50);
  const {data: me} = useOpsMe();
  const {push} = useToast();
  const router = useRouter();
  const seen = useRef<Set<number>>(new Set());
  const seeded = useRef(false);
  const myCall = me?.admin.call_sign ?? null;

  // Ask for overlay permission on the first gesture — never unprompted on
  // load, and in a user-gesture context so browsers actually show the prompt.
  // SosAlertBar asks too; both listeners are once-only and the second ask is
  // a no-op once the state is no longer 'default'.
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'default') return;
    const ask = () => { void Notification.requestPermission(); };
    window.addEventListener('pointerdown', ask, {once: true});
    return () => window.removeEventListener('pointerdown', ask);
  }, []);

  useEffect(() => {
    if (!data) return;
    const fresh = diffNewItems(data, seen.current, {seeded: seeded.current});
    seeded.current = true;
    for (const it of fresh) {
      if (!isPopupWorthy(it, myCall)) continue;
      if (it.kind === 'sos' && it.severity === 'err') continue; // SosAlertBar owns it
      const href = notificationHref(it);
      const title = notificationTitle(it);
      push({
        kind: toastKind(it),
        title,
        text: it.message,
        href: href ?? undefined,
        ttlMs: popupTtlMs(it),
      });
      overlay(it, title, href, path => router.push(path));
    }
  }, [data, myCall, push, router]);

  return null;
}

function toastKind(it: FeedItem): 'ok' | 'err' | 'warn' | 'info' {
  if (it.severity === 'err') return 'err';
  if (it.severity === 'warn') return 'warn';
  if (it.severity === 'ok') return 'ok';
  return 'info';
}

/**
 * The browser-level overlay: only when the tab cannot be seen (a visible tab
 * already has the toast), only with permission, and always tagged by row id so
 * a re-render can never duplicate one.
 */
function overlay(it: FeedItem, title: string, href: string | null, go: (path: string) => void): void {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return;
  try {
    const n = new Notification(`${title} — Bravo Ops`, {
      body: it.message,
      tag: `bravo-ops-feed-${it.id}`,
      requireInteraction: it.severity === 'err' || it.kind === 'booking.request',
    });
    n.onclick = () => {
      window.focus();
      if (href) go(href);
      n.close();
    };
  } catch {
    // Notification construction can throw on some platforms; the toast stands.
  }
}
