/**
 * B-647 — the Secure Transfer add-on row must never ask Fabric to re-parent a
 * child mid-batch.
 *
 * Five identical Android fatals on 2026-09-03 (`addViewAt: cannot insert view
 * [icon Text] into parent [row]: View already has a parent [icon wrapper]`)
 * all landed in the commit where an `AddonRow` (re)mounted its ON decorations:
 * a conditional first child (`{on && <View/>}`) plus a conditional gradient in
 * the Toggle, in the same batch as the icon wrapper's subtree restructuring.
 * The mitigation is structural, so this pin is a source scan of the JSX shape:
 *
 *   1. no conditional mount as a child of AddonRow / Toggle — decorations are
 *      always mounted and driven by opacity;
 *   2. the icon wrapper and the toggle thumb are `collapsable={false}`, so a
 *      style swap can never flip their flattenability.
 *
 * The file is CRLF — scan line-based, never anchor on `\n`.
 */
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'CustomizeAddOnsScreen.tsx'),
  'utf8',
);

function fnBody(name: string): string {
  const lines = SRC.split(/\r?\n/);
  const start = lines.findIndex(l => l.startsWith(`function ${name}(`));
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  let seen = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') {depth++; seen = true;}
      if (ch === '}') {depth--;}
    }
    if (seen && depth === 0) {return lines.slice(start, i + 1).join('\n');}
  }
  throw new Error(`unterminated ${name}`);
}

const stripComments = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');

describe('B-647 — AddonRow mount shape', () => {
  const row = stripComments(fnBody('AddonRow'));
  const toggle = stripComments(fnBody('Toggle'));

  it('AddonRow has no conditionally mounted child', () => {
    expect(row).not.toMatch(/\{on\s*&&\s*</);
    expect(row).not.toMatch(/\{on\s*\?\s*</);
  });

  it('the top light is always mounted and hidden by opacity', () => {
    expect(row).toMatch(/style=\{\[s\.cardTopLightSm,\s*!on\s*&&\s*s\.hidden\]\}/);
  });

  it('the icon wrapper is pinned non-flattenable', () => {
    expect(row).toMatch(/<View collapsable=\{false\} style=\{\[s\.addonIc,/);
  });

  it('Toggle never (un)mounts its gradient track', () => {
    expect(toggle).not.toMatch(/\{on\s*\?\s*\(?\s*<LinearGradient/);
    expect(toggle).toMatch(/!on\s*&&\s*s\.hidden/);
    expect(toggle).toMatch(/<View collapsable=\{false\} style=\{\[s\.toggleThumb,/);
  });

  it('s.hidden exists and is opacity-only', () => {
    expect(SRC).toMatch(/hidden:\s*\{opacity:\s*0\},/);
  });
});

describe('B-790 — the sibling sites on the same screen the B-647 fix stopped short of', () => {
  const body = stripComments(SRC);

  /**
   * B-861 (SECURE_TRANSFER_ZONE_SCHEDULE_PLAN_2026-09-11 R1) — the OPERATING
   * ZONE tiles are GONE: the zone follows the pick-up pin, so there is no zone
   * chip left to mount a top light on. This pin FLIPS rather than being deleted
   * — the B-790 rule (a decoration is hidden by opacity, never unmounted) is
   * still what it defends, and it now defends it by proving the site is gone
   * AND that every surviving `cardTopLightSm` still uses the opacity idiom.
   */
  it('the zone chip is gone, and no cardTopLightSm site conditionally mounts', () => {
    expect(body).not.toMatch(/s\.zoneChip/);
    expect(body).not.toMatch(/s\.zoneCode/);
    expect(body).not.toMatch(/\{on\s*&&\s*<View style=\{s\.cardTopLightSm\}/);
    // Every remaining site is the always-mounted, opacity-hidden shape.
    const lights = body.match(/<View[^>]*style=\{\[s\.cardTopLightSm[^\]]*\]\}/g) ?? [];
    expect(lights.length).toBeGreaterThan(0);
    for (const site of lights) {
      expect(site).toMatch(/pointerEvents="none"/);
      expect(site).toMatch(/&& s\.hidden\]/);
    }
  });

  it('the driver-only row top light is always mounted (driver_only resets in the post-submit commit)', () => {
    expect(body).not.toMatch(/\{driver_only\s*&&\s*</);
    expect(body).toMatch(/<View pointerEvents="none" style=\{\[s\.cardTopLightSm, !driver_only && s\.hidden\]\} \/>/);
  });

  it('the consent check Icon is always mounted and hidden by opacity', () => {
    expect(body).not.toMatch(/\{consentGiven\s*&&\s*</);
    expect(body).toMatch(/<View collapsable=\{false\} style=\{\[s\.checkbox, consentGiven && s\.checkboxOn\]\}>\s*<Icon name="check"[^>]*style=\{consentGiven \? undefined : s\.hidden\}/);
  });

  it('the CTA arrow is never conditionally mounted on `submitting`', () => {
    expect(body).not.toMatch(/\{!submitting\s*&&\s*<Icon/);
    expect(body).toMatch(/<Icon name="arrow-right"[^>]*style=\{submitting \? s\.hidden : undefined\}/);
  });
});
