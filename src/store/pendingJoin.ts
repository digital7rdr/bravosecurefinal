import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * 2026-10-31 (owner) — "Enter with Code" on the pre-auth plan screen:
 *   - 'agent'     — Secure Services → Agent: a provider's single-use roster
 *                   code (POST /org/invites/redeem);
 *   - 'workspace' — Workspace → Enterprise User: a company's invite or
 *                   referral code (the JoinWorkspace screen).
 * Both need a signed-in account, so the code is carried through signup / OTP
 * (and app restarts) here, and PendingJoinHost redeems it on the first
 * signed-in mount. Same bridge pattern as pendingProvider / pendingTier.
 * Cleared once used and on sign-out.
 */
const KEY = 'auth:pending_join';

export type PendingJoinKind = 'agent' | 'workspace';
export interface PendingJoin {kind: PendingJoinKind; code: string}

/** Codes are letters, digits and dashes; anything else is stripped. */
export function normalizeJoinCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 32);
}

export const pendingJoin = {
  async set(v: PendingJoin): Promise<void> {
    try { await AsyncStorage.setItem(KEY, JSON.stringify({kind: v.kind, code: normalizeJoinCode(v.code)})); } catch { /* best-effort */ }
  },
  async get(): Promise<PendingJoin | null> {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      if (!raw) {return null;}
      const v = JSON.parse(raw) as Partial<PendingJoin>;
      return (v.kind === 'agent' || v.kind === 'workspace') && typeof v.code === 'string' && v.code
        ? {kind: v.kind, code: v.code} : null;
    } catch { return null; }
  },
  async clear(): Promise<void> {
    try { await AsyncStorage.removeItem(KEY); } catch { /* best-effort */ }
  },
};
