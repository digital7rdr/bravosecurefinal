import {create} from 'zustand';
import {persist} from 'zustand/middleware';
import {makeDebouncedJsonStorage} from './debouncedJsonStorage';

/**
 * referralStore (2026-09-05) — the referral code a deep link handed us,
 * waiting for the next booking.
 *
 * A link can arrive on a cold open before sign-in, or a week before the person
 * books, so the code is PERSISTED rather than pushed straight into the booking
 * draft (which may not exist yet, and is cleared at submit). The booking
 * screens read `pendingCode`, pre-fill the code box once, and `consume()` it
 * so it is applied to one booking, never re-applied forever.
 *
 * N8 (NAV_RAPID_USE_LOOP): the shared debounced adapter, never bare
 * createJSONStorage. Nothing here is sensitive — a code is a public promo.
 */
export interface ReferralState {
  pendingCode: string | null;
  receivedAt: string | null;
  setPending: (code: string) => void;
  consume: () => void;
}

export const useReferralStore = create<ReferralState>()(
  persist(
    set => ({
      pendingCode: null,
      receivedAt: null,
      setPending: code => set({pendingCode: code, receivedAt: new Date().toISOString()}),
      consume: () => set({pendingCode: null, receivedAt: null}),
    }),
    {
      name: 'referralStore',
      storage: makeDebouncedJsonStorage(500, 'referralStore'),
      partialize: state => ({pendingCode: state.pendingCode, receivedAt: state.receivedAt}),
    },
  ),
);
