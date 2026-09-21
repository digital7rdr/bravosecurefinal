/**
 * B-843/A5 — the "Pay from" state, once, for every screen that commits to
 * Bravo Credits (CustomizeAddOns, AddOns, ExecReview) and for the legacy
 * auto-debit (OpsRoomReview).
 *
 * Three screens hand-rolling this is exactly the duplicate-copy class this
 * repo keeps paying for, and the parts that are easy to get subtly wrong are
 * the ones that decide where money lands:
 *
 *  · The pre-fill runs ONCE and stops for good after a refusal. Re-filling the
 *    root the server just refused would put the member in a loop where every
 *    Continue re-aims at the same dead account.
 *  · `blocked` is what disables Continue: with ≥2 roots there is no safe
 *    default, and after a refusal there is no safe default either.
 *  · The server's own `options[]` REPLACE the fetched list when a refusal
 *    carries them — the server has just re-read the rows under lock, so it is
 *    the fresher truth.
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import {familyApi, type FamilyMembership} from '@services/api';
import {useAuthStore} from '@store/authStore';
import {useWalletStore} from '@store/walletStore';
import {useBookingStore} from '@store/bookingStore';
import {
  buildPayerChoices,
  defaultPayerChoice,
  payerChoiceFromRefusal,
  payerRefusalMessage,
  type PayerMembershipInput,
} from './payerOptions';

/**
 * Every root this person is a member of. `memberships()` is the B-843 read;
 * a ≤1.0.306 server 404s it, so the single-membership read is the fallback and
 * a member with one root behaves exactly as before.
 */
export function useFamilyMemberships(): {
  memberships: PayerMembershipInput[];
  loading: boolean;
  /**
   * P2-7 — did `/family/memberships` answer? Only then can the server honour a
   * chosen payer: a ≤1.0.306 server strips `payer_user_id` through
   * `whitelist: true` and charges its own default, so offering a choice there
   * would let a member pick "My wallet" and still be billed to the root.
   */
  supported: boolean;
} {
  const [memberships, setMemberships] = useState<PayerMembershipInput[]>([]);
  const [supported, setSupported] = useState(false);
  const [loading, setLoading] = useState(true);
  // N7 — one live run per mount; a re-render must not re-fetch.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) {return undefined;}
    started.current = true;
    let alive = true;
    void (async () => {
      try {
        const {data} = await familyApi.memberships();
        const list = Array.isArray(data?.memberships) ? data.memberships : null;
        if (!list) {throw new Error('memberships_unavailable');}
        if (alive) {setMemberships(list); setSupported(true);}
      } catch {
        try {
          const {data} = await familyApi.membership();
          const one: FamilyMembership | null = data?.membership ?? null;
          // `supported` stays false: this is the OLD read, and the roster it
          // gives is display-only. The member keeps today's behaviour exactly.
          if (alive) {setMemberships(one ? [one] : []);}
        } catch {
          // Offline or signed out — no selector rather than a wrong one.
          if (alive) {setMemberships([]);}
        }
      } finally {
        if (alive) {setLoading(false);}
      }
    })();
    return () => { alive = false; };
  }, []);

  return {memberships, loading, supported};
}

export interface PayerChoiceState {
  memberships: PayerMembershipInput[];
  selfUserId: string;
  selfBalance: number;
  /** The chosen payer's user id, straight off the booking draft. */
  value: string | null | undefined;
  choose: (holderId: string) => void;
  /** The selector has something to ask — mount it. */
  visible: boolean;
  /** Continue / Pay must stay disabled while this is true. */
  blocked: boolean;
  /**
   * Feed a failed `confirmBooking()` in. Returns the line to show when the
   * refusal was about WHO pays (and re-opens the choice); null otherwise, in
   * which case the caller's existing handling stands unchanged.
   */
  noteRefusal: (e: unknown) => string | null;
}

export function usePayerChoice(): PayerChoiceState {
  const {memberships: fetched, supported} = useFamilyMemberships();
  const [refused, setRefused] = useState<PayerMembershipInput[] | null>(null);
  const [locked, setLocked] = useState(false);
  const selfUserId = useAuthStore(s => s.user?.id ?? '');
  const selfBalance = useWalletStore(s => s.balance?.bravo_credits ?? 0);
  const value = useBookingStore(s => s.draft.payerUserId);
  const updateDraft = useBookingStore(s => s.updateDraft);
  // The store's record of the server having asked, so a screen that re-mounts
  // after the refusal still offers the accounts the SERVER named. Cleared at
  // the start of the next submit, so it can never outlive its question.
  const asked = useBookingStore(s => s.payerChoiceRequired);
  // The server's own refusal options outrank the list this screen fetched: it
  // just re-read those rows under lock. P2-10 — they are also the roster of
  // LAST resort, so an offline boot followed by a refusal still has something
  // to render instead of blocking a button with no answer on screen.
  const refusalOptions = refused ?? asked ?? null;
  const memberships = refusalOptions ?? fetched;
  // P2-7 — a choice is only real when the server can act on it: either it
  // answered the new read, or it has just asked us the question itself.
  const choiceOffered = refusalOptions !== null || supported;
  // P2-5 — "is there a safe default?" is the SAME question the pre-fill asks,
  // asked once so the two can never disagree. A single held/suspended root has
  // no safe default, and shipping no `payer_user_id` there makes the server
  // resolve to self and charge the member's own wallet.
  const noSafeDefault =
    defaultPayerChoice(buildPayerChoices({selfUserId, selfBalance, memberships})) === null;

  useEffect(() => {
    if (!choiceOffered || locked || asked || value || memberships.length === 0) {return;}
    const pick = defaultPayerChoice(
      buildPayerChoices({selfUserId, selfBalance, memberships}),
    );
    if (pick) {updateDraft({payerUserId: pick.holderId});}
  }, [choiceOffered, locked, asked, value, memberships, selfUserId, selfBalance, updateDraft]);

  const choose = useCallback(
    (holderId: string) => { updateDraft({payerUserId: holderId}); },
    [updateDraft],
  );

  const noteRefusal = useCallback((e: unknown): string | null => {
    const message = payerRefusalMessage(e);
    if (!message) {return null;}
    const options = payerChoiceFromRefusal(e);
    if (options) {setRefused(options);}
    // The refused choice is cleared AND the pre-fill is retired: re-selecting
    // the account the server just turned down is a loop, not a default.
    setLocked(true);
    updateDraft({payerUserId: undefined});
    return message;
  }, [updateDraft]);

  return {
    memberships,
    selfUserId,
    selfBalance,
    value,
    choose,
    visible: choiceOffered && memberships.length > 0,
    // Blocked only while there is a question the member can actually answer:
    // rows to choose from, a server that can honour the pick, and no safe
    // default (≥2 roots is one case of that) or a refusal that retired it.
    // With NO rows the button stays usable — a locked CTA with no selector on
    // screen is a dead end, and the refusal message is the member's signal.
    blocked: choiceOffered && memberships.length > 0 && !value && (noSafeDefault || locked),
    noteRefusal,
  };
}
