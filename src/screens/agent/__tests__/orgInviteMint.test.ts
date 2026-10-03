/**
 * B-812 — the provider can MINT the invitation code an officer redeems on
 * "Join your provider". Until 2026-09-06 the redeem screen and the table
 * existed but nothing in the product created a code.
 *
 * Static source scans (the agent screens cannot be mounted in this node
 * project), in the `agentInviteOnboarding.test.ts` style: comment-stripped,
 * CRLF-normalised, anchored inside the block that matters.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
function code(rel: string): string {
  const src = readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('//') || t.startsWith('*')) {continue;}
    out.push(line);
  }
  return out.join('\n');
}

const ROSTER = 'src/screens/agent/OrgRosterScreen.tsx';
const MODAL  = 'src/screens/agent/InviteOfficerModal.tsx';
const API    = 'src/services/api.ts';
const ORG_CTRL   = 'apps/auth-service/src/org/org.controller.ts';
const JOIN_CTRL  = 'apps/auth-service/src/org/org-invite.controller.ts';

describe('B-812 — the roster has an invitation-code door', () => {
  it('OrgRosterScreen opens InviteOfficerModal from a footer button and reloads the roster when it changes', () => {
    const src = code(ROSTER);
    expect(src).toMatch(/import \{InviteOfficerModal\} from '\.\/InviteOfficerModal'/);
    expect(src).toMatch(/onPress=\{\(\) => setInviteOpen\(true\)\}/);
    const at = src.indexOf('<InviteOfficerModal');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf('/>', at));
    expect(block).toMatch(/visible=\{inviteOpen\}/);
    expect(block).toMatch(/canInviteManager=\{isOwner\}/);
    // A mint never changes the roster; the modal must not trigger a roster reload.
    expect(block).not.toMatch(/onChanged/);
  });

  it('the API client has mint / list / revoke against /org/invites (the OrgManagerGuard controller)', () => {
    const src = code(API);
    expect(src).toMatch(/listInvites: \(\) => authHttp\.get<ProviderInvite\[\]>\('\/org\/invites'\)/);
    expect(src).toMatch(/mintInvite: \([^)]*\) =>\s*authHttp\.post<[^>]+>\('\/org\/invites', dto\)/);
    expect(src).toMatch(/revokeInvite: \(code: string\) =>\s*authHttp\.post<[^>]+>\(`\/org\/invites\/\$\{encodeURIComponent\(code\)\}\/revoke`/);
  });

  it('the modal guards every money-adjacent press with a synchronous ref, copies, shares, and never navigates', () => {
    const src = code(MODAL);
    const mint = src.slice(src.indexOf('const mint = async'), src.indexOf('const revoke ='));
    expect(mint).toMatch(/if \(busyRef\.current\) \{return;\}/);
    expect(mint).toMatch(/finally \{\s*busyRef\.current = false/);
    const revoke = src.slice(src.indexOf('const revoke ='), src.indexOf('const copy ='));
    expect(revoke).toMatch(/if \(busyRef\.current\) \{return;\}/);
    expect(revoke).toMatch(/style: 'destructive'/); // confirm before an irreversible revoke
    expect(src).toMatch(/Clipboard\.setStringAsync\(code\)/);
    expect(src).toMatch(/Share\.share\(\{message: buildInviteShareText/);
    expect(src).toMatch(/import \{Alert\} from '@utils\/alert'/);
    expect(src).not.toMatch(/useNavigation|navigation\.navigate/);
    // Only the owner may mint a MANAGER invite (mirrors the promote rule).
    expect(src).toMatch(/const disabled = r === 'manager' && !canInviteManager/);
  });

  it('the share text tells the officer exactly where to type the code', () => {
    const src = code(MODAL);
    const fn = src.slice(src.indexOf('export function buildInviteShareText'), src.indexOf('export function InviteOfficerModal'));
    expect(fn).toMatch(/Join your provider/);
    expect(fn).toMatch(/single use/i);
  });

  it('server: mint/list/revoke sit on OrgController (OrgManagerGuard); the joiner\'s controller still only redeems', () => {
    const org = code(ORG_CTRL);
    // 2026-10-01 — CsrfGuard joined the stack for the provider web console
    // (cookie sessions); OrgManagerGuard still gates every route, and the
    // invite routes additionally need the owner's "Officer roster" grant.
    expect(org).toMatch(/@UseGuards\(JwtAuthGuard, CsrfGuard, OrgManagerGuard\)/);
    expect(org).toMatch(/@OrgModules\('roster'\)\s*@Post\('invites'\)/);
    expect(org).toMatch(/@Post\('invites'\)/);
    expect(org).toMatch(/@Get\('invites'\)/);
    expect(org).toMatch(/@Post\('invites\/:code\/revoke'\)/);
    expect(org).toMatch(/mintInviteCode\(manager\.org_user_id, manager\.user_id, dto\)/);
    const joinCtrl = code(JOIN_CTRL);
    expect(joinCtrl).toMatch(/@Post\('redeem'\)/);
    expect(joinCtrl).not.toMatch(/mintInvite|listInvite|revokeInvite/);
  });
});
