import {useSyncExternalStore} from 'react';

/**
 * OP-11 / OC-17 — console-wide data freshness, fed by the global SWRConfig
 * `onSuccess` / `onError` hooks. The Shell renders it as a LIVE / STALE /
 * OFFLINE pill so a 10-minute-stale board is no longer pixel-identical to a
 * live one.
 */
export interface Freshness {
  lastOkAt: number | null;
  lastErrorAt: number | null;
  /** Failures since the last success; reset to 0 by any success. */
  consecutiveFailures: number;
}

const INITIAL: Freshness = {lastOkAt: null, lastErrorAt: null, consecutiveFailures: 0};

let state: Freshness = INITIAL;
const listeners = new Set<() => void>();

function emit(next: Freshness): void {
  state = next;
  for (const l of listeners) l();
}

export function recordOk(at: number = Date.now()): void {
  emit({lastOkAt: at, lastErrorAt: state.lastErrorAt, consecutiveFailures: 0});
}

export function recordError(at: number = Date.now()): void {
  emit({...state, lastErrorAt: at, consecutiveFailures: state.consecutiveFailures + 1});
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
const getSnapshot = (): Freshness => state;
// Why: the server never fetches, so its snapshot is the constant initial
// state — a stable reference keeps hydration from reporting a mismatch.
const getServerSnapshot = (): Freshness => INITIAL;

export function useFreshness(): Freshness {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
