'use client';

/**
 * Singleton React context that owns the encrypted messenger runtime
 * for the whole ops-console session. Mounts inside the root layout so
 * any page can request unlock + listen to incoming envelopes.
 *
 * State machine:
 *   absent  — no admin user known yet (still loading /ops/me)
 *   locked  — runtime not booted; UI shows VaultUnlockModal on demand
 *   unlocking — passphrase being verified
 *   unlocked  — runtime is pumping envelopes; panels can subscribe
 *   error     — boot failed; show message + retry
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import dynamic from 'next/dynamic';
import {usePathname} from 'next/navigation';
import type {MessengerRuntime, DecryptedMessage, PresenceState} from '@/lib/messenger/runtime';
import type {LinkedRuntime, LinkPairing, LinkRecord} from '@/lib/messenger/linkedRuntime';
import type {MessengerDb} from '@/lib/messenger/idb';
import type {WrapKey} from '@/lib/messenger/crypto';
import useSWR from 'swr';
import {useOpsMe} from '@/lib/api';
import {isProviderHost, isWebHost} from '@/lib/provider/host';
import {webAuth} from '@/lib/web/api';
import {pvAuth} from '@/lib/provider/api';

// OP-18 — this provider is mounted in the root layout, so anything it imports
// statically ships on EVERY route including /login. The runtime (libsignal,
// socket.io-client, idb) is a type-only import here and is `import()`ed at
// unlock time — and so is `lib/messenger/errors`, because it re-exports from
// the `@bravo/messenger-core` barrel and one static `WrongPassphraseError`
// import dragged libsignal + curve25519 + msrCrypto (~450 kB) onto /login.
// The unlock modal (which pulls `idb` + the crypto helpers) is a client-only
// dynamic chunk. The provider itself stays a plain, SSR-able wrapper — a
// `next/dynamic({ssr:false})` around a component that wraps `{children}`
// would blank the whole app until its chunk arrived.
const VaultUnlockModal = dynamic(
  () => import('./VaultUnlockModal').then(m => m.VaultUnlockModal),
  {ssr: false},
);

type State = 'absent' | 'locked' | 'unlocking' | 'unlocked' | 'link_required' | 'error';

/**
 * Linked devices (2026-10-12) — 'standalone': this browser is its own Signal
 * device (accounts without a phone, e.g. web-only staff). 'linked': it mirrors
 * the user's phone (LinkedRuntime). While the account has a phone but this
 * browser is not linked yet, state is 'link_required' and the chat shows the
 * QR code to scan from the app.
 */
export type MessengerMode = 'standalone' | 'linked';

/** What the chat UI calls on either runtime. */
export type ChatRuntime = MessengerRuntime | LinkedRuntime;

export interface PairingState { qr: string | null; error: string | null }

interface Ctx {
  state: State;
  error: string | null;
  userId: string | null;
  /** Live runtime. Null until state === 'unlocked'. */
  runtime: ChatRuntime | null;
  /** The Signal runtime — null in linked mode (mission groups need it). */
  signalRuntime: MessengerRuntime | null;
  mode: MessengerMode | null;
  /** The QR to scan while state === 'link_required' (after beginPairing). */
  pairing: PairingState | null;
  /** Start showing a link QR; returns a stop function. */
  beginPairing: () => () => void;
  /** Linked mode: log this browser out of the phone (clears the mirror). */
  unlinkBrowser: () => Promise<void>;
  /**
   * 2026-10-23 — the account has the Bravo app on a phone, so this browser
   * can be linked to it (QR code) instead of being its own device.
   */
  canLink: boolean;
  /**
   * Replace this browser's own messenger (passphrase vault, its browser-only
   * chats) with a link to the phone: shows the QR code. Only when canLink.
   */
  linkInstead: () => Promise<void>;
  /** Open the unlock dialog. Resolves when state becomes 'unlocked'. */
  requestUnlock: () => void;
  /** Forget the current key + close DB. UI snaps back to 'locked'. */
  lock: () => Promise<void>;
  /**
   * Audit P0-W5 — destructive sign-out: wipe IndexedDB vault for the
   * current admin. Used by `Shell.tsx` logout flow so a sign-out clears
   * every encrypted artefact for the previous admin's session before
   * the next admin authenticates in the same browser. The passphrase
   * canary, ratchet state, message history, and presence cache all go.
   */
  wipe: () => Promise<void>;
}

