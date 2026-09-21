/**
 * B-804 — the two design calls left open by B-799..B-803, now closed.
 *
 *  1. The client dashboard's Bravo GeoRisk tile still wore a `VBG` pill — the
 *     acronym of the product's OLD name. B-802 renamed the card and left the
 *     badge behind, so the tile read "Bravo GeoRisk … VBG".
 *  2. A user who LANDS on the messenger's Calls or News tab had no visible way
 *     out. Those tabs render an EMBEDDED body, which draws no chevron, and the
 *     "← Secure Services" chevron lives inside the Chats block — so the exit
 *     was hardware-back (the N1 handler steps to Chats) and only THEN a
 *     chevron. B-799 and B-801 made landing there routine: the agent
 *     dashboard's Bravo Feed row and the Pro dashboard's Bravo Feed tile both
 *     arrive at `{tab: 'News'}`.
 *
 * Source scans: these screens mount RN trees the node project cannot import.
 * Comments stripped (the code quotes the tokens under test), CRLF normalised.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function code(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
}

const HOME = code('src/screens/messenger/MessengerHomeScreen.tsx');
const NEWS = code('src/screens/news/NewsHubScreen.tsx');
const CALLS = code('src/screens/messenger/CallsLogScreen.tsx');
const DASH = code('src/screens/dashboard/DashboardScreen.tsx');

describe('B-804.1 — the GeoRisk tile no longer wears the old name\'s acronym', () => {
  it('the badge is GEO, and VBG is gone from the card', () => {
    const at = DASH.indexOf('title="Bravo GeoRisk"');
    expect(at).toBeGreaterThan(-1);
    const card = DASH.slice(at, at + 300);
    expect(card).toMatch(/text: isPro \? 'PRO' : 'GEO'/);
    expect(card).not.toContain("'VBG'");
  });

  it('no user-visible VBG literal survives anywhere in the screen', () => {
    // The `vbg` CODE family (goToVBG, VBGHome…) is deliberately untouched, so
    // this asserts the QUOTED form only.
    expect(DASH).not.toMatch(/'VBG'|"VBG"/);
  });
});

describe('B-804.2 — a landed Calls/News tab has a visible way out', () => {
  it('the host computes the exit, because only the host knows the shell', () => {
    expect(HOME).toMatch(/const tabExit = useMemo</);
  });

  it('a Secure-product client exits to the sibling SecureTab — the Chats chevron\'s hop', () => {
    const block = HOME.slice(HOME.indexOf('const tabExit = useMemo<'));
    const body = block.slice(0, block.indexOf('}, [inSecureProduct, navigation]);'));
    expect(body).toMatch(/if \(inSecureProduct\)/);
    expect(body).toMatch(/label: 'Back to Secure Services'/);
    // N3 — a hot forward/cross-tab press goes through navigateOnce.
    expect(body).toMatch(/navigateOnce\(navigation, 'SecureTab' as never\)/);
  });

  it('a shell where MessengerHome was PUSHED (the agency stack) gets a real pop', () => {
    // The agent dashboard's Bravo Feed row pushes this screen, so without this
    // arm B-799's own door was a two-step trap.
    const block = HOME.slice(HOME.indexOf('const tabExit = useMemo<'));
    const body = block.slice(0, block.indexOf('}, [inSecureProduct, navigation]);'));
    expect(body).toMatch(/if \(navigation\.canGoBack\(\)\)/);
    // N2 — a TAPPABLE back goes through goBackOnce (never a raw goBack).
    expect(body).toMatch(/goBackOnce\(navigation\)/);
    expect(HOME).toMatch(/import \{goBackOnce, navigateOnce, NAV_GUARD_MS\} from '@navigation\/tapGuard'/);
  });

  it('and at a stack root with no product to return to it stays null — no chevron', () => {
    // A chevron that dispatches GO_BACK from a stack root is the N1 hazard the
    // embedded bodies suppress theirs for.
    const block = HOME.slice(HOME.indexOf('const tabExit = useMemo<'));
    const body = block.slice(0, block.indexOf('}, [inSecureProduct, navigation]);'));
    expect(body).toMatch(/return null;/);
  });

  it('both embedded bodies receive it', () => {
    expect(HOME).toMatch(/<CallsLogBody embedded bottomPad=\{MSG_TAB_HEIGHT\}\s*\n?\s*onExit=\{tabExit\?\.onPress\} exitLabel=\{tabExit\?\.label\} \/>/);
    expect(HOME).toMatch(/<NewsHubBody embedded bottomPad=\{MSG_TAB_HEIGHT\}\s*\n?\s*onExit=\{tabExit\?\.onPress\} exitLabel=\{tabExit\?\.label\} \/>/);
  });

  it('the News body renders the host\'s handler — never a GO_BACK, which would pop the host', () => {
    expect(NEWS).toMatch(/onExit\?: \(\) => void;/);
    const at = NEWS.indexOf('embedded && onExit ?');
    expect(at).toBeGreaterThan(-1);
    const arm = NEWS.slice(at, at + 320);
    expect(arm).toMatch(/onPress=\{onExit\}/);
    expect(arm).not.toMatch(/goBackOnce/);
    expect(arm).toMatch(/accessibilityLabel=\{exitLabel \?\? 'Back'\}/);
  });

  it('the Calls body does the same', () => {
    expect(CALLS).toMatch(/onExit\?: \(\) => void;/);
    const at = CALLS.indexOf('embedded && onExit &&');
    expect(at).toBeGreaterThan(-1);
    const arm = CALLS.slice(at, at + 320);
    expect(arm).toMatch(/onPress=\{onExit\}/);
    expect(arm).not.toMatch(/goBackOnce/);
    expect(arm).toMatch(/accessibilityLabel=\{exitLabel \?\? 'Back'\}/);
  });

  it('the un-hosted paths are untouched: pushed bodies still goBackOnce, rootless embedded still draws nothing', () => {
    // NewsHubBody keeps its pushed-route chevron...
    expect(NEWS).toMatch(/!embedded && navigation\.canGoBack\(\) \?/);
    expect(NEWS).toMatch(/onPress=\{\(\) => goBackOnce\(navigation\)\}/);
    // ...and still falls through to the layout spacer when there is no exit.
    expect(NEWS).toMatch(/: <View style=\{styles\.backBtn\} \/>\}/);
    expect(CALLS).toMatch(/\{!embedded && \(/);
  });

  it('the N1 hardware-back step to Chats SURVIVES — the chevron is an addition, not a replacement', () => {
    // Losing this would eject the user out of the messenger on a back press.
    expect(HOME).toMatch(/if \(activeTab === 'Chats'\) \{return;\}/);
    expect(HOME).toMatch(/setActiveTab\('Chats'\);/);
  });
});
