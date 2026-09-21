/**
 * B-854 — the four chained-funding routes, pinned at the WIRE.
 *
 * `src/services/api.ts` cannot be imported by the node `booking` project (it
 * pulls axios and the RN keychain), so this is a source scan — and per the repo
 * scan rules it strips comments first (a route named in prose is not a call
 * site) and is CRLF-safe.
 *
 * What it is actually guarding: a money route whose METHOD or PATH drifts from
 * the server's does not fail loudly. It 404s inside a `catch` and the member is
 * told "please try again" forever, with the chain silently never switching on.
 * The approval model (A11) makes that worse, not better: B asks, A never hears.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Strip block comments and `//` tails so prose can never satisfy a scan. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(line => {
      const i = line.indexOf('//');
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join('\n');
}

const API = stripComments(read('src/services/api.ts'));

describe('B-854 — familyApi carries the chained-funding routes', () => {
  it('the scan is not vacuous — it can see the routes that already exist', () => {
    expect(API).toContain('/family/memberships');
    expect(API).toContain('`/family/members/${id}/spend`');
  });

  /**
   * Member side. `POST`, not `PATCH`: A11 made this a REQUEST that A decides,
   * so it creates a row rather than flipping a flag, and B cannot switch its
   * own funding on.
   */
  it('requestFundMembers POSTs to the MEMBERSHIP row (member side)', () => {
    expect(API).toMatch(/requestFundMembers:\s*\(membershipId: string\)\s*=>/);
    expect(API).toContain('`/family/memberships/${membershipId}/fund-members/request`');
    const at = API.indexOf('requestFundMembers');
    const block = API.slice(at, at + 320);
    expect(block).toContain('authHttp.post');
  });

  /**
   * Holder side. Keyed on the `family_members` ROW id, never on a user id: the
   * holder is deciding about ONE membership, and a user-keyed route could not
   * name which of several rows it meant.
   */
  it('approveFundMembers / declineFundMembers POST to the MEMBER row (holder side)', () => {
    for (const [fn, seg] of [['approveFundMembers', 'approve'], ['declineFundMembers', 'decline']] as const) {
      expect(API).toMatch(new RegExp(`${fn}:\\s*\\(rowId: string\\)\\s*=>`));
      expect(API).toContain('`/family/members/${rowId}/fund-members/' + seg + '`');
      const at = API.indexOf(fn);
      expect(API.slice(at, at + 320)).toContain('authHttp.post');
    }
  });

  /** A10 — switching it OFF is the holder's, and it is a PATCH of the row. */
  it('setFundMembers PATCHes the member row with {enabled}', () => {
    // `false`, not `boolean`: the server DTO is `@IsIn([false])`, so a `true`
    // here is a 400 the compiler should have caught. Switching the chain ON is
    // the approve route (A11).
    expect(API).toMatch(/setFundMembers:\s*\(rowId: string, enabled: false\)\s*=>/);
    expect(API).toContain('`/family/members/${rowId}/fund-members`');
    const at = API.indexOf('setFundMembers');
    const block = API.slice(at, at + 320);
    expect(block).toContain('authHttp.patch');
    expect(block).toContain('{enabled}');
  });

  /**
   * The member may STOP the chain even though they may not start it: switching
   * it off narrows who can spend the root's money, so it needs nobody's
   * approval. Keyed on their own MEMBERSHIP row, like the request.
   */
  it('stopFundMembers POSTs to the MEMBERSHIP row (member side)', () => {
    expect(API).toMatch(/stopFundMembers:\s*\(membershipId: string\)\s*=>/);
    expect(API).toContain('`/family/memberships/${membershipId}/fund-members/off`');
    const at = API.indexOf('stopFundMembers');
    expect(API.slice(at, at + 320)).toContain('authHttp.post');
  });

  it('no funding route is spelled against the wrong side', () => {
    // The two halves are a real trap: `/family/members/:rowId/...` is the
    // HOLDER's row on their roster and `/family/memberships/:id/...` is the
    // MEMBER's own row. Swapping them 404s or, worse, acts on someone else's.
    expect(API).not.toContain('`/family/members/${membershipId}');
    expect(API).not.toContain('`/family/memberships/${rowId}');
  });
});

