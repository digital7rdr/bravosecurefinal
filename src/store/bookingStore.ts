import {create} from 'zustand';
import {immer} from 'zustand/middleware/immer';
import {bookingApi, type BookingCreateBody, type PayerOption} from '@services/api';
import {useWalletStore} from '@store/walletStore';
import {useAuthStore} from '@store/authStore';
import type {Booking, BookingAddOn, Location, LiveConvoy} from '@appTypes/index';
import {
  isInsufficientCreditsError,
  creditShortfallFrom,
  humanCreditMessage,
} from '@screens/booking/creditErrors';
import {clampDurationHours, hourlyDurationRule} from '@screens/booking/durationRule';
import {payerChoiceFromRefusal} from '@screens/booking/payerOptions';
import {LAUNCHED_ZONES} from '@screens/booking/launchedZones';
// E2E-29 — the ONE EUR→BC boundary for an estimate reply (pure, so the node
// `booking` project can verify it without loading the API layer).
import {estimateBc} from '@screens/booking/pricing';

export type ServiceKey =
  | 'secure_transfer'
  | 'executive_protection'
  | 'recon_team'
  | 'emergency_extraction';

export type BookingMode = 'now' | 'later';

interface BookingDraft {
  type: Booking['type'];
  pickup: Location | null;
  dropoff: Location | null;
  start_time: string;
  duration_hours: number;
  selected_add_ons: string[];
  payment_method: Booking['payment_method'];
  region: string;
  notes: string;
  /** Issue 28 — optional partner / preferred-provider code (attribution only). */
  referral_code: string;
  estimated_price: number | null;
  // ─── Lite booking wizard state (HTML flow) ──────────────────────
  zone_code: string;                 // e.g. 'AE', 'SA'
  zone_label: string;                // e.g. 'UAE — Dubai, Abu Dhabi, Sharjah'
  /** B-789b — the zone's fixed UTC offset; schedule pickers are read in THIS
   *  clock, not the device's. null = unknown = device clock. */
  zone_utc_offset_hours: number | null;
  service: ServiceKey;               // current service choice
  mode: BookingMode;                 // now vs later
  passengers: number;                // excl. CPO + driver
  cpo_count: number;                 // team counter
  vehicle_count: number;             // team counter
  driver_only: boolean;              // client provides vehicle
  addon_switches: Record<string, boolean>; // {female_cpo:true, recon:true,...}
  // Step 22 — explicit, opt-in consent to share live location with the assigned
  // agency + accept the dispatch terms. Required by the server on the auto path
  // (lawful basis); the review screen gates the "Find an agency" CTA on it.
  location_consent: boolean;
  // ─── Executive Protection (service 'executive_protection') ──────────────────────────────────────────
  /** What the protection detail is for (site_protection / event_security / …). */
  task_type: string;
  /** Optional secure-transfer leg. 'none' = protection only, no vehicle moves. */
  transport_mode: 'none' | 'one_way' | 'return' | 'both_ways';
  transport_pickup: Location | null;
  transport_dropoff: Location | null;
  /** ISO time of the transfer pickup; '' = same as the booking start time. */
  transport_pickup_time: string;
  /**
   * B-843/A5 — WHICH account pays: a root's user id, or the member's OWN id
   * for "my wallet". `undefined` = not chosen, which is the only correct
   * default with ≥2 memberships (the server then refuses rather than guessing).
   * Not persisted (this store is immer-only) and deliberately NOT part of
   * `isBookingDraftDirty()`.
   */
  payerUserId?: string | null;
}

interface BookingState {
  bookings: Booking[];
  /**
   * The LAST booking any screen loaded. Kept for back-compat only — a customer
   * may hold several bookings at once (2026-09-04), so no screen may read this
   * for its own booking; read `bookingsById[myId]` via `useBookingById`.
   */
  activeBooking: Booking | null;
  /**
   * 2026-09-04 — every booking the app has seen, keyed by id. One slot per
   * booking, so four screens polling four bookings can never overwrite each
   * other, and the stale-response guard (`updated_at`) is applied per id.
   */
  bookingsById: Record<string, Booking>;
  liveConvoy: LiveConvoy | null;
  draft: BookingDraft;
  availableAddOns: BookingAddOn[];
  isLoading: boolean;
  error: string | null;
  /**
   * B-843 — the server refused because the member is under ≥2 roots and named
   * none. This is a QUESTION, not a failure: the options live here so the
   * wizard can open the selector, and `error` stays untouched (it is rendered
   * verbatim by BookingHistoryScreen / AddOnsScreen).
   */
  payerChoiceRequired: PayerOption[] | null;
}

