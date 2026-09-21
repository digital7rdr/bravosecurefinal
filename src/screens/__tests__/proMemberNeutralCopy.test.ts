/**
 * B-833 / B-834 — linked people are "members", full stop.
 *
 * The founder's rule (WhatsApp 2026-09-08): "instead of using words like
 * brother sister father just call it members", and the count limit goes. This
 * scan is the standing guard for the four files a holder or a member actually
 * READS the wording from — the two holder screens and the two notification
 * copy maps.
 *
 * Scope is EXACTLY those four files on purpose: `NextOfKinModal.tsx`
 * legitimately offers "Spouse, Brother" for a next-of-kin relationship, and a
 * repo-wide ban would either break that screen or have to carve it out.
 *
 * Mechanics, per the CLAUDE.md source-scan rules: comments are stripped first
 * (a prose mention of a banned word is not a defect), scanning is line-based
 * because these files are CRLF, and the push/activity maps are scanned by
 * their COPY VALUES only — the kind ids (`family-invite`, …) are wire
 * identifiers pinned by `serverWakeKindParity` and must NOT be renamed.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/** CODE lines only — line-based so a MIME string like '&#42;/&#42;' is never read as a comment. */
function codeLines(...rel: string[]): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of readFileSync(join(process.cwd(), ...rel), 'utf8').split(/\r?\n/)) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(raw.replace(/(^|\s)\/\/.*$/, '$1'));
  }
  return out;
}

const HOLDER_SCREENS: Array<{label: string; rel: string[]; present: string}> = [
  {
    label: 'SecureProMembersScreen',
    rel: ['src', 'screens', 'securepro', 'SecureProMembersScreen.tsx'],
    present: 'Add Member',
  },
  {
    label: 'IndividualProfileScreen',
    rel: ['src', 'screens', 'settings', 'IndividualProfileScreen.tsx'],
    present: 'Add a member',
  },
];

const COPY_MAPS: Array<{label: string; rel: string[]}> = [
  {label: 'serverWakeNotifications', rel: ['src', 'modules', 'messenger', 'push', 'serverWakeNotifications.ts']},
  {label: 'activitySync', rel: ['src', 'store', 'activitySync.ts']},
];

/**
 * B-854 — the chained-funding surfaces. Three MORE places a holder or a member
 * reads wording from, and the founder's rule does not stop at the two
 * notification maps: "member", never "family", and never a relationship word.
 *
 * These files cannot be scanned the way the maps above are (`title:`/`body:`
 * pairs): the copy lives in JSX text, alert arguments and returned sentences,
 * mixed on the same lines as identifiers. So the discrimination is a WORD
 * BOUNDARY rather than a list of exemptions — the one property that actually
 * separates the two:
 *
 *   prose      "your family member", "Family Members"   → \bfamily\b matches
 *   identifier `familyApi`, `FamilyMember`               → y|A are both word
 *                                                          chars, no boundary
 *   wire code  `family_spend_limit_exceeded`             → `_` is a word char,
 *                                                          no boundary
 *
 * That is not a loophole being left open: renaming `familyApi` is a different
 * and much larger job, and what the rule governs is what a person READS.
 */
const B854_COPY: Array<{label: string; rel: string[]}> = [
  {label: 'FundingRequestCard', rel: ['src', 'screens', 'settings', 'FundingRequestCard.tsx']},
  {label: 'FamilyQuotaCard',    rel: ['src', 'screens', 'settings', 'FamilyQuotaCard.tsx']},
  {label: 'creditErrors',       rel: ['src', 'screens', 'booking', 'creditErrors.ts']},
];

/** The word as ENGLISH — never as half an identifier or a snake_case code. */
const PROSE_FAMILY = /\bfamil(y|ies|ial)\b/i;
/** `/family/...` is a wire PATH, not something anyone reads. */
const ROUTE_PATH = /\/family\//;

const RELATIONSHIP_WORDS = /\b(Spouse|Father|Mother|Daughter|Brother|Sister|Guardian)\b/;
const FAMILY_IS_FULL = /family is full/i;
const FAMILY_MEMBERS_LABEL = /Family Members/;
const SEAT_CAP_CONST = /MAX_SEATS/;

