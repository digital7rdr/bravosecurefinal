/**
 * B-830 — the address search bar lives in the TOP bar, highlighted.
 *
 * Founder 2026-09-08 (drop-off map screenshot, arrow drawn from the bottom
 * search field up to the top bar): "Can we please shift search bar to the top
 * and highlight it, to make it clearer." This REVERSES the founder's own
 * 2026-08-01 instruction that moved it to the map's foot for thumb reach — the
 * newer instruction wins, so the pin has to be able to tell the two layouts
 * apart rather than just asserting the element exists somewhere.
 *
 * Three things this pins, and why each one is a real regression door:
 *   (a) the bar sits INSIDE the `s.topBar` block and NOT inside `s.bottomStack`
 *       — the whole ask;
 *   (b) `s.bottomStack` still carries the coverage banner — moving the search
 *       bar must not take the "In coverage" message with it (Issue 27 fixed
 *       that banner's position once already);
 *   (c) the right-edge FAB column is pushed down by the MEASURED top-bar
 *       height, never a literal `insets.top + 72` — the bar is now ~50dp
 *       taller and grows again at fontScale 1.3, so a hard-coded offset puts
 *       the map-style FAB straight on top of the new row.
 *
 * STATIC SOURCE SCAN — `LocationPickerScreen.tsx` mounts a WebView and the
 * navigation context, so the node `booking` project cannot import it. Per
 * CLAUDE.md the two traps that make a scan like this pass VACUOUSLY are
 * handled below and self-checked in the last describe: comments are stripped
 * (the founder's own reversal note names "search" and "top bar"), and the file
 * is CRLF so every anchor is matched on a `\r?\n`-normalised string.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const R = process.cwd();
const FILE = join(R, 'src', 'screens', 'booking', 'LocationPickerScreen.tsx');

const RAW = readFileSync(FILE, 'utf8');

/**
 * CODE lines only, line-based so CRLF cannot make an assertion vacuous.
 *
 * Line-based and NOT `/\/\*[\s\S]*?\*\//g`: a URL or a CSS token can carry a
 * `/` followed by `*`, which that regex reads as a comment OPEN and then eats
 * every line to the next close — swallowing the very code being asserted on.
 * `{/*` is stripped as well as `/*`: JSX comments are where this screen keeps
 * its founder notes.
 */
function codeOf(src: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split(/\r?\n/)) {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) {inBlock = false;}
      continue;
    }
    if (t.startsWith('/*') || t.startsWith('{/*')) {
      if (!t.includes('*/')) {inBlock = true;}
      continue;
    }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

const SRC = codeOf(RAW);

/**
 * The MAIN render's top bar. There are two `s.topBar` sites — the tokenless
 * MAPBOX_TOKEN_MISSING early return renders a chevron-only bar first — so this
 * takes the LAST one and the control block below proves that is the real one
 * (it is the only bar carrying the step kicker).
 */
const TOP_START = SRC.lastIndexOf('style={[s.topBar');
const TOP_END = SRC.indexOf('style={[s.fabCol', TOP_START);
const TOP_BAR = TOP_START >= 0 && TOP_END > TOP_START ? SRC.slice(TOP_START, TOP_END) : '';

/** The bottom overlay stack that sits above the CONFIRM bar. */
const BS_START = SRC.indexOf('style={[s.bottomStack');
const BS_END = SRC.indexOf('visible={searchOpen}', BS_START);
const BOTTOM_STACK = BS_START >= 0 && BS_END > BS_START ? SRC.slice(BS_START, BS_END) : '';

/** The search `TouchableOpacity` itself, sliced around its testID. */
const SEARCH_ELEMENT = (() => {
  const at = TOP_BAR.indexOf('testID="location-search-bar"');
  if (at < 0) {return '';}
  const open = TOP_BAR.lastIndexOf('<TouchableOpacity', at);
  const close = TOP_BAR.indexOf('</TouchableOpacity>', at);
  return open >= 0 && close > at ? TOP_BAR.slice(open, close) : '';
})();

