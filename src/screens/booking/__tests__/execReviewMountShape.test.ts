/**
 * B-790 — Executive Protection "Confirm & Book" must never ask Fabric to
 * re-parent a child mid-batch (second site of the B-647 class).
 *
 * The founder's two 12 h bookings on 2026-09-03 (created 42 s apart, both
 * successful server-side) each ended with "Bravo Secure closed" on the client.
 * The store's synchronous post-create draft reset re-rendered the still-mounted
 * review screen — the chosen duration cell deselecting (default 4 h is not a
 * grid value), the consent check Icon unmounting, the transport section
 * tearing down — in the same React/Fabric batch as the post-submit alert host,
 * and Android Fabric (RN 0.81) executes an insert before the matching remove
 * when a wrapper's subtree restructures alongside a sibling change in one
 * commit. The ROOT fix defers that reset out of the commit (see
 * `bookingStore.draftClear.test.ts`); this pin is the structural belt: a source
 * scan of the JSX shape so that, whatever commit a re-render lands in, this
 * screen never contains a conditional mount or a flattenability change inside
 * a styled wrapper:
 *
 *   1. the duration cell's top light, the consent check and BOTH CTA states
 *      are always mounted and driven by opacity / native `animating`;
 *   2. every wrapper whose style toggles (cell check, checkbox, CTA label, the
 *      three blocker-flash sections that are plain Views) is
 *      `collapsable={false}`; the fourth flash target, the consent row, is a
 *      TouchableOpacity (an Animated.View with an opacity style) and is never
 *      flattened, so it needs no pin;
 *   3. the CTA-wrap gate hint is always mounted (collapsed by style), and the
 *      calculation rows are pinned, so a draft change cannot insert a sibling
 *      into those parents either.
 *
 * B-791 rides here too: every place that compared a ZONE wall-clock to a
 * device INSTANT (focus re-floor, the server re-seed after a lead refusal,
 * scheduleValid, both date-dialog floors, the "earliest available" hint, the
 * transfer "same as start time" label) now converts first.
 *
 * The file is CRLF — scan line-based, never anchor on a bare newline.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

// EXEC_REVIEW_SRC lets the mutation proof point this scan at `git show HEAD:…`
// (a temp copy of the pre-fix file) without touching the working tree.
const SRC = readFileSync(
  process.env.EXEC_REVIEW_SRC ?? join(__dirname, '..', '..', 'executive', 'ExecReviewScreen.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');

const stripComments = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');

/** The JSX between two anchors, comments stripped. Missing anchors are a
 *  named failure, not a suite error. */
function between(startAnchor: string, endAnchor: string): string {
  const a = SRC.indexOf(startAnchor);
  const b = a < 0 ? -1 : SRC.indexOf(endAnchor, a);
  if (a < 0 || b < 0) {return `ANCHOR MISSING: ${a < 0 ? startAnchor : endAnchor}`;}
  return stripComments(SRC.slice(a, b));
}

const body = stripComments(SRC);

