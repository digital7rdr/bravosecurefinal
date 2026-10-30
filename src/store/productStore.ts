import {create} from 'zustand';
import {persist, createJSONStorage} from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * productStore (B-91 M0) — which of the three standalone Bravo products the
 * client is currently living in: Messenger, Secure Services or Virtual
 * Bodyguard. Spec v2.0: the active product persists across launches and the
 * app reopens straight into it; switching products is a deliberate act
 * (Profile → Switch Dashboard) that remounts the product shell, which resets
 * the previous product's navigation stack structurally.
 *
 * `pendingProduct` carries the card the user tapped on the pre-auth product
 * selector through the signup flow; the client shell adopts it on first
 * mount after auth. Only CLIENT accounts consult this store — agent/CPO/
 * agency shells are chosen by `resolveAuthedRoute` before it is read.
 */
export type BravoProduct = 'messenger' | 'secure' | 'vbg';

/**
 * 2026-10-31 (owner) — the four doors on the pre-auth welcome page: Messenger,
 * Secure Services, Workspace and Bravo GeoRisk. Workspace is not a product of
 * its own (it lives inside Messenger), so it maps to pendingProduct
 * 'messenger' and only decides which plan cards the next screen shows.
 */
export type OnboardingPath = BravoProduct | 'workspace';

export const PRODUCT_LABELS: Record<BravoProduct, string> = {
  messenger: 'Messenger',
  secure: 'Secure Services',
  // Founder 2026-09-05 (B-802) — the product is "Bravo GeoRisk" everywhere the
  // user reads it. Keys, routes and the `vbg` code family are unchanged.
  vbg: 'Bravo GeoRisk',
};

interface ProductState {
  activeProduct: BravoProduct | null;
  pendingProduct: BravoProduct | null;
  /**
   * B-95 — true while the product gate is re-shown OVER an already-chosen
   * product (drawer "Choose dashboard" / hardware back at a product root).
   * Ephemeral by design: never persisted, so a relaunch still opens straight
   * into the active product per spec v2.
   */
  gateVisible: boolean;
  /**
   * B-352 — product to RETURN to on back at the current product's root.
   * Set only by cross-product entry points (VBG dashboard → "Secure
   * Services"); back then restores the origin product instead of ejecting to
   * the gate. Ephemeral like gateVisible: never persisted, cleared by any
   * ordinary switch, gate open, or sign-out reset.
   */
  returnProduct: BravoProduct | null;
  setActiveProduct: (p: BravoProduct, returnTo?: BravoProduct | null) => void;
  setPendingProduct: (p: BravoProduct | null) => void;
  /** Which welcome-page door was tapped (ephemeral; drives the plan cards). */
  onboardingPath: OnboardingPath | null;
  /** Welcome-page door → pendingProduct + the plan cards to show. */
  setOnboardingPath: (p: OnboardingPath) => void;
  /**
   * 2026-10-31 — a screen to open on the FIRST mount after signup (persisted
   * across OTP and restarts, like pendingProduct): 'workspace' for an
   * Enterprise company registration, so it lands on the Workspace setup.
   */
  pendingLanding: 'workspace' | null;
  setPendingLanding: (l: 'workspace' | null) => void;
  /** Re-open the post-login "where would you like to start?" gate. */
  requestGate: () => void;
  /** Close a re-opened gate and return to the current product (2026-10-25). */
  closeGate: () => void;
  /**
   * 2026-10-25 — a screen to open once the chosen product has mounted. Set by
   * the gate's Workspace card (Workspace lives inside Messenger), consumed by
   * MainNavigator. Ephemeral like gateVisible.
   */
  landing: 'workspace' | 'plans' | 'messenger' | null;
  /** With landing 'messenger': the Messenger tab to open (Calls / News). */
  landingTab: string | null;
  /**
   * 2026-10-27 (owner) — Messenger and Workspace are their own product, not a
   * screen inside Secure Services. Entering Messenger from Secure Services
   * switches the product (back then never lands on Secure Services); `tab`
   * is the Messenger tab the entry asked for.
   */
  enterMessenger: (tab?: string | null) => void;
  /** Gate → Workspace: mount Messenger, then open the Workspace hub. */
  openWorkspaceFromGate: () => void;
  clearLanding: () => void;
  /** Open the subscription plans once the client shell is mounted. */
  requestPlansLanding: () => void;
  /** First client mount after auth: promote the selector choice, if any. */
  adoptPendingProduct: () => void;
  reset: () => void;
}