interface BookingActions {
  loadBookings: () => Promise<void>;
  // LB-ST4 / LB-API2 — resolves to whether the fetch succeeded so pollers can drive
  // backoff + a "reconnecting" state (it clears `error` on success and never throws).
  loadActiveBooking: (id: string) => Promise<boolean>;
  /** 2026-09-04 — the ONE duration setter; clamps into the live ops rule. */
  setDurationHours: (hours: number) => void;
  updateDraft: (updates: Partial<BookingDraft>) => void;
  /**
   * B-861 — the ONE writer for "the pick-up moved, so the zone moved with it".
   * Returns whether the zone actually changed and whether that cost the user
   * their drop-off, so the wizard can say so instead of silently emptying a row.
   */
  setPickupWithZone: (input: {
    zone_code: string;
    zone_label: string;
    region: string;
    zone_utc_offset_hours: number | null;
    pickup: Location;
  }) => {zoneChanged: boolean; dropoffCleared: boolean};
  resetDraft: () => void;
  /** Executive Protection — begin a fresh executive draft (idempotent while one is in progress). */
  startExecutiveDraft: () => void;
  estimatePrice: () => Promise<void>;
  confirmBooking: () => Promise<Booking>;
  cancelBooking: (id: string) => Promise<void>;
  loadAddOns: (region: string) => Promise<void>;
  setLiveConvoy: (convoy: LiveConvoy | null) => void;
  clearError: () => void;
  /** Wipe bookings/convoy/draft back to the empty default — called on sign-out. */
  reset: () => void;
}

/**
 * B-868 — the draft's operating zone is SEEDED, never hand-picked.
 *
 * The founder removed the zone step (`ZoneMapScreen` was the flow's head and the
 * only writer of `zone_utc_offset_hours` outside `setPickupWithZone`), so the
 * draft has to carry a real zone from the first frame or the four schedule
 * readers — CustomizeAddOns, BookingDateTime, ExecReview, ExecTransport — fall
 * back to the DEVICE clock and book the wrong hour (B-789b).
 *
 * DERIVED, never re-typed: `zone_label` becomes create()'s `region_label` on the
 * ops console and the offset is a time/money value, so a second hand-written
 * copy here is a launch-day drift waiting to happen (the reason
 * `launchedZones.ts` exists at all).
 *
 * Why the FIRST launched zone and not the device's: the store has no
 * synchronous device signal. A device region costs a permission prompt, an
 * async GPS fix and a server reverse-geocode (what `ZoneMapScreen` does with
 * `useVbgLocation` + `vbgApi.geocode`), and `defaultDraft` is a module constant
 * every `seedDraft()` clones. Making the seed async would race `resetDraft` and
 * the post-submit clear for no gain: the first CONFIRMED pick-up overrides all
 * four fields through `setPickupWithZone`, which is the founder's rule.
 */
const SEED_ZONE = LAUNCHED_ZONES[0];

const defaultDraft: BookingDraft = {
  type: 'timeslot',
  pickup: null,
  dropoff: null,
  start_time: '',
  duration_hours: 4,
  selected_add_ons: [],
  // Why: B-847 — the app has no card lane. Every booking is debited from Bravo
  // Credits (the escrow hold at agency accept, or payWithCredits), and no screen
  // ever offers a card choice, so the legacy default only mislabelled the row on
  // the ops console and Trip Summary.
  payment_method: 'bravo_credits',
  region: SEED_ZONE.code,
  notes: '',
  referral_code: '',
  estimated_price: null,
  zone_code: SEED_ZONE.code,
  zone_label: SEED_ZONE.name,
  zone_utc_offset_hours: SEED_ZONE.utcOffsetHours,
  service: 'secure_transfer',
  mode: 'now',
  passengers: 2,
  cpo_count: 1,
  vehicle_count: 1,
  driver_only: false,
  addon_switches: {},
  location_consent: false,
  task_type: 'site_protection',
  transport_mode: 'none',
  transport_pickup: null,
  transport_dropoff: null,
  transport_pickup_time: '',
  payerUserId: undefined,
};