describe('B-790 — ExecReview duration cell mount shape (the B-647 AddonRow twin)', () => {
  const cell = between('accessibilityLabel={`${h} hours`}', '</TouchableOpacity>');

  it('the top light is always mounted and hidden by opacity — never `{selected && <View`', () => {
    expect(cell).not.toMatch(/\{selected\s*&&\s*</);
    expect(cell).toMatch(/<View pointerEvents="none" style=\{\[s\.cellTopLight, !selected && s\.hidden\]\} \/>/);
  });

  it('the check wrapper is pinned non-flattenable', () => {
    expect(cell).toMatch(/<View collapsable=\{false\} style=\{\[s\.cellCheck, !selected && s\.cellCheckHidden\]\}>/);
  });
});

describe('B-790 — ExecReview consent checkbox mount shape', () => {
  const consent = between('{/* ── Consent (auto path only) ── */}', '</ScrollView>');

  it('the check Icon is always mounted and hidden by opacity — never `{consentGiven && <Icon`', () => {
    expect(consent).not.toMatch(/\{consentGiven\s*&&\s*</);
    expect(consent).toMatch(/<Icon name="check"[^>]*style=\{consentGiven \? undefined : s\.hidden\}/);
  });

  it('the checkbox wrapper is pinned non-flattenable', () => {
    expect(consent).toMatch(/<View collapsable=\{false\} style=\{\[s\.checkbox, consentGiven && s\.checkboxOn\]\}>/);
  });
});

describe('B-790 — ExecReview CTA mount shape', () => {
  const cta = between('{/* ── Footer CTA ── */}', '</TouchableOpacity>');

  it('the gradient never swaps its children on `submitting`', () => {
    expect(cta).not.toMatch(/^ANCHOR MISSING/); // a missing anchor must not pass the negatives below
    expect(cta).not.toMatch(/submitting\s*\?\s*\(?\s*<ActivityIndicator/);
    expect(cta).not.toMatch(/\{submitting\s*&&\s*</);
    expect(cta).not.toMatch(/\{!submitting\s*&&\s*</);
  });

  it('label and spinner are both always mounted — opacity for the label, native `animating` for the spinner', () => {
    expect(cta).toMatch(/<View collapsable=\{false\} style=\{\[s\.ctaLabel, submitting && s\.hidden\]\}>/);
    // The spinner sits in its own pointerEvents="none" wrapper: RN forwards only
    // `style`/`onLayout` to ActivityIndicator's wrapper View, so pointerEvents on
    // the indicator itself would land on the native ProgressBar.
    expect(cta).toMatch(/<View pointerEvents="none" style=\{s\.ctaSpinner\}>\s*<ActivityIndicator animating=\{submitting\}/);
  });
});

describe('B-790 — blocker-flash wrappers cannot change flattenability', () => {
  it.each(['schedule', 'pickup', 'transport'])('the %s section wrapper is collapsable={false}', key => {
    const re = new RegExp(`<View collapsable=\\{false\\} style=\\{[^\\n]*flashSection === '${key}'`);
    expect(body).toMatch(re);
    // and the pre-fix spelling (a bare <View style= with the flash) is gone
    const bare = new RegExp(`<View style=\\{[^\\n]*flashSection === '${key}'`);
    expect(body).not.toMatch(bare);
  });

  it('s.hidden exists and is opacity-only', () => {
    expect(SRC).toMatch(/hidden:\s*\{opacity:\s*0\},/);
  });
});

describe('B-790 — no sibling insert into the CTA wrap or the calculation card on a draft change', () => {
  it('the gate hint is always mounted and collapsed by style — never `{gateHint && <Text`', () => {
    expect(body).not.toMatch(/\{gateHint\s*&&\s*<Text/);
    expect(body).toMatch(/<Text style=\{\[s\.gateHint, !gateHint && s\.gateHintCollapsed\]\} numberOfLines=\{2\}>\{gateHint \?\? ''\}<\/Text>/);
    expect(SRC).toMatch(/gateHintCollapsed:\s*\{opacity: 0, maxHeight: 0, marginBottom: 0, overflow: 'hidden'\},/);
  });

  it('calculation rows and their amount wrappers are pinned non-flattenable', () => {
    expect(body).toMatch(/<View key=\{l\.label\} collapsable=\{false\} style=\{\[s\.calcRow, i > 0 && s\.calcDivider\]\}>/);
    expect(body).toMatch(/<View collapsable=\{false\} style=\{\{alignItems: 'flex-end', flexShrink: 0\}\}>/);
  });

  it('the start_time effect never writes onto a non-Executive draft (the deferred clear must not re-dirty it)', () => {
    expect(body).toMatch(/useEffect\(\(\) => \{\s*if \(draft\.service !== 'executive_protection'\) \{return;\}\s*const startWall = new Date\(laterDate\);/);
    expect(body).toMatch(/\}, \[laterDate, draft\.duration_hours, zoneOffset, draft\.service\]\);/);
  });
});

describe('B-791 — zone wall-clock vs device instant: every comparison converts first', () => {
  it('the focus re-floor compares wall-clock to wall-clock', () => {
    expect(body).toMatch(/setLaterDate\(prev => \{\s*const floor = instantToZoneWallClock\(earliestLater\(\), zoneOffset\);\s*return prev\.getTime\(\) < floor\.getTime\(\) \? floor : prev;/);
    expect(body).not.toMatch(/setLaterDate\(prev => \{\s*const floor = earliestLater\(\);/);
  });

  it('the server re-seed after a lead refusal converts earliest_start into the zone clock', () => {
    expect(body).toMatch(/const snapped = roundUpToMinuteStep\(instantToZoneWallClock\(serverEarliest, zoneOffset\), 5\);/);
    expect(body).not.toMatch(/roundUpToMinuteStep\(serverEarliest, 5\)/);
  });

  it('scheduleValid and BOTH date-dialog floors (Android imperative, iOS spinner) are in the zone frame', () => {
    expect(body).toMatch(/const scheduleValid = zoneWallClockToInstant\(laterDate, zoneOffset\)\.getTime\(\) >= Date\.now\(\)/);
    expect(body).toMatch(/minimumDate: instantToZoneWallClock\(new Date\(Date\.now\(\) \+ execMinLeadHours\(\) \* 3600_000\), zoneOffset\),/);
    expect(body).toMatch(/minimumDate=\{instantToZoneWallClock\(new Date\(Date\.now\(\) \+ execMinLeadHours\(\) \* 3600_000\), zoneOffset\)\}/);
    expect(body).not.toMatch(/minimumDate=\{new Date\(Date\.now\(\)/);
  });

  it('the "earliest available" hint and the transfer start label read in the zone frame', () => {
    expect(body).toMatch(/const live = instantToZoneWallClock\(earliestLater\(\), zoneOffset\);/);
    expect(body).not.toMatch(/const live = earliestLater\(\);/);
    expect(body).toMatch(/const startWallForTransfer = instantToZoneWallClock\(startDate, zoneOffset\);\s*const startLabel = formatTime12h\(startWallForTransfer\.getHours\(\), startWallForTransfer\.getMinutes\(\)\);/);
  });
});
