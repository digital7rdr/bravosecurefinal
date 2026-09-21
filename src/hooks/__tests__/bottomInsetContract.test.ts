/**
 * B-245 contract scan — the screens fixed from the founder's screenshots must
 * not re-grow their own bottom-inset arithmetic.
 *
 * These are RN screens the node project cannot import (WebView, Mapbox,
 * navigation context), so this is a source scan by necessity. Two traps that
 * have each cost this repo a session, per CLAUDE.md:
 *   - strip comments before any absence assertion (prose naming the banned
 *     form is the single most common false result here);
 *   - these files are CRLF, so a `\n`-anchored regex matches nothing and the
 *     test passes VACUOUSLY. Scanning is line-based.
 *
 * Scope: the 38 screens whose bottom-anchored footer / CTA / FAB sits under
 * the ROOT tab bar. Four groups are deliberately EXCLUDED, because for them
 * the raw inset is correct and converting would be a new bug:
 *
 *   - tab bars themselves (MainNavigator, ObsidianTabBar, MessengerHomeScreen's
 *     own bar, AgentVerifiedScreen's bottomNav) — they ARE the thing that
 *     reserves the inset;
 *   - full-screen surfaces that COVER the bar (CallScreen, GroupCallScreen,
 *     VoiceCallScreen, IncomingGroupCallScreen, RestoreProgressOverlay,
 *     SOSScreen, AccessEndedScreen) and everything inside a <Modal>;
 *   - auth screens, which render before any tab bar exists;
 *   - src/screens/deptchat/*, which already hand-rolls the correct conditional
 *     (`inDepartmentalShell ? 12 : insets.bottom + 12`).
 *
 * ScrollView `contentContainerStyle` padding is also left alone — over-padding
 * scrollable content is benign (you can scroll past it) and is not the
 * reported defect.
 */
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

const R = process.cwd();
const FIXED = [
  // The three with founder screenshots:
  join(R, 'src', 'screens', 'booking', 'LocationPickerScreen.tsx'),
  join(R, 'src', 'screens', 'ops', 'OpsRoomReviewScreen.tsx'),
  join(R, 'src', 'screens', 'booking', 'BookingHomeScreen.tsx'),
  // …and the rest of the sweep (same defect, no photo):
  join(R, 'src', 'screens', 'agent', 'AgentRejectedScreen.tsx'),
  join(R, 'src', 'screens', 'agent', 'AgentVerificationStatusScreen.tsx'),
  join(R, 'src', 'screens', 'agent', 'AttendanceScreen.tsx'),
  join(R, 'src', 'screens', 'agent', 'IncomingOfferScreen.tsx'),
  join(R, 'src', 'screens', 'agent', 'JobDetailScreen.tsx'),
  join(R, 'src', 'screens', 'agent', 'OrgHierarchyScreen.tsx'),
  join(R, 'src', 'screens', 'agent', 'OrgRosterScreen.tsx'),
  join(R, 'src', 'screens', 'agent', '_shared.tsx'),
  join(R, 'src', 'screens', 'booking', 'AddOnsScreen.tsx'),
  join(R, 'src', 'screens', 'booking', 'AgencyAcceptedScreen.tsx'),
  join(R, 'src', 'screens', 'booking', 'BaselinePackageScreen.tsx'),
  join(R, 'src', 'screens', 'booking', 'BookingConfirmationScreen.tsx'),
  join(R, 'src', 'screens', 'booking', 'BookingDateTimeScreen.tsx'),
  join(R, 'src', 'screens', 'booking', 'CustomizeAddOnsScreen.tsx'),
  join(R, 'src', 'screens', 'booking', 'FindingDetailScreen.tsx'),
  join(R, 'src', 'screens', 'booking', 'MissionCompleteScreen.tsx'),
  join(R, 'src', 'screens', 'booking', 'NoDetailScreen.tsx'),
  join(R, 'src', 'screens', 'booking', 'ServiceTypeScreen.tsx'),
  join(R, 'src', 'screens', 'booking', 'ZoneMapScreen.tsx'),
  join(R, 'src', 'screens', 'cpo', 'AssignedMissionDetailScreen.tsx'),
  join(R, 'src', 'screens', 'liveops', 'LiveTrackingScreen.tsx'),
  join(R, 'src', 'screens', 'news', 'IntelFeedScreen.tsx'),
  join(R, 'src', 'screens', 'news', 'NewsArticleScreen.tsx'),
  join(R, 'src', 'screens', 'news', 'NewsPreferencesScreen.tsx'),
  join(R, 'src', 'screens', 'ops', 'OpsMissionDetailScreen.tsx'),
  join(R, 'src', 'screens', 'pro', 'ProActivityHistoryScreen.tsx'),
  join(R, 'src', 'screens', 'pro', 'ProAssignedTeamScreen.tsx'),
  join(R, 'src', 'screens', 'pro', 'TierPaywall.tsx'),
  join(R, 'src', 'screens', 'vbg', 'VBGMapScreen.tsx'),
  join(R, 'src', 'screens', 'wallet', 'CreditsScreen.tsx'),
];

