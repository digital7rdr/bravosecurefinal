/**
 * Booking · Step 05 — Team & Add-ons
 *
 * Premium redesign (Bravo "Team Add-ons" design handoff): obsidian/cobalt
 * palette matching the rest of the booking flow. Team composition steppers
 * (CPOs, Vehicles), a "Driver Only (Client Vehicle)" toggle, a Control-Room
 * approval notice, and optional add-on rows with live +BC/hr pricing. A rate
 * bar shows the live BC/hr total; CTA submits for Ops review.
 *
 * Pricing mirrors the server (pricing.ts → pricing.service.ts): 86 BC base,
 * +25% per extra CPO/vehicle, 0.65× driver-only. Driver-only means the client
 * supplies the vehicle — Bravo dispatches a security driver but no Bravo
 * vehicle, so the vehicle stepper is locked to "Client vehicle".
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, TextInput,
  Platform, Modal, Pressable,
} from 'react-native';
import {Alert} from '@utils/alert';
import {isIdentityRequiredError, promptIdentityRequired} from '@modules/identity/identityGate';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {useNowTick} from '@hooks/useNowTick';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import DateTimePicker, {type DateTimePickerEvent} from '@react-native-community/datetimepicker';
import {openAndroidDatePicker} from '@components/booking/androidPicker';
import type {BookingStackParamList} from '@navigation/types';
import {useBookingStore} from '@store/bookingStore';
import {bookingApi} from '@services/api';
import TimeDropdownField from '@components/booking/TimeDropdownField';
import {formatTime12h, roundUpToMinuteStep} from '@components/booking/time12h';
import {rateBcPerHour, vehiclesForPassengers, nextVehicleCount, localTotalBc, estimateBc, MAX_CPOS, MAX_VEHICLES, BASE_RATE_BC} from './pricing';
import {useReferralStore} from '@store/referralStore';
import type {EstimateReferral} from '@services/api';
import {zoneWallClockToInstant, instantToZoneWallClock, zoneClockNote} from './zoneClock';
import {
  canAdvanceSchedule, deriveBookingMode, startNeedsReseed, MIN_LEAD_HOURS,
} from './scheduleGate';
import {launchedZone, launchedZonesLabel, LAUNCHED_ZONE_CODES} from './launchedZones';
import {zoneFromPickup} from '@utils/regions';
import {hourlyDurationRule, clampDurationHours, transferBlockHours} from './durationRule';
import {isInsufficientCreditsError, creditShortfallFrom, shortfallFor} from './creditErrors';
import {PayerSelector} from './PayerSelector';
import {usePayerChoice} from './usePayerChoice';
import {fmtTimeUtc} from '@utils/datetime';
import {scaleTextStyles} from '@utils/scaling';
import {useAuthStore} from '@store/authStore';
import {useWalletStore} from '@store/walletStore';
import {goBackOnce} from '@navigation/tapGuard';
import {pricingZoneKey, useServicePricing, useServicePricingStore} from '@store/servicePricingStore';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'CustomizeAddOns'>;
type Rt  = RouteProp<BookingStackParamList, 'CustomizeAddOns'>;
type IconName = React.ComponentProps<typeof Icon>['name'];

/**
 * Earliest bookable start = now + MIN_LEAD_HOURS, rounded up to the next 5-min
 * boundary.
 *
 * B-874 (founder 2026-09-14) — the E2E-10 rule that made `leadHours` a
 * PARAMETER is REVERSED: "no need to indicate anything about dispatching
 * immediately or 3 hours etc. The app must simply not allow you to select a
 * time less than 3 hours ahead." There is no second, ops-configurable floor any
 * more — one number, every account, so the picker can never offer a time the
 * server's own gate would refuse. Always CALLED, never frozen in a mount-time
 * memo: "now" moves while the screen is open.
 *
 * B-861 P2-1 — the SHARED rounder carries the seconds, so the result is never a
 * hair under the server gate. Never a local setMinutes.
 */
function earliestStart(): Date {
  return roundUpToMinuteStep(new Date(Date.now() + MIN_LEAD_HOURS * 3600_000), 5);
}

// B-861 — the OPERATING ZONE tiles are gone (founder 2026-09-11: "the operating
// zone will be chosen dynamically when the user selects their pick-up
// location"). Wave 5b's local `ZONES` copy moved to `launchedZones.ts`, which
// ZoneMapScreen's REGION_SEED now derives from too, so the `zone_label` written
// here and there stays byte-identical whichever surface set the zone.

// Design tokens (Bravo "Team Add-ons" handoff — obsidian/cobalt premium).
// Issue 29 — matches nothing server-side today; a generous cap that keeps a
// paste-bomb out of the booking row.
const NOTES_MAX = 500;

