/**
 * Booking · Location Picker (modal)
 *
 * Full-screen Mapbox picker that mirrors an Uber-style drop-a-pin flow.
 * The user pans the map, the centre crosshair reverse-geocodes on idle,
 * and we test the centre against Bravo coverage zones for the current
 * country. If out of coverage, the confirm button disables and a warning
 * banner appears.
 *
 * Opened via `navigation.navigate('LocationPicker', { ... })` — the
 * caller declares whether it wants the pickup or dropoff and the
 * country the user is booking within.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, StatusBar, Platform, Modal, Pressable,
  PermissionsAndroid, TextInput, FlatList, ActivityIndicator,
} from 'react-native';
import Geolocation from 'react-native-geolocation-service';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {useKeyboardOverlap} from '@hooks/useKeyboardLayout';
import {WebView, type WebViewMessageEvent} from 'react-native-webview';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {UI} from '@components/ui/tokens';
import LoadingView from '@components/LoadingView';
import {BravoFont} from '@theme/bravo';
import {buildLocationPickerHtml, type MapStyleId} from '../../modules/booking/bravoLocationPickerMapHtml';
import {COVERAGE_ZONES, checkCoverage} from '../../modules/booking/coverageZones';
import {isInsideRegionBox, regionFromBBox, regionDef, zoneFromPickup} from '@utils/regions';
import {launchedZonesLabel} from './launchedZones';
import {scaleTextStyles} from '@utils/scaling';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'LocationPicker'>;
type Rt  = RouteProp<BookingStackParamList, 'LocationPicker'>;

import {MAPBOX_TOKEN, MAPBOX_TOKEN_MISSING} from '@/modules/maps/mapToken';
import {mapHtmlSource} from '@/modules/maps/mapWebViewSource';
import {MapFailedOverlay} from '@/modules/maps/MapFailedOverlay';
import {goBackOnce} from '@navigation/tapGuard';

function ResultSeparator() {
  return <View style={{height: 1, backgroundColor: UI.hair, marginHorizontal: 16}} />;
}

// B-789 — the zone chip in the top bar. The user who typed "Cape Town" from
// Dubai never reached the zone step; this puts the door where they are.
const zs = StyleSheet.create({
  chip: {
    alignSelf: 'flex-start', marginTop: 4, minHeight: 28, paddingHorizontal: 10,
    borderRadius: 999, borderWidth: 1, borderColor: 'rgba(91,141,239,0.45)',
    backgroundColor: 'rgba(91,141,239,0.14)', justifyContent: 'center', maxWidth: '100%',
  },
  chipText: {color: UI.accentSoft, fontFamily: UI.fSemi, fontSize: 11.5},
  chipWarn: {borderColor: 'rgba(245,199,107,0.5)', backgroundColor: 'rgba(245,199,107,0.12)'},
  chipWarnText: {color: UI.amber},
});

export default function LocationPickerScreen() {
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  // Issue 27 — the CTA bar's height before onLayout reports: paddingTop 10
  // + button 48 + its bottom padding. Derived, not magic, so it stays correct
  // if the bar's padding changes.
  const CTA_FALLBACK_H = 10 + 48 + bottomPad(12);
  const keyboardOverlap = useKeyboardOverlap();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();

  const {kind, countryCode, initial, onPickRouteKey} = route.params;
  /**
   * B-861 — `countryCode` may carry the LAUNCHED LIST ('AE,ZA') when the caller
   * accepts a pin in ANY launched zone: the Lite pick-up, where the zone now
   * FOLLOWS the pin instead of being chosen up front. The first entry is the
   * draft's current zone, so the map still opens on its hub and the chip still
   * names it before a pin is confirmed.
   *
   * A single code is the unchanged behaviour, and it stays the rule for the
   * DROP-OFF and every Executive picker: the server has no drop-off region
   * check at all (`booking.service.ts` persists address/lat/lng only), so this
   * wall is the only thing keeping a cross-zone destination out of a booking.
   */
  const zoneCodes = useMemo(
    () => countryCode.split(',').map(c => c.trim().toUpperCase()).filter(Boolean),
    [countryCode],
  );
  /**
   * T-6 — accepting ANY of the listed zones is the CALLER's declared intent, not
   * something inferred from the list's length. `zoneCodes.length > 1` made a
   * one-zone deployment silently fall back to the box-only rule, which is the
   * arm that cannot apply the country tie-break at all.
   */
  const anyZone = (route.params as {anyZone?: boolean}).anyZone === true;
  const primaryCode = zoneCodes[0] ?? 'AE';
  const webRef = useRef<WebView>(null);
  /** The place the user picked from search, so our own recentre cannot clobber it. */
  const chosenRef = useRef<{lat: number; lng: number; address: string} | null>(null);

  // `usedInitialPin` — did we honour a location the user had ALREADY chosen?
  // If so the map must open there and must NOT be yanked to GPS on mount
  // (re-opening the picker to adjust a pin would otherwise throw the pin away).
  const {center: initialCenter, usedInitialPin} = useMemo(() => {
    // B-861 — the PRIMARY code is the draft's own zone, so a multi-zone picker
    // still opens on the hub the user is booking from, never the hard-coded
    // Dubai fallback (which is what a raw 'AE,ZA' lookup would have found).
    const firstZone = COVERAGE_ZONES.find(z => z.countryCode === primaryCode);
    const zoneCenter = firstZone
      ? {lat: firstZone.lat, lng: firstZone.lng}
      : {lat: 25.2048, lng: 55.2708};
    // Why: only honour a passed-in pin when it falls inside THIS country's coverage.
    // A stale pickup from a previous zone (e.g. a Dubai pin carried into a Bangladesh
    // booking) would otherwise pin the map to the wrong country and scope the address
    // search to it — making the chosen country's addresses impossible to find.
    if (initial) {
      // B-788 — honour a pin anywhere inside the zone's COUNTRY BOX (the
      // server's own rule), not only inside a city ring. A box-less region
      // (null) is treated as inside; the server decides.
      const inThisCountry = zoneCodes.some(
        c => isInsideRegionBox(c, initial.latitude, initial.longitude) !== false);
      if (inThisCountry) {
        return {center: {lat: initial.latitude, lng: initial.longitude}, usedInitialPin: true};
      }
    }
    return {center: zoneCenter, usedInitialPin: false};
  }, [zoneCodes, primaryCode, initial]);

  const [styleId, setStyleId] = useState<MapStyleId>('dark');

  const html = useMemo(() => {
    const zones = COVERAGE_ZONES
      .filter(z => zoneCodes.includes(z.countryCode))
      .map(z => ({id: z.id, label: z.label, lat: z.lat, lng: z.lng, radiusKm: z.radiusKm}));
    return buildLocationPickerHtml({
      mapboxToken: MAPBOX_TOKEN,
      initial: initialCenter,
      zones,
      countryCode,
      initialStyle: 'dark',
    });
    // html is built ONCE; style swaps happen via injectJavaScript, not rebuild.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countryCode]);
  // Why: keep the source object identity stable — a fresh {html} every render
  // leans on the WebView's internal string diff to avoid a full map reload.
  const webSource = useMemo(() => mapHtmlSource(html), [html]);

  // Map lifecycle: loading (booting/reloading) → ready ('ready' postMessage) →
  // failed (load error / renderer crash). Confirm is gated on 'ready' so the
  // user can never confirm a location over a blank map.
  // Issue 27 — measured height of the fixed CTA bar, so the coverage banner can
  // sit clear of it on every navigation mode instead of a hard-coded offset.
  const [ctaHeight, setCtaHeight] = useState(0);
  // B-830 — measured height of the top bar, so the FAB column clears the
  // search row it now carries at any fontScale.
  const [topBarH, setTopBarH] = useState(0);
  const [mapState, setMapState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [webViewKey, setWebViewKey] = useState(0);
  // B-77 — auto-remount budget for the watchdog below. Separate from a manual
  // RETRY so an auto-retry can't reset its own budget into a loop.
  const mapAutoRetries = useRef(0);
  const reloadMap = useCallback(() => {
    setMapState('loading');
    setWebViewKey(k => k + 1);
  }, []);
  const manualRetryMap = useCallback(() => {
    mapAutoRetries.current = 0;
    reloadMap();
  }, [reloadMap]);
  // B-77 — the map's `failed` state was effectively unreachable on Android:
  // react-native-webview only fires onError/onHttpError for MAIN-frame failures,
  // and the main frame is the inline HTML (which can't fail), so a style/tile/CDN
  // failure left an eternal "LOADING MAP…" with a permanently-disabled CONFIRM.
  // Watchdog: if the map hasn't posted `ready` within the window, auto-remount
  // once, then surface the RETRY overlay. Cleared the instant it reports ready.
  useEffect(() => {
    if (mapState === 'ready') {mapAutoRetries.current = 0; return undefined;}
    if (mapState !== 'loading') {return undefined;}
    const t = setTimeout(() => {
      if (mapAutoRetries.current < 1) {
        mapAutoRetries.current += 1;
        reloadMap();
      } else {
        setMapState('failed');
      }
    }, 15_000);
    return () => clearTimeout(t);
  }, [mapState, webViewKey, reloadMap]);

  // B-861 — the pin carries the map's reverse-geocoded ISO-2 country. It used
  // to be discarded, and without it the derivation has only the bounding boxes,
  // which overlap on Saudi soil in the east Empty Quarter.
  const [pin, setPin] = useState<{lat: number; lng: number; address: string; country: string | null}>({
    lat: initialCenter.lat, lng: initialCenter.lng, address: '', country: null,
  });
  /**
   * B-861 — a SEARCHED pin has no country until the recentre's own `moveend`
   * reverse-geocodes it, and until then the derivation has only the bounding
   * boxes — which is the one thing they cannot decide: the AE box swallows a
   * large piece of the Saudi Empty Quarter. CONFIRM was live in that window,
   * so a searched Saudi address could be filed as a UAE pick-up by tapping
   * before the map answered.
   *
   * Armed ONLY by `pickResult` (a dragged pin arrives WITH its country, or
   * with none at all and the bbox rule is all there ever was for it).
   */
  const [awaitingGeocode, setAwaitingGeocode] = useState(false);
  const geocodeWait = useRef<ReturnType<typeof setTimeout> | null>(null);
  const releaseGeocodeGate = useCallback(() => {
    if (geocodeWait.current) {clearTimeout(geocodeWait.current); geocodeWait.current = null;}
    setAwaitingGeocode(false);
  }, []);
  useEffect(() => () => {
    if (geocodeWait.current) {clearTimeout(geocodeWait.current);}
  }, []);

  /**
   * B-861 — with the launched list the zone is DERIVED FROM THE PIN (country
   * first, the box only as the offline fallback) and an UNLAUNCHED country is
   * refused even when a launched box contains it — a Riyadh pin sits in the AE
   * box and the server would refuse it as `unsupported_region`.
   */
  const pinZone = useMemo(
    () => (anyZone
      ? zoneFromPickup({lat: pin.lat, lng: pin.lng, country: pin.country}, zoneCodes)
      : null),
    [anyZone, pin.lat, pin.lng, pin.country, zoneCodes],
  );
  // B-788 — with ONE zone the ONLY gate on CONFIRM is that zone's country box
  // (the same rule create() prices on). `null` = no box known for this region →
  // allow; the server refuses `pickup_outside_region` itself. The city rings
  // are hints, never a wall — in either mode.
  const insideZone = anyZone
    ? pinZone !== null
    : isInsideRegionBox(primaryCode, pin.lat, pin.lng) !== false;
  /** The zone this pin belongs to: derived when any is acceptable, else the one passed in. */
  const zoneCode = anyZone ? pinZone : primaryCode;
  const hub = useMemo(
    () => checkCoverage(pin.lat, pin.lng, zoneCode ?? primaryCode),
    [pin.lat, pin.lng, zoneCode, primaryCode],
  );
  const zone = regionDef(zoneCode);
  // B-789 — where the DEVICE is (offline bbox). Drives the "booking elsewhere"
  // chip state and the decision NOT to yank the map to GPS.
  const [deviceRegion, setDeviceRegion] = useState<string | null>(null);
  // B-861 — "elsewhere" is now "outside every zone this picker accepts".
  const deviceElsewhere = deviceRegion !== null && !zoneCodes.includes(deviceRegion);
  // Search results rank around the pin while it is in the zone, else the hub —
  // never around a phone that is in another country.
  const searchAnchor = useMemo(
    () => (insideZone ? {lat: pin.lat, lng: pin.lng} : initialCenter),
    [insideZone, pin.lat, pin.lng, initialCenter],
  );

  const [permModal, setPermModal] = useState<null | {kind: 'denied' | 'error'; detail?: string}>(null);

  // ── Address search (Mapbox Search Box API v1) ──────────────────────────
  // The legacy /geocoding/v5 endpoint has thin POI coverage outside the US,
  // so queries like "Dhaka University" used to return nothing. Search Box
  // is Mapbox's POI-rich autocomplete endpoint and is a two-step flow:
  //   /suggest   → list of suggestions (name + mapbox_id, NO coords)
  //   /retrieve  → coords + full feature for one tapped suggestion
  // A session_token de-duplicates the suggest+retrieve pair on the billing
  // side; we generate one per screen mount.
  type Suggestion = {id: string; mapboxId: string; name: string; subtitle: string};
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Suggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionToken = useRef<string>(
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    }),
  );

  useEffect(() => {
    if (!searchOpen) {return;}
    if (searchDebounce.current) {clearTimeout(searchDebounce.current);}
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchDebounce.current = setTimeout(() => { void (async () => {
      try {
        // B-789a — scope to the BOOKING ZONE's country, never to whatever
        // country the pin happens to sit over. The pin opened on the phone's
        // GPS whenever it could, so scoping to the pin made "Cape Town" from a
        // Dubai-located phone search inside the UAE and return nothing.
        const country = countryCode.toLowerCase();
        const anchor = searchAnchor;
        type Sug = {name: string; mapbox_id: string; place_formatted?: string; full_address?: string; feature_type?: string};
        const suggest = async (scoped: boolean): Promise<Sug[]> => {
          const url =
            'https://api.mapbox.com/search/searchbox/v1/suggest' +
            `?q=${encodeURIComponent(q)}` +
            `&access_token=${encodeURIComponent(MAPBOX_TOKEN)}` +
            `&session_token=${encodeURIComponent(sessionToken.current)}` +
            `&proximity=${anchor.lng},${anchor.lat}` +
            (scoped ? `&country=${encodeURIComponent(country)}` : '') +
            '&language=en&limit=8' +
            '&types=poi,address,street,neighborhood,locality,place,district,category';
          const res = await fetch(url);
          const json = (await res.json()) as {suggestions?: Sug[]};
          return json.suggestions ?? [];
        };
        let suggestions = await suggest(true);
        // Nothing inside the zone: retry world-wide ONCE so a mistyped zone is
        // visible (every result carries its country in the subtitle) rather
        // than an unexplained empty list.
        if (suggestions.length === 0) {suggestions = await suggest(false);}
        setResults(
          suggestions.map((s, i) => ({
            id: `${s.mapbox_id}-${i}`,
            mapboxId: s.mapbox_id,
            name: s.name,
            subtitle: s.place_formatted ?? s.full_address ?? '',
          })),
        );
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    })(); }, 200);
    return () => {
      if (searchDebounce.current) {clearTimeout(searchDebounce.current);}
    };
  }, [query, searchOpen, searchAnchor, countryCode]);

  const pickResult = async (sug: Suggestion) => {
    const label = sug.subtitle ? `${sug.name}, ${sug.subtitle}` : sug.name;
    setSearchOpen(false);
    setQuery('');
    setResults([]);
    try {
      const url =
        `https://api.mapbox.com/search/searchbox/v1/retrieve/${encodeURIComponent(sug.mapboxId)}` +
        `?access_token=${encodeURIComponent(MAPBOX_TOKEN)}` +
        `&session_token=${encodeURIComponent(sessionToken.current)}`;
      const res = await fetch(url);
      const json = (await res.json()) as {
        features?: Array<{geometry?: {coordinates?: [number, number]}}>;
      };
      const coords = json.features?.[0]?.geometry?.coordinates;
      if (!coords || coords.length < 2) {return;}
      const [lng, lat] = coords;
      // The country lands on the recentre's own moveend (the map reverse-geocodes
      // the exact point); until then the derivation falls back to the boxes.
      setPin({lat, lng, address: label, country: null});
      // Recentring the map fires a moveend, whose reverse-geocode would
      // otherwise overwrite the name the user just chose with whatever Mapbox
      // calls that coordinate. Remember the choice so the moveend handler can
      // recognise its own recentre and keep it.
      chosenRef.current = {lat, lng, address: label};
      setAwaitingGeocode(true);
      if (geocodeWait.current) {clearTimeout(geocodeWait.current);}
      // A map that never answers must not wedge the CTA. After 4 s the
      // bounding-box arm takes over — the pre-B-861 behaviour, which still
      // refuses a box we do not serve. LIVENESS, not correctness.
      geocodeWait.current = setTimeout(() => {
        geocodeWait.current = null;
        setAwaitingGeocode(false);
      }, 4_000);
      webRef.current?.injectJavaScript(
        `try { window.recentre(${lng}, ${lat}); } catch(e){} true;`,
      );
    } catch {
      // retrieve failed — keep the modal-closed state, user can re-search.
    }
  };

  const cycleStyle = () => {
    const next: MapStyleId =
      styleId === 'dark' ? 'light' : styleId === 'light' ? 'streets' : styleId === 'streets' ? 'satellite' : 'dark';
    setStyleId(next);
    webRef.current?.injectJavaScript(
      `try { window.setMapStyle(${JSON.stringify(next)}); } catch(e){} true;`,
    );
  };

  const [, setLocating] = useState(false);

  const pushMeToMap = (lat: number, lng: number) => {
    webRef.current?.injectJavaScript(
      `try { window.showMeAt(${lng}, ${lat}); } catch(e){} true;`,
    );
  };

  const fetchPosition = () => {
    setLocating(true);
    Geolocation.getCurrentPosition(
      pos => {
        setLocating(false);
        pushMeToMap(pos.coords.latitude, pos.coords.longitude);
      },
      err => {
        setLocating(false);
        setPermModal({kind: 'error', detail: err?.message});
      },
      {enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000},
    );
  };

  /**
   * Open the picker ON the user's current position instead of on a coverage-zone
   * constant.
   *
   * Before this, `initialCenter` fell back to the first zone for the country —
   * `{25.2048, 55.2708}` (Dubai) for the default 'AE' — so the map opened on
   * Trade Centre and reverse-geocoded THAT into the search field before the user
   * touched anything. The crosshair was the only way to reach your own location.
   * The founder's rule: opening should centre on you; the crosshair is for
   * RE-CENTRING after you have scrolled away.
   *
   * Three things make this fiddly, all handled here:
   *  1. The map HTML is built ONCE (`html` useMemo is keyed on countryCode only,
   *     with initialCenter deliberately out of the dep array so the WebView is
   *     not rebuilt). So the centre CANNOT be moved by setting React state — it
   *     has to go through injectJavaScript, exactly like the search-result path.
   *  2. injectJavaScript before the WebView has loaded is silently DROPPED, so
   *     this must wait for mapState === 'ready'.
   *  3. It must not run when the user is re-opening the picker to adjust a pin
   *     they already chose (`usedInitialPin`) — that would discard their choice.
   *
   * Permission-wise this only ever uses a grant the user has already given, or
   * asks once with the same rationale the crosshair uses. A refusal is silent:
   * the map simply stays on the zone centre, exactly as it did before.
   */
  const autoCentredRef = useRef(false);
  useEffect(() => {
    if (autoCentredRef.current) {return;}
    if (mapState !== 'ready') {return;}
    if (usedInitialPin) {return;}
    autoCentredRef.current = true;
    void (async () => {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        );
        if (!granted) {
          const res = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
            {
              title: 'Find your location',
              message: 'Bravo Secure uses your location only to pin your position on the map.',
              buttonPositive: 'Allow',
              buttonNegative: 'Not now',
            },
          );
          // Silent on refusal — the zone centre is a perfectly usable fallback
          // and the crosshair is still there. Do NOT surface the blocked modal
          // here; the user did not ask for their location, we did.
          if (res !== PermissionsAndroid.RESULTS.GRANTED) {return;}
        }
      }
      Geolocation.getCurrentPosition(
        pos => {
          // B-789 — the ZONE is the authority. Centre on the phone only when it
          // is inside the zone being booked; a Dubai user booking South Africa
          // keeps the map over the zone hub and searches there. The crosshair
          // still centres on demand.
          const dev = regionFromBBox(pos.coords.latitude, pos.coords.longitude);
          setDeviceRegion(dev);
          // B-861 — "inside the zone being booked" becomes "inside ANY zone this
          // picker accepts", which for the Lite pick-up is the launched set.
          if (zoneCodes.includes(dev)) {
            pushMeToMap(pos.coords.latitude, pos.coords.longitude);
          }
        },
        () => {/* silent — see above */},
        {enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000},
      );
    })();

  }, [mapState, usedInitialPin, zoneCodes]);

  const locateMe = async () => {
    if (Platform.OS !== 'android') {
      // iOS auth is requested lazily by the geolocation library.
      fetchPosition();
      return;
    }
    const already = await PermissionsAndroid.check(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    );
    if (already) {
      fetchPosition();
      return;
    }
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      {
        title: 'Find your location',
        message: 'Bravo Secure uses your location only to pin your position on the map.',
        buttonPositive: 'Allow',
        buttonNegative: 'Not now',
      },
    );
    if (result === PermissionsAndroid.RESULTS.GRANTED) {
      fetchPosition();
    } else if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
      setPermModal({kind: 'denied'});
    }
    // If just DENIED (not NEVER_ASK_AGAIN), no modal — user can tap again.
  };

  const onMessage = useCallback((e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data) as {
        type?: string; lng?: number; lat?: number;
        address?: string; country?: string; message?: string;
      };
      if (msg.type === 'ready') {
        setMapState('ready');
      } else if (msg.type === 'err') {
        // Review m-5 — the HTML's constructor fast-fail post was inert
        // here: treat a pre-ready fatal as failed (same guard as onError).
        setMapState(st => (st === 'ready' ? st : 'failed'));
      } else if (msg.type === 'moveend' && typeof msg.lat === 'number' && typeof msg.lng === 'number') {
        // A moveend landing on the exact point the user picked from search is
        // OUR recentre, not them dragging — keep the name they chose. Anything
        // else is a real pan, so the reverse-geocoded name wins and the
        // remembered choice is discarded. 1e-5 deg is about a metre.
        const chosen = chosenRef.current;
        const isOwnRecentre = !!chosen
          && Math.abs(chosen.lat - msg.lat) < 1e-5
          && Math.abs(chosen.lng - msg.lng) < 1e-5;
        setPin({
          lat: msg.lat,
          lng: msg.lng,
          address: isOwnRecentre ? chosen.address : (msg.address ?? ''),
          // B-861 — the reverse-geocoded country belongs to the POINT, so it is
          // kept on both branches: our own recentre keeps only the NAME the user
          // chose, never a stale country from the pin before it.
          country: msg.country || null,
        });
        if (!isOwnRecentre) {chosenRef.current = null;}
        // The country has landed — or the user panned away from the search
        // pin entirely, which puts them back on the ordinary bbox rule.
        if (msg.country || !isOwnRecentre) {releaseGeocodeGate();}
      } else if (msg.type === 'locate:denied') {
        setPermModal({kind: 'denied'});
      } else if (msg.type === 'locate:error') {
        setPermModal({kind: 'error', detail: msg.message});
      }
    } catch {
      // ignore
    }
  }, [releaseGeocodeGate]);

  const confirm = () => {
    if (!insideZone || awaitingGeocode) {return;}
    // The caller names its own return route (Executive Protection screens do); the Lite
    // schedule screen predates the param and stays the default. `merge: true`
    // pops back when the route is already on the stack (Lite) and pushes
    // forward when it isn't yet (executive wizard step order).
    navigation.navigate({
      name: (onPickRouteKey ?? 'BookingDateTime') as never,
      params: {
        pickedAddress: pin.address || `${hub.nearest?.label ?? ''}, ${zoneCode ?? primaryCode}`,
        pickedLat: pin.lat,
        pickedLng: pin.lng,
        pickedKind: kind,
        pickedAt: Date.now(),
        pickedCountry: pin.country || undefined,
        // B-861 — the caller re-derives the zone from the point, and at the
        // AE/SA border only the geocoded country can settle it. Untyped on the
        // param list on purpose: `src/navigation/types.ts` is owned elsewhere,
        // and the readers widen locally.
      } as never,
      merge: true,
    });
  };

  // B-89 MG-04 — tokenless build: honest state instead of a retry loop.
  if (MAPBOX_TOKEN_MISSING) {
    return (
      <View style={s.root}>
        <StatusBar barStyle="light-content" backgroundColor={UI.bg} />
        <MapFailedOverlay onRetry={() => {}} variant="misconfigured" />
        <View style={[s.topBar, {paddingTop: insets.top + 8}]}>
          <TouchableOpacity style={s.back} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
            <Icon name="chevron-left" size={22} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg} />

      <WebView
        key={`picker-map-${webViewKey}`}
        ref={webRef}
        source={webSource}
        onMessage={onMessage}
        style={s.web}
        javaScriptEnabled
        domStorageEnabled
        mixedContentMode="compatibility"
        originWhitelist={['*']}
        androidLayerType={Platform.OS === 'android' ? 'hardware' : undefined}
        bounces={false}
        onLoadStart={() => setMapState('loading')}
        // Why: on Android these also fire for subresource failures (a single
        // 404'd tile) — only treat them as fatal before the map reported ready.
        onError={() => setMapState(st => (st === 'ready' ? st : 'failed'))}
        onHttpError={() => setMapState(st => (st === 'ready' ? st : 'failed'))}
        onRenderProcessGone={manualRetryMap}
        onContentProcessDidTerminate={manualRetryMap}
      />

      {/* Map boot / failure overlays — never leave a silent dark void. */}
      {mapState === 'loading' && (
        <View style={s.mapOverlay} pointerEvents="none">
          <LoadingView compact />
          <Text style={s.mapOverlayText}>LOADING MAP…</Text>
        </View>
      )}
      {mapState === 'failed' && (
        <View style={s.mapOverlay}>
          <Icon name="map-marker-off-outline" size={22} color={UI.amber} />
          <Text style={s.mapOverlayText}>Map failed to load — check your connection.</Text>
          <TouchableOpacity style={s.mapRetry} onPress={manualRetryMap} activeOpacity={0.85}>
            <Text style={s.mapRetryText}>RETRY</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Top bar */}
      <View
        style={[s.topBar, {paddingTop: insets.top + 8}]}
        onLayout={e => setTopBarH(e.nativeEvent.layout.height)}>
        <View style={s.topRow}>
          <TouchableOpacity
            style={s.back}
            onPress={() => goBackOnce(navigation)}
            activeOpacity={0.7}
            hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
            accessibilityRole="button"
            accessibilityLabel="Go back">
            <Icon name="chevron-left" size={22} color="#FFF" />
          </TouchableOpacity>
          <View style={s.topInfo}>
            <Text style={s.topKicker}>
              {kind === 'pickup' ? 'SELECT PICK-UP' : 'SELECT DROP-OFF'}
            </Text>
            {/* B-861 A7 — INFORMATIONAL. The "· Change" door to ZoneMap is gone:
                the zone follows the pin now, so a separate zone choice on this
                screen could only contradict the pin the user is placing. */}
            <View style={[zs.chip, deviceElsewhere && zs.chipWarn]}>
              <Text
                style={[zs.chipText, deviceElsewhere && zs.chipWarnText]}
                numberOfLines={1}>
                {zone
                  ? `${zone.flag ? `${zone.flag} ` : ''}${zone.name}`
                  : `Zone follows your pick-up · ${launchedZonesLabel()}`}
              </Text>
            </View>
          </View>
        </View>
        {/* Why: B-830, founder 2026-09-08 — the address search comes back to the
            top bar, highlighted as the primary control. This reverses the same
            founder's 2026-08-01 move to the map's foot ("thumb reach"); the
            newer instruction wins because the field was being missed entirely. */}
        <TouchableOpacity
          style={s.searchBar}
          onPress={() => setSearchOpen(true)}
          activeOpacity={0.85}
          testID="location-search-bar"
          accessibilityRole="button"
          accessibilityLabel="Search an address">
          <Icon name="magnify" size={18} color={UI.accent} />
          <Text
            numberOfLines={1}
            style={[s.searchBarText, !pin.address && s.searchBarMuted]}>
            {pin.address || 'Search an address…'}
          </Text>
          <Icon name="chevron-right" size={18} color={UI.accent} />
        </TouchableOpacity>
      </View>

      {/* Floating controls on the right edge */}
      <View style={[s.fabCol, {top: topBarH > 0 ? topBarH + 12 : insets.top + 128}]}>
        <TouchableOpacity
          style={s.fab}
          onPress={cycleStyle}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Change map style">
          <Icon
            name={styleId === 'dark' ? 'map-outline' : styleId === 'streets' ? 'satellite-variant' : 'map'}
            size={18}
            color="#FFF"
          />
        </TouchableOpacity>
        <View style={s.fabLabel}>
          <Text style={s.fabLabelText}>
            {styleId === 'dark' ? 'DARK' : styleId === 'streets' ? 'STREETS' : 'SAT'}
          </Text>
        </View>

        <TouchableOpacity
          style={[s.fab, s.fabAccent]}
          onPress={() => { void locateMe(); }}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Use my current location">
          <Icon name="crosshairs-gps" size={18} color="#FFF" />
        </TouchableOpacity>
      </View>

      {/* Coverage status banner.
          Issue 27 — `bottom` was a hard-coded 96, but the CTA bar is
          inset-aware: 10 (paddingTop) + 48 (button) + bottomPad(12).
          On 3-button navigation that is ~118dp, so the bar sat ON TOP of this
          banner and hid whether the pin was in coverage. Driven off the measured
          CTA height now, with the same arithmetic as the pre-measure fallback. */}
      <View style={[s.bottomStack, {bottom: (ctaHeight > 0 ? ctaHeight : CTA_FALLBACK_H) + 12}]}>
        <View style={[s.banner, insideZone ? s.bannerOk : s.bannerWarn]}>
          <Icon
            name={insideZone ? 'shield-check' : 'map-marker-alert'}
            size={16}
            color={insideZone ? UI.signal : UI.amber}
          />
          <Text style={s.bannerText} numberOfLines={2}>
            {/* B-788 — distance to a hub is INFORMATION. The provider decides
                whether it is feasible; the box decides whether it is bookable. */}
            {insideZone
              ? hub.nearHub
                ? `In ${zone?.name ?? primaryCode} · ${hub.nearest?.label} area`
                : hub.nearest
                  ? `In ${zone?.name ?? primaryCode} · nearest Bravo hub ${hub.nearest.label}, ${hub.distanceKm} km`
                  : `In ${zone?.name ?? primaryCode}`
              // B-861 — with the launched list there is no "booking zone" left to
              // change; the refusal names where we DO operate instead.
              : anyZone
                ? `We don't operate here yet — pick a location in ${launchedZonesLabel()}`
                : `Outside ${zone?.name ?? primaryCode} — move the pin or change the booking zone`}
          </Text>
        </View>
      </View>

      {/* Address search modal — full-screen with live Mapbox geocoding */}
      <Modal
        visible={searchOpen}
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => setSearchOpen(false)}>
        {/* B-184 — the results list shrinks by the true IME overlap; the
            search field itself lives at the top and is never covered. */}
        <View style={[s.searchRoot, {paddingBottom: keyboardOverlap}]}>
          <View style={[s.searchHeader, {paddingTop: insets.top + 8}]}>
            <TouchableOpacity
              style={s.back}
              onPress={() => setSearchOpen(false)}
              activeOpacity={0.7}
              hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
              accessibilityRole="button"
              accessibilityLabel="Close search">
              <Icon name="chevron-left" size={22} color="#FFF" />
            </TouchableOpacity>
            <View style={s.searchField}>
              <Icon name="magnify" size={16} color={UI.textMute} />
              <TextInput
                style={s.searchInput}
                placeholder={kind === 'pickup' ? 'Search pick-up address…' : 'Search destination…'}
                placeholderTextColor={UI.textMute}
                value={query}
                onChangeText={setQuery}
                autoFocus
                returnKeyType="search"
                selectionColor={UI.accent}
              />
              {query.length > 0 && (
                <TouchableOpacity
                  onPress={() => setQuery('')}
                  hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                  accessibilityRole="button"
                  accessibilityLabel="Clear search text">
                  <Icon name="close-circle" size={16} color={UI.textMute} />
                </TouchableOpacity>
              )}
            </View>
          </View>

          {searching && (
            <View style={s.searchStatus}>
              <ActivityIndicator size="small" color={UI.accent} />
              <Text style={s.searchStatusText}>Searching…</Text>
            </View>
          )}

          {!searching && query.trim().length >= 2 && results.length === 0 && (
            <View style={s.searchStatus}>
              <Icon name="map-search-outline" size={18} color={UI.textMute} />
              <Text style={s.searchStatusText}>No matches found.</Text>
            </View>
          )}

          <FlatList
            data={results}
            keyExtractor={r => r.id}
            keyboardShouldPersistTaps="handled"
            ItemSeparatorComponent={ResultSeparator}
            renderItem={({item}) => (
              <TouchableOpacity
                style={s.result}
                onPress={() => { void pickResult(item); }}
                activeOpacity={0.85}>
                <Icon name="map-marker-outline" size={18} color={UI.accent} />
                <View style={{flex: 1}}>
                  <Text style={s.resultText} numberOfLines={1}>{item.name}</Text>
                  {item.subtitle ? (
                    <Text style={s.resultSubtitle} numberOfLines={1}>{item.subtitle}</Text>
                  ) : null}
                </View>
              </TouchableOpacity>
            )}
          />
        </View>
      </Modal>

      {/* Permission / GPS error modal — Bravo-themed */}
      <Modal
        visible={!!permModal}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setPermModal(null)}>
        <Pressable style={s.mBackdrop} onPress={() => setPermModal(null)}>
          <Pressable style={s.mCard} onPress={() => {}}>
            <View style={s.mIconWrap}>
              <Icon
                name={permModal?.kind === 'denied' ? 'shield-lock-outline' : 'crosshairs-question'}
                size={28}
                color={UI.accent}
              />
            </View>
            <Text style={s.mTitle}>
              {permModal?.kind === 'denied' ? 'Location access blocked' : 'Couldn’t find you'}
            </Text>
            <Text style={s.mBody}>
              {permModal?.kind === 'denied'
                ? 'Enable location in your phone Settings → Apps → Bravo Secure → Permissions so we can pin your spot.'
                : permModal?.detail ?? 'GPS is unavailable right now. Try again outdoors or with Wi-Fi on.'}
            </Text>
            <TouchableOpacity
              style={s.mPrimary}
              onPress={() => setPermModal(null)}
              activeOpacity={0.85}>
              <Text style={s.mPrimaryText}>GOT IT</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Confirm button — also gated on map readiness (no blank-map confirms). */}
      <View
        style={[s.ctaWrap, {paddingBottom: bottomPad(12)}]}
        onLayout={e => setCtaHeight(e.nativeEvent.layout.height)}>
        <TouchableOpacity
          style={[s.cta, (!insideZone || mapState !== 'ready' || awaitingGeocode) && s.ctaDisabled]}
          onPress={confirm}
          disabled={!insideZone || mapState !== 'ready' || awaitingGeocode}
          activeOpacity={0.85}>
          <Icon name="check" size={16} color="#FFF" />
          <Text style={s.ctaText}>
            {mapState !== 'ready' ? 'MAP LOADING…'
              : awaitingGeocode ? 'CHECKING THE ZONE…'
              : insideZone ? 'CONFIRM LOCATION' : 'OUTSIDE ZONE'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: UI.bg},
  web: {flex: 1, backgroundColor: UI.bg},

  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    gap: 8, paddingHorizontal: 14, paddingBottom: 10,
    backgroundColor: 'rgba(7,9,13,0.82)',
    borderBottomWidth: 1, borderBottomColor: 'rgba(91,141,239,0.18)',
  },
  topRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  back: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(20,24,33,0.9)', borderWidth: 1, borderColor: UI.hair,
    alignItems: 'center', justifyContent: 'center',
  },
  topInfo: {flex: 1, minWidth: 0, justifyContent: 'center'},
  topKicker: {
    fontFamily: BravoFont.semiBold, fontSize: 10, letterSpacing: 1.6,
    color: UI.textMute,
  },
  // B-830 — the primary control of this screen: accent-tinted, accent-bordered
  // and lifted, so it reads as a button over the map instead of a caption.
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: 9,
    minHeight: 48, paddingHorizontal: 13, paddingVertical: 10, borderRadius: 14,
    backgroundColor: 'rgba(91,141,239,0.18)',
    borderWidth: 1.5, borderColor: UI.accent,
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 8,
    shadowOffset: {width: 0, height: 3}, elevation: 3,
  },
  searchBarText: {flex: 1, fontFamily: BravoFont.semiBold, fontSize: 14, color: '#FFF'},
  searchBarMuted: {color: 'rgba(255,255,255,0.7)'},

  // ── Address search modal ───────────────────────────────────────
  searchRoot: {flex: 1, backgroundColor: UI.bg},
  searchHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 12, paddingBottom: 10,
    borderBottomWidth: 1, borderBottomColor: UI.hair,
  },
  searchField: {
    flex: 1, height: 44, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderWidth: 1, borderColor: UI.hair,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12,
  },
  searchInput: {
    flex: 1, fontSize: 14, color: UI.text,
    fontFamily: BravoFont.regular, paddingVertical: 0,
  },
  searchStatus: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 20, paddingVertical: 14,
  },
  searchStatusText: {
    fontSize: 12.5, color: UI.textMute,
  },
  result: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 18, paddingVertical: 12,
  },
  resultText: {
    fontSize: 14, color: UI.text, lineHeight: 18, fontWeight: '600',
  },
  resultSubtitle: {
    fontSize: 12, color: UI.textMute, lineHeight: 16, marginTop: 2,
  },
  resultSep: {
    height: 1, backgroundColor: UI.hair, marginHorizontal: 16,
  },

  fabCol: {
    position: 'absolute', right: 14, zIndex: 15,
    gap: 8, alignItems: 'center',
  },
  fab: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(20,24,33,0.92)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 10,
    shadowOffset: {width: 0, height: 4}, elevation: 6,
  },
  fabAccent: {
    backgroundColor: UI.accent,
    borderColor: 'rgba(255,255,255,0.3)',
    shadowColor: UI.accent, shadowOpacity: 0.5,
  },
  fabLabel: {
    paddingHorizontal: 6, paddingVertical: 3, borderRadius: 6,
    backgroundColor: 'rgba(20,24,33,0.92)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  fabLabelText: {
    fontFamily: BravoFont.bold, fontSize: 9, letterSpacing: 1.2,
    color: '#FFF',
  },

  mapOverlay: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: 'rgba(7,9,13,0.55)',
  },
  mapOverlayText: {
    fontFamily: BravoFont.semiBold, fontSize: 11, letterSpacing: 1.4,
    color: UI.textDim, textAlign: 'center', paddingHorizontal: 40,
  },
  mapRetry: {
    marginTop: 4, paddingHorizontal: 18, paddingVertical: 9, borderRadius: 8,
    backgroundColor: UI.accent,
  },
  mapRetryText: {
    fontFamily: BravoFont.bold, fontSize: 11, letterSpacing: 1.2, color: '#FFF',
  },

  // Issue 27 — `bottom` is supplied at render from the measured CTA height.
  bottomStack: {position: 'absolute', left: 16, right: 16, gap: 8},
  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 11, borderRadius: 10,
  },
  bannerOk: {
    backgroundColor: 'rgba(0,200,83,0.1)',
    borderWidth: 1, borderColor: 'rgba(0,200,83,0.35)',
  },
  bannerWarn: {
    backgroundColor: 'rgba(255,193,7,0.12)',
    borderWidth: 1, borderColor: 'rgba(255,193,7,0.35)',
  },
  bannerText: {flex: 1, fontSize: 12, color: '#FFF'},

  ctaWrap: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: 16, paddingTop: 10,
    backgroundColor: 'rgba(7,9,13,0.92)',
    borderTopWidth: 1, borderTopColor: UI.hair,
  },
  cta: {
    minHeight: 48, borderRadius: 8, backgroundColor: UI.accent,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    shadowColor: UI.accent, shadowOpacity: 0.4, shadowRadius: 14,
    shadowOffset: {width: 0, height: 6}, elevation: 6,
  },
  ctaDisabled: {backgroundColor: '#27324A', shadowOpacity: 0, elevation: 0},
  ctaText: {
    fontFamily: BravoFont.bold, fontSize: 13, color: '#FFF',
    letterSpacing: 1.2,
  },

  // ── Themed permission modal ────────────────────────────────────
  mBackdrop: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 32,
    backgroundColor: 'rgba(2, 6, 15, 0.82)',
  },
  mCard: {
    width: '100%', maxWidth: 340,
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderRadius: 18, paddingTop: 24, paddingBottom: 16, paddingHorizontal: 22,
    borderWidth: 1, borderColor: UI.hair,
    alignItems: 'center',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 24,
    shadowOffset: {width: 0, height: 14}, elevation: 24,
  },
  mIconWrap: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: 'rgba(91,141,239,0.14)',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.35)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 14,
  },
  mTitle: {
    fontFamily: BravoFont.bold, fontSize: 16,
    color: UI.text, letterSpacing: -0.2,
    textAlign: 'center', marginBottom: 8,
  },
  mBody: {
    fontFamily: BravoFont.regular, fontSize: 13,
    color: UI.textDim, lineHeight: 18,
    textAlign: 'center', marginBottom: 18,
  },
  mPrimary: {
    width: '100%', height: 44, borderRadius: 10,
    backgroundColor: UI.accent,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: UI.accent, shadowOpacity: 0.4, shadowRadius: 12,
    shadowOffset: {width: 0, height: 4}, elevation: 4,
  },
  mPrimaryText: {
    fontFamily: BravoFont.bold, fontSize: 12.5, letterSpacing: 1.4,
    color: '#FFF',
  },
}));