/** The `searchBar` StyleSheet entry. */
const SEARCH_STYLE = (() => {
  const at = SRC.indexOf('searchBar: {');
  const end = SRC.indexOf('searchBarText:', at);
  return at >= 0 && end > at ? SRC.slice(at, end) : '';
})();

describe('B-830 — the anchors this scan slices on still exist', () => {
  // CONTROL. Every assertion below reads one of these slices; if an anchor
  // moves, the slice goes empty and `not.toContain` starts passing for the
  // wrong reason. Fail loudly here instead.
  it('finds exactly two s.topBar sites and slices the one with the kicker', () => {
    expect(RAW.split('style={[s.topBar').length - 1).toBe(2);
    expect(TOP_START).toBeGreaterThan(-1);
    expect(TOP_END).toBeGreaterThan(TOP_START);
    expect(TOP_BAR).toContain('SELECT PICK-UP');
    expect(TOP_BAR).toContain('SELECT DROP-OFF');
  });

  it('slices the real bottom stack', () => {
    expect(BS_START).toBeGreaterThan(-1);
    expect(BS_END).toBeGreaterThan(BS_START);
    expect(BOTTOM_STACK).toContain('ctaHeight > 0 ? ctaHeight : CTA_FALLBACK_H');
  });

  it('the two slices do not overlap', () => {
    expect(TOP_END).toBeLessThan(BS_START);
  });

  it('the search bar element and its style block are both reachable', () => {
    expect(SEARCH_ELEMENT).not.toBe('');
    expect(SEARCH_STYLE).not.toBe('');
  });
});

describe('B-830 (a) — the search bar sits in the top bar, not the bottom stack', () => {
  it('the testID is declared exactly once in the file', () => {
    expect(RAW.split('testID="location-search-bar"').length - 1).toBe(1);
  });

  it('it is INSIDE the top bar block', () => {
    expect(TOP_BAR).toContain('testID="location-search-bar"');
    expect(TOP_BAR).toContain('style={s.searchBar}');
  });

  it('it is NOT inside the bottom stack block', () => {
    expect(BOTTOM_STACK).not.toContain('testID="location-search-bar"');
    expect(BOTTOM_STACK).not.toContain('s.searchBar');
  });

  it('it renders UNDER the kicker / zone-chip row, not above it', () => {
    expect(TOP_BAR.indexOf('SELECT PICK-UP'))
      .toBeLessThan(TOP_BAR.indexOf('testID="location-search-bar"'));
    expect(TOP_BAR.indexOf('Change zone'))
      .toBeLessThan(TOP_BAR.indexOf('testID="location-search-bar"'));
  });

  it('still opens the search modal and keeps its accessibility contract', () => {
    expect(SEARCH_ELEMENT).toContain('onPress={() => setSearchOpen(true)}');
    expect(SEARCH_ELEMENT).toContain('accessibilityRole="button"');
    expect(SEARCH_ELEMENT).toContain('accessibilityLabel="Search an address"');
  });

  it('shows the chosen address, falling back to the placeholder', () => {
    expect(SEARCH_ELEMENT).toContain("{pin.address || 'Search an address…'}");
    expect(SEARCH_ELEMENT).toMatch(/numberOfLines=\{1\}/);
  });

  it('reads as the primary control — accent magnify + a forward chevron', () => {
    expect(SEARCH_ELEMENT).toMatch(/name="magnify"\s+size=\{18\}\s+color=\{UI\.accent\}/);
    expect(SEARCH_ELEMENT).toMatch(/name="chevron-right"[^/]*color=\{UI\.accent\}/);
  });
});

describe('B-830 (b) — the coverage banner stays at the bottom', () => {
  it('the bottom stack still renders the banner', () => {
    expect(BOTTOM_STACK).toContain('style={[s.banner,');
    expect(BOTTOM_STACK).toContain('s.bannerOk');
    expect(BOTTOM_STACK).toContain('s.bannerWarn');
  });

  it('the banner did NOT follow the search bar into the top bar', () => {
    expect(TOP_BAR).not.toContain('s.banner');
  });

  it('Issue 27 arithmetic is untouched — the stack still rides the measured CTA', () => {
    expect(SRC).toContain('setCtaHeight(e.nativeEvent.layout.height)');
    expect(SRC).toMatch(/CTA_FALLBACK_H =[^;]*bottomPad\(12\)/);
  });
});

