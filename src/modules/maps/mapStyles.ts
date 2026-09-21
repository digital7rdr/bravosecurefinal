/**
 * The native map's style vocabulary — the KEYS only.
 *
 * The four `mapbox://styles/...` URLs deliberately stay inside `BravoMap.tsx`:
 * `__tests__/nativeMapParity.test.ts` counts the URLs in that file and compares
 * the set against the WebView map's, which is what stops the two renderers from
 * quietly disagreeing about how the map LOOKS. Moving them here would empty
 * that scan and the pin would pass vacuously.
 *
 * So this module carries the type and nothing else, which is all a consumer
 * (the shared detail layers, a screen's style switcher) needs in order to talk
 * about a style without pulling the whole map component in.
 */
export type BravoMapStyleId = 'dark' | 'light' | 'sat' | '3d';

/** Human labels for a style switcher. */
export const MAP_STYLE_LABEL: Record<BravoMapStyleId, string> = {
  dark: 'Dark',
  light: 'Light',
  sat: 'Satellite',
  '3d': '3D',
};