/** `title: '…'` / `body: "…"` / `subtitle: '…'` — the strings a user reads. */
function copyValues(...rel: string[]): string[] {
  const src = codeLines(...rel).join('\n');
  const out: string[] = [];
  const re = /\b(?:title|body|subtitle)\s*:\s*(['"])((?:\\.|(?!\1).)*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {out.push(m[2]);}
  return out;
}

describe('B-834 — the holder screens carry no relationship or seat-cap wording', () => {
  it.each(HOLDER_SCREENS)('$label', ({rel, present}) => {
    const lines = codeLines(...rel);
    // Self-check FIRST: a scan that reads nothing passes every absence test.
    expect(lines.some(l => l.includes(present))).toBe(true);

    expect(lines.filter(l => RELATIONSHIP_WORDS.test(l))).toEqual([]);
    expect(lines.filter(l => FAMILY_IS_FULL.test(l))).toEqual([]);
    expect(lines.filter(l => FAMILY_MEMBERS_LABEL.test(l))).toEqual([]);
    expect(lines.filter(l => SEAT_CAP_CONST.test(l))).toEqual([]);
  });
});

describe('B-834 — push and activity copy says "member", never "family"', () => {
  it.each(COPY_MAPS)('$label copy values are neutral', ({rel}) => {
    const values = copyValues(...rel);
    // Self-check: this map really was parsed, and a kind that keeps its copy is here.
    expect(values.length).toBeGreaterThan(20);
    expect(values).toContain('Credit request');

    expect(values.filter(v => /famil/i.test(v))).toEqual([]);
    expect(values.filter(v => RELATIONSHIP_WORDS.test(v))).toEqual([]);
    expect(values.filter(v => SEAT_CAP_CONST.test(v))).toEqual([]);
  });

  it('the wire KIND ids are untouched — renaming them breaks serverWakeKindParity', () => {
    for (const {rel} of COPY_MAPS) {
      const src = codeLines(...rel).join('\n');
      expect(src).toContain("'family-invite'");
      expect(src).toContain("'family-invite-accepted'");
      expect(src).toContain("'family-charge-blocked'");
      expect(src).toContain("'family-quota-threshold'");
    }
  });
});

describe('B-854 — the chained-funding surfaces say "member" too', () => {
  it.each(B854_COPY)('$label reads neutrally', ({rel}) => {
    const lines = codeLines(...rel);
    // Self-check FIRST: a scan that reads nothing passes every absence test.
    expect(lines.length).toBeGreaterThan(40);
    expect(lines.some(l => l.includes('member'))).toBe(true);

    const offenders = lines.filter(l =>
      !ROUTE_PATH.test(l) && (PROSE_FAMILY.test(l) || RELATIONSHIP_WORDS.test(l)));
    expect(offenders).toEqual([]);
  });

  /**
   * The boundary rule is the whole scan, so it gets its own proof — otherwise a
   * regex that matched nothing would pass every case above vacuously.
   */
  it('the word-boundary rule separates prose from identifiers', () => {
    // Prose a person reads — MUST be caught.
    for (const prose of [
      'Your family member is now active.',
      '<Text>Family Members · 4</Text>',
      'Ask your family holder to fund your members',
      'families can share credits',
    ]) {
      expect(PROSE_FAMILY.test(prose)).toBe(true);
    }
    // Identifiers and wire codes — must NOT be caught.
    for (const code of [
      "import {familyApi, type FamilyMember} from '@services/api';",
      'export function FamilyQuotaCard(',
      "text.includes('family_spend_limit_exceeded')",
      'opts?: {isFamilyMember?: boolean},',
      "throw new Error('not_a_family_member')",
      'fundingRequest?: FamilyFundingRequest | null;',
    ]) {
      expect(PROSE_FAMILY.test(code)).toBe(false);
    }
    // …and the route path is excluded by its own rule, not by the boundary.
    expect(ROUTE_PATH.test('`/family/memberships/${id}/fund-members/off`')).toBe(true);
  });

  it('a relationship word in this new copy would be caught', () => {
    expect(RELATIONSHIP_WORDS.test('Your Brother may spend this allowance')).toBe(true);
  });
});

describe('B-834 scan self-checks', () => {
  it('the scan is not vacuous — it catches the pre-fix strings', () => {
    expect(/famil/i.test('Your family member is now active. Tap to manage.')).toBe(true);
    expect(RELATIONSHIP_WORDS.test("const RELATIONSHIPS = ['Spouse', 'Father'];")).toBe(true);
    expect(FAMILY_IS_FULL.test("toast('Family is full (4 members max).');")).toBe(true);
    expect(FAMILY_MEMBERS_LABEL.test('<Text>Family Members · {filled} / 4 Max</Text>')).toBe(true);
    expect(SEAT_CAP_CONST.test('const MAX_SEATS = 4;')).toBe(true);
  });
});