describe('B-854 — the DTO fields the chain adds', () => {
  it('FamilyMembership (member side) carries the chain state', () => {
    const at = API.indexOf('export interface FamilyMembership');
    expect(at).toBeGreaterThan(-1);
    const block = API.slice(at, API.indexOf('\n}', at));
    expect(block).toMatch(/fundsSubMembers\??:\s*boolean/);
    expect(block).toMatch(/spentByMembers\??:\s*number/);
    expect(block).toMatch(/holdsMembersCount\??:\s*number/);
    expect(block).toMatch(/fundingRequest\??:/);
  });

  it('FamilyMember (holder roster row) carries the same four', () => {
    const at = API.indexOf('export interface FamilyMember ');
    expect(at).toBeGreaterThan(-1);
    const block = API.slice(at, API.indexOf('\n}', at));
    expect(block).toMatch(/fundsSubMembers\??:\s*boolean/);
    expect(block).toMatch(/holdsMembersCount\??:\s*number/);
    expect(block).toMatch(/spentByMembers\??:\s*number/);
    expect(block).toMatch(/fundingRequest\??:/);
    // Both rosters send the object now. The bare `fundingRequestId` an interim
    // build projected is gone from the server, so carrying it here would be a
    // dead field that invites a dead code path to read it.
    expect(block).not.toContain('fundingRequestId');
  });

  it('a funding request\'s `status` is OPTIONAL — the server sends pending-only rows', () => {
    const at = API.indexOf('export interface FamilyFundingRequest');
    expect(at).toBeGreaterThan(-1);
    const block = API.slice(at, API.indexOf('\n}', at));
    expect(block).toMatch(/status\?:\s*FamilyFundingRequestStatus/);
  });

  it('a spend row can name the ACTOR and the member it came VIA', () => {
    const at = API.indexOf('export interface FamilyMemberSpend');
    const block = API.slice(at, API.indexOf('\n}', at));
    expect(block).toMatch(/actorName\??:\s*string \| null/);
    expect(block).toMatch(/viaUserId\??:\s*string \| null/);
  });

  it('PayerOption carries effectiveSpendable (A12)', () => {
    const at = API.indexOf('export interface PayerOption');
    const block = API.slice(at, API.indexOf('\n}', at));
    expect(block).toMatch(/effectiveSpendable\??:\s*number \| null/);
  });

  /**
   * LM-B7 / A8 — the via holder's name is a HOLDER/OPS fact. The client's own
   * history already reads "Paid by B" because the server projects B into
   * `payer_name`; a `payer_via_name` on the client DTO is the shape that lets
   * A's name reach C, which is the one thing this whole feature must not do.
   */
  it('the CLIENT history DTO does NOT learn the wallet owner behind the chain', () => {
    // Self-check: the DTO this is about really is in the scanned file.
    expect(API).toContain('payer: \'self\' | \'family_owner\'');
    // WHOLE FILE, not a window around that line: `payer_via_name` anywhere in
    // the client's API surface is a field some screen can read, and the ±400
    // char window would have missed it being added three interfaces away.
    expect(API).not.toContain('payer_via_name');
  });
});

/**
 * B-854/A13 — the 80/90/100 % warning finally reads its own band.
 *
 * `pct` has been on the wire since the quota work shipped and nothing consumed
 * it, so the crossing that actually BLOCKS a booking (100 %) drew the same
 * "is approaching their spending limit" banner as the gentlest one. This is a
 * real import, not a scan: `serverWakeNotifications` has no static imports (its
 * native deps are lazy-required), so the node project can execute it.
 */
describe('B-854/A13 — quotaThresholdCopy is band-aware and person-free', () => {
  const {quotaThresholdCopy} =
    require('../../../modules/messenger/push/serverWakeNotifications') as
      typeof import('../../../modules/messenger/push/serverWakeNotifications');

  it('80 % is "approaching"', () => {
    expect(quotaThresholdCopy(80).body).toMatch(/approaching their spending limit/i);
  });

  it('90 % is "almost at" — distinctly stronger than 80', () => {
    expect(quotaThresholdCopy(90).body).toMatch(/almost at their spending limit/i);
    expect(quotaThresholdCopy(90).body).not.toBe(quotaThresholdCopy(80).body);
  });

  it('100 % says the limit is GONE, and says so in the title too', () => {
    const at100 = quotaThresholdCopy(100);
    expect(at100.body).toMatch(/has used all of their spending limit/i);
    expect(at100.title).toMatch(/limit reached/i);
    // THE regression: 100 % reading like 80 %.
    expect(at100.body).not.toMatch(/approaching/i);
  });

  it('reads a numeric STRING — an FCM data payload is all strings', () => {
    expect(quotaThresholdCopy('100').body).toBe(quotaThresholdCopy(100).body);
    expect(quotaThresholdCopy('90').body).toBe(quotaThresholdCopy(90).body);
  });

  it('an absent or junk band falls back to the gentlest wording, never a stronger claim', () => {
    for (const junk of [undefined, null, '', 'lots', NaN, {}]) {
      expect(quotaThresholdCopy(junk).body).toBe(quotaThresholdCopy(80).body);
    }
  });

  it('a band above 100 does not silently weaken', () => {
    expect(quotaThresholdCopy(140).body).toBe(quotaThresholdCopy(100).body);
  });

  /** B-833/B-834 + P0-N8 — no name, no figure, no relationship word. */
  it('names nobody and quotes nothing', () => {
    for (const pct of [80, 90, 100]) {
      const {title, body} = quotaThresholdCopy(pct);
      for (const s of [title, body]) {
        expect(s).not.toMatch(/famil/i);
        expect(s).not.toMatch(/\b(Spouse|Father|Mother|Daughter|Brother|Sister|Guardian)\b/);
        expect(s).not.toMatch(/\d/);
      }
    }
  });
});