const D = {
  bg:         '#07090D',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  textFaint:  'rgba(180,188,204,0.28)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  accentSoft: '#A9C5FF',
  amber:      '#F5C76B',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

/**
 * The LocationPicker merge-param contract. `pickedCountry` is B-861's addition
 * and is deliberately NOT on `BookingStackParamList`: `src/navigation/types.ts`
 * is owned by another packet, so the reader widens locally instead.
 */
type PickedLocationParams = {
  pickedAddress?: string;
  pickedLat?: number;
  pickedLng?: number;
  pickedKind?: 'pickup' | 'dropoff';
  pickedAt?: number;
  pickedCountry?: string;
};

interface AddOnDef {
  key: string;
  title: string;
  desc: string;
  icon: IconName;
  /** Per-hour price in BC (1:1 with EUR in Phase 1). */
  priceHourly: number;
}

// Offline fallback ONLY — the live catalogue (`/bookings/add-ons`) is authoritative
// and ops-editable. These prices mirror the LITE seed in
// 20260423113000_booking_module.sql; they used to carry the EXECUTIVE table
// (120/100/90/75), which over-stated every Lite add-on ~4× whenever the fetch failed.
const ADDONS: AddOnDef[] = [
  {key: 'female_cpo', title: 'Female CPO Team', desc: 'Female close protection officer(s)', icon: 'account',       priceHourly: 30},
  {key: 'recon',      title: 'Recon Team',      desc: 'Area sweep & route assessment',      icon: 'radar',         priceHourly: 25},
  {key: 'medical',    title: 'Medical Support', desc: 'Paramedic on standby',               icon: 'medical-bag',   priceHourly: 22},
  {key: 'comms',      title: 'ESCM',            desc: 'Electronic Surveillance Counter Measures', icon: 'cellphone-key', priceHourly: 18},
];

export default function CustomizeAddOnsScreen() {
  // Live ops-editable pricing (founder 2026-08-26): subscribe so a
  // hydration re-renders the quote; load is single-flight + fail-open.
  // OP-01/OP-08 — the board for THIS zone, keyed the way the charge is (by
  // the pickup point once set), reloaded on every focus.
  useServicePricing({
    region: useBookingStore(st => st.draft.region),
    lat: useBookingStore(st => st.draft.pickup?.latitude ?? null),
    lng: useBookingStore(st => st.draft.pickup?.longitude ?? null),
  });
  // E2E-33 — the region the CHARGE prices in, as resolved by the server from
  // the pickup point. `draft.region` is the dispatch CHIP (defaults 'AE'), the
  // one field create() ignores, so keying the peak mirror on it quoted the
  // wrong local clock for any pickup outside the chosen chip.
  const pricedRegion = useServicePricingStore(st => st.pricedRegion);
  // …and WHICH point that answer was fetched for. `pricedRegion` is store
  // state read at render and is nulled only inside `load()`, so on the commit
  // where the pin moves the board on screen is still the PREVIOUS pin's.
  const pricedZoneKey = useServicePricingStore(st => st.zone);

  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const updateDraft = useBookingStore(st => st.updateDraft);
  // B-861 A6 — the ONE writer that moves the zone WITH the pin (the store's
  // zone-change hook would otherwise null the pin that caused the change).
  const setPickupWithZone = useBookingStore(st => st.setPickupWithZone);
  const setDurationHours = useBookingStore(st => st.setDurationHours);
  const draft = useBookingStore(st => st.draft);
  const confirmBooking = useBookingStore(st => st.confirmBooking);
  const availableAddOns = useBookingStore(st => st.availableAddOns);
  const loadAddOns = useBookingStore(st => st.loadAddOns);
  const [submitting, setSubmitting] = useState(false);
  // E2E-36 — a REF, not the `submitting` state. `disabled={ctaBlocked}` needs a
  // committed re-render, which lands late exactly when the JS thread is backed
  // up, and every queued repeat here is a booking. Same idiom as
  // CreditPaywallScreen's processingRef; reset in `finally` so a throw cannot
  // latch the button dead.
  const submitGuard = useRef(false);
  // Bug 1: server-driven auto-dispatch flag (replaces the build-time AUTO_DISPATCH
  // constant). Reactive selector — it also decides the lead rule (E2E-10) and the
  // location-consent gate.
  const autoDispatch = useAuthStore(s => s.user?.auto_dispatch_enabled === true);

  // B-385 — the catalogue is OPS-EDITABLE (lite_booking_add_ons) and the server
  // now REJECTS an id it can't resolve, so the screen must both take live prices
  // AND drop de-listed rows. Merging alone left a de-listed add-on selectable and
  // turned the wizard into a dead end at submit. The catalogue is region-scoped
  // server-side, so fetch with the SAME region create() validates against.
  const addOnRegion = draft.region || draft.zone_code || 'AE';
  useEffect(() => { void loadAddOns(addOnRegion).catch(() => undefined); }, [loadAddOns, addOnRegion]);
  const liveAddOns = useMemo(() => {
    const byId = new Map(availableAddOns.map(a => [a.id, a]));
    // Offline / failed fetch → keep the compiled list (better than an empty screen).
    if (byId.size === 0) {return ADDONS;}
    return ADDONS.filter(a => byId.has(a.key)).map(a => {
      const livePrice = Number(byId.get(a.key)?.price_eur_per_hour);
      return Number.isFinite(livePrice) && livePrice > 0 ? {...a, priceHourly: livePrice} : a;
    });
  }, [availableAddOns]);

  // A row that vanished from the catalogue must not stay silently selected —
  // create() would 400 `unknown_add_on` on a toggle the user can no longer see.
  useEffect(() => {
    const selected = Object.entries(draft.addon_switches ?? {}).filter(([, v]) => v).map(([k]) => k);
    if (selected.length === 0) {return;}
    const allowed = new Set(liveAddOns.map(a => a.key));
    const stale = selected.filter(k => !allowed.has(k));
    if (stale.length === 0) {return;}
    const next = {...(draft.addon_switches ?? {})};
    for (const k of stale) {delete next[k];}
    updateDraft({addon_switches: next});
  }, [liveAddOns, draft.addon_switches, updateDraft]);

  const {cpo_count, vehicle_count, driver_only, addon_switches, passengers} = draft;

  // Passengers set the vehicle floor (1 per 3 pax). The user can add vehicles
  // but not drop below what the party physically needs.
  const minVehicles = vehiclesForPassengers(passengers);

  // B-864 — ONE ceiling, in both modes. The client's own car used to cap CPOs
  // at its free seats, which killed the + button at 1 CPO for a party of four.
  // Bravo still adds no vehicle in driver-only mode; the RATE carries the extra
  // CPOs instead (25% of base each past the first).
  const maxCpos = MAX_CPOS;

  /**
   * B-787 — the vehicle count the USER picked on the stepper, or null while it
   * is still auto-derived from the party size.
   *
   * Without this the count could only be told apart from the passenger-derived
   * floor by comparing against that floor, which made the sync a ONE-WAY
   * RATCHET: growing the party raised the vehicles (right) and shrinking it
   * again left them raised (wrong) — the client kept paying for a vehicle the
   * party no longer needed while the banner above said "1 vehicle covers this
   * party". Seeded from the draft so a choice survives leaving and re-entering
   * the screen: a count already ABOVE the floor at mount can only have been set
   * by hand.
   */
  const chosenVehiclesRef = useRef<number | null>(
    (draft.vehicle_count ?? 1) > vehiclesForPassengers(draft.passengers)
      ? (draft.vehicle_count ?? null)
      : null,
  );

  const setCount = (k: 'cpo_count' | 'vehicle_count', d: number) => {
    const cur = (draft[k] as number) ?? 1;
    const floor = k === 'vehicle_count' ? minVehicles : 1;
    const ceil = k === 'cpo_count' ? maxCpos : MAX_VEHICLES;
    const next = Math.max(floor, Math.min(ceil, cur + d));
    // Record an explicit vehicle choice so the party-size sync below respects
    // it instead of overwriting it on the next passenger change. Stepping
    // back DOWN TO the floor is the user saying "just the minimum", so that
    // hands control back to AUTO — otherwise a later party change would pin
    // them at the OLD floor, which is the ratchet in a smaller coat.
    if (k === 'vehicle_count') {chosenVehiclesRef.current = next > floor ? next : null;}
    updateDraft({[k]: next} as never);
  };

  // Keep vehicle_count in step with the party size — in BOTH directions
  // (B-787). B-864 — the CPO count is NEVER touched here any more: with the
  // seat cap gone nothing may quietly lower a team the user chose and paid for.
  useEffect(() => {
    if (!driver_only) {
      const want = nextVehicleCount({
        passengers,
        chosen: chosenVehiclesRef.current,
        driverOnly: false,
      });
      if ((vehicle_count ?? 1) !== want) {
        updateDraft({vehicle_count: want});
      }
    }
  }, [passengers, vehicle_count, driver_only, updateDraft]);

  // Driver-only (client vehicle): the client supplies the car, so Bravo assigns
  // no vehicle. Restore the passenger-derived count when toggled off. B-864 —
  // the CPO count rides through untouched in both directions.
  const toggleDriverOnly = () => {
    const next = !driver_only;
    // B-787 — turning driver-only OFF hands the vehicle back to Bravo, so the
    // count returns to AUTO rather than to whatever was chosen before.
    if (next) {chosenVehiclesRef.current = null;}
    updateDraft({
      driver_only: next,
      vehicle_count: next ? 0 : nextVehicleCount({passengers, chosen: null, driverOnly: false}),
    });
  };

  const toggleAddon = (k: string) =>
    updateDraft({addon_switches: {...addon_switches, [k]: !addon_switches?.[k]}});

  const rateBc = useMemo(() => {
    const addOnsBcPerHour = liveAddOns.reduce(
      (sum, a) => (addon_switches?.[a.key] ? sum + a.priceHourly : sum),
      0,
    );
    return rateBcPerHour({
      cpoCount: cpo_count,
      vehicleCount: vehicle_count,
      driverOnly: driver_only,
      addOnsBcPerHour,
    });
  }, [cpo_count, vehicle_count, driver_only, addon_switches, liveAddOns]);

  // LM-M1 — the AUTHORITATIVE quote. The escrow charge is the TOTAL (rate ×
  // hours + server surcharges), but this screen previously stored the PER-HOUR
  // rate as `estimated_price`, so the paywall under-asked ~4× and the "PAID"
  // line lied. Fetch the server estimate (debounced) and always carry a TOTAL.
  // 2026-09-04 — the customer picks the hours. The rule (default / min / max)
  // comes from the ops board via durationRule.ts, never a compiled 4; the
  // server re-validates and refuses (never reprices) anything off-rule.
  //
  // B-877 (founder 2026-09-14, "set the 4 hours per region") — a Secure
  // TRANSFER is not hourly: it is billed as a fixed BLOCK of hours ops set per
  // region, so the client has no duration control and reads the block back.
  const isTransfer = draft.type === 'transfer';
  const durationRule = hourlyDurationRule();
  const [serverTotal, setServerTotal] = useState<number | null>(null);
  // B-877 — the block the SERVER resolved for this transfer, from the estimate
  // reply (`duration_hours`). The board mirror is only the pre-hydration value.
  const [serverBlock, setServerBlock] = useState<number | null>(null);
  const durationHours = isTransfer
    ? (serverBlock ?? transferBlockHours())
    : clampDurationHours(draft.duration_hours ?? durationRule.default, durationRule);
  // E2E-33 — the estimate failure used to be swallowed entirely, so an offline
  // quote was indistinguishable from a live one. The screen now says which it is.
  const [estimateFailed, setEstimateFailed] = useState(false);
  // Referral campaign (2026-09-05) — what the code did to the live quote, and
  // the pre-discount figure so the total strip can say "was X".
  const [referralQuote, setReferralQuote] = useState<EstimateReferral | null>(null);
  const [grossBc, setGrossBc] = useState<number | null>(null);
  // Declared here (not beside the code box) because the estimate effect below
  // lists it as a dependency — a later `const` would be in its TDZ at render.
  const referralCode = useBookingStore(st => st.draft.referral_code);
  // A code that arrived through a shared link pre-fills the box ONCE, then is
  // consumed so it applies to this booking and is not re-applied forever.
  const pendingReferral = useReferralStore(st => st.pendingCode);
  const consumePendingReferral = useReferralStore(st => st.consume);
  useEffect(() => {
    if (pendingReferral && !referralCode) {
      updateDraft({referral_code: pendingReferral});
      consumePendingReferral();
    }
  }, [pendingReferral, referralCode, updateDraft, consumePendingReferral]);
  const pickupLat = draft.pickup?.latitude;
  const pickupLng = draft.pickup?.longitude;
  useEffect(() => {
    let alive = true;
    setServerTotal(null);
    // Reset with the total: `estimateFailed` describes the CURRENT attempt. Left
    // set, it flashed "· OFFLINE" and the offline note through the 400 ms
    // debounce after every single stepper tap once one failure had happened.
    setEstimateFailed(false);
    const t = setTimeout(() => {
      const selected = Object.entries(addon_switches ?? {}).filter(([, v]) => v).map(([k]) => k);
      bookingApi.estimatePrice({
        type: 'transfer',
        region: draft.region,
        duration_hours: durationHours,
        add_ons: selected,
        cpo_count,
        vehicle_count,
        driver_only,
        passengers,
        pickup_time: draft.start_time || undefined,
        // Referral campaign (2026-09-05) — quoted server-side; the reply says
        // whether it applied and, if not, why.
        referral_code: referralCode.trim() || undefined,
        // E2E-27 — the point create() derives its pricing region from. Without
        // it the quote prices GLOBAL while the charge prices the region.
        ...(typeof pickupLat === 'number' && typeof pickupLng === 'number'
          ? {pickup: {latitude: pickupLat, longitude: pickupLng}}
          : null),
      })
        .then(({data}) => {
          if (!alive) {return;}
          // E2E-29 — BC, never the EUR `total`: this number is rendered "BC",
          // stored as estimated_price and compared against bravo_credits.
          const bc = estimateBc(data);
          if (bc > 0) {setServerTotal(bc); setEstimateFailed(false);}
          // B-877 — the hours the server actually quoted (the region's block for
          // a transfer). NOT reset alongside `serverTotal` at the top of this
          // effect: `durationHours` is one of its own dependencies, so clearing
          // it there would flip the dep back to the mirror and re-enter forever.
          if (typeof data.duration_hours === 'number' && Number.isInteger(data.duration_hours)
            && data.duration_hours > 0) {
            setServerBlock(data.duration_hours);
          }
          setReferralQuote(data.referral ?? null);
          setGrossBc(typeof data.gross_bc === 'number' && data.gross_bc > 0 ? data.gross_bc : null);
        })
        .catch(() => { if (alive) {setEstimateFailed(true);} }); // → the labelled local fallback below
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [cpo_count, vehicle_count, driver_only, passengers, addon_switches, durationHours,
    draft.region, draft.start_time, pickupLat, pickupLng, referralCode]);
  // B-877 — mirror the transfer BLOCK into the draft, so `confirmBooking`'s
  // `duration_hours` and the post-confirm Summary row both carry the hours the
  // server will store. Transfers only: the stepper owns the field everywhere
  // else. The inequality guard is what stops it re-entering (`durationHours`
  // for a transfer never reads `draft.duration_hours`).
  useEffect(() => {
    if (isTransfer && draft.duration_hours !== durationHours) {
      updateDraft({duration_hours: durationHours});
    }
  }, [isTransfer, draft.duration_hours, durationHours, updateDraft]);
  // E2E-33 — the offline number now mirrors the server's peak rule (17–20 local
  // to the pricing region) and its EUR→BC conversion, instead of a bare
  // rate × hours that under-quoted every evening booking by the multiplier.
  const localTotal = localTotalBc({
    rateBc,
    durationHours,
    pickupTime: draft.start_time ? new Date(draft.start_time) : null,
    // Pickup-derived first (that is what the charge uses); the chip only while
    // no pickup has been placed and no board has come back yet.
    regionCode: (draft.pickup ? pricedRegion : null) ?? draft.region,
  });
  const totalBc = serverTotal ?? localTotal;

  const selectedCount = Object.values(addon_switches ?? {}).filter(Boolean).length;
  const needsOpsApproval = cpo_count > 1 || (!driver_only && vehicle_count > 1);
  // Step 22 — the auto path shares the client's live location with the assigned
  // agency, so the CTA is gated on an explicit, opt-in consent. Legacy ops-mediated
  // bookings keep their existing implicit flow (no gate).
  const consentRequired = autoDispatch;
  const consentGiven = draft.location_consent === true;
  // The 3h-lead gate, reused verbatim: a transfer needs both ends; an hourly
  // detail needs only a pickup. Blocks the money path until the schedule is set.
  const scheduleReady = canAdvanceSchedule(draft.type, draft.pickup, draft.dropoff);
  // B-843 — a member under ≥2 roots has no safe default payer, so Continue
  // waits for the pick rather than charging one of them.
  const payer = usePayerChoice();
  const ctaBlocked = submitting || (consentRequired && !consentGiven) || !scheduleReady || payer.blocked;
  // Issue 25 — used only to compute the top-up shortfall when the server's
  // rejection didn't carry one (legacy flat 400).
  const walletCredits = useWalletStore(st => st.balance?.bravo_credits);
  const notes = useBookingStore(st => st.draft.notes);
  // Issue 29 — an hourly detail has no destination, so the brief matters more.
  // B-877 — ONE source for the same field (`isTransfer`, declared above).
  const isHourly = !isTransfer;

  // ── Schedule (folded from BookingDateTimeScreen) ─────────────────────────────
  // Pick-up + drop-off (LocationPicker modal), MISSION START and passengers.
  // pickup/dropoff/mode/passengers/start_time all write the SAME draft fields
  // the old Schedule step wrote.
  //
  // B-861 — the Book Now / Book Later segment is GONE. It only ever chose which
  // of the server's two rules applied, and the chosen time decides that on its
  // own, so `mode` is DERIVED (deriveBookingMode) and written by the same
  // effect that writes `start_time`. Nothing downstream changes: the wire, the
  // summary rows and the server all still read `booking_mode`.
  // B-789b — the booking ZONE's clock. null = unknown = the device clock (today).
  const zoneOffset = draft.zone_utc_offset_hours ?? null;
  // B-861 P1-3 — "now" moves while this screen sits open, and the derived lane
  // moves with it. Refreshed every 30 s and on every return to the foreground.
  const nowTick = useNowTick();

  /**
   * B-874 — the ONE floor: `MIN_LEAD_HOURS`, for every account. It is both the
   * picker's floor and the `booking_mode` boundary now, so a bookable time
   * always derives 'later' and there is no lane left to explain. Computed per
   * render (never memoised at mount): "now" moves while the screen is open.
   *
   * B-789b — the earliest bookable INSTANT expressed in the booking ZONE's
   * wall-clock, because that is the frame the pickers show and the frame
   * `computeStartTime` converts back from.
   */
  const earliest = instantToZoneWallClock(earliestStart(), zoneOffset);
  // One seed for all three fields — separate earliestStart() calls can straddle
  // a 5-minute boundary and seed a day from one instant and a minute from another.
  const [startPick, setStartPick] = useState<{day: Date; h: number; m: number}>(() => {
    const e = instantToZoneWallClock(earliestStart(), zoneOffset);
    return {day: e, h: e.getHours(), m: e.getMinutes()};
  });
  const startDay = startPick.day;
  const hour = startPick.h;
  const minute = startPick.m;
  const [dateOpen, setDateOpen] = useState(false);
  const [leadHint, setLeadHint] = useState<string | null>(null);
  // B-861 A6 — the store clears the drop-off when the pick-up moves the ZONE.
  // That is the right rule, but the founder must never see a row empty itself
  // with no explanation, so the writer reports it and this renders it.
  const [dropoffNotice, setDropoffNotice] = useState<string | null>(null);
  // B-861 A8 — the zone the price board resolved for this pin, adopted once.
  const [zoneHealNotice, setZoneHealNotice] = useState<string | null>(null);

  /**
   * B-861 P1-2 — the zones this wizard will accept a pick-up in.
   *
   * The compiled `LAUNCHED_ZONE_CODES` is not the whole answer: ZoneMapScreen's
   * OP-04 path appends regions ops launched AFTER this build (live from
   * `regionsAvailability`), so a user can already BE in one — and dropping it
   * here would have the picker refuse the very zone they entered through. The
   * draft's own code therefore leads the union, which also keeps A12.15's "the
   * map opens on the draft zone's hub" property.
   */
  const zoneParamCodes = useMemo(
    () => [...new Set([draft.zone_code, ...LAUNCHED_ZONE_CODES].filter(Boolean))],
    [draft.zone_code],
  );

  /**
   * B-861 P1-2 — the four draft fields for a derived code.
   *
   * A live-added region has no `launchedZone()` row, so its label and clock come
   * from what the draft already carries for it (ZoneMap wrote both off the live
   * board). The offset is KEPT, never invented: a wrong `zone_utc_offset_hours`
   * silently books the wrong hour (B-789b), and "unknown" already means "use the
   * device clock" downstream.
   */
  const zoneFieldsFor = useCallback((code: string) => {
    const z = launchedZone(code);
    if (z) {
      return {
        zone_code: z.code, zone_label: z.name, region: z.code,
        zone_utc_offset_hours: z.utcOffsetHours, display: z.country,
      };
    }
    const known = code === draft.zone_code;
    return {
      zone_code: code,
      zone_label: known ? draft.zone_label : code,
      region: code,
      zone_utc_offset_hours: known ? draft.zone_utc_offset_hours : null,
      display: known && draft.zone_label ? draft.zone_label : code,
    };
  }, [draft.zone_code, draft.zone_label, draft.zone_utc_offset_hours]);

  // When LocationPicker navigates back (merge:true) with a picked spot, write it
  // straight to the draft — the SAME {pickedAddress,pickedLat,pickedLng,
  // pickedKind,pickedAt} contract BookingDateTimeScreen used, plus B-861's
  // `pickedCountry` (untyped on the param list: navigation/types.ts is owned
  // elsewhere, so the reader widens locally).
  useEffect(() => {
    const p = route.params as PickedLocationParams | undefined;
    if (!p?.pickedAt || typeof p.pickedLat !== 'number' || typeof p.pickedLng !== 'number') {return;}
    const address = p.pickedAddress ?? 'Selected location';
    if (p.pickedKind === 'pickup') {
      // B-861 D1 — the ZONE IS THE PICK-UP'S. The geocoded country wins at the
      // AE/SA border and an unlaunched hit is refused (the picker already
      // refused it; this is the second wall, not the first).
      const code = zoneFromPickup(
        {lat: p.pickedLat, lng: p.pickedLng, country: p.pickedCountry ?? null},
        zoneParamCodes,
      );
      const pickup = {address, latitude: p.pickedLat, longitude: p.pickedLng, label: 'Pick-up'};
      if (code) {
        const z = zoneFieldsFor(code);
        const {dropoffCleared} = setPickupWithZone({
          zone_code: z.zone_code, zone_label: z.zone_label, region: z.region,
          zone_utc_offset_hours: z.zone_utc_offset_hours, pickup,
        });
        setDropoffNotice(dropoffCleared ? z.display : null);
        setZoneHealNotice(null);
      } else {
        // No launched zone for this point: keep the pin (the server is the
        // authority and refuses `pickup_outside_region` itself) and leave the
        // zone alone rather than writing one we cannot justify.
        updateDraft({pickup});
      }
    } else if (p.pickedKind === 'dropoff') {
      updateDraft({dropoff: {address, latitude: p.pickedLat, longitude: p.pickedLng, label: 'Drop-off'}});
      setDropoffNotice(null);
    }
    // Clear the params so a re-render doesn't reapply the same pick.
    navigation.setParams({
      pickedAt: undefined, pickedAddress: undefined,
      pickedLat: undefined, pickedLng: undefined, pickedKind: undefined,
      pickedCountry: undefined,
    } as never);
  }, [route.params, navigation, updateDraft, setPickupWithZone, zoneParamCodes, zoneFieldsFor]);

  /**
   * E2E-10 / B-861 — MISSION START resolves to a bookable instant.
   *
   * One path now: the date button owns the DAY and the dropdown owns h:m, so
   * `setHours` is what actually combines the user's two controls. A pick under
   * the floor means "as soon as you can", so it clamps UP to the earliest
   * bookable instant (the resolved start is rendered under the pickers, so the
   * clamp is never silent). It must NEVER roll to tomorrow: that is what made
   * every immediate "guard now" request a silent next-day reservation.
   */
  const computeStartTime = useCallback(() => {
    // B-789b — the picked wall-clock is the ZONE's. A Dubai client scheduling
    // Cape Town for 09:00 used to book 09:00 Gulf (07:00 in Cape Town).
    const floorMs = Date.now() + MIN_LEAD_HOURS * 3600_000;
    let start = new Date(startDay);
    start.setHours(hour, minute, 0, 0);
    if (zoneWallClockToInstant(start, zoneOffset).getTime() < floorMs) {
      start = instantToZoneWallClock(earliestStart(), zoneOffset);
    }
    return zoneWallClockToInstant(start, zoneOffset);
  }, [startDay, hour, minute, zoneOffset]);

  // Keep the draft's start_time AND the derived mode current so the debounced
  // estimate can factor the peak-hour surcharge — exactly as it did when the old
  // Schedule step wrote them before navigating here. Both are recomputed fresh
  // at submit against the clock at that moment.
  // P1-3, second half — `nowTick` is in this effect's dep list so it re-runs as
  // the clock moves. `computeStartTime`'s identity does not change on a tick
  // (its floor is read live from `Date.now()`), so without the dep a screen left
  // open would keep the draft on a start that has since fallen under the floor,
  // and the debounced estimate would keep pricing it.
  useEffect(() => {
    const startIso = computeStartTime();
    updateDraft({
      start_time: startIso.toISOString(),
      mode: deriveBookingMode(startIso.getTime(), nowTick),
    });
  }, [computeStartTime, updateDraft, nowTick]);

  /**
   * B-861 A12.15 — the PICK-UP picker accepts any LAUNCHED zone, passed as the
   * comma-joined list. The draft's own zone leads it, so the map still opens on
   * that hub and the Mapbox address search (`country=ae,za` — the API takes a
   * list) still ranks it first, instead of falling back to hard-coded Dubai.
   */
  const pickupZoneParam = zoneParamCodes.join(',');

  const openPicker = (kind: 'pickup' | 'dropoff') => {
    // Prefer this slot's existing pin; the drop-off falls back to the pickup so
    // the picker opens in the right country (search scoped from frame 1).
    const cur = kind === 'pickup' ? draft.pickup : (draft.dropoff ?? draft.pickup);
    navigation.navigate('LocationPicker', {
      kind,
      // A12.10 — the DROP-OFF stays walled to the DERIVED zone. The server has
      // no drop-off region check (it persists address/lat/lng only), so this is
      // the only thing keeping a cross-zone destination out of a booking.
      countryCode: kind === 'pickup' ? pickupZoneParam : (draft.zone_code || 'AE'),
      // T-6 — "accept any of these zones" is the CALLER's intent, stated
      // explicitly. Deriving it from "the list has more than one entry" made a
      // one-zone deployment silently fall back to the box-only rule. Untyped on
      // the param list on purpose: navigation/types.ts is owned elsewhere.
      ...(kind === 'pickup' ? {anyZone: true} : null),
      initial: cur ? {latitude: cur.latitude, longitude: cur.longitude, address: cur.address} : undefined,
      // Return to THIS dashboard route (merge-navigate), not the old Schedule screen.
      onPickRouteKey: 'CustomizeAddOns',
    } as BookingStackParamList['LocationPicker']);
  };

  // MISSION START — date pick and time pick both land here: snap UP to the next
  // 5-minute boundary, never under the lead (auto-correct to the earliest start
  // and say so, rather than silently booking a different time).
  //
  // B-874 — the floor is `MIN_LEAD_HOURS`, for every account ("the app must
  // simply not allow you to select a time less than 3 hours ahead"). The date
  // dialog already floors via `earliest`; the time field is the PLATFORM clock
  // (TimeDropdownField) and has no minimum on Android, so a sub-floor pick is
  // caught HERE and snapped UP to the earliest bookable instant, which the hint
  // names — never a silent different time.
  const commitStart = (picked: Date) => {
    const snapped = roundUpToMinuteStep(picked, 5);
    // B-792 — BOTH halves live in the zone frame. `picked` comes off pickers
    // that show the booking ZONE's days and times, so `snapped` is a wall-clock:
    // comparing its raw ms to an instant floor measures it by the DEVICE's
    // reading of a foreign clock (a Dubai phone booking Cape Town is 2 h out, in
    // the direction that ACCEPTS an under-lead pick), and seeding the day with a
    // raw `earliestStart()` instant puts an instant in a wall-clock slot, so the
    // auto-correct itself lands at the wrong hour. The EP twin was converted
    // with B-791; this one was missed.
    if (zoneWallClockToInstant(snapped, zoneOffset).getTime() < Date.now() + MIN_LEAD_HOURS * 3600_000) {
      const fixed = instantToZoneWallClock(earliestStart(), zoneOffset);
      setStartPick({day: fixed, h: fixed.getHours(), m: fixed.getMinutes()});
      setLeadHint(
        'Moved to the earliest available start · ' +
        `${fixed.toLocaleDateString(undefined, {weekday: 'short', day: '2-digit', month: 'short'})} · ${formatTime12h(fixed.getHours(), fixed.getMinutes())}.`,
      );
    } else {
      setStartPick({day: snapped, h: snapped.getHours(), m: snapped.getMinutes()});
      setLeadHint(null);
    }
  };

  // iOS spinner only — Android goes through openDate() below. 'set' is the only
  // action that commits: the library's dismiss path hands back the ORIGINAL date,
  // so checking `d` alone would treat Cancel as a pick.
  const onStartDateChange = (ev: DateTimePickerEvent, d?: Date) => {
    if (ev.type !== 'set' || !d) {return;}
    // The dialog moves the DAY; the time the user already chose rides along.
    const next = new Date(d);
    next.setHours(hour, minute, 0, 0);
    commitStart(next);
  };

  const onStartTimeChange = (h: number, m: number) => {
    const next = new Date(startDay);
    next.setHours(h, m, 0, 0);
    commitStart(next);
  };

  // Android opens the native dialog IMPERATIVELY from the gesture. A declarative
  // mount re-opens it on every re-render (see androidDatePicker.ts) and this
  // screen re-renders on its own debounced estimate, which snapped the calendar
  // back to `laterDate` under the user's finger.
  const openDate = () => {
    if (Platform.OS !== 'android') {setDateOpen(true); return;}
    openAndroidDatePicker({
      value: startDay,
      // B-791 (Lite twin) - the dialog shows ZONE wall-clock days, so its floor is in that frame too.
      // B-861 - the floor is the earliest bookable lead, so an on-demand booking
      // can still be placed TODAY; quoting the scheduled 3 h here would grey out
      // today whenever the clock was past 21:00 local.
      minimumDate: earliest,
      // No auto-chain into the time picker: the founder removed the ref, and a
      // second dialog springing up on its own is what made Cancel feel like a
      // loop (B-643). The user taps the time field when they want it.
      onPicked: d => {
        const next = new Date(d);
        next.setHours(hour, minute, 0, 0);
        commitStart(next);
      },
    });
  };

  const setPassengers = (delta: number) =>
    updateDraft({passengers: Math.min(12, Math.max(1, passengers + delta))});

  // "7:00 AM your time" whenever the zone's clock is not the phone's.
  const zoneNote = zoneClockNote(computeStartTime(), zoneOffset);

  // The instant MISSION START actually resolves to, for the line under the pickers.
  const nowStart = computeStartTime();
  // B-789b — the same moment in the ZONE's wall-clock, which is the frame the
  // picker directly above it uses. Reading `nowStart`'s own hours would print
  // the DEVICE's take on that instant beside a zone-local picker.
  const nowStartWall = instantToZoneWallClock(nowStart, zoneOffset);

  /**
   * B-861 A8 — self-heal #1: the SERVER's own answer for this pin.
   *
   * `pricedRegion` is `regionFromPoint(pickup)` as the price board resolved it,
   * which is the same check `create()` and the estimate run. If our bbox mirror
   * has drifted (ops moved a region box) the estimate already breaks long before
   * submit, so adopt the server's region the moment it disagrees — once per pin,
   * so a server that keeps disagreeing surfaces rather than looping.
   *
   * It must go through `setPickupWithZone`: a bare `updateDraft({zone_code})`
   * would trip the store's zone-change hook and delete the very pin being healed.
   */
  const pinKey = draft.pickup ? `${draft.pickup.latitude},${draft.pickup.longitude}` : null;
  const healedForPinKey = useRef<string | null>(null);
  useEffect(() => {
    const pickup = draft.pickup;
    if (!pinKey || !pickup || !pricedRegion) {return;}
    /**
     * The board has to be THIS PIN'S.
     *
     * Without this the commit that moves the pin to Johannesburg still sees
     * the Dubai board, adopts 'AE', clears the drop-off, says "Zone corrected
     * to UAE" — and LATCHES the pin, which then blocks both the real ZA board
     * and the submit backstop, so the booking dead-ends on "Outside our
     * operating zones" for a pin that is plainly inside one.
     *
     * It returns WITHOUT latching on purpose: this is "not yet", not "done".
     */
    if (pricedZoneKey !== pricingZoneKey({lat: pickup.latitude, lng: pickup.longitude})) {return;}
    if (healedForPinKey.current === pinKey) {return;}
    if (!zoneParamCodes.includes(pricedRegion) || pricedRegion === draft.region) {return;}
    healedForPinKey.current = pinKey;
    const z = zoneFieldsFor(pricedRegion);
    // P1-1 — the heal is a zone change like any other, so it can cost the user
    // their drop-off. Consuming the writer's answer is the only way the notice
    // can fire; discarding it is how a row empties itself in silence.
    const {dropoffCleared} = setPickupWithZone({
      zone_code: z.zone_code, zone_label: z.zone_label, region: z.region,
      zone_utc_offset_hours: z.zone_utc_offset_hours, pickup,
    });
    setDropoffNotice(dropoffCleared ? z.display : null);
    setZoneHealNotice(z.display);
  }, [pinKey, pricedRegion, pricedZoneKey, draft.region, draft.pickup, setPickupWithZone,
    zoneParamCodes, zoneFieldsFor]);

  /**
   * D3 / A12.11 — a pick-up in another zone moves the CLOCK the pickers read in.
   * The stored wall-clock is re-evaluated in the NEW zone's clock and THAT
   * instant is compared with the new earliest; re-seed only when it now sits
   * below, so a time the user deliberately chose is never overwritten.
   */
  const lastZoneOffsetRef = useRef(zoneOffset);
  useEffect(() => {
    if (lastZoneOffsetRef.current === zoneOffset) {return;}
    lastZoneOffsetRef.current = zoneOffset;
    const chosen = new Date(startDay);
    chosen.setHours(hour, minute, 0, 0);
    // T-2 — the comparison is on the INSTANT the new zone's clock gives that
    // wall-clock, against the new earliest. A start that still clears it is the
    // user's choice and is left alone.
    if (!startNeedsReseed(zoneWallClockToInstant(chosen, zoneOffset).getTime(), Date.now(), MIN_LEAD_HOURS)) {return;}
    const fixed = instantToZoneWallClock(earliestStart(), zoneOffset);
    setStartPick({day: fixed, h: fixed.getHours(), m: fixed.getMinutes()});
    setLeadHint(
      'Start moved to the earliest slot in the new zone · ' +
      `${fixed.toLocaleDateString(undefined, {weekday: 'short', day: '2-digit', month: 'short'})} · ${formatTime12h(fixed.getHours(), fixed.getMinutes())}.`,
    );
  }, [zoneOffset, startDay, hour, minute]);

  const handleSubmit = async () => {
    // E2E-36 — the SYNCHRONOUS guard is the real one; `submitting` is kept for
    // the label + the disabled style, both of which need a committed render.
    if (submitGuard.current || submitting) {return;}
    // Schedule must be complete before the money path runs (the old Confirm-
    // Schedule gate, folded in): a transfer needs both ends, else just a pickup.
    if (!scheduleReady) {return;}
    submitGuard.current = true;
    // Finalise the schedule into the draft confirmBooking() reads. start_time is
    // recomputed fresh here; vehicle_count keeps the passenger-derived floor the
    // old Schedule step pinned (the team effect already holds it, re-pinned here).
    // Why: B-874 — every start is >= now + MIN_LEAD_HOURS by construction, so
    // this re-derive always files 'later'. It is kept as the shared vocabulary
    // the Summary row and the server both read, never as a lane chooser.
    const submitStart = computeStartTime();
    updateDraft({
      mode: deriveBookingMode(submitStart.getTime(), Date.now()),
      passengers,
      // B-787 — the SAME rule the stepper renders, so the quote the user saw is
      // the quote that gets submitted. `Math.max(current, floor)` here was the
      // other half of the ratchet.
      vehicle_count: nextVehicleCount({passengers, chosen: chosenVehiclesRef.current, driverOnly: driver_only}),
      start_time: submitStart.toISOString(),
    });

    const selectedList = Object.entries(addon_switches ?? {})
      .filter(([, v]) => v)
      .map(([k]) => k);
    // LM-M1 — estimated_price is the TOTAL the escrow will hold, never the hourly rate.
    updateDraft({selected_add_ons: selectedList, estimated_price: totalBc});

    setSubmitting(true);
    try {
      // Persist server-side BEFORE navigating, so re-entering the Secure tab
      // resumes into the right screen rather than a purely client-side one.
      const booking = await confirmBooking();
      // Step 19 — route by the returned status: an auto request comes back DISPATCHING
      // (→ Finding) or NO_PROVIDER (→ NoDetail); the legacy flow stays → OpsRoomReview.
      const st = (booking.status ?? '').toString().toUpperCase();
      if (st === 'DISPATCHING') {
        navigation.navigate('FindingDetail', {bookingId: booking.id});
      } else if (st === 'NO_PROVIDER') {
        navigation.navigate('NoDetail', {bookingId: booking.id});
      } else if (booking.booking_mode === 'later') {
        // B-405 — a FUTURE reservation must not park the client on the locked
        // review screen (founder, 2026-08-09): back to home, where it shows as
        // an upcoming card; approval + the T-60 reminder arrive as pushes.
        navigation.popToTop();
        Alert.alert(
          'Booking scheduled',
          'Your request is with the Bravo Control System for approval. ' +
          "We'll notify you when it's approved and remind you 1 hour before start. " +
          'You can keep using the app in the meantime — and book another service while this one waits.',
        );
      } else {
        navigation.navigate('OpsRoomReview', {bookingId: booking.id});
      }
    } catch (e) {
      const direct = e as {code?: string; amountDue?: number; bookingId?: string};
      // B-843/A7 — WHO pays is answered by the selector, never by the top-up
      // paywall. Checked FIRST: a root-short refusal carries the same
      // `insufficient_credits` code as a self-short one, so the paywall branch
      // below would otherwise win and send the member to buy credits that are
      // not paying for this booking.
      const payerAsk = payer.noteRefusal(e);
      if (payerAsk) {
        Alert.alert('Choose an account', payerAsk);
        return;
      }
      // Issue 25 — a short balance is NOT a booking failure. One check covers
      // every shape: the auto soft-check's typed throw, the structured 400, the
      // legacy flat 400, and the store's normalised re-throw. Previously only
      // the first matched, so a server-side rejection fell through to the
      // generic alert and leaked the raw `insufficient_credits` code.
      if (isInsufficientCreditsError(e)) {
        navigation.navigate('CreditPaywall', {
          source: 'booking-flow',
          // The server's exact shortfall when it sent one; otherwise our own
          // estimate-minus-balance. Never under-ask — the paywall's own
          // fallback is the full estimate.
          amountDue: creditShortfallFrom(e) ?? shortfallFor(totalBc, walletCredits),
        });
        return;
      }
      // B-867 — the server's identity gate (no ID / passport on file). Routed to
      // Profile → Identity verification, never surfaced as "Booking failed".
      if (isIdentityRequiredError(e)) {
        promptIdentityRequired(() => navigation.navigate('IdentityDocument'));
        return;
      }
      if (direct?.code === 'consent_required') {
        Alert.alert('Consent required', 'Please confirm location-sharing consent to find an agency.');
        return;
      }
      const msg = (e as {
        response?: {data?: {code?: string; booking_id?: string; message?: string; pickup_region?: string}};
        message?: string;
      })?.response?.data;
      /**
       * B-861 A8 — self-heal #2, the BACKSTOP. `create()` runs its own
       * `regionFromPoint` and refuses `pickup_outside_region` with the region
       * that DOES contain the pin. Adopt it once per pin (the price board
       * usually heals this first), then let the user re-submit; a second refusal
       * for the same pin surfaces the message instead of looping.
       */
      if (msg?.code === 'pickup_outside_region' && draft.pickup) {
        const served = msg.pickup_region && zoneParamCodes.includes(msg.pickup_region)
          ? msg.pickup_region
          : null;
        if (served && pinKey && healedForPinKey.current !== pinKey) {
          healedForPinKey.current = pinKey;
          const healed = zoneFieldsFor(served);
          // P1-1 — the heal can clear the drop-off, and the CTA is blocked by
          // `canAdvanceSchedule` until it is back. Saying only "confirm again"
          // would leave the founder tapping a disabled button.
          const {dropoffCleared} = setPickupWithZone({
            zone_code: healed.zone_code, zone_label: healed.zone_label, region: healed.region,
            zone_utc_offset_hours: healed.zone_utc_offset_hours, pickup: draft.pickup,
          });
          setDropoffNotice(dropoffCleared ? healed.display : null);
          setZoneHealNotice(healed.display);
          Alert.alert(
            'Zone corrected',
            `Your pick-up is in ${healed.display}. We've moved the booking there and re-quoted it — ` +
            (dropoffCleared
              ? 'add the drop-off again, then confirm.'
              : 'please confirm again.'),
          );
          return;
        }
        // P2-2/P2-9 — no region to adopt (the server named none, or it is one we
        // do not serve, or this pin has already been healed once). "Booking
        // failed" tells the user nothing they can act on; name the wall.
        Alert.alert(
          'Outside our operating zones',
          `Your pick-up is outside our operating zones — move the pin inside ${launchedZonesLabel()} and try again.`,
        );
        return;
      }
      // The store normalises `code`/`bookingId` onto the re-thrown error; the
      // raw body is only present when a caller reaches the API directly.
      const activeId = msg?.booking_id ?? direct?.bookingId;
      if ((msg?.code ?? direct?.code) === 'active_booking_exists' && activeId) {
        navigation.navigate('OpsRoomReview', {bookingId: activeId});
        return;
      }
      // The other half of a double-tap: the first request is still filing this
      // same booking (one Idempotency-Key per draft). It will navigate; a
      // "Booking failed" here would invite a retry under a fresh key.
      if ((msg?.code ?? direct?.code) === 'idempotency_key_in_progress') {return;}
      Alert.alert(
        'Booking failed',
        msg?.message ?? (e as Error).message ?? 'Could not submit booking. Please try again.',
      );
    } finally {
      // Reset in `finally`, never on the success path: one rejection outside it
      // latches the ref and kills the button until the screen remounts.
      submitGuard.current = false;
      setSubmitting(false);
    }
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />

      <View pointerEvents="none" style={s.ambient} />

      {/* ── Header ── */}
      <View style={s.header}>
        <TouchableOpacity
          style={s.back}
          onPress={() => goBackOnce(navigation)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="chevron-left" size={20} color={D.text} />
        </TouchableOpacity>
        <View style={{flex: 1, minWidth: 0}}>
          <Text style={s.headerTitle} numberOfLines={1} ellipsizeMode="tail">Secure Transfer</Text>
          <FitLine style={s.headerSub} text={'BUILD & CONFIRM YOUR DETAIL'} />
        </View>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: 160, paddingTop: 4, gap: 14}}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">

        {/* ── Schedule (folded from BookingDateTimeScreen) ── */}
        <View style={s.schSection}>

          {/* Pickup / Drop-off — the LocationPicker modal, unchanged.
              B-861 D5 — the pick-up row carries the DERIVED zone as its
              sub-label: it is the only place the zone is decided now, so it has
              to be visible where the decision was made. */}
          <LocationRow
            label="PICK-UP LOCATION"
            address={draft.pickup?.address}
            placeholder="Select pick-up…"
            filled={!!draft.pickup}
            sub={draft.pickup ? (launchedZone(draft.zone_code)?.country ?? null) : `Zone follows your pick-up · ${launchedZonesLabel()}`}
            onPress={() => openPicker('pickup')}
          />
          {zoneHealNotice && (
            <Text style={s.gateHint}>{`Zone corrected to ${zoneHealNotice} — the price and team were re-quoted for it.`}</Text>
          )}
          <LocationRow
            label="DROP-OFF LOCATION"
            address={draft.dropoff?.address}
            placeholder="Select destination…"
            filled={!!draft.dropoff}
            onPress={() => openPicker('dropoff')}
          />
          {/* A6 — the store clears the drop-off when the pick-up moves the zone.
              Never let that row empty itself without saying why. */}
          {dropoffNotice && !draft.dropoff && (
            <Text style={s.gateHint}>
              {`Drop-off cleared — the pick-up moved to ${dropoffNotice}. Add it again.`}
            </Text>
          )}

          {!scheduleReady && (
            <Text style={s.gateHint}>
              {!draft.pickup ? 'Add a pick-up location to continue.' : 'Add a drop-off location to continue.'}
            </Text>
          )}

          {/* B-861 R2 — MISSION START is ALWAYS shown: date + time, one field.
              "A time in the near future simply IS now", so there is nothing left
              for a mode toggle to choose. */}
          <View>
            <Text style={s.fieldLabel}>MISSION START</Text>
            <View style={s.laterBox}>
              <View style={s.laterRow}>
                <TouchableOpacity
                  style={s.laterBtn}
                  onPress={openDate}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel="Choose date">
                  <Icon name="calendar" size={15} color={D.accent} />
                  {/* Founder screenshot 2026-09-04: "Fri, 04 Sept 2026" ran past the pill.
                      Two causes: the year is noise inside the current year (the home
                      screen's formatDateTime already drops it), and a Text in a
                      centred flex row does not shrink unless it is allowed to
                      (flexShrink/minWidth). FitLine measures and scales the font
                      down to the floor — the native fit-to-width prop pair is
                      BANNED app-wide (B-657, headerFitContract). */}
                  <FitLine
                    style={s.laterBtnText}
                    floorScale={0.8}
                    text={startDay.toLocaleDateString(undefined, {
                      weekday: 'short', day: '2-digit', month: 'short',
                      ...(startDay.getFullYear() !== new Date().getFullYear() ? {year: 'numeric'} : {}),
                    })}
                  />
                </TouchableOpacity>
                <TimeDropdownField
                  style={{flex: 1}}
                  hour={hour}
                  minute={minute}
                  onChange={onStartTimeChange}
                  minuteStep={5}
                  title="MISSION START TIME"
                  accessibilityLabel="Choose start time"
                />
              </View>
              {/* E2E-10 / E2E-37 — the RESOLVED start, so a clamp to the earliest
                  bookable instant is never silent, and the UTC stamp the Bravo
                  Control System and your CPO read is on the same row. */}
              <Text style={s.laterHint}>
                Pick-up {formatTime12h(nowStartWall.getHours(), nowStartWall.getMinutes())}
                {' · '}
                {nowStartWall.toLocaleDateString(undefined, {weekday: 'short', day: '2-digit', month: 'short'})}
                {'  ·  '}{fmtTimeUtc(nowStart)}
              </Text>
              {leadHint && <Text style={s.gateHint}>{leadHint}</Text>}
              {zoneNote && (
                <Text style={s.gateHint}>
                  {`Times are ${draft.zone_label || 'zone'} local · ${zoneNote}`}
                </Text>
              )}
            </View>
          </View>

          {/* Passengers */}
          <View>
            <Text style={s.fieldLabel}>PASSENGERS</Text>
            <View style={s.counter}>
              <View style={s.counterTopLight} />
              <View style={s.counterLeft}>
                <View style={s.counterIcon}>
                  <Icon name="account" size={17} color={D.accent} />
                </View>
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={s.counterLabel} numberOfLines={2}>Number of passengers</Text>
                  <Text style={s.counterSub} numberOfLines={2}>Excluding CPO and driver</Text>
                </View>
              </View>
              <View style={s.counterCtrl}>
                <TouchableOpacity
                  style={s.counterBtn}
                  onPress={() => setPassengers(-1)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel="Remove passenger"
                  hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                  <Icon name="minus" size={16} color={D.textDim} />
                </TouchableOpacity>
                <Text style={s.counterVal}>{passengers}</Text>
                <TouchableOpacity
                  onPress={() => setPassengers(+1)}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityLabel="Add passenger"
                  hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                  <LinearGradient
                    colors={['#6E9BF5', D.accentDeep]}
                    start={{x: 0, y: 0}}
                    end={{x: 0, y: 1}}
                    style={s.counterBtnPri}>
                    <Icon name="plus" size={16} color="#fff" />
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            </View>
          </View>

          <View style={s.schHint}>
            <Icon name="information-outline" size={16} color={D.accentSoft} style={{marginTop: 1}} />
            <Text style={s.schHintText}>
              Each vehicle carries up to 3 passengers (CPO and driver occupy 1 seat each).{' '}
              {passengers > 3 ? (
                <Text style={s.schHintStrong}>
                  {vehiclesForPassengers(passengers)} vehicles will be assigned — adjust below.
                </Text>
              ) : '1 vehicle covers this party.'}
            </Text>
          </View>
        </View>

        {/* ── Baseline package (folded from BaselinePackageScreen — writes nothing) ── */}
        <View style={s.baseCard}>
          <View style={s.baseTopLight} />
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={s.baseCap}>BASELINE PACKAGE · ALWAYS INCLUDED</Text>
            <Text style={s.baseInc}>1 CPO · 1 Vehicle · 1 Driver · encrypted comms · live GPS · ops handler</Text>
          </View>
          <View style={s.baseAmtRow}>
            <Text style={s.baseAmt}>{BASE_RATE_BC}</Text>
            <Text style={s.baseBc}>BC/hr</Text>
          </View>
        </View>

        {/* ── Team composition ── */}
        <View style={s.teamCard}>
          <View style={s.cardTopLight} />
          <Text style={s.sectionLabel}>TEAM COMPOSITION</Text>
          <View style={s.teamCols}>
            <TeamCell
              cap="CPOs"
              value={cpo_count}
              minusDisabled={cpo_count <= 1}
              plusDisabled={cpo_count >= maxCpos}
              onMinus={() => setCount('cpo_count', -1)}
              onPlus={() => setCount('cpo_count', +1)}
            />
            {driver_only ? (
              <View style={s.teamCell}>
                <Text style={s.teamCellCap}>VEHICLES</Text>
                <View style={s.clientVehicle}>
                  <Icon name="car-key" size={18} color={D.accentSoft} />
                  <Text style={s.clientVehicleText}>Client</Text>
                </View>
              </View>
            ) : (
              <TeamCell
                cap="VEHICLES + DRIVERS"
                value={vehicle_count}
                minusDisabled={vehicle_count <= minVehicles}
                plusDisabled={vehicle_count >= MAX_VEHICLES}
                onMinus={() => setCount('vehicle_count', -1)}
                onPlus={() => setCount('vehicle_count', +1)}
              />
            )}
          </View>
          <Text style={s.teamNote}>
            {driver_only
              ? 'Client vehicle · Bravo adds no car. Extra CPOs still add to the rate.'
              : passengers > 3
              ? `${passengers} passengers require at least ${minVehicles} vehicles · 3 per vehicle.`
              : 'Each vehicle carries up to 3 passengers · 3 per vehicle.'}
          </Text>
        </View>

        {/* ── Service duration (2026-09-04) — an HOURLY service's customer picks
            the hours; the rate is per hour, so the total below is rate × hours.
            Default and range are ops-configurable (durationRule.ts), never a
            hardcoded 4.

            B-877 (founder 2026-09-14, on a 10-minute transfer: "What is this
            for? … This card is not relative." → "Confirm we can set the 4 hours
            per region" — "Yes") — a Secure TRANSFER is billed as a fixed block
            of hours ops set PER REGION, so it has no card at all: the block is
            disclosed on the ESTIMATED TOTAL line below and stored on the
            booking. Hourly services keep the stepper untouched. */}
        {!isTransfer && (
          <View style={s.teamCard}>
            <View style={s.cardTopLight} />
            <Text style={s.sectionLabel}>SERVICE DURATION</Text>
            <View style={s.teamCols}>
              <TeamCell
                cap="HOURS"
                value={durationHours}
                minusDisabled={durationHours <= durationRule.min}
                plusDisabled={durationHours >= durationRule.max}
                onMinus={() => setDurationHours(durationHours - 1)}
                onPlus={() => setDurationHours(durationHours + 1)}
              />
              <View style={s.teamCell}>
                <Text style={s.teamCellCap}>RATE</Text>
                <View style={s.clientVehicle}>
                  <Icon name="clock-outline" size={18} color={D.accentSoft} />
                  <Text style={s.clientVehicleText}>{rateBc} BC/hr</Text>
                </View>
              </View>
            </View>
            <Text style={s.teamNote}>
              {`Billable time starts only when your officer confirms you are received — not at booking or dispatch. ${durationRule.min}–${durationRule.max} hours.`}
            </Text>
          </View>
        )}

        {/* ── Driver Only toggle ── */}
        <TouchableOpacity
          style={[s.driverRow, driver_only && s.driverRowOn]}
          onPress={toggleDriverOnly}
          activeOpacity={0.85}>
          {/* B-790 — driver_only resets in the post-submit commit; keep the light mounted. */}
          <View pointerEvents="none" style={[s.cardTopLightSm, !driver_only && s.hidden]} />
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={s.driverTitle}>Driver Only (Client Vehicle)</Text>
            <Text style={s.driverDesc}>Client provides vehicle — Bravo driver only</Text>
          </View>
          <Toggle on={driver_only} onPress={toggleDriverOnly} label="Driver only" />
        </TouchableOpacity>

        {/* ── Approval notice ── */}
        {needsOpsApproval && (
          <View style={s.alertWarn}>
            <Icon name="alert" size={18} color={D.amber} style={{marginTop: 1}} />
            <Text style={s.alertText}>
              Requests beyond the baseline (1 CPO + 1 Vehicle) are sent to the{' '}
              <Text style={s.alertBold}>Bravo Control System</Text> for review.
            </Text>
          </View>
        )}

        {/* ── Optional add-ons ── */}
        <View style={s.sectionRow}>
          <Text style={s.sectionLabel}>OPTIONAL ADD-ONS</Text>
          <Text style={s.sectionMeta}>{selectedCount} SELECTED</Text>
        </View>

        <View style={{gap: 10}}>
          {liveAddOns.map(a => (
            <AddonRow
              key={a.key}
              icon={a.icon}
              title={a.title}
              desc={a.desc}
              price={a.priceHourly}
              on={!!addon_switches?.[a.key]}
              onToggle={() => toggleAddon(a.key)}
            />
          ))}
        </View>

        {/* ── Location-sharing consent (auto path only) ── */}
        {consentRequired && (
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => updateDraft({location_consent: !consentGiven})}
            style={[s.consentRow, consentGiven && s.consentRowOn]}
            accessibilityRole="checkbox"
            accessibilityState={{checked: consentGiven}}>
            {/* B-790 — the consent check (an Icon Text) unmounted in the
                post-submit commit on the screen with five captured fatals. */}
            <View collapsable={false} style={[s.checkbox, consentGiven && s.checkboxOn]}>
              <Icon name="check" size={14} color="#fff" style={consentGiven ? undefined : s.hidden} />
            </View>
            <Text style={s.consentText}>
              I consent to sharing my live location with the assigned agency for the duration of
              this detail, and I accept the{' '}
              <Text style={s.consentLink}>Dispatch Terms</Text>.
            </Text>
          </TouchableOpacity>
        )}

        {/* ── Rate bar ── */}
        <View style={s.rateBar}>
          <View style={s.rateBarTopLight} />
          <View>
            <Text style={s.rateCap}>CURRENT RATE</Text>
            <Text style={s.rateSub}>Bravo Credits / hour</Text>
          </View>
          <View style={s.rateAmtRow}>
            <Text style={s.rateAmt}>{rateBc.toLocaleString()}</Text>
            <Text style={s.rateUnit}>BC</Text>
          </View>
        </View>
        {/* LM-M1 — the number escrow will actually hold, shown BEFORE submit. */}
        {/* Issue 29 — free-text instructions. The PDF names event support and
            meeting attendance: an hourly detail has no route to infer intent
            from, so the brief has to be stated. Persisted as `notes`, which the
            booking API already carried but no screen ever exposed. */}
        <View style={s.refWrap}>
          <Text style={s.refLabel}>
            {isHourly ? 'Brief for the team (optional)' : 'Anything the team should know? (optional)'}
          </Text>
          <TextInput
            style={[s.refInput, s.notesInput]}
            value={notes}
            onChangeText={t => updateDraft({notes: t.slice(0, NOTES_MAX)})}
            placeholder={isHourly
              ? 'e.g. Event support at the Hilton, 3 guests, discreet dress'
              : 'e.g. Meet at the north entrance'}
            placeholderTextColor={D.textMute}
            multiline
            maxLength={NOTES_MAX}
            textAlignVertical="top"
            accessibilityLabel="Instructions for the security team, optional"
          />
          <Text style={s.refNote}>{notes.length}/{NOTES_MAX} · Sent to the Bravo Control System with your request.</Text>
        </View>

        {/* Issue 28 — optional partner / preferred-provider code, captured
            before final submission. Attribution only: the server validates and
            records it, and it never bypasses availability, licensing or
            operator approval. */}
        <View style={s.refWrap}>
          <Text style={s.refLabel}>Provider / referral code (optional)</Text>
          <TextInput
            style={s.refInput}
            value={referralCode}
            onChangeText={t => updateDraft({referral_code: t.toUpperCase().replace(/[^A-Z0-9-]/g, '').replace(/^-+/, '')})}
            placeholder="e.g. TRAVELCO-01"
            placeholderTextColor={D.textMute}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={32}
            accessibilityLabel="Provider or referral code, optional"
          />
          <Text style={s.refNote}>
            From a partner or travel agent. It records who referred you — it does not
            change availability or who is assigned. A Bravo referral code takes its discount off the total.
          </Text>
          {referralQuote && (
            <Text
              style={[s.refNote, referralQuote.applied ? s.refOk : referralQuote.kind === 'attribution' ? null : s.refWarn]}
              accessibilityLiveRegion="polite">
              {referralQuote.applied
                ? `✓ ${referralQuote.label ?? 'Discount'} applied · −${referralQuote.discount_bc.toLocaleString()} BC on this booking`
                : referralQuote.kind === 'attribution'
                  ? 'Partner code recorded — it does not change the price.'
                  : referralQuote.message ?? 'That code could not be applied.'}
            </Text>
          )}
        </View>

        <View style={s.totalRow}>
          {/* The OFFLINE tag is keyed on an actual FAILURE, not on
              `serverTotal === null` — that is also true for the 400 ms debounce
              after every stepper tap, which would flash "OFFLINE" constantly. */}
          <Text style={s.totalCap} numberOfLines={1} ellipsizeMode="tail">
            ESTIMATED TOTAL · {durationHours}H{estimateFailed && serverTotal === null ? ' · OFFLINE' : ''}
            {referralQuote?.applied && serverTotal !== null ? ` · ${(referralQuote.label ?? 'DISCOUNT').toUpperCase()}` : ''}
          </Text>
          <View style={s.totalAmtCol}>
            <Text style={s.totalAmt}>{Math.round(totalBc).toLocaleString()} BC</Text>
            {referralQuote?.applied && serverTotal !== null && grossBc !== null && grossBc > totalBc && (
              <Text style={s.totalWas}>was {Math.round(grossBc).toLocaleString()} BC</Text>
            )}
          </View>
        </View>
        {/* E2E-33 — an offline quote is LABELLED as one. The local mirror now
            includes the peak surcharge, but it cannot see an ops price change
            made since the app last synced, so it is a preview, not the charge. */}
        {estimateFailed && serverTotal === null && (
          <Text style={s.gateHint}>
            Live pricing is unavailable right now, so this is an offline estimate. Nothing is
            charged until an agency accepts — the exact amount is confirmed then.
          </Text>
        )}

        {/* B-843 — which account pays. Only rendered for someone who is a
            member somewhere; a solo client sees exactly what they saw before. */}
        {payer.visible && (
          <PayerSelector
            selfUserId={payer.selfUserId}
            selfBalance={payer.selfBalance}
            memberships={payer.memberships}
            value={payer.value}
            onChange={payer.choose}
          />
        )}
      </ScrollView>

      {/* Native DATE picker (MISSION START) — the time is the 12-hour dropdown
          above. Android has no mount here on purpose: openDate() opens the
          dialog imperatively so a re-render cannot re-open and reset it. */}
      {Platform.OS === 'ios' && dateOpen && (
        <Modal
          visible
          transparent
          animationType="slide"
          onRequestClose={() => setDateOpen(false)}>
          <Pressable style={s.iosBackdrop} onPress={() => setDateOpen(false)}>
            <Pressable style={s.iosCard} onPress={() => {}}>
              <DateTimePicker
                value={startDay}
                mode="date"
                display="spinner"
                minimumDate={earliest}
                textColor={D.text}
                onChange={onStartDateChange}
              />
              <TouchableOpacity activeOpacity={0.9} onPress={() => setDateOpen(false)}>
                <LinearGradient
                  colors={['#6E9BF5', D.accent, D.accentDeep]}
                  locations={[0, 0.55, 1]}
                  start={{x: 0, y: 0}}
                  end={{x: 0, y: 1}}
                  style={s.iosDone}>
                  <Text style={s.iosDoneText}>Done</Text>
                </LinearGradient>
              </TouchableOpacity>
            </Pressable>
          </Pressable>
        </Modal>
      )}

      {/* ── Footer CTA ── */}
      <LinearGradient
        colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
        locations={[0, 0.5]}
        style={[s.ctaWrap, {paddingBottom: bottomPad(12)}]}>
        <TouchableOpacity
          activeOpacity={ctaBlocked ? 1 : 0.9}
          onPress={() => { void handleSubmit(); }}
          disabled={ctaBlocked}>
          <LinearGradient
            colors={ctaBlocked ? ['#27324A', '#1C2436'] : ['#6E9BF5', D.accent, D.accentDeep]}
            locations={ctaBlocked ? [0, 1] : [0, 0.55, 1]}
            start={{x: 0, y: 0}}
            end={{x: 0, y: 1}}
            style={[s.cta, ctaBlocked && s.ctaDisabled]}>
            <Text style={s.ctaText}>
              {submitting ? 'Submitting…' : consentRequired ? 'Confirm Booking' : 'Submit for Ops Review'}
            </Text>
            <Icon name="arrow-right" size={19} color="#fff" style={submitting ? s.hidden : undefined} />
          </LinearGradient>
        </TouchableOpacity>
      </LinearGradient>
    </View>
  );
}

// Pick-up / drop-off row (folded from BookingDateTimeScreen). Reads its address
// off the draft; a zone change empties the draft (store invariant) so it falls
// back to the placeholder and the user is re-prompted.
function LocationRow({
  label, address, placeholder, filled, sub, onPress,
}: {
  label: string;
  address?: string;
  placeholder: string;
  filled: boolean;
  /** B-861 D5 — the derived zone, beside the row that decides it. */
  sub?: string | null;
  onPress: () => void;
}) {
  return (
    <View>
      <Text style={s.fieldLabel}>{label}</Text>
      <TouchableOpacity
        style={[s.locRow, filled ? s.locRowFilled : s.locRowIdle]}
        onPress={onPress}
        activeOpacity={0.8}>
        <View style={s.locTopLight} />
        <View style={[s.locPin, filled ? s.locPinFilled : s.locPinIdle]}>
          <Icon
            name={filled ? 'map-marker' : 'map-marker-outline'}
            size={16}
            color={filled ? D.accent : D.textMute}
          />
        </View>
        <View style={{flex: 1, minWidth: 0}}>
          <Text
            style={[s.locText, filled ? s.locTextFilled : s.locTextPlaceholder]}
            numberOfLines={1}>
            {filled ? address : placeholder}
          </Text>
          {!!sub && <Text style={s.locSub} numberOfLines={1}>{sub}</Text>}
        </View>
        <Icon name="chevron-right" size={16} color={D.textMute} />
      </TouchableOpacity>
    </View>
  );
}

function Toggle({on, onPress, label}: {on: boolean; onPress: () => void; label: string}) {
  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={onPress}
      style={[s.toggle, on && s.toggleOn]}
      accessibilityRole="switch"
      accessibilityState={{checked: on}}
      accessibilityLabel={label}
      hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
      {/* B-647 — always mounted (see AddonRow); the track fades, it never (un)mounts. */}
      <LinearGradient
        colors={['#6E9BF5', D.accentDeep]}
        start={{x: 0, y: 0}}
        end={{x: 0, y: 1}}
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, !on && s.hidden] as never}
      />
      <View collapsable={false} style={[s.toggleThumb, on && s.toggleThumbOn]} />
    </TouchableOpacity>
  );
}

