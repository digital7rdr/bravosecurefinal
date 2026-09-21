/**
 * B-785 — the two bookable cards on Select Service behave the SAME way.
 *
 * Founder (2026-09-03): "With secure transfers if I select it, it shows it's
 * selected by blue pin and then I must press continue. With Executive
 * Protection, if I touch the card it enters automatically." The executive
 * card's onPress navigated (openExecutive) while the transfer card's only
 * wrote the draft. Now every card's tap PINS the card (local `picked`), and
 * "Continue to Schedule" is the only thing that moves — into the executive
 * dashboard for that pick, into CustomizeAddOns for a Lite pick.
 *
 * Source scan: the screen mounts navigation + safe-area + the booking store,
 * which the booking project does not render. CRLF-safe, comment-stripped.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src', 'screens', 'booking', 'ServiceTypeScreen.tsx'), 'utf8')
  .replace(/\r\n/g, '\n');
const CODE = SRC.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

function block(startMarker: string, endMarker: string): string {
  const a = CODE.indexOf(startMarker);
  expect(a).toBeGreaterThan(-1);
  const b = CODE.indexOf(endMarker, a);
  expect(b).toBeGreaterThan(a);
  return CODE.slice(a, b);
}

describe('B-785 — a card tap selects; only Continue moves on', () => {
  it('the card onPress pins the pick and NEVER navigates — for the executive card too', () => {
    const onPress = block('onPress={() => {\n              setPicked(svc.key);', '/>');
    expect(onPress).toMatch(/setPicked\(svc\.key\)/);
    expect(onPress).not.toMatch(/openExecutive\(|navigation\.navigate|navigateOnce/);
    // The executive tap returns before the Lite draft write.
    expect(onPress).toMatch(/if \(svc\.key === 'executive_protection'\) \{return;\}/);
  });

  it('the selected pin follows the local pick, not the draft (an executive pick shows as selected)', () => {
    expect(CODE).toMatch(/selected=\{svc\.key === picked && !svc\.comingSoon\}/);
  });

  it('Continue routes the executive pick into the executive dashboard, with the dirty guard intact', () => {
    const cont = block('const handleContinue = () => {', 'navigation.navigate(\'CustomizeAddOns\')');
    expect(cont).toMatch(/if \(picked === 'executive_protection'\) \{\s*openExecutive\(\);\s*return;\s*\}/);
    // The Lite branch pins the booking type from the PICK.
    expect(cont).toMatch(/updateDraft\(\{service: picked, type: bookingTypeFor\(picked\)\}\)/);
    // openExecutive still asks before discarding a dirty Lite draft (B-91 M3 R5).
    const exec = block('const openExecutive = () => {', 'goExecutive();\n  };');
    expect(exec).toMatch(/isBookingDraftDirty\(\)/);
    expect(exec).toMatch(/Discard & continue/);
  });

  it('the CTA is enabled for any bookable pick (coming-soon stays locked)', () => {
    // B-867 — the identity gate holds Continue too (identityGate.test.ts pins
    // the gate itself); the bookable/coming-soon half of the rule is unchanged.
    expect(CODE).toMatch(/const canContinue = !!pickedDef && !pickedDef\.comingSoon && !identityBlocked;/);
    expect(CODE).toMatch(/disabled=\{!canContinue\}/);
    expect(CODE).not.toMatch(/liteSelected/);
  });
});