/** CODE lines only. Line-based, so CRLF cannot make an assertion vacuous. */
function codeLines(path: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(raw);
  }
  return out;
}

const RAW_INSET = /(paddingBottom|bottom):\s*[^,}]*insets\.bottom/;

/**
 * Anchored sites only — a `contentContainerStyle` padding is scroll room, not
 * a bottom-anchored element, and over-padding scrollable content is benign.
 * Same split the sweep itself used; asserting on all of them would demand
 * churn this fix deliberately did not make.
 */
function anchoredOffenders(path: string): string[] {
  const lines = codeLines(path);
  return lines.filter((l, i) => {
    if (!RAW_INSET.test(l)) {return false;}
    const ctx = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
    return !ctx.includes('contentContainerStyle');
  }).map(l => l.trim());
}

describe('the fixed screens use the rule, not hand-rolled inset arithmetic', () => {
  it.each(FIXED)('%s has no raw-inset ANCHORED element left', path => {
    // The exact shape that produced every screenshot:
    //   paddingBottom: Math.max(insets.bottom, 12) + 12
    //   bottom: insets.bottom + 72
    expect(anchoredOffenders(path)).toEqual([]);
  });

  it.each(FIXED)('%s imports the rule', path => {
    expect(codeLines(path).join('\n')).toMatch(/from '@hooks\/useBottomInset'/);
  });

  it('the scan is not vacuous — it catches the pre-fix shape', () => {
    // Guards the regex itself. If this stops matching, every assertion above
    // is passing for the wrong reason.
    const pre = [
      '        style={[s.ctaWrap, {paddingBottom: Math.max(insets.bottom, 12) + 12}]}',
      '        style={[styles.fabWrap, {bottom: insets.bottom + 72}]}',
    ];
    for (const line of pre) {
      expect(RAW_INSET.test(line)).toBe(true);
    }
  });

  it('the anchored/scroll split is real, not a way to pass by excluding everything', () => {
    // If the contentContainerStyle carve-out ever widened to swallow anchored
    // sites too, every assertion above would pass vacuously. Prove it still
    // discriminates: an anchored line is caught, a scroll line is not.
    const probe = [
      '  <View style={[s.footer, {paddingBottom: insets.bottom + 16}]}>',
      '  contentContainerStyle={{paddingBottom: insets.bottom + 96}}>',
    ];
    expect(RAW_INSET.test(probe[0])).toBe(true);
    expect(RAW_INSET.test(probe[1])).toBe(true);
    expect(probe[1].includes('contentContainerStyle')).toBe(true);
    expect(probe[0].includes('contentContainerStyle')).toBe(false);
  });

  it('insets.top is untouched — this rule is about the BOTTOM only', () => {
    // LocationPicker legitimately uses insets.top for its floating header.
    // A scan that banned insets.* wholesale would have broken it.
    const src = codeLines(FIXED[0]).join('\n');
    expect(src).toMatch(/insets\.top/);
  });
});

