'use client';

import {type ReactNode} from 'react';
import {SWRConfig, type SWRConfiguration} from 'swr';
import {ApiError} from '@/lib/api';
import {recordError, recordOk} from '@/lib/freshness';

/**
 * OP-11 / OP-12 — the one `SWRConfig` every hook in the console inherits.
 *
 *   keepPreviousData  a filter/tab/search change keeps the last table on
 *                     screen while the new key loads (no more blank-to-
 *                     "Loading…" on every keystroke);
 *   dedupingInterval  two hooks on one key within 2 s share one request;
 *   retry             3 attempts, 5xx / network only — a 4xx is an answer
 *                     (401 already boots to /login, 403 is RBAC, 404/409 are
 *                     decisions) and repeating it only repeats the response;
 *   onSuccess/onError feed the LIVE / STALE / OFFLINE pill in the Shell.
 *
 * `refreshWhenHidden` stays at SWR's default (false): the five life-safety
 * keys opt in per hook and nothing else should poll a hidden tab.
 */
function shouldRetryOnError(err: Error): boolean {
  return !(err instanceof ApiError && err.status >= 400 && err.status < 500);
}

const SWR_CONFIG: SWRConfiguration = {
  keepPreviousData: true,
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
  dedupingInterval: 2000,
  errorRetryCount: 3,
  shouldRetryOnError,
  onSuccess: () => recordOk(),
  onError: () => recordError(),
};

export function SwrProvider({children}: {children: ReactNode}) {
  return <SWRConfig value={SWR_CONFIG}>{children}</SWRConfig>;
}