describe('B-830 (c) — the FAB column clears the taller bar by MEASUREMENT', () => {
  it('the top bar reports its own height', () => {
    expect(TOP_BAR).toContain('onLayout={e => setTopBarH(e.nativeEvent.layout.height)}');
    expect(SRC).toMatch(/const \[topBarH, setTopBarH\] = useState\(0\)/);
  });

  it('the FAB column top is derived from that measurement', () => {
    expect(SRC).toMatch(/style=\{\[s\.fabCol,\s*\{top:[^}]*topBarH/);
  });

  it('the pre-measure fallback clears the bar without ignoring fontScale', () => {
    // A fallback is only ever painted for one frame; the measured value takes
    // over. It must still be BIGGER than the old row-only offset, or the first
    // frame lands the map-style FAB on the new search row.
    expect(SRC).toMatch(/topBarH[^;]*insets\.top \+ 128/);
  });

  it('the old hard-coded row offset is gone', () => {
    expect(SRC).not.toMatch(/s\.fabCol,\s*\{top:\s*insets\.top \+ 72\}/);
  });
});

describe('B-830 (d) — the pill is highlighted and meets the touch-target rule', () => {
  it('is at least 48dp tall (Android minimum touch target)', () => {
    expect(SEARCH_STYLE).toMatch(/minHeight:\s*48/);
  });

  it('carries the accent border and tint, from the token — no invented colour', () => {
    expect(SEARCH_STYLE).toMatch(/borderWidth:\s*1\.5/);
    expect(SEARCH_STYLE).toMatch(/borderColor:\s*UI\.accent/);
    expect(SEARCH_STYLE).toMatch(/backgroundColor:\s*'rgba\(91,141,239,0\.18\)'/);
    expect(SEARCH_STYLE).toMatch(/borderRadius:\s*14/);
  });

  it('lifts off the map with a shadow / elevation', () => {
    expect(SEARCH_STYLE).toMatch(/elevation:\s*3/);
    expect(SEARCH_STYLE).toMatch(/shadowOpacity:/);
  });

  it('the placeholder is dimmed, the chosen address is white', () => {
    expect(SRC).toMatch(/searchBarText: \{[^}]*color: '#FFF'/);
    expect(SRC).toMatch(/searchBarMuted: \{color: 'rgba\(255,255,255,0\.7\)'\}/);
    expect(SEARCH_ELEMENT).toContain('!pin.address && s.searchBarMuted');
  });
});

describe('B-830 — the scan itself is not vacuous', () => {
  it('the source really is CRLF, and every anchor is matched normalised', () => {
    // If this file ever became LF the assertions would still hold, but the
    // reverse (a `\n`-only anchor on a CRLF file) is the trap. Prove the
    // normalisation is doing work.
    expect(RAW).toContain('\r\n');
    expect(SRC).not.toContain('\r');
  });

  it('the comment stripper removes JSX and line comments', () => {
    const probe = [
      '      {/* the search bar moved to s.bottomStack',
      '          testID="location-search-bar" */}',
      '      const kept = 1; // trailing note',
      '      /* block */',
    ].join('\r\n');
    const stripped = codeOf(probe);
    expect(stripped).not.toContain('bottomStack');
    expect(stripped).not.toContain('testID="location-search-bar"');
    expect(stripped).not.toContain('trailing note');
    expect(stripped).toContain('const kept = 1;');
  });

  it('a URL-ish token is not mistaken for a comment open', () => {
    // The screen is full of `https://api.mapbox.com/...` template strings.
    expect(SRC).toContain('https://api.mapbox.com/search/searchbox/v1/suggest');
  });
});
