/**
 * B-793 — the console's long pages must actually scroll.
 *
 * `.main-area` is `display:flex; flex-direction:column; overflow-y:auto`. A flex
 * item's automatic minimum size is content-based ONLY while its own `overflow`
 * is `visible`; give it `overflow:hidden` and that minimum drops to 0, so the
 * browser happily COMPRESSES the item to make the column fit the viewport
 * instead of letting the column overflow. The result is a page whose bottom
 * rows are clipped with no scrollbar anywhere — All Users / Clients /
 * Compliance all sat un-scrollable behind exactly that.
 *
 * `.card` and `.kpi-row` were already pinned (the reasoning is in globals.css);
 * `.dt-wrap` — the DataTable frame every directory renders — was the one that
 * was missed. This scans the stylesheet so the next `overflow:hidden` block
 * dropped into the main column has to make the same decision on purpose.
 *
 * The stylesheet is CRLF and full of prose, so: comments are stripped before
 * anything is asserted, and the blocks are split on braces rather than matched
 * with a newline-anchored regex (a `\n` anchor passes vacuously here).
 */

import {readFileSync} from 'fs';
import {join} from 'path';

const CSS = readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf8');

/** Strip comments first — prose ABOUT `overflow: hidden` is not a rule. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Declarations of every top-level rule whose selector list names `selector`,
 * concatenated. Brace-split rather than regex-matched so CRLF and multi-line
 * values (the `background:` gradient stack) cannot make it match nothing.
 */
function declarationsFor(selector: string): string {
  let out = '';
  let rest = RULES;
  while (rest.length > 0) {
    const open = rest.indexOf('{');
    if (open === -1) break;
    const close = rest.indexOf('}', open);
    if (close === -1) break;
    const selectors = rest
      .slice(0, open)
      .split(',')
      .map(s => s.trim());
    if (selectors.includes(selector)) out += `${rest.slice(open + 1, close)};`;
    rest = rest.slice(close + 1);
  }
  return out;
}

/**
 * Every block rendered as a direct flex child of `.main-area`. Each one keeps
 * its natural height so the column overflows and `.main-area` scrolls; a page
 * that genuinely wants to fill the viewport opts in with an inline `flex: 1`,
 * which outranks the class.
 */
const MUST_PIN_SHRINK = ['.card', '.kpi-row', '.dt-wrap'];

describe('main-area scroll contract', () => {
  it('reads the stylesheet it means to scan', () => {
    // Guard the parser itself: an anchor that matches nothing would make every
    // assertion below pass vacuously.
    expect(declarationsFor('.app-shell')).toMatch(/grid-template-columns/);
  });

  it('.main-area scrolls its overflow instead of clipping it', () => {
    const decls = declarationsFor('.main-area');
    expect(decls).toMatch(/overflow-y:\s*auto/);
    expect(decls).not.toMatch(/overflow:\s*hidden/);
  });

  it.each(MUST_PIN_SHRINK)('%s cannot be compressed out of the scrolling column', selector => {
    const decls = declarationsFor(selector);
    expect(decls).not.toBe('');
    expect(decls).toMatch(/flex-shrink:\s*0/);
  });

  it('.dt-wrap still clips, which is why its shrink pin matters', () => {
    // The pin is load-bearing precisely BECAUSE the frame hides its overflow
    // (that zeroes the automatic minimum size). If the clip ever goes away,
    // re-derive the pin rather than assuming it is still doing the work.
    expect(declarationsFor('.dt-wrap')).toMatch(/overflow:\s*hidden/);
  });
});