interface TeamCellProps {
  cap: string;
  value: number;
  minusDisabled?: boolean;
  plusDisabled?: boolean;
  onMinus: () => void;
  onPlus: () => void;
}

function TeamCell({cap, value, minusDisabled, plusDisabled, onMinus, onPlus}: TeamCellProps) {
  return (
    <View style={s.teamCell}>
      <Text style={s.teamCellCap}>{cap}</Text>
      <View style={s.teamCellRow}>
        <TouchableOpacity
          style={[s.stepBtn, minusDisabled && s.stepBtnDisabled]}
          onPress={onMinus}
          disabled={minusDisabled}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`Decrease ${cap}`}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="minus" size={15} color={minusDisabled ? D.textFaint : D.textDim} />
        </TouchableOpacity>
        <Text style={s.stepVal}>{value}</Text>
        <TouchableOpacity
          onPress={onPlus}
          disabled={plusDisabled}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={`Increase ${cap}`}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <LinearGradient
            colors={plusDisabled ? ['#27324A', '#1C2436'] : ['#6E9BF5', D.accentDeep]}
            start={{x: 0, y: 0}}
            end={{x: 0, y: 1}}
            style={[s.stepBtnPri, plusDisabled && s.stepBtnDisabled]}>
            <Icon name="plus" size={15} color={plusDisabled ? D.textFaint : '#fff'} />
          </LinearGradient>
        </TouchableOpacity>
      </View>
    </View>
  );
}