describe('EVERY tab-bar renderer reports itself', () => {
  /**
   * The miss that made the first attempt a no-op on the reported screens.
   *
   * `useReportBottomTabBar` was wired into ObsidianTabBar only — but the ROOT
   * shell renders its own `CustomTabBar` in MainNavigator, and that is the bar
   * on booking / agent / pro / news / wallet. So `hasTabBar` stayed false
   * exactly where the founder photographed the gap, `bottomPad()` kept adding
   * the inset, and the shipped fix changed nothing on those screens.
   *
   * Enumerated from the type, not a hand-list: anything typed as a
   * BottomTabBarProps renderer IS a tab bar and must report.
   */
  const RENDERERS = [
    join(R, 'src', 'navigation', 'ObsidianTabBar.tsx'),
    join(R, 'src', 'navigation', 'MainNavigator.tsx'),
  ];

  it('the renderer list still matches what the codebase actually has', () => {
    // If someone adds a third bar, this fails and forces it into the list
    // rather than letting it silently skip reporting — which is the exact
    // shape of the original miss.
    const nav = join(R, 'src', 'navigation');
    const withProps = readdirSync(nav)
      .filter(f => f.endsWith('.tsx'))
      .filter(f => codeLines(join(nav, f)).join('\n').includes('BottomTabBarProps'))
      // Exclude delegators: a navigator that RENDERS <ObsidianTabBar hands its
      // inset reporting to ObsidianTabBar (which calls useReportBottomTabBar), so
      // it is NOT a new independent bar even if it references the props type (e.g.
      // SecureTabNavigator hoists its renderer for perf). The tripwire still fires
      // for a genuinely new BottomTabBarProps renderer that does not delegate.
      .filter(f => !/<ObsidianTabBar\b/.test(codeLines(join(nav, f)).join('\n')))
      .map(f => join(nav, f))
      .sort();
    expect(withProps).toEqual([...RENDERERS].sort());
  });

  it.each(RENDERERS)('%s calls useReportBottomTabBar', path => {
    expect(codeLines(path).join('\n')).toMatch(/useReportBottomTabBar\(/);
  });

  it.each(RENDERERS)('%s reports BEFORE any early return', path => {
    // A hook after `return null` breaks the rules of hooks; a gated call
    // leaves a hidden bar permanently counted as present.
    const lines = codeLines(path);
    const reportAt = lines.findIndex(l => l.includes('useReportBottomTabBar('));
    const firstNullReturn = lines.findIndex(l => /\breturn null;/.test(l));
    expect(reportAt).toBeGreaterThan(-1);
    expect(firstNullReturn).toBeGreaterThan(-1);
    expect(reportAt).toBeLessThan(firstNullReturn);
  });

  it.each(RENDERERS)('%s passes VISIBILITY, not a constant', path => {
    expect(codeLines(path).join('\n')).toMatch(/useReportBottomTabBar\(!hidden\)/);
  });

  it('MainNavigator folds BOTH of its hide conditions into `hidden`', () => {
    // display:'none' AND the MessengerTab special case. Missing either would
    // leave the bar counted as visible on a screen where it is not rendered,
    // and every footer there would lose the inset it genuinely needs.
    const src = codeLines(join(R, 'src', 'navigation', 'MainNavigator.tsx')).join('\n');
    expect(src).toMatch(/const hidden =[^;]*display === 'none'/);
    expect(src).toMatch(/const hidden =[^;]*MessengerTab/);
  });
});

describe('ObsidianTabBar reports itself so screens can see it', () => {
  const BAR = join(R, 'src', 'navigation', 'ObsidianTabBar.tsx');

  it('reports on every render, including when hidden', () => {
    // Called unconditionally, ABOVE the early return — a hook after the
    // `return null` would break the rules of hooks, and gating the call would
    // leave a hidden bar permanently counted as present.
    const lines = codeLines(BAR);
    const reportAt = lines.findIndex(l => l.includes('useReportBottomTabBar('));
    const returnAt = lines.findIndex(l => l.includes('if (hidden) {return null;}'));
    expect(reportAt).toBeGreaterThan(-1);
    expect(returnAt).toBeGreaterThan(-1);
    expect(reportAt).toBeLessThan(returnAt);
  });

  it('passes the VISIBILITY, not a constant', () => {
    expect(codeLines(BAR).join('\n')).toMatch(/useReportBottomTabBar\(!hidden\)/);
  });

  it('still pads ITSELF by the safe-area inset', () => {
    // The rule's whole premise: the bar owns the inset so screens don't. If
    // this ever goes away the tab icons sit under the system nav buttons and
    // every screen is now under-padded too.
    expect(codeLines(BAR).join('\n')).toMatch(/insets\.bottom > 0 \? insets\.bottom : 12/);
  });
});

/**
 * B-784 — the `safeBottom` variant of the same defect. Three BookingNavigator
 * screens (Pro application, credit paywall, executive task) ride
 * KeyboardAvoidingScreen but padded their footer by `safeBottom + 12` from
 * `useKeyboardLayout` THEMSELVES, under a tab bar that already owns that
 * inset — the founder's "Submit Pro Request" floating ~48dp above the bar.
 * RAW_INSET above only names `insets.bottom`, which is how this spelling
 * survived the B-245 sweep. The rule for a footer inside KeyboardAvoidingScreen
 * is its `footerGap` prop (built on `useBottomInset`); the screen adds no
 * bottom arithmetic of its own.
 *
 * Scoped to the `footer={…}` prop block on purpose: a six-line
 * contentContainerStyle carve-out swallowed the footer line on two of the three
 * screens (the two props are adjacent), and a whole-file scan would flag the
 * paywall's <Modal> pay sheet, where the raw inset is CORRECT (nothing below a
 * modal owns it).
 */
const KAS_FOOTER_SCREENS = [
  join(R, 'src', 'screens', 'securepro', 'SecureProApplyScreen.tsx'),
  join(R, 'src', 'screens', 'booking', 'CreditPaywallScreen.tsx'),
  join(R, 'src', 'screens', 'executive', 'ExecTaskScreen.tsx'),
  join(R, 'src', 'screens', 'agent', 'AgentRegistrationScreen.tsx'),
];
const ANY_BOTTOM_INSET = /(paddingBottom|bottom):\s*[^,}]*(insets\.bottom|safeBottom)/;

