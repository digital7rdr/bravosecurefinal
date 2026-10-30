/**
 * GeoRisk in-app navigation (owner 2026-10-30: "GeoRisk navigation must stay
 * inside BRAVO App … navigation should start with voice interaction").
 *
 * Navigate on a key point (police, hospital, embassy, fire) or a recorded
 * position used to hand off to Google Maps / Waze / Apple Maps. It now opens
 * this screen:
 *
 *   1. PREVIEW — route from your position, Drive or Walk, up to three route
 *      choices with time, distance and the main road. Nothing leaves the app.
 *   2. NAVIGATING — Bravo's own turn-by-turn: maneuver banner, next turns,
 *      remaining distance, arrival time, track-up camera that closes in at
 *      turns, re-routing when you leave the line. Voice guidance starts the
 *      moment Start is tapped ("Starting navigation to …") and announces every
 *      turn; the speaker button mutes it.
 *   3. ARRIVED — "You have arrived at …".
 *
 * Built on what the CPO tracker already drives missions with: the Mapbox
 * WebView map (bravoAgentTrackerMapHtml), utils/mapboxDirections,
 * utils/navVoice and modules/maps/navCamera. The decisions specific to this
 * screen are pure and tested in vbgNavigation.ts.
 *
 * Coordinates are never logged.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView} from 'react-native';
import {WebView, type WebViewMessageEvent} from 'react-native-webview';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import type {BookingStackParamList} from '@navigation/types';
import {goBackOnce} from '@navigation/tapGuard';
import {useBottomInset} from '@hooks/useBottomInset';
import {scaleTextStyles} from '@utils/scaling';
import {useMapReload} from '@/modules/maps/useMapReload';
import {MapFailedOverlay} from '@/modules/maps/MapFailedOverlay';
import {MAPBOX_TOKEN, MAPBOX_TOKEN_MISSING} from '@/modules/maps/mapToken';
import {mapHtmlSource} from '@/modules/maps/mapWebViewSource';
import {navCameraFor, shouldRetarget, type NavCamFrame} from '@/modules/maps/navCamera';
import {subscribeOwnPosition, type OwnFix} from '@services/ownPositionBus';
import {
  fetchDirections, fetchRouteAlternatives, hasDirectionsToken, haversineM, nearestIndexOnRoute,
  nextManeuver, offRouteDistanceM, remainingRouteM, splitRouteAtProgress, upcomingManeuvers,
  formatDistance, formatDuration, type DirectionsRoute, type LngLat,
} from '@utils/mapboxDirections';
import {pickAnnouncement, routeVoiceId} from '@utils/navVoice';
import {speakGuidance, stopGuidance} from '@utils/navSpeech';
import {
  arrivalAnnouncement, arrivalClock, defaultModeFor, hasArrived, profileFor, remainingSeconds,
  REROUTE_ANNOUNCEMENT, shouldReroute, startAnnouncement, type TravelMode,
} from './vbgNavigation';
import {VBG} from './vbgUi';

type Nav = NativeStackNavigationProp<BookingStackParamList>;
type Phase = 'locating' | 'no-location' | 'routing' | 'preview' | 'no-route' | 'navigating' | 'arrived';
type IconName = React.ComponentProps<typeof Icon>['name'];

/** No first fix within this window → say so and offer Try again. */
const FIX_TIMEOUT_MS = 20_000;

function maneuverIcon(modifier: string | null, type: string): IconName {
  if (type === 'arrive') {return 'map-marker-check';}
  const m = (modifier ?? '').toLowerCase();
  if (m.includes('uturn')) {return 'arrow-u-left-top';}
  if (m.includes('left')) {return 'arrow-top-left';}
  if (m.includes('right')) {return 'arrow-top-right';}
  return 'arrow-up';
}

const toPairs = (coords: LngLat[]): [number, number][] => coords.map(c => [c.lng, c.lat] as [number, number]);