interface AddonRowProps {
  icon: IconName;
  title: string;
  desc: string;
  price: number;
  on: boolean;
  onToggle: () => void;
}

function AddonRow({icon, title, desc, price, on, onToggle}: AddonRowProps) {
  // Why: B-647 — five Fabric fatals on 2026-09-03 ("addViewAt … child already has
  // a parent") all landed in THIS row's mount batch: a new first child appearing
  // while the icon wrapper's subtree restructured in the same commit made the
  // Android differ insert the icon Text into the row before removing it from
  // its wrapper. The decorations are therefore always mounted and driven by
  // opacity, and the wrapper is pinned non-flattenable, so no batch can ever
  // ask for a re-parent inside this row.
  return (
    <TouchableOpacity style={[s.addon, on ? s.addonOn : s.addonIdle]} onPress={onToggle} activeOpacity={0.85}>
      <View pointerEvents="none" style={[s.cardTopLightSm, !on && s.hidden]} />
      <View collapsable={false} style={[s.addonIc, on ? s.addonIcOn : s.addonIcIdle]}>
        <Icon name={icon} size={21} color={on ? D.accentSoft : D.textMute} />
      </View>
      <View style={s.addonBody}>
        <View style={s.addonTitleRow}>
          <Text style={s.addonTitle} numberOfLines={1}>{title}</Text>
          <Text style={[s.addonPrice, on && s.addonPriceOn]}>+{price} BC/hr</Text>
        </View>
        <Text style={s.addonDesc} numberOfLines={2}>{desc}</Text>
      </View>
      <Toggle on={on} onPress={onToggle} label={title} />
    </TouchableOpacity>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg, overflow: 'hidden'},

  ambient: {
    position: 'absolute', top: -100, alignSelf: 'center',
    width: 460, height: 260, borderRadius: 230,
    backgroundColor: 'rgba(91,141,239,0.07)',
  },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14,
  },
  back: {
    width: 40, height: 40, borderRadius: 12, flexShrink: 0,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: {fontFamily: D.fBold, fontSize: 21, letterSpacing: -0.5, color: D.text, lineHeight: 24},
  headerSub: {fontFamily: D.fMono, fontSize: 9.5, fontWeight: '600', letterSpacing: 1.6, color: D.textMute, marginTop: 5},

  scroll: {flex: 1},

  cardTopLight: {position: 'absolute', top: 0, left: 18, right: 18, height: 1, backgroundColor: 'rgba(255,255,255,0.1)'},
  cardTopLightSm: {position: 'absolute', top: 0, left: 16, right: 16, height: 1, backgroundColor: 'rgba(120,160,255,0.34)'},
  hidden: {opacity: 0},

  sectionLabel: {fontFamily: D.fMono, fontSize: 10, fontWeight: '600', letterSpacing: 2, color: D.textDim},

  // Team composition
  teamCard: {
    position: 'relative', overflow: 'hidden',
    borderRadius: 20, padding: 16,
    backgroundColor: 'rgba(18,24,36,0.7)', borderWidth: 1, borderColor: D.hair2,
  },
  teamCols: {flexDirection: 'row', gap: 12, marginTop: 14},
  /**
   * Founder 2026-08-08 — "please align this, it seems skew".
   *
   * The two cells stretch to a common height (teamCols leaves alignItems at
   * its `stretch` default), but their CONTENT was top-aligned — and the caps
   * are not the same height: "CPOs" is one line, "VEHICLES + DRIVERS" is two.
   * So the taller cap pushed its stepper down a full line while the shorter
   * one stayed put, and the two steppers sat on different baselines.
   *
   * Fixed twice over, because either alone has a hole:
   *   - `justifyContent: space-between` bottom-anchors the stepper, so the two
   *     line up no matter how many lines a cap takes — this is the one that
   *     survives fontScale 1.3+, where a cap can wrap to three lines;
   *   - `minHeight` on the cap reserves two lines even for the one-line "CPOs",
   *     so in the ordinary case both cells share the same internal rhythm
   *     rather than one having a visible gap under its cap.
   */
  teamCell: {
    flex: 1, paddingVertical: 13, paddingHorizontal: 12, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'space-between',
  },
  teamCellCap: {
    fontFamily: D.fMono, fontSize: 9, fontWeight: '700', letterSpacing: 1.4,
    color: D.textMute, marginBottom: 11,
    // Two lines' worth. `textAlign` because the cell centres the Text BOX but
    // not the lines inside it, so a wrapped cap rendered ragged-left inside a
    // centred block.
    lineHeight: 12, minHeight: 24, textAlign: 'center',
  },
  teamCellRow: {flexDirection: 'row', alignItems: 'center', gap: 9},
  stepBtn: {
    width: 36, height: 36, borderRadius: 11,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  stepBtnDisabled: {opacity: 0.4},
  stepBtnPri: {
    width: 36, height: 36, borderRadius: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 12, shadowOffset: {width: 0, height: 6}, elevation: 6,
  },
  stepVal: {minWidth: 38, textAlign: 'center', fontFamily: D.fBold, fontSize: 22, color: D.text},
  clientVehicle: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 7, paddingHorizontal: 12, borderRadius: 11,
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)',
    // Matches `stepBtn`'s 36 so the Driver-Only branch, which swaps the stepper
    // for this chip, still lines up with the CPO stepper beside it — the same
    // skew one state over.
    minHeight: 36,
  },
  clientVehicleText: {fontFamily: D.fSemi, fontSize: 14, color: D.accentSoft},
  teamNote: {fontFamily: D.fSans, fontSize: 11.5, letterSpacing: -0.05, color: D.textMute, marginTop: 13, textAlign: 'center'},

  // Driver-only row
  driverRow: {
    position: 'relative', overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair,
  },
  driverRowOn: {backgroundColor: 'rgba(20,32,56,0.9)', borderColor: 'rgba(91,141,239,0.45)'},
  driverTitle: {fontFamily: D.fBold, fontSize: 15.5, letterSpacing: -0.2, color: D.text},
  driverDesc: {fontFamily: D.fSans, fontSize: 11.5, letterSpacing: -0.05, color: D.textMute, marginTop: 4},

  // Toggle
  toggle: {
    width: 48, height: 28, borderRadius: 999, flexShrink: 0, overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: D.hair2,
    justifyContent: 'center',
  },
  toggleOn: {borderColor: 'rgba(255,255,255,0.2)'},
  toggleThumb: {
    position: 'absolute', left: 2.5, width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 5, shadowOffset: {width: 0, height: 2}, elevation: 3,
  },
  toggleThumbOn: {left: 22},

  // Approval notice
  alertWarn: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 11, padding: 14, borderRadius: 14,
    backgroundColor: 'rgba(245,181,68,0.07)', borderWidth: 1, borderColor: 'rgba(245,181,68,0.26)',
  },
  alertText: {flex: 1, fontFamily: D.fSans, fontSize: 11.5, color: D.textDim, lineHeight: 17},
  alertBold: {fontFamily: D.fSemi, color: D.amber},

  // Section row
  sectionRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 2},
  sectionMeta: {fontFamily: D.fMono, fontSize: 9, letterSpacing: 1, color: D.textMute},

  // Add-on rows
  addon: {
    position: 'relative', overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', gap: 14, padding: 15, borderRadius: 17,
  },
  addonIdle: {backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair},
  addonOn: {
    backgroundColor: 'rgba(20,32,56,0.9)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.45)',
    shadowColor: D.accentDeep, shadowOpacity: 0.28, shadowRadius: 16, shadowOffset: {width: 0, height: 10}, elevation: 7,
  },
  addonIc: {
    width: 44, height: 44, borderRadius: 13, flexShrink: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  addonIcIdle: {backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2},
  addonIcOn: {
    backgroundColor: 'rgba(91,141,239,0.16)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)',
    shadowColor: D.accent, shadowOpacity: 0.24, shadowRadius: 16, shadowOffset: {width: 0, height: 0}, elevation: 4,
  },
  addonBody: {flex: 1, minWidth: 0},
  addonTitleRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  addonTitle: {flex: 1, minWidth: 0, fontFamily: D.fBold, fontSize: 15, letterSpacing: -0.2, color: D.text},
  addonPrice: {flexShrink: 0, fontFamily: D.fMono, fontSize: 8.5, fontWeight: '600', letterSpacing: 0.4, color: D.textMute},
  addonPriceOn: {color: D.accentSoft},
  addonDesc: {fontFamily: D.fSans, fontSize: 11.5, letterSpacing: -0.05, color: D.textMute, marginTop: 4},

  // Rate bar
  rateBar: {
    position: 'relative', overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: 16, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  rateBarTopLight: {position: 'absolute', top: 0, left: 16, right: 16, height: 1, backgroundColor: 'rgba(255,255,255,0.08)'},
  rateCap: {fontFamily: D.fMono, fontSize: 10, fontWeight: '600', letterSpacing: 1.5, color: D.textDim},
  rateSub: {fontFamily: D.fSans, fontSize: 10.5, color: D.textMute, marginTop: 4},
  rateAmtRow: {flexDirection: 'row', alignItems: 'baseline', gap: 5},
  rateAmt: {fontFamily: D.fBold, fontSize: 24, letterSpacing: -0.5, color: D.text},
  rateUnit: {fontFamily: D.fBold, fontSize: 14, color: D.accentSoft},
  // Issue 28 — partner / referral code field.
  refWrap: {marginTop: 14, gap: 6},
  notesInput: {height: 88, paddingTop: 10, letterSpacing: 0},
  refLabel: {fontFamily: D.fSemi, fontSize: 11.5, color: D.textDim},
  refInput: {
    minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: D.hair2,
    backgroundColor: 'rgba(255,255,255,0.03)', paddingHorizontal: 12,
    fontFamily: D.fSans, fontSize: 14, color: D.text, letterSpacing: 1,
  },
  refNote: {fontFamily: D.fSans, fontSize: 10.5, color: D.textMute, lineHeight: 14},
  // Referral campaign (2026-09-05) — applied / refused feedback under the box.
  refOk: {color: D.accentSoft, fontFamily: D.fSemi},
  refWarn: {color: D.amber},
  totalAmtCol: {flexShrink: 0, alignItems: 'flex-end'},
  totalWas: {fontFamily: D.fSans, fontSize: 10, color: D.textMute, textDecorationLine: 'line-through'},

  // LM-M1 — estimated-total strip under the rate bar.
  totalRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, marginTop: -6,
    backgroundColor: 'rgba(91,141,239,0.08)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.22)'},
  totalCap: {flexShrink: 1, fontFamily: D.fSemi, fontSize: 10, letterSpacing: 1.4, color: D.textMute},
  totalAmt: {flexShrink: 0, fontFamily: D.fBold, fontSize: 16, color: D.accentSoft},

  // Consent (auto path)
  consentRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    padding: 14, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  consentRowOn: {borderColor: 'rgba(91,141,239,0.45)', backgroundColor: 'rgba(91,141,239,0.08)'},
  checkbox: {
    width: 22, height: 22, borderRadius: 7, marginTop: 1,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: D.textMute, backgroundColor: 'transparent',
  },
  checkboxOn: {backgroundColor: D.accent, borderColor: D.accent},
  consentText: {flex: 1, fontFamily: D.fSans, fontSize: 12.5, lineHeight: 18, color: D.textDim},
  consentLink: {fontFamily: D.fSemi, color: D.accentSoft},

  // CTA
  ctaWrap: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 28},
  cta: {
    minHeight: 58, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: {width: 0, height: 14}, elevation: 10,
  },
  ctaDisabled: {borderColor: D.hair2, shadowOpacity: 0, elevation: 0},
  ctaText: {fontFamily: D.fBold, fontSize: 16, letterSpacing: 0.3, color: '#fff'},

  // ── Schedule section (folded from BookingDateTimeScreen) ──
  // B-861 — the OPERATING ZONE tiles and the Book Now / Book Later segment are
  // gone, and their styles with them (zoneRow/zoneChip/zoneCode/zoneName,
  // schToggle*). The zone follows the pick-up pin; MISSION START is always shown.
  schSection: {gap: 14},
  fieldLabel: {
    fontFamily: D.fMono, fontSize: 9.5, fontWeight: '700',
    letterSpacing: 1.8, color: D.textDim, marginBottom: 9, paddingLeft: 2,
  },

  // Location rows
  locRow: {
    position: 'relative', overflow: 'hidden',
    minHeight: 58, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14,
  },
  locRowFilled: {backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2},
  locRowIdle: {backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair},
  locTopLight: {position: 'absolute', top: 0, left: 14, right: 14, height: 1, backgroundColor: 'rgba(255,255,255,0.08)'},
  locPin: {
    width: 30, height: 30, borderRadius: 9, flexShrink: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  locPinFilled: {backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)'},
  locPinIdle: {backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2},
  locText: {fontSize: 14.5, letterSpacing: -0.1},
  locTextFilled: {fontFamily: D.fSemi, color: D.text},
  locTextPlaceholder: {fontFamily: D.fSans, color: D.textFaint},
  // B-861 D5 — the derived zone, under the pick-up address.
  locSub: {fontFamily: D.fMono, fontSize: 10, letterSpacing: 0.3, color: D.textMute, marginTop: 2},
  gateHint: {fontFamily: D.fSans, fontSize: 11.5, color: D.amber, textAlign: 'center', marginTop: 2, marginBottom: 6},

  // Book Later
  laterBox: {
    padding: 14, borderRadius: 16, gap: 10,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  laterRow: {flexDirection: 'row', gap: 10},
  laterBtn: {
    flex: 1, minWidth: 0, paddingVertical: 13, paddingHorizontal: 10, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
    flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center',
  },
  laterBtnText: {fontFamily: D.fSemi, fontSize: 12.5, color: D.text, letterSpacing: 0.2, flexShrink: 1, minWidth: 0},
  laterHint: {fontFamily: D.fMono, fontSize: 11, color: D.textMute, textAlign: 'center'},

  // Passenger stepper
  counter: {
    position: 'relative', overflow: 'hidden',
    minHeight: 60, paddingVertical: 10, borderRadius: 16, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingLeft: 14, paddingRight: 12,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  counterTopLight: {position: 'absolute', top: 0, left: 14, right: 14, height: 1, backgroundColor: 'rgba(255,255,255,0.08)'},
  counterLeft: {flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, paddingRight: 8},
  counterIcon: {
    width: 30, height: 30, borderRadius: 9, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)',
    alignItems: 'center', justifyContent: 'center',
  },
  counterLabel: {fontFamily: D.fSemi, fontSize: 14, color: D.text, letterSpacing: -0.1},
  counterSub: {fontFamily: D.fSans, fontSize: 10.5, color: D.textMute, marginTop: 2},
  counterCtrl: {flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0},
  counterBtn: {
    width: 38, height: 38, borderRadius: 11,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  counterBtnPri: {
    width: 38, height: 38, borderRadius: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 12, shadowOffset: {width: 0, height: 6}, elevation: 6,
  },
  counterVal: {minWidth: 34, textAlign: 'center', fontFamily: D.fBold, fontSize: 20, color: D.text},

  // Schedule info hint
  schHint: {
    flexDirection: 'row', gap: 10, padding: 13, borderRadius: 13,
    backgroundColor: 'rgba(91,141,239,0.07)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.2)',
  },
  schHintText: {flex: 1, fontFamily: D.fSans, fontSize: 11, color: D.textDim, lineHeight: 16},
  schHintStrong: {fontFamily: D.fSemi, color: D.accentSoft},

  // iOS picker modal
  iosBackdrop: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(2,6,15,0.72)'},
  iosCard: {
    backgroundColor: '#0E1320', borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingTop: 10, paddingHorizontal: 16,
    borderTopWidth: 1, borderTopColor: D.hair2,
  },
  iosDone: {
    height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    marginTop: 10, marginBottom: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  iosDoneText: {fontFamily: D.fBold, fontSize: 15, color: '#fff', letterSpacing: 0.3},

  // ── Baseline card (folded from BaselinePackageScreen) ──
  baseCard: {
    position: 'relative', overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderRadius: 18,
    backgroundColor: 'rgba(20,32,56,0.6)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
  },
  baseTopLight: {position: 'absolute', top: 0, left: 16, right: 16, height: 1, backgroundColor: 'rgba(120,160,255,0.34)'},
  baseCap: {fontFamily: D.fMono, fontSize: 9.5, fontWeight: '700', letterSpacing: 1.4, color: D.accentSoft},
  baseInc: {fontFamily: D.fSans, fontSize: 11.5, letterSpacing: -0.05, color: D.textMute, marginTop: 5},
  baseAmtRow: {flexDirection: 'row', alignItems: 'baseline', gap: 4, flexShrink: 0},
  baseAmt: {fontFamily: D.fBold, fontSize: 22, letterSpacing: -0.5, color: D.text},
  baseBc: {fontFamily: D.fBold, fontSize: 12, color: D.accentSoft},
}));