const MessengerCtx = createContext<Ctx | null>(null);

export function MessengerProvider({children}: {children: ReactNode}) {
  const {data: me} = useOpsMe();
  // 2026-10-03 — the service provider console (provider.* host) uses the same
  // encrypted messenger. There is no ops admin there: the vault belongs to the
  // signed-in provider user, read from the console context (same SWR key as
  // ProviderShell, so it is one request). Decided after mount so server and
  // client render the same tree.
  //
  // Same for the Bravo Web App (web.* host): the vault belongs to the signed-in
  // Bravo account, read from GET /auth/me (the WebShell's SWR key).
  const [host, setHost] = useState<'ops' | 'provider' | 'web'>('ops');
  useEffect(() => {
    const h = window.location.host;
    setHost(isProviderHost(h) ? 'provider' : isWebHost(h) ? 'web' : 'ops');
  }, []);
  const onProvider = host === 'provider';
  // 2026-10-25 — this provider sits in the ROOT layout, so it stays mounted
  // across the client-side hop from /login to the chats page. The signed-in
  // checks below (cookie + path) are read during render, and nothing made it
  // re-render after sign-in: the web messenger stayed on "Loading…" until a
  // full page reload. Subscribing to the route re-runs them on every
  // navigation.
  const pathname = usePathname();
  const offLogin = typeof window !== 'undefined' && pathname !== undefined && !window.location.pathname.startsWith('/login');
  const pvSignedIn = onProvider && typeof document !== 'undefined' && /(?:^|;\s*)bravo_pv_csrf=/.test(document.cookie) && offLogin;
  const webSignedIn = host === 'web' && typeof document !== 'undefined' && /(?:^|;\s*)bravo_web_csrf=/.test(document.cookie) && offLogin;
  const {data: pvCtx} = useSWR(pvSignedIn ? ['pv', 'context'] : null, pvAuth.context, {refreshInterval: 120_000});
  const {data: webMe} = useSWR(webSignedIn ? ['web', 'me'] : null, webAuth.me, {refreshInterval: 120_000});
  const userId = host === 'provider' ? (pvCtx && pvCtx.orgs.length > 0 ? pvCtx.user.id : null)
    : host === 'web' ? (webMe?.user.id ?? null)
    : (me?.admin.user_id ?? null);

  const [state, setState] = useState<State>('absent');
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const runtimeRef = useRef<ChatRuntime | null>(null);
  const [mode, setMode] = useState<MessengerMode | null>(null);
  const [pairing, setPairing] = useState<PairingState | null>(null);
  // The unlocked vault while waiting for the phone to approve the link.
  const vaultRef = useRef<{db: MessengerDb; wrapKey: WrapKey} | null>(null);
  const pairingRef = useRef<LinkPairing | null>(null);
  const [canLink, setCanLink] = useState(false);

  const startLinked = useCallback(async (lr: LinkedRuntime): Promise<void> => {
    lr.onUnlinked(() => {
      // The phone (or this browser) ended the link: back to the QR.
      vaultRef.current = lr.vaultHandle();
      runtimeRef.current = null;
      setPairing(null);
      setState('link_required');
    });
    await lr.startListening();
    vaultRef.current = null;
    runtimeRef.current = lr;
    setMode('linked');
    setState('unlocked');
    setModalOpen(false);
  }, []);

  /**
   * After the vault is open: linked (a link record exists), link_required
   * (the account has a phone), or standalone (everything as before).
   */
  const bootFromVault = useCallback(async (rt: MessengerRuntime, uid: string): Promise<void> => {
    const {readLinkRecord, LinkedRuntime} = await import('@/lib/messenger/linkedRuntime');
    const vault = rt.vaultHandle();
    const link = await readLinkRecord(vault.db, vault.wrapKey);
    let hasPhone = !!link;
    if (!hasPhone) {
      try {
        const {messengerAccountHasPhone} = await import('@/lib/api');
        hasPhone = await messengerAccountHasPhone();
      } catch { hasPhone = false; }
    }
    if (link) {
      await startLinked(new LinkedRuntime(uid, vault.db, vault.wrapKey, link));
      return;
    }
    if (hasPhone) {
      vaultRef.current = vault;
      runtimeRef.current = null;
      setMode('linked');
      setState('link_required');
      setModalOpen(false);
      return;
    }
    await rt.ensureIdentityPublished();
    rt.startListening();
    // Session-level presence: while the vault is unlocked we are reachable
    // on the messenger, so flag ourselves as active to anyone watching.
    rt.setActivity('active');
    runtimeRef.current = rt;
    setMode('standalone');
    setState('unlocked');
    setModalOpen(false);
  }, [startLinked]);

  const beginPairing = useCallback((): (() => void) => {
    const vault = vaultRef.current;
    if (!vault || !userId) return () => undefined;
    let cancelled = false;
    void (async () => {
      const {LinkPairing, LinkedRuntime} = await import('@/lib/messenger/linkedRuntime');
      if (cancelled) return;
      pairingRef.current?.stop();
      const p = new LinkPairing(vault.db, vault.wrapKey,
        (qr, error) => { if (!cancelled) setPairing({qr, error}); },
        (rec: LinkRecord) => {
          if (cancelled) return;
          setPairing(null);
          void startLinked(new LinkedRuntime(userId, vault.db, vault.wrapKey, rec)).catch(e => {
            setError((e as Error).message || 'Link failed');
          });
        });
      pairingRef.current = p;
      p.start();
    })();
    return () => { cancelled = true; pairingRef.current?.stop(); pairingRef.current = null; };
  }, [userId, startLinked]);

  // 2026-10-23 — whether "Link with your phone" can be offered.
  useEffect(() => {
    if (!userId || mode === 'linked') { setCanLink(false); return; }
    let live = true;
    void import('@/lib/api')
      .then(m => m.messengerAccountHasPhone())
      .then(v => { if (live) setCanLink(!!v); })
      .catch(() => { if (live) setCanLink(false); });
    return () => { live = false; };
  }, [userId, mode]);

  const linkInstead = useCallback(async () => {
    if (!userId) return;
    setError(null);
    // Close this browser's own messenger, delete its vault, and start again
    // with a device-bound vault that goes straight to the QR code.
    try { runtimeRef.current?.setActivity('away'); } catch { /* ignore */ }
    try { runtimeRef.current?.close(); } catch { /* ignore */ }
    runtimeRef.current = null;
    pairingRef.current?.stop();
    try { vaultRef.current?.db.close(); } catch { /* ignore */ }
    vaultRef.current = null;
    setPairing(null);
    setState('unlocking');
    try {
      await new Promise<void>((res, rej) => {
        const req = indexedDB.deleteDatabase(`bravo-messenger-${userId}`);
        req.onsuccess = () => res(); req.onerror = () => rej(req.error); req.onblocked = () => res();
      });
      const {MessengerRuntime} = await import('@/lib/messenger/runtime');
      const rt = await MessengerRuntime.createDeviceVault(userId);
      await bootFromVault(rt, userId);
    } catch (e) {
      setError((e as Error).message || 'Could not switch to the phone link.');
      setState('locked');
    }
  }, [userId, bootFromVault]);

  const unlinkBrowser = useCallback(async () => {
    const rt = runtimeRef.current;
    if (rt && 'kind' in rt && rt.kind === 'linked') await rt.unlink();
  }, []);

  useEffect(() => {
    if (!userId) { setState('absent'); return; }
    if (state === 'absent') setState('locked');
  }, [userId, state]);

  // 2026-10-12 — the messenger reopens by itself when it was kept unlocked
  // on this browser: no passphrase dialog. Tried once per signed-in user.
  const autoTried = useRef<string | null>(null);
  useEffect(() => {
    if (!userId || state !== 'locked' || autoTried.current === userId) return;
    autoTried.current = userId;
    void (async () => {
      try {
        const {MessengerRuntime} = await import('@/lib/messenger/runtime');
        let runtime = await MessengerRuntime.unlockRemembered(userId);
        if (!runtime) {
          // Linked devices — an account with a phone needs no passphrase on a
          // browser that never had a vault: it gets a device-bound key and goes
          // straight to "scan the code with your phone".
          if (await MessengerRuntime.hasVault(userId)) return;
          const {messengerAccountHasPhone} = await import('@/lib/api');
          if (!(await messengerAccountHasPhone().catch(() => false))) return;
          runtime = await MessengerRuntime.createDeviceVault(userId);
        }
        setState('unlocking');
        await bootFromVault(runtime, userId);
      } catch (e) {
        console.warn('[messenger] remembered unlock failed', e);
        runtimeRef.current = null;
        setState('locked');
      }
    })();
  }, [userId, state, bootFromVault]);

  const unlock = useCallback(async (passphrase: string, remember = true) => {
    if (!userId) throw new Error('no admin user yet');
    setState('unlocking'); setError(null);
    try {
      const {MessengerRuntime} = await import('@/lib/messenger/runtime');
      const runtime = await MessengerRuntime.unlock(userId, passphrase);
      await runtime.rememberOnThisBrowser(remember).catch(e => console.warn('[messenger] remember failed', e));
      // Standalone: identity publish + listen + presence (mobile members see
      // ops as 'active' while the vault is unlocked). Linked: mirror the phone.
      await bootFromVault(runtime, userId);
    } catch (e) {
      // Why: matched by name, not `instanceof` — the class lives behind the
      // dynamic import above (errors.ts stamps `name` in its constructor).
      if ((e as Error)?.name === 'WrongPassphraseError') setError('Wrong passphrase.');
      else setError((e as Error).message || 'Unlock failed');
      setState('locked');
      throw e;
    }
  }, [userId, bootFromVault]);

  const lock = useCallback(async () => {
    // Flip back to away before the socket closes so watchers see the
    // transition cleanly. The disconnect handler will follow it up
    // with 'offline' on the last-socket close.
    runtimeRef.current?.setActivity('away');
    // 2026-10-12 — an explicit lock also forgets "keep unlocked on this
    // browser": the next open asks for the passphrase again.
    await runtimeRef.current?.rememberOnThisBrowser(false).catch(() => undefined);
    // Audit OPS-MSG-09 — close() stops the pumps, closes the IDB handle,
    // and drops the in-memory group-key cache (not just stopListening()).
    runtimeRef.current?.close();
    runtimeRef.current = null;
    pairingRef.current?.stop();
    vaultRef.current = null;
    setPairing(null);
    setMode(null);
    setState('locked');
  }, []);

  /**
   * Audit P0-W5 — destructive sign-out. Closes the runtime, then
   * deletes the IndexedDB messenger database for the current admin
   * AND scrubs any sessionStorage / localStorage keys we control. The
   * passphrase canary, vault wrap-key salt, ratchet state, message
   * history, presence cache, and read-receipt cache are all gone after
   * this. A different admin signing in on the same browser starts
   * from a true clean slate.
   *
   * Idempotent — calling on an already-locked / never-unlocked runtime
   * just runs the IDB delete + storage scrub.
   */
  const wipe = useCallback(async () => {
    // Drop the live runtime + WS first so an in-flight session can't
    // race a wipe and re-create rows after the IDB delete starts.
    try {
      const rt = runtimeRef.current;
      // Linked mode: signing out also logs this browser out of the phone,
      // so the phone stops mirroring to a browser that kept nothing.
      if (rt && 'kind' in rt && rt.kind === 'linked') {
        await Promise.race([rt.unlink().catch(() => undefined), new Promise(r => setTimeout(r, 3_000))]);
      }
      rt?.setActivity('away');
      rt?.stopListening();
      if (rt) {
        await rt.wipe();
      }
    } catch { /* runtime.wipe handles its own errors; never block sign-out */ }
    runtimeRef.current = null;
    pairingRef.current?.stop();
    try { vaultRef.current?.db.close(); } catch { /* ignore */ }
    vaultRef.current = null;
    setPairing(null);
    setMode(null);

    // Even if no runtime was live, the IDB may exist from a prior
    // session: delete it by deterministic name. Indexed by userId so
    // we don't wipe a different admin's vault from this browser.
    if (typeof indexedDB !== 'undefined' && userId) {
      try {
        await new Promise<void>((res, rej) => {
          const req = indexedDB.deleteDatabase(`bravo-messenger-${userId}`);
          req.onsuccess = () => res();
          req.onerror   = () => rej(req.error);
          req.onblocked = () => res();
        });
      } catch { /* non-fatal — sign-out proceeds either way */ }
    }

    // Scrub any sessionStorage breadcrumbs the messenger surface
    // wrote. The httpOnly auth cookies are wiped server-side by
    // clearSession() in api.ts; this only touches values JS owns.
    if (typeof window !== 'undefined') {
      try {
        window.sessionStorage.removeItem('bravo_ops_access_expires_at');
        window.sessionStorage.removeItem('bravo_ops_idle_logout');
      } catch { /* private-mode storage quirks — non-fatal */ }
    }

    setState('locked');
  }, [userId]);

  const requestUnlock = useCallback(() => { setModalOpen(true); }, []);

  const value: Ctx = useMemo(() => {
    const rt = runtimeRef.current;
    const signal = rt && !('kind' in rt) ? rt : null;
    return {
      state, error, userId,
      runtime: rt,
      signalRuntime: signal,
      mode, pairing, beginPairing, unlinkBrowser, canLink, linkInstead,
      requestUnlock, lock, wipe,
    };
  }, [state, error, userId, mode, pairing, beginPairing, unlinkBrowser, canLink, linkInstead, requestUnlock, lock, wipe]);

  // Tear down the runtime on unmount. Mirror the lock() cleanup so the
  // last 'away' frame goes out before we close the socket.
  useEffect(() => () => {
    runtimeRef.current?.setActivity('away');
    runtimeRef.current?.close();
  }, []);

  return (
    <MessengerCtx.Provider value={value}>
      {children}
      {modalOpen && (
        <VaultUnlockModal
          state={state}
          error={error}
          userId={userId}
          onClose={() => setModalOpen(false)}
          onSubmit={async (p, remember) => { try { await unlock(p, remember); } catch { /* error already in state */ } }}
        />
      )}
    </MessengerCtx.Provider>
  );
}

