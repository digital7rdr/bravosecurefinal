/**
 * Shared native-Mapbox detail layers — the real-world texture the WebView map
 * never had: live traffic congestion, 3D building extrusions and an
 * atmospheric sky.
 *
 * Why a shared component and not JSX copied per screen: this repo already runs
 * two map implementations and pins them against each other
 * (`__tests__/nativeMapParity.test.ts`) precisely because silent drift is how a
 * migration loses a behaviour. A third hand-rolled surface with its own
 * slightly-different traffic ramp is that same failure. Extracted from
 * BravoMap 2026-09-05 with the layer ids, filters and style expressions
 * UNCHANGED, so the mission map renders exactly what it rendered before.
 *
 * Two style guards, deliberately DIFFERENT (critic finding on the first cut,
 * which gated all three together and silently took traffic off the mission
 * map's '3d' style):
 *
 *   traffic     off only on 'sat' — the mission map's HEAD semantics. Standard
 *               ('3d') keeps its traffic.
 *   buildings + off on 'sat' (imagery already carries the real world — grey
 *   sky         boxes over a photograph look broken) and on '3d' (Mapbox
 *               Standard draws its OWN `2d-building` extrusions and sky;
 *               adding ours doubles every building).
 *
 * The extrusion layer is inserted BELOW the first label layer. Appended on top
 * (the first cut, and BravoMap before it) the 0.72-opacity roofs paint over
 * every road and POI label at street zoom with a flat camera — which, on the
 * check-in map, was most of the "no labels" the founder saw. Mapbox's own 3D
 * buildings example inserts below the first symbol layer for this reason.
 * `road-label-simple` is that layer in both dark-v11 and light-v11, the only
 * two styles this component renders for; an id the style lacks would make the
 * SDK queue the layer forever (RNMBXMapView.waitForLayer), so the guard above
 * is load-bearing for this too.
 */
import React from 'react';
import Mapbox from '@rnmapbox/maps';

import type {BravoMapStyleId} from './mapStyles';

interface Props {
  styleId: BravoMapStyleId;
  /**
   * Draw congestion UNDER this layer. The mission map passes its route line —
   * the route is the instruction, traffic is context. Omitted (check-in map)
   * the layer simply sits on top of the base style.
   */
  belowLayerID?: string;
  /**
   * Live congestion — what the roads look like NOW. Default on: it is the
   * texture that makes every native surface read as one product. A screen
   * showing a past event may pass `false` if "now" would mislead there.
   */
  traffic?: boolean;
}

/**
 * Live traffic renders on the classic styles only.
 *
 * B-805 — 'sat' because congestion lines over imagery are noise; '3d' (Mapbox
 * Standard) because it is a style-IMPORT style and this binding adds custom
 * layers through paths it does NOT guard: `RNMBXLayer.addBelow/addAbove` call
 * `style.addLayerBelow(...)` straight, outside the `Logger.logged {}` wrapper
 * that protects the plain `add()` path. The founder hit a hard crash tapping
 * the Standard option on device (1.0.297). Standard draws its own buildings and
 * sky, so refusing our layers there costs nothing and removes the whole class.
 */
export function supportsTraffic(styleId: BravoMapStyleId): boolean {
  return styleId !== 'sat' && styleId !== '3d';
}

/** Our own extrusions + sky render only on the two classic styles. */
export function supportsDetailLayers(styleId: BravoMapStyleId): boolean {
  return styleId !== 'sat' && styleId !== '3d';
}

/** First label layer in dark-v11 / light-v11 — extrusions go under it. */
export const FIRST_LABEL_LAYER = 'road-label-simple';

export function RichDetailLayers({styleId, belowLayerID, traffic = true}: Props) {
  const showTraffic = traffic && supportsTraffic(styleId);
  const showDetail = supportsDetailLayers(styleId);
  if (!showTraffic && !showDetail) {
    return null;
  }
  return (
    <>
      {/* Congestion straight off Mapbox's traffic tileset. The colour ramp is
          the near-universal one (green→amber→red→maroon), so it needs no
          legend. */}
      {showTraffic && (
        <Mapbox.VectorSource id="bravo-traffic" url="mapbox://mapbox.mapbox-traffic-v1">
          <Mapbox.LineLayer
            id="bravo-traffic-line"
            sourceLayerID="traffic"
            belowLayerID={belowLayerID}
            style={{
              // Widens with zoom so congestion reads clearly at nav zoom
              // without shouting on the overview frame.
              lineWidth: ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 2.4, 17, 4.5],
              lineCap: 'round',
              lineColor: [
                'match',
                ['get', 'congestion'],
                'low', '#3DD68C',
                'moderate', '#E8B33D',
                'heavy', '#F2704B',
                'severe', '#C62828',
                'transparent',
              ],
            }}
          />
        </Mapbox.VectorSource>
      )}

      {showDetail && (
        <>
          {/* 3D building extrusions — the Google-Maps-at-a-junction read. Height
              ramps in with zoom so the city does not pop up abruptly the moment
              the camera crosses the threshold. Under the labels — see header. */}
          <Mapbox.FillExtrusionLayer
            id="bravo-buildings-3d"
            sourceID="composite"
            sourceLayerID="building"
            belowLayerID={FIRST_LABEL_LAYER}
            filter={['==', ['get', 'extrude'], 'true']}
            minZoomLevel={15}
            // Required alongside minZoomLevel in @rnmapbox/maps v10 types.
            maxZoomLevel={22}
            style={{
              fillExtrusionColor: '#1B2431',
              fillExtrusionOpacity: 0.72,
              fillExtrusionBase: ['get', 'min_height'],
              fillExtrusionHeight: [
                'interpolate',
                ['linear'],
                ['zoom'],
                15,
                0,
                16.5,
                ['get', 'height'],
              ],
            }}
          />

          <Mapbox.SkyLayer
            id="bravo-sky"
            style={{skyType: 'atmosphere', skyAtmosphereSun: [0, 0], skyAtmosphereSunIntensity: 5}}
          />
        </>
      )}
    </>
  );
}