/** The lines of the KeyboardAvoidingScreen `footer={` prop, up to the props' closing `}>`. */
function kasFooterBlock(path: string): string[] {
  const lines = codeLines(path);
  const kasAt = lines.findIndex(l => l.includes('<KeyboardAvoidingScreen'));
  expect(kasAt).toBeGreaterThan(-1);
  const footerAt = lines.findIndex((l, i) => i > kasAt && /\bfooter=\{/.test(l));
  expect(footerAt).toBeGreaterThan(-1);
  const closeAt = lines.findIndex((l, i) => i > footerAt && /^\s*\}>\s*$/.test(l));
  expect(closeAt).toBeGreaterThan(footerAt);
  return lines.slice(footerAt, closeAt + 1);
}

describe('B-784 — footers inside KeyboardAvoidingScreen use footerGap, not safeBottom arithmetic', () => {
  it.each(KAS_FOOTER_SCREENS)('%s has no hand-rolled bottom inset inside its footer', path => {
    const offenders = kasFooterBlock(path).filter(l => ANY_BOTTOM_INSET.test(l)).map(l => l.trim());
    expect(offenders).toEqual([]);
  });

  it.each(KAS_FOOTER_SCREENS)('%s hands the footer pad to KeyboardAvoidingScreen', path => {
    const src = codeLines(path).join('\n');
    expect(src).toMatch(/<KeyboardAvoidingScreen[^>]*footerGap=\{\d+\}/);
  });

  it('the widened scan catches the pre-fix shape', () => {
    expect(ANY_BOTTOM_INSET.test('            style={[s.ctaWrap, {paddingBottom: safeBottom + 12}]}>')).toBe(true);
    expect(ANY_BOTTOM_INSET.test('          <View style={[styles.footer, {paddingBottom: safeBottom + 12}]}>')).toBe(true);
    expect(ANY_BOTTOM_INSET.test('        contentContainerStyle={s.scrollContent}')).toBe(false);
  });
});