export function useMessenger(): Ctx {
  const v = useContext(MessengerCtx);
  if (!v) throw new Error('useMessenger called outside MessengerProvider');
  return v;
}

/**
 * Subscribe to decrypted messages for a specific conversation_id.
 * Returns persisted history (inbound + outbound) merged with live
 * inbound, oldest first. The runtime fires `onHistoryChange` whenever
 * IDB mutates so the hook stays in sync without polling.
 *
 * Outbound messages from history are surfaced with `senderUserId`
 * equal to the current user so the panel's `display` logic still
 * branches on `m.senderUserId === messenger.userId` without changes.
 *
 * OP-20 — history is windowed: the newest `HISTORY_PAGE` rows are decrypted
 * on each change, and `loadOlder` widens the window by another page.
 * `hasOlder` is true while the window came back full (there may be more).
 */
const HISTORY_PAGE = 200;

export interface GroupMessages {
  messages: DecryptedMessage[];
  hasOlder: boolean;
  loadOlder: () => void;
}

export function useGroupMessages(conversationId: string | null): GroupMessages {
  const {runtime, state} = useMessenger();
  const [items, setItems] = useState<DecryptedMessage[]>([]);
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const [windowFull, setWindowFull] = useState(false);

  // A different thread starts back at one page.
  useEffect(() => { setLimit(HISTORY_PAGE); setWindowFull(false); }, [conversationId]);

  useEffect(() => {
    if (!runtime || !conversationId || state !== 'unlocked') return;
    let cancelled = false;

    const reload = () => {
      void runtime.loadConversation(conversationId, limit).then(rows => {
        if (cancelled) return;
        const mapped: DecryptedMessage[] = rows.map(r => ({
          envelopeId:     r.envelopeId ?? `local|${r.id}`,
          conversationId: r.conversationId,
          senderUserId:   r.senderUserId,
          senderDeviceId: 1,
          body:           r.body,
          clientMsgId:    r.clientMsgId ?? undefined,
          receivedAt:     r.sentAt,
        }));
        setItems(mapped);
        setWindowFull(rows.length >= limit);
      });
    };

    reload();
    const offIncoming = runtime.onIncoming(m => {
      if (m.conversationId !== conversationId) return;
      // The runtime persists every inbound before fanning to listeners,
      // so a fresh `reload()` would cover us — but we also append in
      // place so the UI updates without waiting on the IDB roundtrip.
      setItems(prev =>
        prev.some(x => x.envelopeId === m.envelopeId) ? prev : [...prev, m],
      );
    });
    const offHistory = runtime.onHistoryChange(cid => {
      if (cid === conversationId) reload();
    });
    return () => {
      cancelled = true;
      offIncoming();
      offHistory();
    };
  }, [runtime, conversationId, state, limit]);

  const loadOlder = useCallback(() => { setLimit(l => l + HISTORY_PAGE); }, []);

  return useMemo(
    () => ({messages: items, hasOlder: windowFull, loadOlder}),
    [items, windowFull, loadOlder],
  );
}

