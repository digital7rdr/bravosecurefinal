/**
 * B-409 — the LIVE MAP screen's in-map controls sat under the status bar
 * (founder on-device, 2026-08-09: "shifted down a bit so it can be used").
 *
 * VBGMapScreen renders VbgKeyPointsMap with `StyleSheet.absoluteFillObject`,
 * i.e. FULL-BLEED behind its own header, and the map's DARK|LIGHT segment was
 * pinned at a hardcoded `top:10px` inside the WebView — which cannot see that
 * overlay. On a device with a 24-59dp status bar plus a ~44dp header the
 * segment landed behind the status icons: visible, not reliably tappable.
 *
 * Fix mirrors the tracker map's `--recenter-bottom` contract: the host
 * MEASURES its header and pushes the offset in as `--chrome-top`. Embedded
 * card hosts pass nothing and keep the 10px fallback.
 *
 * Founder 2026-09-11 — "remove the heat map from Bravo GeoRisk". The second
 * control under the segment (the HEATMAP chip) and the whole density layer are
 * GONE, and the key-point pins/labels are always shown. The removal scan below
 * keeps it that way: heat came back once already (it is a one-line chip plus a
 * `heatmap` layer), and the visible symptom is silent — pins simply vanish.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {buildVbgKeyPointsMapHtml} from '../vbgKeyPointsMapHtml';

const HTML   = join(process.cwd(), 'src', 'screens', 'vbg', 'vbgKeyPointsMapHtml.ts');
const MAPCMP = join(process.cwd(), 'src', 'screens', 'vbg', 'VbgKeyPointsMap.tsx');
const SCREEN = join(process.cwd(), 'src', 'screens', 'vbg', 'VBGMapScreen.tsx');
const ZONE   = join(process.cwd(), 'src', 'screens', 'booking', 'ZoneMapScreen.tsx');

/** CRLF-normalised, comments stripped (`[^:]` keeps `https://` intact). */
function code(p: string): string {
  return readFileSync(p, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('B-409 — LIVE MAP in-map controls clear the host header', () => {
  it('the style segment reads the offset from --chrome-top, not a hardcoded top', () => {
    const src = code(HTML);
    expect(src).toMatch(/\.styleseg\s*\{[^}]*top:\s*var\(--chrome-top,\s*\d+px\)/);
    // The old absolute must not come back.
    expect(src).not.toMatch(/\.styleseg\s*\{[^}]*top:\s*10px/);
  });

  it('the component injects the inset instead of rebuilding the html', () => {
    // Rebuilding would change `source` and remount the WebView, tearing down
    // the live map on every layout pass (same rule as the tracker map).
    const src = code(MAPCMP);
    expect(src).toMatch(/topInset\?: number/);
    expect(src).toMatch(/setProperty\('--chrome-top'/);
    expect(src).toMatch(/injectJavaScript\(/);
    expect(src).not.toMatch(/buildVbgKeyPointsMapHtml\([^)]*topInset/);
  });

  it('the inset is re-pushed on ready, so a WebView remount restores it', () => {
    const src = code(MAPCMP);
    expect(src).toMatch(/msg\.type === 'ready'[\s\S]{0,80}pushInset\(\)/);
  });

  it('the full-bleed host passes its MEASURED header height', () => {
    const src = code(SCREEN);
    // absoluteFill behind a header is exactly the condition that needs it.
    expect(src).toMatch(/style=\{StyleSheet\.absoluteFillObject\}/);
    expect(src).toMatch(/topInset=\{headerH \+ \d+\}/);
    expect(src).toMatch(/onLayout=\{e => setHeaderH\(e\.nativeEvent\.layout\.height\)\}/);
    // A constant would be wrong: insets.top varies 0-59 by device and the
    // header's content grows with fontScale.
    expect(src).toMatch(/useState\(insets\.top \+ \d+\)/);
  });
});

/**
 * Founder 2026-09-11 — "remove the heat map from Bravo GeoRisk".
 *
 * Source scans, because the map is a WebView HTML template no test can mount.
 * Every absence assertion is paired with a PRESENT-token self-check on
 * something that deliberately stays, so a renamed/moved file can never make
 * the block pass vacuously. Comments are stripped first (a prose mention of
 * the removed feature is not a regression) and the scan is `\r?\n`-safe — this
 * tree is CRLF, where an `\n`-anchored regex matches nothing.
 */
describe('no heat map on Bravo GeoRisk', () => {
  const HOSTS = [
    ZONE,
    SCREEN,
    join(process.cwd(), 'src', 'screens', 'vbg', 'VBGGeoRiskScreen.tsx'),
    join(process.cwd(), 'src', 'screens', 'vbg', 'VBGHomeScreen.tsx'),
    join(process.cwd(), 'src', 'screens', 'vbg', 'VBGNearbyScreen.tsx'),
  ];

  it('the builder scan reads real code (guards a vacuous pass)', () => {
    const src = code(HTML);
    expect(src.split(/\r?\n/).length).toBeGreaterThan(100);
    // Tokens that STAY — if these stop matching the absences below are noise.
    expect(src).toContain('--chrome-top');
    expect(src).toMatch(/window\.setMapStyle\s*=/);
    expect(src).toMatch(/buildVbgKeyPointsMapHtml\(mapboxToken: string\): string/);
  });

  it('the builder carries no heat source, layer, chip or option', () => {
    const src = code(HTML);
    expect(src).not.toMatch(/heatchip/i);
    expect(src).not.toMatch(/vbg-heat/);
    expect(src).not.toMatch(/type\s*:\s*'heatmap'/);
    expect(src).not.toMatch(/heatmap-/);
    // The chip was the only caller of the pin-hiding helper.
    expect(src).not.toMatch(/\bsetKpVisible\b/);
    // And the option that used to switch it off for the booking embed.
    expect(src).not.toMatch(/heatChip/i);
  });

  it('the builder takes the token and nothing else', () => {
    // A second parameter is how the chip option would come back.
    expect(buildVbgKeyPointsMapHtml.length).toBe(1);
  });

  it('the built HTML keeps the pins and the style segment, and has no chip', () => {
    const html = buildVbgKeyPointsMapHtml('pk.test-token');
    // Present: the controls and the key-point markers that must survive.
    expect(html).toContain('id="styleseg"');
    expect(html).toContain('window.updateKeyPoints');
    expect(html).toContain("el.className='kp'");
    // Absent: the chip element, the layer, and any pin-hiding.
    expect(html).not.toMatch(/heatchip/i);
    expect(html).not.toMatch(/heatmap/i);
    expect(html).not.toContain('vbg-heat');
    expect(html).not.toMatch(/el\.style\.display/);
  });

  it('the component exposes no plain prop and passes no builder option', () => {
    const src = code(MAPCMP);
    expect(src).toMatch(/buildVbgKeyPointsMapHtml\(MAPBOX_TOKEN\)/);
    expect(src).not.toMatch(/\bplain\b/);
    expect(src).not.toMatch(/heatChip/i);
  });

  it('no host passes the removed plain prop', () => {
    let seen = 0;
    for (const file of HOSTS) {
      const els = code(file).match(/<VbgKeyPointsMap\b[\s\S]*?\/>/g) ?? [];
      expect(els.length).toBeGreaterThan(0);
      seen += els.length;
      for (const el of els) {
        expect(el).not.toMatch(/\bplain\b/);
        expect(el).not.toMatch(/heatChip/i);
      }
    }
    // Every known host was actually walked (a moved file would drop to 0 above,
    // but a silently-renamed component would not).
    expect(seen).toBeGreaterThanOrEqual(HOSTS.length);
  });
});