// Step 22 — consent versions stamped on the booking so a future ToS/DPA revision
// can detect who consented under which text. Bump when the consent copy changes.
const LOCATION_CONSENT_VERSION = '2026-06-22';
const TERMS_VERSION = '2026-06-22';

/**
 * E2E-36 — the idempotency key for a create that is CURRENTLY in flight.
 *
 * Minting a fresh key per attempt meant two taps landing inside the same tick
 * sent two DIFFERENT keys, so the server saw two genuine requests; the app-level
 * one-active guard exempts parked `later` reservations, so a double-tapped
 * scheduled booking really could create two. Concurrent calls now share one key
 * (the server collapses them onto the first write); a sequential retry after the
 * first settles gets a fresh one, which is what a retry must have.
 */

/** B-790 — how long after a successful submit the draft is cleared. Longer than
 *  a stack pop transition, so the clear never shares a commit with the
 *  navigation + alert that follow the response. */
export const DRAFT_CLEAR_AFTER_SUBMIT_MS = 500;

// B-790 — at most ONE deferred clear is pending. Anything that replaces the
// draft wholesale before it lands (a new Book Now seed, resetDraft, the
// sign-out reset) SUPERSEDES it: a stale timer must never wipe a freshly seeded
// Executive draft into a Lite one, nor re-seed the previous account's zone
// after sign-out. While it is pending the draft is NOT "unsaved work" — the
// booking it describes already exists server-side.
let draftClearTimer: ReturnType<typeof setTimeout> | null = null;
let draftClearPending = false;
function cancelPendingDraftClear(): void {
  if (draftClearTimer !== null) {clearTimeout(draftClearTimer);}
  draftClearTimer = null;
  draftClearPending = false;
}
export function isDraftClearPending(): boolean {
  return draftClearPending;
}

/**
 * 2026-09-04 — ONE Idempotency-Key per draft SUBMISSION, reused on retry.
 * The key used to be minted per attempt (`Date.now()` + random), so a retry
 * after a slow network was a NEW request to the server and could file a second
 * booking. It is minted when a submission starts, kept across failures for the
 * same draft, and dropped when the booking exists or the draft is replaced.
 */
let submitKey: string | null = null;
let submitFingerprint: string | null = null;
export function currentSubmitKey(): string | null {
  return submitKey;
}
/**
 * One key per SUBMISSION BODY. The same body on a retry replays the first
 * response; a DIFFERENT body — the user changed the duration or the time after
 * a lost response — is a new submission. The server keys its replay cache on
 * actor + route + header only (the body is never hashed), so reusing the key
 * across an edit would hand back the OLD booking as if the new one were filed.
 */