/**
 * Subscribe to presence for a list of userIds. The runtime registers
 * the subscription with the server on mount and tears it down on
 * unmount, so the hook can be used freely in any panel.
 */
export function usePresence(userIds: string[]): Map<string, PresenceState> {
  const {runtime, state} = useMessenger();
  const [snap, setSnap] = useState<Map<string, PresenceState>>(new Map());
  // Stable join key so the effect doesn't re-fire when callers pass a
  // fresh array reference with the same content on every render.
  const key = userIds.join(',');

  useEffect(() => {
    if (!runtime || state !== 'unlocked' || userIds.length === 0) return;
    runtime.subscribePresence(userIds);
    const off = runtime.onPresenceChange((uid, p) => {
      if (!userIds.includes(uid)) return;
      setSnap(prev => {
        const next = new Map(prev);
        next.set(uid, p);
        return next;
      });
    });
    return () => {
      off();
      runtime.unsubscribePresence(userIds);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, state, key]);

  return snap;
}

/**
 * Subscribe to typing indicators by peer userId. Returns the set of
 * userIds currently typing — typically rendered as "X is typing…".
 */
export function useTyping(peerUserIds: string[]): Set<string> {
  const {runtime, state} = useMessenger();
  const [typing, setTyping] = useState<Set<string>>(new Set());
  const key = peerUserIds.join(',');

  useEffect(() => {
    if (!runtime || state !== 'unlocked' || peerUserIds.length === 0) return;
    const off = runtime.onTypingChange((uid, isTyping) => {
      if (!peerUserIds.includes(uid)) return;
      setTyping(prev => {
        const next = new Set(prev);
        if (isTyping) next.add(uid); else next.delete(uid);
        return next;
      });
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, state, key]);

  return typing;
}

/**
 * Subscribe to read-receipt frames. Returns a set of envelope ids
 * the peer has acknowledged reading. Used to flip outbound bubbles
 * from single-tick (delivered) to double-tick (read).
 */
export function useReadReceipts(): Set<string> {
  const {runtime, state} = useMessenger();
  const [read, setRead] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!runtime || state !== 'unlocked') return;
    const off = runtime.onReadReceipt((_peerUid, envelopeIds) => {
      setRead(prev => {
        const next = new Set(prev);
        for (const id of envelopeIds) next.add(id);
        return next;
      });
    });
    return off;
  }, [runtime, state]);

  return read;
}
