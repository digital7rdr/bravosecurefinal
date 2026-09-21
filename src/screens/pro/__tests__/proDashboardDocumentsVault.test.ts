/**
 * Client 2026-09-01 — three brand/navigation asks from the same round:
 *
 *  · "when click doc it will redirect to vault"  (Documents tile was SOON + dead)
 *  · "change that lock and shield to the Bravo Logo"  (cold-start badge)
 *  · "remember the 2 images here too … the same way we added img other modules"
 *    (the two live Select Service cards had no art)
 *
 * Source scans, because these three files mount RN screens the node project
 * cannot import. Comments are stripped first — this repo has lost a session to
 * a scan matching its own explanatory prose.
 */
import {readFileSync} from 'fs';
import {join} from 'path';

const ROOT = join(__dirname, '..', '..', '..', '..');

function code(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const DASH = code('src/screens/pro/ProDashboardScreen.tsx');
const LOADING = code('src/components/LoadingView.tsx');
const SERVICE = code('src/screens/booking/ServiceTypeScreen.tsx');

describe('Documents opens the vault', () => {
  const row = DASH.split('\n').find(l => l.includes("key: 'documents'")) ?? '';

  it('is no longer COMING SOON', () => {
    expect(row).not.toMatch(/comingSoon:\s*true/);
  });

  it('targets the vault THROUGH the messenger tab', () => {
    // VaultScreen is registered on MessengerNavigator, not on this shell's
    // stack. A bare navigate('VaultScreen') from here resolves to nothing and
    // React Navigation drops it silently — the documented failure shape.
    expect(row).toMatch(/target:\s*'MessengerTab'/);
    // B-726 — `initial: false` is part of the contract: without it the nested
    // screen is only honoured while the tab is UNMOUNTED, so the tile worked
    // exactly once per shell and then landed on Messenger home.
    // B-801 critic — and the payload is a FACTORY: React Navigation applies a
    // nested payload only when its identity changes, so a constant object was
    // honoured once per WARM tab mount and ignored on every later tap.
    expect(row).toMatch(/targetParams:\s*\(\)\s*=>\s*\(\{screen:\s*'VaultScreen',\s*initial:\s*false\}\)/);
    expect(row).not.toMatch(/targetParams:\s*\{/);
  });

  it('carries art, like every other live tile', () => {
    expect(row).toMatch(/img:\s*Imagery\.messengerVault/);
  });

  it('openModule actually forwards the nested params', () => {
    // Without this the tile would navigate to the messenger tab's default
    // screen and look like it "sort of" worked.
    expect(DASH).toMatch(/m\.targetParams/);
    // Called, not passed — a fresh object per tap (see the factory pin above).
    expect(DASH).toMatch(/\.navigate\(m\.target,\s*m\.targetParams\(\)\)/);
  });

  it('the PIN gate is NOT bypassed — the destination self-gates', () => {
    // VaultScreen replaces to VaultLock on focus while locked (B-716). This
    // asserts we did not add a caller-side unlock or skip.
    const vault = code('src/screens/messenger/VaultScreen.tsx');
    expect(vault).toMatch(/navigation\.replace\('VaultLock'\)/);
  });
});

describe('the cold-start badge is the Bravo mark, not a stock padlock', () => {
  it('renders BravoMark', () => {
    expect(LOADING).toMatch(/<BravoMark\b/);
    expect(LOADING).toMatch(/from '@components\/BravoMark'/);
  });

  it('no longer draws the shield-lock glyph', () => {
    expect(LOADING).not.toMatch(/shield-lock/);
  });

  it('still accepts the per-surface accent, so the badge tracks its caller', () => {
    expect(LOADING).toMatch(/accent=\{accent\}/);
  });
});

describe('the live Select Service cards carry brand art', () => {
  it('both bookable services have an image', () => {
    expect(SERVICE).toMatch(/img:\s*Imagery\.svcExecTransport/);
    expect(SERVICE).toMatch(/img:\s*Imagery\.svcCloseProtection/);
  });

  it('the backdrop is rendered, and only when the card has art', () => {
    expect(SERVICE).toMatch(/!!svc\.img && <ImageryBackdrop/);
  });

  it('the backdrop radius matches the card, or the photo corners square off', () => {
    const cardRadius = SERVICE.match(/padding:\s*16,\s*borderRadius:\s*(\d+),\s*overflow:\s*'hidden'/);
    expect(cardRadius).not.toBeNull();
    const backdrop = SERVICE.match(/<ImageryBackdrop[^>]*radius=\{(\d+)\}/);
    expect(backdrop).not.toBeNull();
    expect(backdrop![1]).toBe(cardRadius![1]);
  });

  it('the COMING SOON card stays flat — a locked tile must not out-shine a bookable one', () => {
    const extraction = SERVICE.slice(SERVICE.indexOf("key: 'emergency_extraction'"));
    const row = extraction.slice(0, extraction.indexOf('},'));
    expect(row).not.toMatch(/img:/);
  });
});
