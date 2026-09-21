import React, {useCallback, useMemo, useRef, useState} from 'react';
import {StatusBar, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import Mapbox from '@rnmapbox/maps';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import type {DeptAttendStackParamList} from '@navigation/types';
import {ensureNativeMapboxConfigured} from '@/modules/maps/nativeMapbox';
import {STYLE_URL} from '@/modules/maps/BravoMap';
import {MAP_STYLE_LABEL, type BravoMapStyleId} from '@/modules/maps/mapStyles';
import {RichDetailLayers} from '@/modules/maps/mapDetail';
import {MapFailedOverlay} from '@/modules/maps/MapFailedOverlay';
import {cleanPlaceName, coordHuman, distanceM, distanceText, useResolvedPlace, validFix} from './placeName';
import {OB, ObHeader, Card} from './_obsidian';

/**
 * A check-in fix on the map (founder, 2026-09-05: "when click it will show on
 * map — only Mapbox"). Native Mapbox, centred on the fix with the shift's
 * geofence drawn when the shift carries one, so the manager sees at a glance
 * whether the member was inside the approved radius.
 *
 * Founder follow-ups the same day (B-803), all three fixed here:
 *
 *  1. _"who can understand this coordinate? please make it human readable"_ —
 *     the card printed `placeLabel()`'s coordinate FALLBACK in the slot meant
 *     for a place name, and then printed the same coordinate again underneath.
 *     Now the name is resolved from the fix when the server has none (every
 *     check-in older than the `clock_in_place` column), the coordinate appears
 *     ONCE and is labelled as the GPS fix, and the distance from the approved
 *     site — the manager's actual question — is stated in metres.
 *  2. _"it's blank not opening map"_ — the screen had no load state, so the
 *     seconds before the first tiles arrive were an unexplained black
 *     rectangle, and a style that failed to load stayed black forever.
 *     `MapFailedOverlay` (the same one the WebView maps use) covers the load
 *     window, and `onMapLoadingError` turns a failure into the shared
 *     connection card with RETRY (remounts the map).
 *  3. _"this map more details with mapbox sdk inherited as much as can … I mean
 *     rich"_ — the mission map's full 'rich' set from the ONE shared
 *     `RichDetailLayers` (live traffic, 3D buildings, sky), a pitched camera so
 *     the buildings actually read as 3D, the same four styles the mission map
 *     uses — satellite included, which is what identifies a gate or a yard —
 *     plus compass, attribution and a recenter control.
 *
 * On the labels the founder's second screenshot lacked: the first cut blamed
 * missing Bengali glyphs. The critic probed the style with the baked token and
 * that was wrong — dark-v11 already labels with `name_en` first and the glyph
 * ranges are served. What DID hide labels was the extrusion layer being
 * appended above them (fixed in `mapDetail.tsx`, inserted under the first
 * label layer), plus glyphs arriving seconds after the tiles with no load
 * state. `localizeLabels` was then removed outright by B-805 — see the MapView.
 *
 * Traffic is the mission map's LIVE congestion — texture that makes this read
 * as the same product, not evidence about the shift.
 *
 * B-806 closes what B-803 left half-done. The name is CLEANED
 * (`cleanPlaceName`), because "Turag, Dhaka, ঢাকা, Dhaka, Bangladesh" is not
 * what the founder meant by human-readable; the verification line finally
 * renders, off the verdict the server RECORDED at clock-in rather than a
 * recomputation from a site the callers never passed; a shift with no approved
 * site says so instead of showing nothing; and the compass moves off the style
 * switcher it was sitting under.
 */
type R = RouteProp<DeptAttendStackParamList, 'CheckInMap'>;

type IconName = React.ComponentProps<typeof Icon>['name'];

/**
 * Offered in the switcher — three CLASSIC styles.
 *
 * B-805: '3d' (Mapbox Standard) was the third option in 1.0.297 and the founder
 * hit a hard crash the moment they tapped it, on device. Standard is a
 * style-IMPORT style, and two things this screen did reach into a loaded
 * style's layers: `localizeLabels` (removed — see the MapView) and our own
 * custom layers (now refused on Standard, see `mapDetail.tsx`). Neither is
 * guarded natively, so rather than ship a guess at which one threw, Standard is
 * off the switcher until someone can reproduce with a logcat.
 *
 * Nothing visible is lost: the founder asked for 3D and gets it on BOTH
 * remaining basemaps — `RichDetailLayers` extrudes real building heights on
 * dark and light, and the camera is pitched — while satellite is what actually
 * identifies a gate or a yard.
 */
const STYLES: BravoMapStyleId[] = ['dark', 'sat', 'light'];
const STYLE_ICON: Record<BravoMapStyleId, IconName> = {
  dark: 'map-outline',
  light: 'white-balance-sunny',
  sat: 'satellite-variant',
  '3d': 'city-variant-outline',
};

const FIX_ZOOM = 17;
/** Enough tilt for extruded buildings to read as buildings; the radius still reads. */
const FIX_PITCH = 35;

function circlePolygon(lat: number, lng: number, radiusM: number, steps = 48): [number, number][] {
  const out: [number, number][] = [];
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    out.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return out;
}

export default function CheckInMapScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const {params} = useRoute<R>();
  const ready = ensureNativeMapboxConfigured();
  const cameraRef = useRef<Mapbox.Camera>(null);

  const [styleId, setStyleId] = useState<BravoMapStyleId>('dark');
  const [loaded, setLoaded] = useState(false);
  // Read inside the native callback, which closes over its first render.
  const loadedRef = useRef(false);
  const [failed, setFailed] = useState(false);
  // Bumped by RETRY: remounts the MapView so a failed style load starts over.
  const [attempt, setAttempt] = useState(0);

  const hasSite = validFix(params.siteLat, params.siteLng);
  const fence = useMemo(() => hasSite && params.radiusM
    ? {type: 'Feature' as const, properties: {}, geometry: {type: 'Polygon' as const,
        coordinates: [circlePolygon(params.siteLat!, params.siteLng!, params.radiusM)]}}
    : null, [hasSite, params.siteLat, params.siteLng, params.radiusM]);

  // The founder's fix: a NAME for the place, resolved from the coordinate when
  // the server never stored one. A coordinate in `place` counts as "no name".
  const {name, status} = useResolvedPlace(params.place, params.lat, params.lng);

  /**
   * B-806 — the verification line, which used to be unreachable.
   *
   * Every caller hard-coded `siteLat/siteLng/radiusM` to null (the session row
   * carried no site), so `fromSite` was always null and the line never rendered
   * on an attendance VERIFICATION screen. Meanwhile the answer was already in
   * hand: the server computes the distance and the inside/outside verdict at
   * clock-in and stores them on the session, and the list payload has carried
   * them all along.
   *
   * So the RECORDED verdict wins — it is the number the decision was made on,
   * and it stays correct after a shift's site is moved or its radius edited.
   * The measured fallback exists only for a row that predates those columns and
   * still has a site to measure against.
   */
  const fromSite = typeof params.distanceM === 'number' && Number.isFinite(params.distanceM) && params.distanceM >= 0
    ? params.distanceM
    : hasSite ? distanceM(params.lat, params.lng, params.siteLat!, params.siteLng!) : null;
  const recorded = typeof params.withinRadius === 'boolean';
  const inFence = recorded
    ? params.withinRadius
    : fromSite !== null && typeof params.radiusM === 'number' ? fromSite <= params.radiusM : null;
  const rawSite = params.siteLabel?.trim();
  // 120 chars is allowed server-side; past ~28 the verdict clause — the only
  // part that matters — truncated off the end of the two-line box at
  // fontScale 1.3 on a 320 dp phone.
  const siteName = !rawSite ? 'the site'
    : rawSite.length > 28 ? rawSite.slice(0, 27) + '…'
      : rawSite;
  // A shift with no approved site is not a silent gap — say so, or the reviewer
  // cannot tell "compliant" from "never checked".
  const noSite = fromSite === null && !hasSite && !recorded;

  const recenter = useCallback(() => {
    if (hasSite) {
      // Same framing the camera opened with — both pins and the fence.
      cameraRef.current?.fitBounds(
        [Math.max(params.lng, params.siteLng!), Math.max(params.lat, params.siteLat!)],
        [Math.min(params.lng, params.siteLng!), Math.min(params.lat, params.siteLat!)],
        [90, 70], 450,
      );
      return;
    }
    cameraRef.current?.setCamera({
      centerCoordinate: [params.lng, params.lat],
      zoomLevel: FIX_ZOOM,
      pitch: FIX_PITCH,
      animationDuration: 450,
    });
  }, [hasSite, params.lat, params.lng, params.siteLat, params.siteLng]);

  const retry = useCallback(() => {
    setFailed(false);
    setLoaded(false);
    loadedRef.current = false;
    // Back to the base style: one style can fail alone (satellite on a metered
    // or filtered network) and the failure card covers the switcher, so
    // retrying the SAME style is a dead end with no way out but the back button.
    setStyleId('dark');
    setAttempt(n => n + 1);
  }, []);

  // "location", not "address": the request asks for address, POI,
  // neighbourhood, locality or place, and a locality is the common answer.
  // B-806 — `cleanPlaceName`, or the card prints Mapbox's raw hierarchy:
  // "Turag, Dhaka, ঢাকা, Dhaka, Bangladesh" was the founder's screenshot.
  const placeLine =
    status === 'resolving' ? 'Finding location name…'
      : name ? (cleanPlaceName(name) || name)
        : 'Location name unavailable for this fix';

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <ObHeader title={params.title ?? 'Check-in location'} onBack={() => navigation.goBack()} />
      <View style={s.mapWrap}>
        {ready ? (
          <>
            <Mapbox.MapView
              key={attempt}
              style={s.map}
              styleURL={STYLE_URL[styleId]}
              logoEnabled={false}
              // Mapbox's terms require attribution to stay reachable; the
              // mission map already keeps it.
              attributionEnabled
              scaleBarEnabled={false}
              compassEnabled
              compassFadeWhenNorth
              // B-806 — TOP-LEFT. Mapbox defaults the compass to the top-RIGHT
              // corner, which is exactly where the style switcher sits; the two
              // overlapped in the founder's screenshot.
              compassViewPosition={0}
              // B-805 — NO `localizeLabels`. It bought nothing (dark-v11 and
              // light-v11 already resolve `coalesce(name_en, name)`) and it
              // costs a native call the binding does not guard:
              // `RNMBXMapView.applyLocalizeLabels` runs
              // `savedStyle?.localizeLabels(...)` on EVERY style load with no
              // try/catch, and that extension rewrites `name_xx` expressions by
              // walking the style's layers. See the STYLES note for why that
              // matters.
              onDidFinishLoadingMap={() => { loadedRef.current = true; setLoaded(true); }}
              onMapLoadingError={() => { if (!loadedRef.current) {setFailed(true);} }}>
              <Mapbox.Camera
                ref={cameraRef}
                pitch={FIX_PITCH}
                animationDuration={0}
                {...(hasSite
                  ? {bounds: {
                    ne: [Math.max(params.lng, params.siteLng!), Math.max(params.lat, params.siteLat!)],
                    sw: [Math.min(params.lng, params.siteLng!), Math.min(params.lat, params.siteLat!)],
                    paddingTop: 90, paddingBottom: 90, paddingLeft: 70, paddingRight: 70,
                  }}
                  : {zoomLevel: FIX_ZOOM, centerCoordinate: [params.lng, params.lat]})}
              />

              {/* Full 'rich' parity with the mission map: live traffic, 3D
                  buildings and sky, from the ONE shared component. */}
              <RichDetailLayers styleId={styleId} />

              {fence && (
                <Mapbox.ShapeSource id="fence" shape={fence}>
                  <Mapbox.FillLayer id="fence-fill" style={{fillColor: OB.accent, fillOpacity: 0.12}} />
                  <Mapbox.LineLayer id="fence-line" style={{lineColor: OB.accent, lineWidth: 1.5, lineOpacity: 0.8}} />
                </Mapbox.ShapeSource>
              )}
              {hasSite && (
                <Mapbox.MarkerView id="site" coordinate={[params.siteLng!, params.siteLat!]} allowOverlap>
                  <View style={s.sitePin}><Icon name="office-building-marker" size={16} color={OB.accentSoft} /></View>
                </Mapbox.MarkerView>
              )}
              <Mapbox.MarkerView id="fix" coordinate={[params.lng, params.lat]} allowOverlap>
                <View style={s.pinWrap}>
                  <View style={s.pin}><Icon name="account-check" size={16} color="#fff" /></View>
                  <View style={s.pinTail} />
                </View>
              </Mapbox.MarkerView>
            </Mapbox.MapView>

            {/* Style switcher — satellite is what identifies a gate or a yard.
                40 dp + 4 dp slop = the 48 dp target; the 8 dp gap keeps
                neighbouring slops from overlapping. */}
            <View style={s.styleBar}>
              {STYLES.map(id => (
                <TouchableOpacity
                  key={id}
                  style={[s.styleBtn, styleId === id && s.styleBtnOn]}
                  onPress={() => setStyleId(id)}
                  accessibilityRole="button"
                  accessibilityState={{selected: styleId === id}}
                  accessibilityLabel={`${MAP_STYLE_LABEL[id]} map`}
                  hitSlop={{top: 4, bottom: 4, left: 4, right: 4}}>
                  <Icon name={STYLE_ICON[id]} size={17} color={styleId === id ? OB.bg : OB.textDim} />
                </TouchableOpacity>
              ))}
            </View>

            <TouchableOpacity
              style={s.recenter}
              onPress={recenter}
              accessibilityRole="button"
              accessibilityLabel="Recentre on the check-in"
              hitSlop={{top: 4, bottom: 4, left: 4, right: 4}}>
              <Icon name="crosshairs-gps" size={18} color={OB.accentSoft} />
            </TouchableOpacity>

            {/* The black rectangle the founder saw was this window, unexplained;
                and offline it never ended. Loading → skeleton; failed → the
                shared connection card, whose RETRY remounts the map. */}
            {failed
              ? <MapFailedOverlay variant="connection" onRetry={retry} />
              : !loaded && <MapFailedOverlay variant="loading" onRetry={retry} />}
          </>
        ) : (
          <MapFailedOverlay variant="misconfigured" onRetry={() => {}} />
        )}
      </View>

      <View style={[s.footer, {paddingBottom: insets.bottom + 14}]}>
        <Card style={{gap: 6}}>
          {params.subtitle ? <Text style={s.who} numberOfLines={1}>{params.subtitle}</Text> : null}
          <Text style={[s.place, !name && s.placeDim]} numberOfLines={3}>{placeLine}</Text>
          {inFence !== null && (
            <Text style={[s.fence, inFence === false && {color: OB.amber}]} numberOfLines={2}>
              <Icon name={inFence ? 'map-marker-check-outline' : 'alert-circle-outline'} size={11} />
              {'  '}{inFence ? 'Inside' : 'Outside'} the approved radius
              {/* The radius NUMBER only on the measured branch: a recorded
                  verdict is from clock-in, while params.radiusM is whatever the
                  shift says today, and an admin may have edited it since. */}
              {!recorded && typeof params.radiusM === 'number' ? ` (${params.radiusM} m)` : ''}
            </Text>
          )}
          {fromSite !== null && (
            <Text style={s.fence} numberOfLines={2}>
              <Icon name={inFence === null ? 'map-marker-distance' : 'map-marker-radius-outline'} size={11} />
              {'  '}{distanceText(fromSite)} from {siteName}
              {recorded ? ' when they checked in' : ''}
            </Text>
          )}
          {noSite && (
            <Text style={s.fence} numberOfLines={2}>
              <Icon name="map-marker-question-outline" size={11} />
              {'  '}No approved site set for this shift — nothing to check the fix against.
            </Text>
          )}
          {/* No line cap: the precise fix is the one line that must never
              truncate (fontScale 1.3 on a 320 dp phone wraps it instead). */}
          <Text style={s.coords}>GPS fix · {coordHuman(params.lat, params.lng)}</Text>
        </Card>
      </View>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  mapWrap: {flex: 1, marginHorizontal: 16, marginTop: 6, borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: OB.hair, backgroundColor: OB.card},
  map: {flex: 1},
  footer: {paddingHorizontal: 16, paddingTop: 12},
  who: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase'},
  place: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 14, lineHeight: 19},
  placeDim: {color: OB.textDim, fontFamily: BravoFont.regular},
  fence: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 11.5, lineHeight: 16},
  coords: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 10.5, letterSpacing: 0.4},
  styleBar: {position: 'absolute', top: 10, right: 10, flexDirection: 'row', gap: 8, backgroundColor: 'rgba(7,9,13,0.72)', borderRadius: 12, padding: 4, borderWidth: 1, borderColor: OB.hair2},
  styleBtn: {width: 40, height: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center'},
  styleBtnOn: {backgroundColor: OB.accentSoft},
  recenter: {position: 'absolute', bottom: 12, right: 10, width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(7,9,13,0.72)', borderWidth: 1, borderColor: OB.hair2},
  pinWrap: {alignItems: 'center'},
  pin: {width: 30, height: 30, borderRadius: 15, backgroundColor: OB.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff'},
  pinTail: {width: 0, height: 0, borderLeftWidth: 6, borderRightWidth: 6, borderTopWidth: 8, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: '#fff', marginTop: -1},
  sitePin: {width: 28, height: 28, borderRadius: 14, backgroundColor: OB.card, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: OB.accent},
}));
