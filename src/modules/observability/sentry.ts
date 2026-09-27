/**
 * Mobile crash / error transport — Sentry protocol (2026-09-27).
 *
 * Replaces Firebase Crashlytics + Analytics. Works with hosted Sentry
 * (sentry.io, EU region available) or a self-hosted, Sentry-compatible
 * server such as GlitchTip — only the DSN differs. With no DSN the shim is
 * a silent no-op, so dev builds and Jest never load the native SDK.
 *
 * Build-time env (EAS / .env.production.local, never committed):
 *   EXPO_PUBLIC_SENTRY_DSN                 project DSN; unset = reporting off
 *   EXPO_PUBLIC_SENTRY_ENV                 optional; default derived from the API host
 *   EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE  optional; default 0 (no performance spans)
 *
 * Privacy (this is a secure messenger):
 *   - sendDefaultPii off, no screenshots, no view hierarchy;
 *   - console breadcrumbs dropped (release builds strip console.log anyway);
 *   - HTTP breadcrumb URLs lose their query string;
 *   - every message, exception value and extra string passes redact();
 *   - the Privacy screen's toggle (setCollectionEnabled) drops events in
 *     beforeSend, so switching it off takes effect without a restart.
 *
 * Callers use the crashlytics.ts wrapper (kept under that name so the many
 * existing imports and test mocks did not have to move), not this file.
 */
import {redact, stripQuery} from './redact';

type Level = 'info' | 'warning' | 'error';
interface Breadcrumb {category?: string; message?: string; data?: Record<string, unknown>; level?: Level}
// Loose event shape — only the fields the scrubber touches.
interface SentryEvent {
  message?: string;
  exception?: {values?: Array<{value?: string}>};
  breadcrumbs?: Breadcrumb[];
  extra?: Record<string, unknown>;
  request?: {url?: string; query_string?: unknown; cookies?: unknown; headers?: unknown};
  user?: {id?: string} | null;
}

type SentryRn = {
  init: (opts: Record<string, unknown>) => void;
  captureException: (e: unknown, ctx?: Record<string, unknown>) => void;
  addBreadcrumb: (b: Breadcrumb) => void;
  setUser: (u: {id?: string} | null) => void;
  setTag: (k: string, v: string) => void;
  nativeCrash?: () => void;
};

let sdk: SentryRn | null = null;
let enabled = false;
let bootAttempted = false;
let collectionEnabled = true;

function environment(): string {
  const explicit = process.env.EXPO_PUBLIC_SENTRY_ENV;
  if (explicit) {return explicit;}
  const api = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  if (api.includes('94-136-184-52')) {return 'staging';}
  if (api.includes('127.0.0.1') || api.includes('localhost')) {return 'local';}
  return 'production';
}

function scrubString(v: unknown): unknown {
  return typeof v === 'string' ? redact(v) : v;
}

/** beforeSend — exported for tests. Returns null to drop the event. */
export function scrubEvent<E extends SentryEvent>(event: E): E | null {
  if (!collectionEnabled) {return null;}
  if (event.message) {event.message = redact(event.message);}
  for (const v of event.exception?.values ?? []) {
    if (v.value) {v.value = redact(v.value);}
  }
  for (const b of event.breadcrumbs ?? []) {
    if (b.message) {b.message = redact(b.message);}
  }
  if (event.extra) {
    for (const k of Object.keys(event.extra)) {event.extra[k] = scrubString(event.extra[k]);}
  }
  if (event.request) {
    if (event.request.url) {event.request.url = stripQuery(event.request.url);}
    delete event.request.query_string;
    delete event.request.cookies;
    delete event.request.headers;
  }
  // Only the pseudonymous id setUser() stamps — never email / ip / username.
  if (event.user) {event.user = event.user.id ? {id: event.user.id} : null;}
  return event;
}

/** beforeBreadcrumb — exported for tests. */
export function scrubBreadcrumb(b: Breadcrumb): Breadcrumb | null {
  if (b.category === 'console') {return null;}
  if (b.message) {b.message = redact(b.message);}
  if (b.data && typeof b.data.url === 'string') {
    b.data = {...b.data, url: stripQuery(b.data.url)};
  }
  return b;
}

export function initSentry(): void {
  if (bootAttempted) {return;}
  bootAttempted = true;
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (!dsn) {
    if (__DEV__) {console.log('[sentry] disabled (no EXPO_PUBLIC_SENTRY_DSN)');}
    return;
  }
  try {
    const mod: SentryRn = require('@sentry/react-native');
    const rate = Number(process.env.EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? '0');
    mod.init({
      dsn,
      environment: environment(),
      tracesSampleRate: Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0,
      sendDefaultPii: false,
      attachScreenshot: false,
      attachViewHierarchy: false,
      maxBreadcrumbs: 100,
      beforeSend: scrubEvent,
      beforeBreadcrumb: scrubBreadcrumb,
    });
    sdk = mod;
    enabled = true;
    if (__DEV__) {console.log('[sentry] enabled');}
  } catch (e) {
    if (__DEV__) {console.warn('[sentry] init failed — ' + (e as Error).message);}
  }
}

export function captureException(e: unknown, ctx?: Record<string, unknown>): void {
  initSentry();
  if (enabled && sdk) {
    try { sdk.captureException(e, ctx); } catch { /* swallow */ }
  }
}

export function addBreadcrumb(b: {category?: string; message: string; data?: Record<string, unknown>; level?: Level}): void {
  initSentry();
  if (enabled && sdk) {
    try { sdk.addBreadcrumb(b); } catch { /* swallow */ }
  }
}

export function setSentryUser(u: {id: string; role?: string} | null): void {
  initSentry();
  if (enabled && sdk) {
    try { sdk.setUser(u ? {id: u.id} : null); } catch { /* swallow */ }
  }
}

export function setTag(key: string, value: string): void {
  initSentry();
  if (enabled && sdk) {
    try { sdk.setTag(key, value); } catch { /* swallow */ }
  }
}

/** Privacy toggle — events are dropped in beforeSend while this is off. */
export function setCollectionEnabled(on: boolean): void {
  collectionEnabled = on;
}

export function isCollectionEnabled(): boolean {
  return collectionEnabled;
}

/** Dev-only native crash for verifying the pipeline end-to-end. */
export function nativeCrash(): void {
  initSentry();
  if (enabled && sdk?.nativeCrash) {sdk.nativeCrash();}
}

export function isSentryEnabled(): boolean {
  initSentry();
  return enabled;
}

/** Test hook — resets module state between cases. */
export function __resetSentryForTests(): void {
  sdk = null; enabled = false; bootAttempted = false; collectionEnabled = true;
}