function mintSubmitKey(fingerprint: string): string {
  if (!submitKey || submitFingerprint !== fingerprint) {
    submitKey = `book-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
    submitFingerprint = fingerprint;
  }
  return submitKey;
}
function dropSubmitKey(): void {
  submitKey = null;
  submitFingerprint = null;
}

/** A snapshot older than the one we hold for the SAME booking must not win. */
export function isStaleSnapshot(prev: Booking | undefined, next: Booking): boolean {
  if (!prev?.updated_at || !next.updated_at) {return false;}
  return new Date(next.updated_at).getTime() < new Date(prev.updated_at).getTime();
}

/** Fields only GET /bookings/:id returns; a list row of the SAME snapshot must not strip them. */
const DETAIL_ONLY_KEYS = ['hourly_checkins'] as const;
/**
 * A list row over the held row. Detail-only fields survive ONLY when the list
 * row is the same snapshot (same updated_at): a NEWER list row may belong to a
 * re-crewed mission whose old hours must not linger, and a blanket spread would
 * also keep keys the server has since stopped sending (no_provider_fallback
 * after a widen). The next detail poll refills what the newer row lacks.
 */
export function mergeListRow(prev: Booking | undefined, next: Booking): Booking {
  if (!prev?.updated_at || prev.updated_at !== next.updated_at) {return next;}
  const out = {...next} as Record<string, unknown>;
  const held = prev as unknown as Record<string, unknown>;
  for (const k of DETAIL_ONLY_KEYS) {
    if (out[k] === undefined && held[k] !== undefined) {out[k] = held[k];}
  }
  return out as unknown as Booking;
}

/** Selector for a screen's OWN booking — never the shared last-loaded slot. */
export const selectBookingById = (id: string | null | undefined) =>
  (s: BookingState): Booking | null =>
    (id ? (s.bookingsById[id] ?? s.bookings.find(b => b.id === id) ?? null) : null);

function seedDraft(): BookingDraft {
  // The hourly default comes from the ops board (fail-open 4), never a compiled 4.
  return {...structuredClone(defaultDraft), duration_hours: hourlyDurationRule().default};
}

export const useBookingStore = create<BookingState & BookingActions>()(
  immer((set, get) => ({
    bookings: [],
    activeBooking: null,
    bookingsById: {},
    liveConvoy: null,
    draft: seedDraft(),
    availableAddOns: [],
    isLoading: false,
    error: null,
    payerChoiceRequired: null,

    loadBookings: async () => {
      set(s => {s.isLoading = true;});
      try {
        const {data} = await bookingApi.list();
        // Audit fix 3.2 — null-guard `data.bookings`. Some error paths
        // and older API replies return `{}` or `{bookings: null}`; the
        // previous code crashed at the next `.find()` / `.unshift()`.
        // Default to [] so callers always get an iterable.
        const list = Array.isArray(data?.bookings) ? data.bookings : [];
        set(s => {
          // Per-id merge: a list row is a snapshot of that booking and must not
          // regress a fresher detail read (updated_at) the store already holds.
          for (const b of list) {
            // A list row carries no hourly_checkins and shares the detail row's
            // updated_at, so a replace would strip what only GET /bookings/:id
            // returns until the next detail poll (see mergeListRow).
            const prev = s.bookingsById[b.id];
            if (!isStaleSnapshot(prev, b)) {s.bookingsById[b.id] = mergeListRow(prev, b);}
          }
          s.bookings = list.map(b => s.bookingsById[b.id] ?? b);
        });
      } catch (e: unknown) {
        set(s => {s.error = e instanceof Error ? e.message : 'Failed to load bookings';});
      } finally {
        set(s => {s.isLoading = false;});
      }
    },

    loadActiveBooking: async (id: string) => {
      set(s => {s.isLoading = true;});
      try {
        const {data} = await bookingApi.getById(id);
        set(s => {
          // Clear a prior transient error on success so a "reconnecting" UI can drop.
          s.error = null;
          // 2026-09-04 — the response is filed under ITS OWN id. An older response
          // (slow network, two devices, a poll that raced a fresher one) never
          // overwrites a newer snapshot of the same booking; it never touches any
          // OTHER booking's slot at all.
          if (data?.id !== id || isStaleSnapshot(s.bookingsById[id], data)) {return;}
          s.bookingsById[id] = data;
          const i = s.bookings.findIndex(b => b.id === id);
          if (i >= 0) {s.bookings[i] = data;}
          s.activeBooking = data;
        });
        return true;
      } catch (e: unknown) {
        set(s => {s.error = e instanceof Error ? e.message : 'Failed to load booking';});
        return false;
      } finally {
        set(s => {s.isLoading = false;});
      }
    },

    setDurationHours: (hours: number) =>
      set(s => {
        // Executive Protection has its own grid and its own screen; this setter is
        // the hourly services' stepper.
        if (s.draft.service === 'executive_protection') {return;}
        s.draft.duration_hours = clampDurationHours(hours);
      }),

    updateDraft: (updates: Partial<BookingDraft>) =>
      set(s => {
        // Why: a pickup/dropoff belongs to a specific operating zone. If the zone
        // changes, a stale pickup from the old country would pin the LocationPicker
        // to that country (it centres on the existing pickup) and mis-scope the
        // address search — making a Dhaka pickup unselectable after an AE draft.
        // Clear both so the next pick re-centres on the newly-chosen zone.
        if (updates.zone_code && updates.zone_code !== s.draft.zone_code) {
          s.draft.pickup = null;
          s.draft.dropoff = null;
        }
        Object.assign(s.draft, updates);
      }),

    /**
     * B-861 — the zone FOLLOWS the pick-up pin now, which puts the hook above
     * directly in the way: it nulls `pickup` and `dropoff` on a zone change.
     * That is still the right rule (a stale pin from the other country would
     * re-centre and mis-scope the next picker), so this does not weaken it — it
     * writes both halves in ONE patch, so the clear runs against the OLD pin
     * and `Object.assign` then applies the NEW one. Two sequential calls with
     * the pickup first would throw away the pin that caused the change.
     */
    setPickupWithZone: input => {
      const prev = get().draft;
      const zoneChanged = input.zone_code !== prev.zone_code;
      const dropoffCleared = zoneChanged && prev.dropoff !== null;
      get().updateDraft({
        zone_code: input.zone_code,
        zone_label: input.zone_label,
        region: input.region,
        zone_utc_offset_hours: input.zone_utc_offset_hours,
        pickup: input.pickup,
      });
      return {zoneChanged, dropoffCleared};
    },

    resetDraft: () => {
      cancelPendingDraftClear(); // B-790 — this replaces the draft; the stale timer must not.
      dropSubmitKey();            // a new draft is a new submission
      // Audit fix 3.2 — deep-clone defaultDraft. The shallow `{...defaultDraft}`
      // copied the reference to `addon_switches` (a nested object), which
      // meant any mutation in the wizard ended up modifying the module-level
      // `defaultDraft` constant for the rest of the app's lifetime. Use
      // structuredClone for a one-call deep copy; safe in RN 0.72+.
      set(s => {s.draft = seedDraft();});
    },

    startExecutiveDraft: () => {
      cancelPendingDraftClear(); // B-790 — a fresh Executive seed supersedes the pending clear.
      dropSubmitKey();
      set(s => {
        // Re-entering the executive entry screen (back-nav mid-wizard) must not wipe
        // in-progress selections — only a cross-product entry resets.
        if (s.draft.service === 'executive_protection') {return;}
        // Why: a stale Lite pickup/dropoff/notes must not leak into an executive
        // booking; the operating zone survives because it is the DRAFT's, seeded
        // at `defaultDraft` and re-derived by the next pick-up pin (B-868 — the
        // header chip only reports it). Same rule as confirmBooking's
        // post-submit clear.
        const {zone_code, zone_label, region, zone_utc_offset_hours} = s.draft;
        s.draft = {
          ...structuredClone(defaultDraft),
          zone_code, zone_label, region, zone_utc_offset_hours,
          service: 'executive_protection',
          type: 'timeslot',
          // executive defaults: first fixed block; vehicles exist only when the
          // optional secure-transfer leg is added later in the wizard.
          duration_hours: 3,
          vehicle_count: 0,
        };
      });
    },
    estimatePrice: async () => {
      const {draft} = get();
      if (!draft.pickup) {return;}
      try {
        const {data} = await bookingApi.estimatePrice({
          type: draft.type,
          // 'executive_protection' selects the per-unit fixed-block formula server-side; the
          // Lite formula would misquote an executive draft by up to ±37%.
          service: draft.service,
          duration_hours: draft.duration_hours,
          add_ons: draft.selected_add_ons,
          region: draft.region,
          // Pass the full team context so the estimate reflects extra CPOs /
          // vehicles, the driver-only discount, and the peak-hour surcharge —
          // these all change the price server-side (pricing.service.ts) but
          // were previously dropped, so the estimate ignored them.
          cpo_count: draft.cpo_count,
          vehicle_count: draft.vehicle_count,
          driver_only: draft.driver_only,
          // Without passengers the server's seat-cap / capacity mirrors default
          // to 1 and can never fire, so "estimate mirrors create" was nominal.
          passengers: draft.passengers,
          pickup_time: draft.start_time || undefined,
          // E2E-27 — price the quote in the region the CHARGE is derived from
          // (regionFromPoint on the pickup), not the dispatch region chip.
          pickup: {latitude: draft.pickup.latitude, longitude: draft.pickup.longitude},
        });
        // E2E-29 — `estimated_price` is compared against `bravo_credits` and
        // rendered "BC", so it must be the BC figure. `total` is EUR; they
        // coincide only while eur_per_bc is 1.0.
        set(s => {s.draft.estimated_price = estimateBc(data); s.error = null;});
      } catch (e: unknown) {
        // Audit fix 3.2 — surface estimate failures so the UI can warn
        // the user that the price might be stale. Was silently swallowed.
        const ax = e as {response?: {data?: {message?: string | string[]}}; message?: string};
        const apiMsg = ax?.response?.data?.message;
        const friendly = Array.isArray(apiMsg) ? apiMsg.join(' · ')
          : apiMsg
          ?? (e instanceof Error ? e.message : 'Estimate unavailable');
        set(s => {s.error = friendly;});
      }
    },

    confirmBooking: async () => {
      const {draft} = get();
      if (!draft.pickup) {throw new Error('Pickup location required');}
      const body: BookingCreateBody = {
        type: draft.type,
        pickup: draft.pickup,
        dropoff: draft.dropoff ?? undefined,
        start_time: draft.start_time,
        duration_hours: draft.duration_hours,
        add_ons: draft.selected_add_ons,
        payment_method: draft.payment_method,
        region: draft.region,
        region_label: draft.zone_label,
        service: draft.service,
        booking_mode: draft.mode,
        passengers: draft.passengers,
        cpo_count: draft.cpo_count,
        vehicle_count: draft.vehicle_count,
        driver_only: draft.driver_only,
        notes: draft.notes,
        referral_code: draft.referral_code.trim() || undefined,
        // B-843/A16 — snake_case, like its DTO siblings. Absent when the member
        // chose nothing, which lets the server default (0 or 1 membership) or
        // refuse with PAYER_CHOICE_REQUIRED (≥2) instead of guessing a root.
        payer_user_id: draft.payerUserId ?? undefined,
      };
      // Executive Protection — task + optional secure-transfer leg ride the same payload.
      if (draft.service === 'executive_protection') {
        body.task_type = draft.task_type;
        if (draft.transport_mode !== 'none' && draft.transport_pickup && draft.transport_dropoff) {
          body.exec_transport = {
            mode: draft.transport_mode,
            pickup: draft.transport_pickup,
            dropoff: draft.transport_dropoff,
            pickup_time: draft.transport_pickup_time || undefined,
            passengers: draft.passengers,
          };
        }
      }
      // Bug 1: server-driven auto-dispatch flag (replaces the build-time AUTO_DISPATCH constant).
      // Read from the auth store; fail-closed to legacy when /auth/me hasn't confirmed it.
      const autoDispatch = useAuthStore.getState().user?.auto_dispatch_enabled === true;
      // Step 22 — lawful-basis consent. Only the auto path shares precise location
      // with a third-party agency, so the server requires it there; we stamp the
      // versioned consent the user gave on the review screen. (Legacy path omits it.)
      if (autoDispatch) {
        if (draft.location_consent !== true) {
          const err: Error & {code?: string} = new Error('consent_required');
          err.code = 'consent_required';
          throw err;
        }
        body.location_consent = true;
        body.terms_accepted = true;
        body.location_consent_version = LOCATION_CONSENT_VERSION;
        body.terms_accepted_version = TERMS_VERSION;
      }
      // Step 19 — auto-dispatch (DARK behind AUTO_DISPATCH). The affordability check is
      // ADVISORY: escrow only charges when an agency accepts, so a short balance is routed
      // to the paywall pre-dispatch rather than blocking. Skipped when the balance isn't
      // loaded (never block on unknown state — accept-time is the authoritative guard). The
      // typed error is thrown BEFORE the try so the screen can route it to CreditPaywall.
      if (autoDispatch) {
        const bal = useWalletStore.getState().balance;
        const estimate = draft.estimated_price ?? 0;
        if (bal && estimate > 0 && bal.bravo_credits < estimate) {
          const err: Error & {code?: string; amountDue?: number} = new Error('insufficient_credits');
          err.code = 'insufficient_credits';
          err.amountDue = Math.ceil(estimate - bal.bravo_credits);
          throw err;
        }
      }
      set(s => {s.isLoading = true; s.error = null; s.payerChoiceRequired = null;});
      try {
        // Auto: create + start the matchmaker server-side (→ DISPATCHING / NO_PROVIDER).
        // Legacy: create → PENDING_OPS. Both carry ONE Idempotency-Key per draft
        // submission (2026-09-04) — minted once, REUSED on retry — so a double-tap
        // or a network-blip retry replays the first response instead of creating a
        // second booking. The server-side one-active guard is gone (a customer may
        // hold several bookings), so this key IS the double-submit protection.
        const key = mintSubmitKey(JSON.stringify(body));
        const {data} = autoDispatch
          ? await bookingApi.requestAuto(body, key)
          : await bookingApi.create(body, key);
        dropSubmitKey(); // the booking exists — the next draft is a new submission
        // Audit fix 3.2 — dedup by id. A retry path or an out-of-order
        // loadBookings() can race confirmBooking and leave two rows for
        // the same booking in the list; check before unshift.
        set(s => {
          s.bookingsById[data.booking.id] = data.booking;
          if (!s.bookings.some(b => b.id === data.booking.id)) {
            s.bookings.unshift(data.booking);
          }
        });
        // B-91 M3 R5 — the wizard's work is now server-side; clear the draft so
        // it stops reading as "unsaved booking" forever (drafts previously
        // lingered until sign-out). Zone survives, INCLUDING its clock (B-789b):
        // the home region chip renders draft.zone_code.
        //
        // B-790 — cleared in its OWN commit, after the submitting screen has
        // left the tree. Clearing it synchronously here landed in the same
        // React/Fabric batch as the post-submit alert host while the review
        // screen was still mounted, and THAT batch (the chosen duration cell
        // deselecting, the consent check unmounting, the transport section
        // tearing down) is the Android "child already has a parent" fatal
        // (B-647 class). The delay clears a stack pop; a screen that is still
        // mounted after it (DISPATCHING → FindingDetail) re-renders alone.
        const {zone_code, zone_label, region, zone_utc_offset_hours} = get().draft;
        cancelPendingDraftClear();
        draftClearPending = true;
        draftClearTimer = setTimeout(() => {
          draftClearTimer = null;
          draftClearPending = false;
          set(s => {
            s.draft = {...seedDraft(), zone_code, zone_label, region, zone_utc_offset_hours};
          });
        }, DRAFT_CLEAR_AFTER_SUBMIT_MS);
        return data.booking;
      } catch (e: unknown) {
        // Axios's default `error.message` is the unhelpful "Request failed
        // with status code 400" — the real reason from NestJS lives at
        // `error.response.data.message` (string or string[] depending on
        // whether the validation pipe or a manual throw produced it).
        // Surface that so the user sees "You already have an active
        // booking…" instead of a status code.
        const ax = e as {
          response?: {data?: {code?: string; message?: string | string[]; booking_id?: string}};
          message?: string;
        };
        const errBody = ax?.response?.data;
        const apiMsg = errBody?.message;
        const raw = Array.isArray(apiMsg) ? apiMsg.join(' · ')
          : apiMsg
          ?? (e instanceof Error ? e.message : 'Booking failed');
        // Issue 25 — `error` is rendered verbatim (BookingHistoryScreen,
        // AddOnsScreen), so a raw server CODE must never land in it.
        const friendly = humanCreditMessage(raw) ?? raw;
        // B-843 — "which account pays?" is a question the selector answers, not
        // a failure banner. Park the server's own options and leave `error`
        // alone; every other refusal behaves exactly as before.
        const needsPayerChoice = errBody?.code === 'PAYER_CHOICE_REQUIRED';
        const payerOptions = needsPayerChoice ? payerChoiceFromRefusal(e) : null;
        set(s => {
          if (needsPayerChoice) {
            s.payerChoiceRequired = payerOptions;
          } else {
            s.error = friendly;
          }
        });
        // Issue 25 — this used to `throw new Error(friendly)`, which discarded
        // the structured body. Every caller branch that keyed off the server's
        // `code` (insufficient_credits, active_booking_exists) was therefore
        // dead, and the raw code fell through to a "Booking failed" alert.
        // Carry the fields callers actually branch on. Detection runs against
        // the ORIGINAL error, which still has the response body.
        const out: Error & {
          code?: string; amountDue?: number; bookingId?: string;
          response?: {data?: unknown};
        } = new Error(friendly);
        // B-843 P0-1 — carry the BODY, not just the code. Every B-843 reader
        // (`payerRefusalMessage`, `payerChoiceFromRefusal`, `holderFrom`) and
        // the older `quotaFiguresFrom` read `response.data`; with only the code
        // copied across they were blind on the create path, so a root-short
        // `insufficient_credits` (`payer_is_self:false`) fell through the payer
        // check into the top-up paywall — the member funding their own wallet
        // for a booking a ROOT is paying (B-384's loop). The OpsRoom path never
        // had this hole because it reads the raw axios error.
        if (errBody) {out.response = {data: errBody};}
        if (isInsufficientCreditsError(e)) {
          out.code = 'insufficient_credits';
          const short = creditShortfallFrom(e);
          if (short !== undefined) {out.amountDue = short;}
        } else if (errBody?.code) {
          out.code = errBody.code;
        }
        if (errBody?.booking_id) {out.bookingId = errBody.booking_id;}
        throw out;
      } finally {
        // A settled attempt releases the key: the NEXT create is a new request,
        // not a retry of this one.
        set(s => {s.isLoading = false;});
      }
    },

    cancelBooking: async (id: string) => {
      await bookingApi.cancel(id);
      set(s => {
        const booking = s.bookings.find(b => b.id === id);
        if (booking) {booking.status = 'CANCELLED';}
        const own = s.bookingsById[id];
        if (own) {own.status = 'CANCELLED';}
      });
    },

    loadAddOns: async (region: string) => {
      const {data} = await bookingApi.getAddOns(region);
      set(s => {s.availableAddOns = data;});
    },

    setLiveConvoy: (convoy: LiveConvoy | null) =>
      set(s => {s.liveConvoy = convoy;}),

    // Legacy `loadJobRequests` / `acceptJob` / `declineJob` removed.
    // They hit /agent/jobs* endpoints that the auth-service never
    // exposed. The live job-feed flow lives on `JobMarketplaceScreen`
    // calling `agentApi.getAvailableJobs` and `applyToJob` / `withdrawApplication`.

    clearError: () => set(s => {s.error = null;}),

    reset: () => {
      cancelPendingDraftClear(); // B-790 — sign-out must never re-seed the previous account's zone.
      dropSubmitKey();
      set(s => {
      s.bookings = [];
      s.activeBooking = null;
      s.bookingsById = {};
      s.liveConvoy = null;
      s.draft = seedDraft();
      s.availableAddOns = [];
      s.isLoading = false;
      s.error = null;
      s.payerChoiceRequired = null;
      });
    },
  })),
);

/**
 * B-91 M3 R5 — does the booking WIZARD hold user-entered work that a product
 * switch would silently discard? Keyed on genuinely user-entered fields (the
 * zone/service defaults the home screen itself writes don't count). An
 * IN-FLIGHT booking is deliberately NOT "dirty": the server owns it and the
 * dashboard restores it on return.
 */
/** 2026-09-04 — a screen's OWN booking, by id. Never the shared last-loaded slot. */
export function useBookingById(id: string | null | undefined): Booking | null {
  return useBookingStore(selectBookingById(id));
}

export function isBookingDraftDirty(): boolean {
  // B-790 — a draft whose booking was just created is not unsaved work, even
  // though its fields are still populated for the deferred-clear window.
  if (draftClearPending) {return false;}
  const d = useBookingStore.getState().draft;
  return (
    d.pickup !== null ||
    d.dropoff !== null ||
    d.start_time !== '' ||
    d.selected_add_ons.length > 0 ||
    d.notes !== '' ||
    d.referral_code !== ''
  );
}