export default function VBGNavigateScreen() {
  const navigation = useNavigation<Nav>();
  const {params} = useRoute<RouteProp<BookingStackParamList, 'VBGNavigate'>>();
  const dest = params.dest;
  const destLL = useMemo<LngLat>(() => ({lng: dest.lng, lat: dest.lat}), [dest.lng, dest.lat]);
  const destLabel = dest.label?.trim() || 'Destination';
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const unavailable = MAPBOX_TOKEN_MISSING || !hasDirectionsToken();

  // ── Map (same WebView map as the CPO tracker) ─────────────
  const webRef = useRef<WebView>(null);
  const map = useMapReload();
  const webReady = map.status === 'ready';
  const inject = useCallback((js: string) => { webRef.current?.injectJavaScript(`${js} true;`); }, []);
  const html = useMemo(() => {
    const {buildAgentTrackerHtml} = require('@modules/booking/bravoAgentTrackerMapHtml') as {
      buildAgentTrackerHtml: (t: string) => string;
    };
    return buildAgentTrackerHtml(MAPBOX_TOKEN);
  }, []);
  const webSource = useMemo(() => mapHtmlSource(html), [html]);

  // ── State ────────────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>('locating');
  const phaseRef = useRef<Phase>('locating');
  const go = useCallback((p: Phase) => { phaseRef.current = p; setPhase(p); }, []);
  const [mode, setMode] = useState<TravelMode | null>(null);
  const [routes, setRoutes] = useState<DirectionsRoute[]>([]);
  const [selected, setSelected] = useState(0);
  const [voiceOn, setVoiceOn] = useState(true);
  const voiceOnRef = useRef(true);
  useEffect(() => { voiceOnRef.current = voiceOn; if (!voiceOn) {stopGuidance();} }, [voiceOn]);
  const [banner, setBanner] = useState<{primary: string; secondary: string | null; distance: string; icon: IconName} | null>(null);
  const [nextTurns, setNextTurns] = useState<Array<{key: string; text: string; distance: string; icon: IconName}>>([]);
  const [summary, setSummary] = useState<{remaining: string; minutes: string; eta: string} | null>(null);
  const [fixTry, setFixTry] = useState(0);

  const fixRef = useRef<OwnFix | null>(null);
  const liveRouteRef = useRef<DirectionsRoute | null>(null);
  const modeRef = useRef<TravelMode>('drive');
  const spokenRef = useRef<Set<string>>(new Set());
  const voiceRouteIdRef = useRef('');
  const lastSplitRef = useRef<{idx: number; at: LngLat; id: string} | null>(null);
  const camRef = useRef<NavCamFrame | null>(null);
  const sigRef = useRef({banner: '', turns: '', summary: ''});
  const rerouteRef = useRef({lastFetch: 0, inFlight: false, announced: false});
  const destKey = `${dest.lng.toFixed(5)},${dest.lat.toFixed(5)}`;

  const say = useCallback((text: string): boolean => (voiceOnRef.current ? speakGuidance(text) : false), []);
  useEffect(() => () => { stopGuidance(); }, []);

  // ── Position: 1 Hz own-device fixes, for the whole screen ──
  const [hasFix, setHasFix] = useState(false);
  useEffect(() => {
    if (unavailable) {return undefined;}
    const off = subscribeOwnPosition(fix => {
      fixRef.current = fix;
      setHasFix(true);
      if (phaseRef.current === 'navigating') {tickRef.current(fix);}
    });
    const t = setTimeout(() => {
      if (!fixRef.current && phaseRef.current === 'locating') {go('no-location');}
    }, FIX_TIMEOUT_MS);
    return () => { clearTimeout(t); off(); };
  }, [unavailable, fixTry, go]);

  // The puck follows every fix, in every phase.
  const lastPuckRef = useRef(0);
  useEffect(() => {
    if (!webReady) {return undefined;}
    const id = setInterval(() => {
      const f = fixRef.current;
      if (!f || f.receivedAt === lastPuckRef.current || phaseRef.current === 'navigating') {return;}
      lastPuckRef.current = f.receivedAt;
      inject(`window.setCpo(${JSON.stringify({lat: f.lat, lng: f.lng, heading_deg: f.headingDeg, callsign: 'You'})});`);
    }, 1000);
    return () => clearInterval(id);
  }, [webReady, inject]);

  // Destination pin as soon as the map is up.
  useEffect(() => {
    if (!webReady) {return;}
    inject(`window.setRoute(${JSON.stringify({pickup: null, dropoff: {lat: dest.lat, lng: dest.lng}, dropoffLabel: destLabel})});`);
  }, [webReady, inject, dest.lat, dest.lng, destLabel]);

  // ── Preview: fetch route choices ───────────────────────────
  const drawPreview = useCallback((list: DirectionsRoute[], pick: number) => {
    if (!webReady || list.length === 0) {return;}
    const chosen = list[Math.min(pick, list.length - 1)];
    inject(`window.setNavRoute(${JSON.stringify({traveled: [], ahead: toPairs(chosen.coordinates)})});`);
    inject(`window.setAlternatives(${JSON.stringify(list.map((r, i) => ({id: r.id || String(i), coords: toPairs(r.coordinates), selected: i === pick})))});`);
    inject(`window.fitRoute(${JSON.stringify(list.flatMap(r => toPairs(r.coordinates)))});`);
  }, [webReady, inject]);

  const loadRoutes = useCallback(async (m: TravelMode) => {
    const f = fixRef.current;
    if (!f) {return;}
    go('routing');
    const list = await fetchRouteAlternatives({lng: f.lng, lat: f.lat}, destLL, {profile: profileFor(m)});
    if (phaseRef.current !== 'routing') {return;}
    setRoutes(list);
    setSelected(0);
    go(list.length ? 'preview' : 'no-route');
  }, [destLL, go]);

  // First fix → pick Walk or Drive by distance, then fetch.
  useEffect(() => {
    if (!hasFix || mode !== null || !fixRef.current) {return;}
    const m = defaultModeFor(haversineM({lng: fixRef.current.lng, lat: fixRef.current.lat}, destLL));
    modeRef.current = m;
    setMode(m);
    void loadRoutes(m);
  }, [hasFix, mode, destLL, loadRoutes]);

  useEffect(() => {
    if (phase === 'preview') {drawPreview(routes, selected);}
  }, [phase, routes, selected, drawPreview]);

  const chooseMode = (m: TravelMode) => {
    if (m === mode || phase === 'routing') {return;}
    modeRef.current = m;
    setMode(m);
    void loadRoutes(m);
  };

  // ── Navigating: one tick per fix ───────────────────────────
  const tick = useCallback((f: OwnFix) => {
    const rt = liveRouteRef.current;
    if (!rt) {return;}
    const p: LngLat = {lng: f.lng, lat: f.lat};
    const rid = routeVoiceId(rt, destKey);
    inject(`window.setCpo(${JSON.stringify({lat: f.lat, lng: f.lng, heading_deg: f.headingDeg, callsign: 'You'})});`);

    // Line split — only when it actually moved (the payload is the whole route).
    const idx = nearestIndexOnRoute(rt.coordinates, p);
    const prev = lastSplitRef.current;
    if (!prev || prev.id !== rid || prev.idx !== idx || haversineM(prev.at, p) > 20) {
      lastSplitRef.current = {idx, at: p, id: rid};
      const {traveled, remaining} = splitRouteAtProgress(rt.coordinates, p);
      inject(`window.setNavRoute(${JSON.stringify({traveled: toPairs(traveled), ahead: toPairs(remaining)})});`);
    }

    const remainM = remainingRouteM(rt.coordinates, p);
    if (hasArrived(remainM, haversineM(p, destLL))) {
      go('arrived');
      setBanner(null);
      setNextTurns([]);
      say(arrivalAnnouncement(destLabel));
      inject(`window.setNavCamera(${JSON.stringify({mode: 'north', rearm: true})});`);
      return;
    }

    const nm = nextManeuver(rt, p);
    if (nm) {
      const primary = nm.step.bannerPrimary || nm.step.instruction || 'Continue';
      const distance = formatDistance(nm.distanceM);
      const icon = maneuverIcon(nm.step.modifier, nm.step.maneuverType);
      const sig = `${primary}|${nm.step.bannerSecondary ?? ''}|${distance}|${icon}`;
      if (sig !== sigRef.current.banner) {
        sigRef.current.banner = sig;
        setBanner({primary, secondary: nm.step.bannerSecondary, distance, icon});
      }
      if (rid !== voiceRouteIdRef.current) {
        voiceRouteIdRef.current = rid;
        spokenRef.current = new Set();
      }
      const cue = pickAnnouncement({
        route: rt, stepIndex: nm.index, distanceToManeuverM: nm.distanceM, spoken: spokenRef.current, routeId: rid,
      });
      // Record only what was actually said: muted / on a call keeps it pending.
      if (cue && say(cue.text)) {
        spokenRef.current.add(cue.key);
        for (const k of cue.superseded) {spokenRef.current.add(k);}
      }
    }

    const ups = upcomingManeuvers(rt, p, 4).slice(1);
    const turnSig = ups.map(u => `${u.index}:${Math.round(u.distanceM / 50)}`).join('|');
    if (turnSig !== sigRef.current.turns) {
      sigRef.current.turns = turnSig;
      setNextTurns(ups.map(u => ({
        key: String(u.index),
        text: u.step.bannerPrimary || u.step.instruction || 'Continue',
        distance: formatDistance(u.distanceM),
        icon: maneuverIcon(u.step.modifier, u.step.maneuverType),
      })));
    }

    const secs = remainingSeconds(rt, remainM);
    const sum = {remaining: formatDistance(remainM), minutes: formatDuration(secs), eta: arrivalClock(Date.now(), secs)};
    const sumSig = `${sum.remaining}|${sum.minutes}|${sum.eta}`;
    if (sumSig !== sigRef.current.summary) {sigRef.current.summary = sumSig; setSummary(sum);}

    const frame = navCameraFor({
      speedKph: f.speedMps !== null ? f.speedMps * 3.6 : null,
      distToManeuverM: nm ? nm.distanceM : null, distToDestinationM: remainM, mode: 'course',
    });
    if (shouldRetarget(camRef.current, frame)) {
      camRef.current = frame;
      inject(`window.setNavCamera(${JSON.stringify({mode: 'course', zoom: frame.zoom, pitch: frame.pitch})});`);
    }

    // Re-route when clearly off the line.
    const rr = rerouteRef.current;
    const offM = offRouteDistanceM(rt.coordinates, p);
    if (offM <= 60) {rr.announced = false;}
    if (shouldReroute({offRouteM: offM, accuracyM: f.accuracyM, nowMs: Date.now(), lastFetchMs: rr.lastFetch, inFlight: rr.inFlight})) {
      rr.inFlight = true;
      rr.lastFetch = Date.now();
      if (!rr.announced) {rr.announced = true; say(REROUTE_ANNOUNCEMENT);}
      void fetchDirections(p, destLL, {profile: profileFor(modeRef.current)}).then(next => {
        rr.inFlight = false;
        if (next && phaseRef.current === 'navigating') {
          liveRouteRef.current = next;
          lastSplitRef.current = null;
        }
      });
    }
  }, [destKey, destLL, destLabel, go, inject, say]);
  const tickRef = useRef(tick);
  useEffect(() => { tickRef.current = tick; }, [tick]);

  // ── Start: voice first, then the driving camera ────────────
  const start = () => {
    const rt = routes[selected];
    const f = fixRef.current;
    if (!rt || !f) {return;}
    liveRouteRef.current = rt;
    lastSplitRef.current = null;
    camRef.current = null;
    sigRef.current = {banner: '', turns: '', summary: ''};
    rerouteRef.current = {lastFetch: Date.now(), inFlight: false, announced: false};
    // The opening line already says the first instruction: mark that cue as
    // delivered so the first tick does not repeat it.
    const rid = routeVoiceId(rt, destKey);
    voiceRouteIdRef.current = rid;
    spokenRef.current = new Set();
    const nm = nextManeuver(rt, {lng: f.lng, lat: f.lat});
    if (nm && nm.index === 0) {
      const first = pickAnnouncement({route: rt, stepIndex: 0, distanceToManeuverM: nm.distanceM, spoken: spokenRef.current, routeId: rid});
      if (first) {spokenRef.current.add(first.key); for (const k of first.superseded) {spokenRef.current.add(k);}}
    }
    inject('window.setAlternatives([]);');
    inject(`window.setNavCamera(${JSON.stringify({mode: 'course', rearm: true})});`);
    go('navigating');
    say(startAnnouncement(rt, destLabel, modeRef.current));
    tick(f);
  };

  const end = () => {
    stopGuidance();
    goBackOnce(navigation);
  };

  const overview = () => {
    const rt = liveRouteRef.current;
    const f = fixRef.current;
    if (!rt || !f) {return;}
    const {remaining} = splitRouteAtProgress(rt.coordinates, {lng: f.lng, lat: f.lat});
    inject(`window.fitRoute(${JSON.stringify(toPairs(remaining))});`);
  };

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data) as {type?: string; where?: string; msg?: string};
      if (msg.type === 'ready') {map.onReady();}
      const fatal = msg.type === 'gl-unsupported'
        || (msg.type === 'err' && (msg.where === 'init' || /401|403|unauthorized|forbidden|access token/i.test(String(msg.msg ?? ''))));
      if (fatal) {map.onError();}
    } catch { /* ignore */ }
  };

  const retryLocation = () => {
    fixRef.current = null;
    setHasFix(false);
    setMode(null);
    go('locating');
    setFixTry(n => n + 1);
  };

  // ── Render ────────────────────────────────────────────────
  const chosen = routes[selected];
  return (
    <View style={styles.root}>
      {unavailable ? (
        <MapFailedOverlay onRetry={() => undefined} variant="misconfigured" />
      ) : (
        <>
          <WebView
            key={`vbg-nav-map-${map.reloadKey}`}
            ref={webRef}
            originWhitelist={['*']}
            source={webSource}
            style={StyleSheet.absoluteFillObject}
            onMessage={onMessage}
            javaScriptEnabled
            domStorageEnabled
            androidLayerType="hardware"
            onRenderProcessGone={map.retry}
            onContentProcessDidTerminate={map.retry}
          />
          {map.status === 'loading' && <MapFailedOverlay onRetry={map.retry} variant="loading" />}
          {map.status === 'failed' && <MapFailedOverlay onRetry={map.retry} />}
        </>
      )}

      {/* Top: back + destination, or the maneuver banner while navigating. */}
      <View style={[styles.top, {paddingTop: insets.top + 8}]}>
        {phase === 'navigating' && banner ? (
          <View style={styles.banner} accessibilityLiveRegion="polite">
            <Icon name={banner.icon} size={34} color="#FFF" />
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={styles.bannerDist}>{banner.distance}</Text>
              <Text style={styles.bannerText} numberOfLines={2}>{banner.primary}</Text>
              {banner.secondary ? <Text style={styles.bannerSub} numberOfLines={1}>{banner.secondary}</Text> : null}
            </View>
          </View>
        ) : (
          <View style={styles.header}>
            <TouchableOpacity style={styles.iconBtn} onPress={end} accessibilityRole="button" accessibilityLabel="Back">
              <Icon name="chevron-left" size={22} color={VBG.text} />
            </TouchableOpacity>
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={styles.headKicker}>DIRECTIONS TO</Text>
              <Text style={styles.headTitle} numberOfLines={1}>{destLabel}</Text>
            </View>
          </View>
        )}
        {phase === 'navigating' && nextTurns.length > 0 ? (
          <View style={styles.thenRow}>
            <Text style={styles.thenLbl}>THEN</Text>
            <Icon name={nextTurns[0].icon} size={16} color={VBG.textDim} />
            <Text style={styles.thenText} numberOfLines={1}>{nextTurns[0].text}</Text>
            <Text style={styles.thenDist}>{nextTurns[0].distance}</Text>
          </View>
        ) : null}
      </View>

      {/* Bottom sheet per phase. */}
      <View style={[styles.sheet, {paddingBottom: bottomPad(14)}]}>
        {unavailable ? (
          <View>
            <Text style={styles.title}>Directions are not available in this build</Text>
            <Text style={styles.dim}>This copy of the app was built without its map key. Install the latest Bravo Secure build.</Text>
            <TouchableOpacity style={styles.primary} onPress={end} accessibilityRole="button">
              <Text style={styles.primaryText}>BACK</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {!unavailable && (phase === 'locating' || phase === 'routing') ? (
          <View style={styles.rowCenter}>
            <ActivityIndicator color={VBG.accent} />
            <Text style={styles.dim}>{phase === 'locating' ? 'Finding your position…' : 'Planning the route…'}</Text>
          </View>
        ) : null}

        {phase === 'no-location' ? (
          <View>
            <Text style={styles.title}>Your position is not available</Text>
            <Text style={styles.dim}>Allow location for Bravo Secure and make sure GPS is on, then try again.</Text>
            <TouchableOpacity style={styles.primary} onPress={retryLocation} accessibilityRole="button">
              <Text style={styles.primaryText}>TRY AGAIN</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {phase === 'no-route' ? (
          <View>
            <Text style={styles.title}>No route found</Text>
            <Text style={styles.dim}>Check your connection and try again{mode === 'drive' ? ', or try Walk' : ''}.</Text>
            <TouchableOpacity style={styles.primary} onPress={() => void loadRoutes(modeRef.current)} accessibilityRole="button">
              <Text style={styles.primaryText}>TRY AGAIN</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {phase === 'preview' && chosen ? (
          <View>
            <View style={styles.modeRow}>
              {(['drive', 'walk'] as const).map(m => (
                <TouchableOpacity key={m} style={[styles.modeBtn, mode === m && styles.modeOn]} onPress={() => chooseMode(m)}
                  accessibilityRole="button" accessibilityState={{selected: mode === m}}>
                  <Icon name={m === 'drive' ? 'car' : 'walk'} size={16} color={mode === m ? '#FFF' : VBG.textDim} />
                  <Text style={[styles.modeText, mode === m && {color: '#FFF'}]}>{m === 'drive' ? 'Drive' : 'Walk'}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <ScrollView style={{maxHeight: 170}}>
              {routes.map((r, i) => (
                <TouchableOpacity key={r.id || i} style={[styles.choice, i === selected && styles.choiceOn]} onPress={() => setSelected(i)}
                  accessibilityRole="button" accessibilityState={{selected: i === selected}}>
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={styles.choiceTime}>{formatDuration(r.durationS)}</Text>
                    <Text style={styles.dim} numberOfLines={1}>
                      {formatDistance(r.distanceM)}{r.viaRoad ? ` · via ${r.viaRoad}` : ''}{i === 0 ? ' · fastest' : ''}
                    </Text>
                  </View>
                  {i === selected ? <Icon name="check-circle" size={20} color={VBG.accent} /> : null}
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={styles.primary} onPress={start} accessibilityRole="button" accessibilityLabel={`Start navigation to ${destLabel}`}>
              <Icon name="navigation" size={18} color="#FFF" />
              <Text style={styles.primaryText}>START</Text>
            </TouchableOpacity>
            <Text style={styles.note}>Guidance is spoken and stays in Bravo Secure.</Text>
          </View>
        ) : null}

        {phase === 'navigating' ? (
          <View style={styles.navRow}>
            <View style={{flex: 1}}>
              <Text style={styles.eta}>{summary?.minutes ?? '—'}</Text>
              <Text style={styles.dim}>{summary ? `${summary.remaining} · arrive ${summary.eta}` : 'Calculating…'}</Text>
            </View>
            <TouchableOpacity style={styles.round} onPress={() => setVoiceOn(v => !v)} accessibilityRole="button"
              accessibilityLabel={voiceOn ? 'Voice guidance on. Tap to mute' : 'Voice guidance muted. Tap to unmute'}>
              <Icon name={voiceOn ? 'volume-high' : 'volume-off'} size={22} color={voiceOn ? VBG.text : VBG.alert} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.round} onPress={overview} accessibilityRole="button" accessibilityLabel="Route overview">
              <Icon name="map-outline" size={22} color={VBG.text} />
            </TouchableOpacity>
            <TouchableOpacity style={[styles.round, styles.endBtn]} onPress={end} accessibilityRole="button" accessibilityLabel="End navigation">
              <Text style={styles.endText}>END</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {phase === 'arrived' ? (
          <View>
            <View style={styles.rowCenter}>
              <Icon name="map-marker-check" size={26} color={VBG.signal} />
              <Text style={styles.title}>You have arrived</Text>
            </View>
            <Text style={styles.dim}>{destLabel}</Text>
            <TouchableOpacity style={styles.primary} onPress={end} accessibilityRole="button">
              <Text style={styles.primaryText}>DONE</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: '#06142B'},
  top: {position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 12, gap: 6},
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 16,
    backgroundColor: 'rgba(10,31,63,0.9)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
  },
  iconBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.06)'},
  headKicker: {color: VBG.textMute, fontSize: 10, fontWeight: '800', letterSpacing: 1.6},
  headTitle: {color: VBG.text, fontSize: 16, fontWeight: '700', marginTop: 1},
  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 16,
    backgroundColor: '#166ED1', shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: {width: 0, height: 4}, elevation: 6,
  },
  bannerDist: {color: '#FFF', fontSize: 22, fontWeight: '800'},
  bannerText: {color: '#FFF', fontSize: 16, fontWeight: '700', marginTop: 1},
  bannerSub: {color: 'rgba(255,255,255,0.8)', fontSize: 12.5, marginTop: 2},
  thenRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', maxWidth: '100%',
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 12, backgroundColor: 'rgba(10,31,63,0.92)',
  },
  thenLbl: {color: VBG.textMute, fontSize: 10, fontWeight: '800', letterSpacing: 1.4},
  thenText: {color: VBG.text, fontSize: 12.5, fontWeight: '600', flexShrink: 1},
  thenDist: {color: VBG.textDim, fontSize: 12},
  sheet: {
    position: 'absolute', left: 12, right: 12, bottom: 0, borderTopLeftRadius: 18, borderTopRightRadius: 18,
    padding: 14, backgroundColor: 'rgba(10,31,63,0.96)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', gap: 8,
  },
  rowCenter: {flexDirection: 'row', alignItems: 'center', gap: 10},
  title: {color: VBG.text, fontSize: 15.5, fontWeight: '700'},
  dim: {color: VBG.textDim, fontSize: 12.5, marginTop: 2},
  note: {color: VBG.textMute, fontSize: 11, textAlign: 'center', marginTop: 6},
  modeRow: {flexDirection: 'row', gap: 8, marginBottom: 8},
  modeBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 14, borderRadius: 17,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
  },
  modeOn: {backgroundColor: VBG.accent, borderColor: VBG.accent},
  modeText: {color: VBG.textDim, fontSize: 13, fontWeight: '700'},
  choice: {
    flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 12, marginBottom: 6,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  choiceOn: {borderColor: VBG.accent, backgroundColor: 'rgba(30,136,255,0.12)'},
  choiceTime: {color: VBG.text, fontSize: 16, fontWeight: '800'},
  primary: {
    marginTop: 10, height: 48, borderRadius: 14, flexDirection: 'row', gap: 8,
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#166ED1',
  },
  primaryText: {color: '#FFF', fontSize: 13.5, fontWeight: '800', letterSpacing: 1.5},
  navRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  eta: {color: VBG.signal, fontSize: 22, fontWeight: '800'},
  round: {
    width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  endBtn: {width: 64, backgroundColor: VBG.alert, borderColor: VBG.alert},
  endText: {color: '#FFF', fontSize: 13, fontWeight: '800', letterSpacing: 1.2},
}));
