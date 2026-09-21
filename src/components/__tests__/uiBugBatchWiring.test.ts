/**
 * B-781 / B-782 / B-783 — wiring pins (source scans; these screens are not
 * unit-rendered).
 *
 *  B-781 — the workspace door's "View Enterprise" opens the Pricing screen
 *          narrowed to the Enterprise card (`openEnterprisePricing`), and the
 *          screen honours `route.params.only` through `tiersToShow`.
 *  B-782 — the Files viewer forwards horizontal swipes: AttachmentFileViewer
 *          passes `onSwipe` down to FileViewer, and FilesScreen steps through
 *          the viewable rows with `stepViewable`.
 *  B-783 — the Secure Services card reveals the CPOs' faces: the band's
 *          `shiftY` is large enough to ride the crop up to the subjects'
 *          heads on both the pre-login and post-login product pickers.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('B-781 — workspace door shows only the Enterprise plan', () => {
  it('both enterprise-prompt callers open the narrowed pricing door', () => {
    for (const rel of ['src/components/ProfileDrawerModal.tsx', 'src/components/useWorkspaceSwitchRow.ts']) {
      const src = read(rel);
      expect(src).toMatch(/showEnterpriseUpgradePrompt\(\{onViewPlans: openEnterprisePricing\}\)/);
      expect(src).not.toMatch(/showEnterpriseUpgradePrompt\(\{onViewPlans: openPricing\}\)/);
    }
  });
  it('the Department Channels gate ("View Enterprise plans") is the THIRD door and narrows too', () => {
    // Missed by the first caller sweep — surfaced as a TS2322 on the widened
    // openPricing signature at the pre-push gate. A door that says "Enterprise"
    // must not open the full ladder.
    const src = read('src/screens/messenger/DepartmentChannelsScreen.tsx');
    expect(src).toMatch(/accessibilityLabel="View Enterprise plans"[\s\S]{0,200}onPress=\{openEnterprisePricing\}/);
    // The import PATH ('@navigation/openPricing') legitimately contains the
    // word; ban the bare identifier only (not preceded by '/' or a word char).
    expect(src).not.toMatch(/[^/\w]openPricing\b/);
  });
  it('openEnterprisePricing narrows to enterprise and PricingScreen honours it', () => {
    const door = read('src/navigation/openPricing.ts');
    expect(door).toMatch(/export function openEnterprisePricing\(\): boolean \{\s*return openPricing\(\{only: 'enterprise'\}\);/);
    const screen = read('src/screens/settings/PricingScreen.tsx');
    expect(screen).toMatch(/tiersToShow\(only\)\.map\(tier =>/);
    expect(screen).toMatch(/route\.params\?\.only/);
    const types = read('src/navigation/types.ts');
    // B-870 RE-POINTED, not relaxed: the route type gained an intersection
    // (`& PricingReturn`) so the plan screen can return to the tab the user
    // came from. What this pin protects is the `only` narrowing itself, so it
    // anchors on that member and tolerates anything intersected alongside it.
    expect(types).toMatch(/Pricing: .*\{only\?: 'lite' \| 'pro' \| 'enterprise'\}/);
    expect(types).toMatch(/Pricing: .*PricingReturn/);
  });
});

describe('B-782 — Files viewer swipes to the next file', () => {
  it('AttachmentFileViewer forwards onSwipe to FileViewer', () => {
    const src = read('src/modules/messenger/ui/AttachmentFileViewer.tsx');
    expect(src).toMatch(/onSwipe\?: \(direction: -1 \| 1\) => void;/);
    expect(src).toMatch(/<FileViewer[\s\S]*onSwipe=\{onSwipe\}/);
  });
  it('FilesScreen steps through the viewable rows on swipe', () => {
    const src = read('src/screens/messenger/FilesScreen.tsx');
    expect(src).toMatch(/import \{stepViewable\} from '\.\/filesViewerStep';/);
    expect(src).toMatch(/stepViewable\(viewableRows, cur\.id, direction\)/);
    expect(src).toMatch(/<AttachmentFileViewer[\s\S]*onSwipe=\{stepViewer\}/);
  });
});

describe('B-783 — Secure Services card shows the CPOs', () => {
  it('both product pickers ride the crop up to the faces', () => {
    for (const rel of ['src/screens/auth/OnboardingScreen.tsx', 'src/screens/auth/ProductGateScreen.tsx']) {
      const src = read(rel);
      const m = src.match(/img: Imagery\.heroBookProtection, shiftY: (\d+)/);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBeGreaterThanOrEqual(120);
    }
  });
});
