/**
 * Founder 2026-08-26 — fetches the ops-editable service-pricing board
 * (GET /bookings/service-pricing) and hydrates the pure mirror overrides.
 * Same posture as planCatalogStore: single-flight, fail-open, and screens
 * that render prices subscribe to `overrides` so a hydration re-renders the
 * quote with the live numbers.
 *
 * OP-01 / OP-08 — the board is fetched for the zone being quoted and reloaded
 * on FOCUS (not once per mount). The zone is named the way the CHARGE names
 * it: by the pickup point when the draft has one (the server runs the same
 * `regionFromPoint`), else by the draft's zone code. Review round 2 found two
 * ways the mirror could quote the WRONG zone's numbers and both are closed
 * here: a zone switch resets the overrides to the compiled board before the
 * fetch, and a response for anything but the LATEST requested zone is dropped
 * (an in-flight AE reply must not land on a ZA screen).
 */
import {useCallback} from 'react';
import {useFocusEffect} from '@react-navigation/native';
import {create} from 'zustand';
import {bookingApi} from '@services/api';
import {
  setServicePricingOverrides, type ServicePricingOverrides,
} from '@screens/booking/servicePricingOverrides';

const GLOBAL = 'GLOBAL';
// A focus inside this window re-uses the board just fetched — one walk through
// the five-screen booking flow is one request, not five.
const FRESH_MS = 15_000;

export interface PricingZone {
  region?: string | null;
  /** Pickup point — preferred, because it is how the server picks the CHARGE board. */
  lat?: number | null;
  lng?: number | null;
}

interface ServicePricingState {
  overrides: ServicePricingOverrides;
  /** The zone key the current `overrides` were fetched for. */
  zone: string;
  /**
   * The region code the SERVER resolved this board for — i.e. the answer to
   * `regionFromPoint(pickup)` when a point was sent. This is the only
   * pickup-derived region the client can trust: the bounding boxes are
   * ops-managed rows, so a client-side mirror of them would drift. Consumers
   * that need "which region does the CHARGE price in" (the peak-hour mirror)
   * read this and fall back to the dispatch chip. `null` until a board lands.
   */
  pricedRegion: string | null;
  loaded: boolean;
  load: (zone?: PricingZone | null) => Promise<void>;
}

// Single-flight per zone key; a different zone is a different request.
const inFlight = new Map<string, Promise<void>>();
const loadedAt = new Map<string, number>();
let latestRequested = GLOBAL;

function normalizeRegion(region?: string | null): string {
  const code = (region ?? '').trim().toUpperCase();
  return /^[A-Z]{2,8}$/.test(code) ? code : GLOBAL;
}

/** Stable key for a zone: the point (4 dp ≈ 10 m) wins over the code. */
export function pricingZoneKey(zone?: PricingZone | null): string {
  const lat = zone?.lat, lng = zone?.lng;
  if (typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)) {
    return `pt:${lat.toFixed(4)},${lng.toFixed(4)}`;
  }
  return normalizeRegion(zone?.region);
}

export const useServicePricingStore = create<ServicePricingState>((set, get) => ({
  overrides: {},
  zone: GLOBAL,
  pricedRegion: null,
  loaded: false,
  load: async (zone) => {
    const key = pricingZoneKey(zone);
    latestRequested = key;
    // A zone switch must not keep quoting the previous zone's numbers while
    // (or after, on failure) the new board is fetched: fall back to the
    // compiled board first. Same-zone reloads keep the live numbers.
    if (get().zone !== key) {
      setServicePricingOverrides({});
      // The resolved region belongs to the OLD zone — drop it with the numbers,
      // or the peak mirror keys the new pickup on the previous region.
      set({overrides: {}, zone: key, pricedRegion: null});
    }
    const fresh = loadedAt.get(key);
    if (fresh !== undefined && Date.now() - fresh < FRESH_MS) {return;}
    const pending = inFlight.get(key);
    if (pending) {return pending;}
    const run = (async () => {
      try {
        // A 'pt:' key is only minted from a zone with coordinates; the guard
        // replaces the non-null assertion without changing which branch runs.
        const point = key.startsWith('pt:') && zone ? {lat: zone.lat as number, lng: zone.lng as number} : undefined;
        const region = point ? undefined : (key === GLOBAL ? undefined : key);
        const {data} = await bookingApi.servicePricing(region, point);
        if (latestRequested !== key) {return;}   // a newer zone was requested meanwhile
        const overrides: Record<string, number> = {};
        for (const [k, v] of Object.entries(data.pricing ?? {})) {
          if (typeof v === 'number' && Number.isFinite(v) && v > 0) {overrides[k] = v;}
        }
        setServicePricingOverrides(overrides);
        loadedAt.set(key, Date.now());
        const resolved = typeof data.region === 'string' && /^[A-Z]{2,8}$/.test(data.region)
          ? data.region : null;
        set({overrides, zone: key, pricedRegion: resolved, loaded: true});
      } catch {
        // Offline / old server — the compiled board (reset above on a zone
        // switch) stands; the next focus retries.
        if (latestRequested === key) {set({loaded: true});}
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, run);
    return run;
  },
}));

/**
 * Subscribe a pricing screen to the live board for `zone` and (re)load it
 * every time the screen gains focus. Returns the overrides so the caller
 * re-renders when they land.
 */
export function useServicePricing(zone?: PricingZone | null): ServicePricingOverrides {
  const overrides = useServicePricingStore(st => st.overrides);
  const load = useServicePricingStore(st => st.load);
  const region = zone?.region ?? null;
  const lat = zone?.lat ?? null;
  const lng = zone?.lng ?? null;
  useFocusEffect(
    useCallback(() => {
      // load() resolves its own failures internally; the catch only
      // satisfies no-floating-promises in this folder.
      load({region, lat, lng}).catch(() => undefined);
    }, [load, region, lat, lng]),
  );
  return overrides;
}
