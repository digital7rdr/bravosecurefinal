/**
 * Linked devices (2026-10-12) — the browser's client for the messenger-service
 * link routes (`/link/*`). Authenticated with the short-lived messenger ticket
 * like the relay. Before the browser is linked it sends no device header; once
 * linked it sends its reserved device id (the server refuses device 1 to a
 * linked browser, so it can never drain the phone's queue).
 */
import {getMessengerTicket} from '@/lib/api';

const ENV_RELAY_BASE =
  process.env.NEXT_PUBLIC_MESSENGER_BASE_URL ??
  process.env.NEXT_PUBLIC_MSG_BASE_URL ??
  null;

export function messengerBase(): string {
  if (ENV_RELAY_BASE) return ENV_RELAY_BASE;
  if (process.env.NODE_ENV === 'production' && typeof window !== 'undefined') {
    throw new Error('[link] NEXT_PUBLIC_MESSENGER_BASE_URL / NEXT_PUBLIC_MSG_BASE_URL not set');
  }
  return 'http://localhost:3100';
}

export class LinkHttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

async function call<T>(method: string, path: string, deviceId: number | null, body?: unknown): Promise<T> {
  const go = async (ticket: string) => fetch(`${messengerBase()}/link${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${ticket}`,
      ...(deviceId ? {'X-Signal-Device-Id': String(deviceId)} : {}),
    },
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    cache: 'no-store',
  });
  let res = await go(await getMessengerTicket());
  if (res.status === 401) res = await go(await getMessengerTicket(true));
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    let code = `http_${res.status}`;
    try { const j = await res.json() as {message?: string}; if (j?.message) code = String(j.message); } catch { /* no body */ }
    throw new LinkHttpError(res.status, code);
  }
  return await res.json() as T;
}

export interface LinkInboxPage { items: Array<{seq: number; data: string}>; more: boolean }

export const linkApi = {
  start: (label: string) =>
    call<{linkId: string; expiresAt: number}>('POST', '/start', null, {label}),
  status: (linkId: string) =>
    call<{status: 'pending'} | {status: 'active'; wsDeviceId: number} | {status: 'expired'}>('GET', `/status/${linkId}`, null),
  send: (linkId: string, deviceId: number, items: string[]) =>
    call<{seq: number}>('POST', `/${linkId}/send`, deviceId, {to: 'phone', items}),
  inbox: (linkId: string, deviceId: number, after: number) =>
    call<LinkInboxPage>('GET', `/${linkId}/inbox?side=web&after=${after}&limit=200`, deviceId),
  ack: (linkId: string, deviceId: number, upTo: number) =>
    call<void>('POST', `/${linkId}/ack`, deviceId, {side: 'web', upTo}),
  revoke: (linkId: string, deviceId: number | null) =>
    call<void>('DELETE', `/${linkId}`, deviceId),
};

/** A short name for this browser, shown on the phone's Linked devices list. */
export function browserLabel(): string {
  if (typeof navigator === 'undefined') return 'Web browser';
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  const host = typeof window !== 'undefined' ? window.location.hostname.split('.')[0] : '';
  const where = host === 'web' ? 'Bravo Web' : host === 'ops' ? 'Ops console' : host === 'provider' ? 'Service Provider console' : '';
  return [`${browser}${os ? ` on ${os}` : ''}`, where].filter(Boolean).join(' · ');
}
