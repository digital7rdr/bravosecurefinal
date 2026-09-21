/**
 * B-843 / plan D9 + A15 — a person may be an active member under SEVERAL root
 * accounts, so the console must stop saying they cannot be.
 *
 * The server's `member_in_another_family` refusal is gone (the one-active index
 * is replaced by a per-(root, member) open index), which means the console copy
 * for it is now a lie that can never be shown: an operator pasting a company
 * roster would read "they are already a member of another account" as a REASON
 * the add failed, when nothing failed at all. The "Already linked" bucket also
 * has to say WHICH account, because "linked" is no longer a global fact.
 *
 * The node project has no DOM, so LinkedMembersCard is not renderable here —
 * this is a source scan, and it obeys the three rules that make one real:
 * comments are stripped BEFORE anything is asserted (prose naming a retired
 * code is not the code), lines are split on `\r?\n` (these files are checked
 * out CRLF on Windows and a `\n` anchor passes vacuously), and every absence
 * assertion is paired with a PRESENT-token self-check so a bad path or an
 * over-eager stripper cannot report a green.
 */

import {readFileSync} from 'fs';
import {join} from 'path';

const PEOPLE = join(__dirname, '..', 'features', 'people');

/** Block comments first, then line comments — neither appears inside a string literal here. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

const CARD = stripComments(readFileSync(join(PEOPLE, 'LinkedMembersCard.tsx'), 'utf8'));
const DETAIL = stripComments(readFileSync(join(PEOPLE, 'UserDetail.tsx'), 'utf8'));

describe('LinkedMembersCard — the scan can see the code it is scanning', () => {
  it('read both files and the stripper left the executable source intact', () => {
    expect(CARD.length).toBeGreaterThan(2000);
    expect(DETAIL.length).toBeGreaterThan(2000);
    // Present-token self-check: sibling codes that MUST survive the strip.
    expect(CARD).toContain('invite_already_pending');
    expect(CARD).toContain('not_a_bravo_user');
    expect(CARD).toContain('const CODE_COPY');
    expect(DETAIL).toContain('family.member_of.length');
  });
});

describe('B-843 — the retired refusal is gone from the console', () => {
  it('LinkedMembersCard names `member_in_another_family` nowhere in its code', () => {
    expect(CARD).not.toContain('member_in_another_family');
  });

  it('the Already-linked bucket keeps only the pending-invite code, and says WHICH account', () => {
    const linked = /\{\s*key:\s*'linked'[\s\S]*?\}/.exec(CARD)?.[0] ?? '';
    // Self-check: the entry was actually found before anything is read off it.
    expect(linked).toContain("key: 'linked'");
    expect(linked).toContain("'invite_already_pending'");
    expect(linked).toContain("title: 'Already on this account'");
    expect(linked).not.toContain('member_in_another_family');
  });

  it('the intro paragraph states that several accounts are allowed', () => {
    // JSX prose wraps wherever it fits, so the sentence is matched on its words.
    const flat = CARD.replace(/\s+/g, ' ');
    expect(flat).toContain('People who spend from this account&apos;s Bravo Credits.');
    expect(flat).toContain('A person can be a member of several accounts; each account keeps its own allocation.');
  });
});

describe('B-843 — the Member of card carries its count', () => {
  it('titles itself "Member of · N" once there is more than one root', () => {
    expect(DETAIL).toContain('member_of.length > 1');
    expect(DETAIL).toContain('Member of · ${family.member_of.length}');
  });
});

/**
 * B-854 — chained credit added a whole column, a disclosure and five refusal
 * sentences to this card. The B-832 product rule ("members", never family or
 * spouse) is a rule about the WORDS an operator reads, and every one of those
 * new strings is a place for it to break.
 *
 * The card's own identifiers legitimately contain "Family" (`useUserFamily`,
 * `OpsFamilyRow`, `opsDataApi.familyMemberSpend` …), so a blanket ban would be
 * a lie that passes. Instead every `famil*` token is enumerated and checked
 * against the identifiers this file is allowed to name: a new one is a hard
 * failure that tells you which token to look at, and the word "family" in prose
 * matches none of them.
 */
describe('B-854 — the chained-credit copy stays neutral', () => {
  const CARD_COPY = stripComments(readFileSync(join(PEOPLE, 'LinkedMembersCard.tsx'), 'utf8'));
  const FUNDING = stripComments(readFileSync(join(PEOPLE, '..', '..', 'lib', 'familyFunding.ts'), 'utf8'));

  const ALLOWED_FAMIL_TOKENS = [
    'FamilyBatchResult', 'FamilyMemberSpend', 'OpsFamilyRow', 'OpsUserFamily',
    'familyFunding', 'familyMemberSpend', 'inviteFamilyMember', 'inviteFamilyMembersBatch',
    'revokeFamilyMember', 'setFamilyMemberHold', 'setFamilyMemberLimit', 'useUserFamily',
  ];

  it('every `famil*` token in the card is an identifier, never a word the operator reads', () => {
    const hits = [...new Set(CARD_COPY.match(/[A-Za-z]*[Ff]amil[A-Za-z]*/g) ?? [])];
    // Self-check: the scan really can see this file's identifiers.
    expect(hits).toContain('useUserFamily');
    expect(hits.filter(h => !ALLOWED_FAMIL_TOKENS.includes(h))).toEqual([]);
  });

  it('the helper module that writes the refusals says none of it either', () => {
    // Its FILENAME is `familyFunding.ts` (it sits beside the family routes), so
    // the check is on the copy the operator reads, not on the module name.
    const strings = FUNDING.match(/'[^'\n]*'/g) ?? [];
    expect(strings.length).toBeGreaterThan(5);          // self-check
    for (const s of strings) {
      expect(`${s}:${/famil|spouse|household|\bkids?\b|\bchild/i.test(s)}`).toBe(`${s}:false`);
    }
  });

  it('never says spouse, household or children anywhere in either file', () => {
    for (const src of [CARD_COPY, FUNDING]) {
      expect(src).not.toMatch(/spouse|household|\bkids?\b/i);
      // React's own `children` prop is spelled `children:` / `{children}` and is
      // not a word anyone reads; prose is followed by a space or punctuation.
      expect(src).not.toMatch(/\bchildren\b(?![:}])/i);
    }
    // Self-check: both files were really read.
    expect(CARD_COPY).toContain('Funds their members');
    expect(FUNDING).toContain('holds ');
  });

  it('the column, the states and the disclosure are all named in member words', () => {
    expect(CARD_COPY).toContain('Funds their members');
    expect(CARD_COPY).toContain('SPENDING');
    expect(CARD_COPY).toContain('their members are back on their own credits');
  });
});
