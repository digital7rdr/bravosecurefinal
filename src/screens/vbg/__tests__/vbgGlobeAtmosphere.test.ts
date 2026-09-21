/**
 * Client 2026-09-01 — "make the Globe on Virtual Bodyguard the same colour as
 * the one on news."
 *
 * The difference was never the map STYLE. Both are `mapbox/dark-v11`. Bravo
 * Feed (`src/modules/news/bravoMapHtml.ts`) calls `setFog` with a cobalt
 * atmosphere and tints water/land; the VBG key-points map did not, so its globe
 * rendered near-black.
 *
 * These compare the two SOURCES against each other rather than hard-coding the
 * colours a second time. A test that re-declared `#2F6FE0` would pass forever
 * while the two maps silently drifted apart — which is the entire failure being
 * fixed here.
 */
import {readFileSync} from 'fs';
import {join} from 'path';

const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const VBG = read('src/screens/vbg/vbgKeyPointsMapHtml.ts');
const NEWS = read('src/modules/news/bravoMapHtml.ts');

/** Pull the setFog object literal out of a map's HTML source. */
function fogOf(src: string): string {
  const m = src.match(/setFog\(\{([\s\S]*?)\}\)/);
  if (!m) {throw new Error('no setFog call found');}
  // Normalise whitespace so formatting differences are not treated as drift.
  return m[1].replace(/\s+/g, '');
}

describe('the VBG globe matches the Bravo Feed globe', () => {
  it('both maps call setFog at all', () => {
    expect(NEWS).toMatch(/setFog\(/);
    expect(VBG).toMatch(/setFog\(/);
  });

  it('the atmosphere values are IDENTICAL to the news map', () => {
    // The actual client request: same colour. Compared source-to-source, so a
    // change to one without the other fails here rather than on a device.
    expect(fogOf(VBG)).toBe(fogOf(NEWS));
  });

  it('the ocean and land tints match too — fog alone leaves the planet dark', () => {
    for (const prop of ['water', 'land']) {
      const re = new RegExp(`setPaintProperty\\('${prop}'[^)]*\\)`);
      const news = NEWS.match(re);
      const vbg = VBG.match(re);
      expect(news).not.toBeNull();
      expect(vbg).not.toBeNull();
      expect(vbg![0].replace(/\s+/g, '')).toBe(news![0].replace(/\s+/g, ''));
    }
  });
});

describe('the atmosphere survives a style swap', () => {
  it('is applied on the initial style.load, not on load', () => {
    // `map.on('load')` fires before paint properties exist for the style, so
    // the water/land tint would silently no-op.
    expect(VBG).toMatch(/map\.on\('style\.load',\s*applyGlobeAtmosphere\)/);
  });

  it('is re-applied after setStyle — DARK -> LIGHT -> DARK must not go grey', () => {
    // setStyle DROPS fog and every paint override. Without re-applying inside
    // the swap handler the globe reverts the first time someone toggles LIGHT
    // and back, which is exactly how this would regress unnoticed.
    const swap = VBG.slice(VBG.indexOf('window.setMapStyle'));
    expect(swap).toMatch(/applyGlobeAtmosphere\(\)/);
  });

  it('LIGHT keeps mapbox’s own atmosphere rather than the dark-tuned fog', () => {
    // Forcing a fog tuned for a black ground onto the light style produced a
    // muddy blue-grey planet, so the helper returns early.
    expect(VBG).toMatch(/currentStyle !== 'dark'[\s\S]{0,40}return/);
  });
});