export const useProductStore = create<ProductState>()(
  persist(
    (set, get) => ({
      activeProduct: null,
      pendingProduct: null,
      gateVisible: false,
      returnProduct: null,

      setActiveProduct: (p, returnTo) =>
        set({activeProduct: p, pendingProduct: null, gateVisible: false, returnProduct: returnTo ?? null}),
      setPendingProduct: p => set({pendingProduct: p}),
      onboardingPath: null,
      setOnboardingPath: p => set({onboardingPath: p, pendingProduct: p === 'workspace' ? 'messenger' : p, pendingLanding: null}),
      pendingLanding: null,
      setPendingLanding: l => set({pendingLanding: l}),

      requestGate: () => set({gateVisible: true, returnProduct: null}),
      closeGate: () => set({gateVisible: false}),
      landing: null,
      landingTab: null,
      enterMessenger: tab =>
        set({activeProduct: 'messenger', pendingProduct: null, gateVisible: false, returnProduct: null,
          landing: tab ? 'messenger' : null, landingTab: tab ?? null}),
      openWorkspaceFromGate: () =>
        set({activeProduct: 'messenger', pendingProduct: null, gateVisible: false, returnProduct: null, landing: 'workspace'}),
      clearLanding: () => set({landing: null, landingTab: null}),
      requestPlansLanding: () => set(st => ({
        landing: 'plans', gateVisible: false,
        activeProduct: st.activeProduct && st.activeProduct !== 'secure' ? st.activeProduct : 'messenger',
      })),

      adoptPendingProduct: () => {
        const {activeProduct, pendingProduct, pendingLanding} = get();
        if (!activeProduct && pendingProduct) {
          set({activeProduct: pendingProduct, pendingProduct: null,
            ...(pendingLanding ? {landing: pendingLanding, pendingLanding: null} : {})});
        }
      },

      reset: () => set({activeProduct: null, pendingProduct: null, gateVisible: false, returnProduct: null, landing: null, landingTab: null,
        onboardingPath: null, pendingLanding: null}),
    }),
    {
      name: 'bravo:product',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: s => ({activeProduct: s.activeProduct, pendingProduct: s.pendingProduct, pendingLanding: s.pendingLanding}),
    },
  ),
);

/**
 * Switch to another product. The client shell keys its subtree on
 * `activeProduct`, so this remount clears the old product's back-stack —
 * the spec's reset-on-switch rule with no reset() bookkeeping. M3 layers the
 * unsaved-booking confirm on top via `guard` (return false to abort).
 *
 * B-352 — `returnTo` marks a CROSS-PRODUCT entry (e.g. VBG dashboard →
 * "Secure Services"): back at the destination product's root then returns
 * to `returnTo` instead of ejecting to the product gate.
 */
export function switchProduct(next: BravoProduct, guard?: () => boolean, returnTo?: BravoProduct): boolean {
  // 2026-10-25 — Secure Services is for paid plans (secureServicesAccess).
  if (next === 'secure') {
    const {useAuthStore} = require('@store/authStore') as typeof import('@store/authStore');
    const access = require('@store/secureServicesAccess') as typeof import('@store/secureServicesAccess');
    if (access.secureServicesLocked(useAuthStore.getState().user)) {
      access.promptSecureServicesUpgrade(() => { useProductStore.getState().requestPlansLanding(); });
      return false;
    }
  }
  if (guard && !guard()) {return false;}
  useProductStore.getState().setActiveProduct(next, returnTo ?? null);
  return true;
}
