/**
 * Client 2026-09-01 — on Messenger Plans, "Bravo Messenger Enterprise" ran
 * straight into "5,000 BC / 30 days" with no space between them.
 *
 * Why a STYLE test rather than a render test: React Native Testing Library does
 * not lay out — there is no flexbox engine in jsdom, so no rendered assertion
 * can observe two texts colliding. The collision is a property of the style
 * object, so that is what gets pinned.
 *
 * The row was `space-between` with no gap and no shrink. `space-between`
 * distributes free space, and the longest plan name plus the longest price
 * consume the row exactly — leaving zero. Neither child could shrink, so at the
 * app's 1.3x font-scale cap (B-680) they overlap rather than reflow.
 *
 * RED-first: against the old styles `gap` is undefined and `flexShrink` is
 * absent on both children.
 */
import {readFileSync} from 'fs';
import {join} from 'path';

const SRC = readFileSync(
  join(__dirname, '..', 'PricingScreen.tsx'), 'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');   // strip comments: the prose names every property

/** The style block for one StyleSheet key, comments already removed. */
function styleBlock(key: string): string {
  const m = SRC.match(new RegExp(`\\b${key}:\\s*\\{([\\s\\S]*?)\\n?\\s*\\},`));
  if (!m) {throw new Error(`style "${key}" not found`);}
  return m[1];
}

describe('Messenger Plans — the plan name and its price cannot collide', () => {
  const head = styleBlock('tierHead');
  const name = styleBlock('tierName');
  const price = styleBlock('tierPrice');

  it('the header row reserves space that does not depend on leftover width', () => {
    // The actual defect: space-between gives you nothing once the children fill
    // the row. A gap is unconditional.
    expect(head).toMatch(/gap:\s*\d+/);
  });

  it('the plan name may shrink and reflow', () => {
    expect(name).toMatch(/flexShrink:\s*1/);
    // Without minWidth 0 a flex child will not shrink below its content width,
    // so flexShrink alone would not have fixed it.
    expect(name).toMatch(/minWidth:\s*0/);
  });

  it('the price never shrinks — a squeezed "5,000 BC / 30 days" is unreadable', () => {
    expect(price).toMatch(/flexShrink:\s*0/);
  });

  it('the row wraps, so at the 1.3x font cap the price drops to its own line', () => {
    expect(head).toMatch(/flexWrap:\s*'wrap'/);
  });

  it('still a space-between row — the price stays right-aligned when it fits', () => {
    // Guards the fix against being "simplified" into a plain flex-start row,
    // which would silently change the layout of every plan card.
    expect(head).toMatch(/justifyContent:\s*'space-between'/);
    expect(head).toMatch(/flexDirection:\s*'row'/);
  });
});
