/**
 * B-862 — THE RULE IS RETIRED. This pin used to enforce it; it now enforces
 * that it is gone.
 *
 * It was born from the founder's 2026-08-26 line ("an ACTIVE Pro member books
 * NOW only here — schedule protection dates via Booking Requests") and it only
 * ever lived on `BookingDateTimeScreen`, which nothing navigates to:
 * `ServiceTypeScreen` routes straight to `CustomizeAddOns`, and the server has
 * never carried a Pro/tier rule on `booking_mode`. So the clamp had not applied
 * to a real booking in a long time — a client-only money rule on a dead screen
 * is not a rule.
 *
 * The founder retired it explicitly on 2026-09-12, asking for the Book Now /
 * Book Later toggle to go: _"since for book later we can choose any date"_ —
 * and then for every open item to be closed. Removed here rather than left
 * dormant: a rule the product no longer holds, sitting in code nobody reaches,
 * is the shape that gets re-adopted by accident the day the screen is revived.
 *
 * IF THE FOUNDER EVER REINSTATES IT, this file flips back — and the fix has to
 * land on `CustomizeAddOnsScreen` (the live screen) AND on the server, not here.
 *
 * Source scan (the screen mounts pickers + animated pills that make a render
 * test heavyweight), anchored at the decision sites per the CLAUDE.md scan
 * rules: comments stripped, CRLF-safe, and the anchors are the executing
 * expressions — not merely "the token appears somewhere".
 */
import fs from 'fs';
import path from 'path';

const SCREEN = path.resolve(
  __dirname, '..', 'BookingDateTimeScreen.tsx',
);
const LIVE = path.resolve(
  __dirname, '..', 'CustomizeAddOnsScreen.tsx',
);

function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
}

describe('B-862 — Pro members are no longer clamped to Book Now', () => {
  const src = code(SCREEN);

  it('the scan reads a real screen (anti-vacuity)', () => {
    // Every assertion below is a NEGATIVE one, and a negative assertion over an
    // empty string passes. Prove the file was read and still contains the thing
    // the removed clamp used to hide.
    expect(src.length).toBeGreaterThan(2000);
    expect(src).toContain('Book Later');
  });

  it('no Pro derivation survives — the screen does not read the Pro store at all', () => {
    expect(src).not.toMatch(/useSecureProStore/);
    expect(src).not.toMatch(/proActive/);
    expect(src).not.toMatch(/loadProApplication/);
  });

  it('the mode clamp is gone — a chosen \'later\' is never forced back to \'now\'', () => {
    expect(src).not.toMatch(/setMode\('now'\);\}/);
    // …and no conditional wraps the toggle: both segments render for everyone.
    expect(src).not.toMatch(/\? \(\s*<View style=\{s\.proNowOnly\}/);
    expect(src).toMatch(/<View style=\{s\.toggle\} onLayout=/);
  });

  it('the explanation card and its copy are gone with it', () => {
    expect(src).not.toMatch(/proNowOnly/);
    expect(src).not.toMatch(/Schedule protection dates via Booking Requests/);
  });

  it('and the LIVE screen never had the rule, so nothing moved there', () => {
    // The asymmetry B-862 documented is closed by DELETION, not by adding the
    // clamp to the screen users actually reach.
    expect(code(LIVE)).not.toMatch(/proActive/);
  });
});
