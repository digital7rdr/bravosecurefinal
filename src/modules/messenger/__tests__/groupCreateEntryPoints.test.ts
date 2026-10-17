import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Bug 27 (2026-10-17) — "Cannot create groups in mobile app".
 *
 * The screens mount RN views (the node project cannot render them), so the
 * wiring is pinned by source scan:
 *  1. every create button on the Groups screen opens member selection, not
 *     plain New Message (where a tap opens a 1:1 chat);
 *  2. "Add by Number" is offered while choosing members, and SELECTS the
 *     person instead of opening a chat;
 *  3. failures are shown with human copy, never the raw runtime message;
 *  4. a transient delivery failure whose copy is queued counts as queued.
 */
function code(...p: string[]): string {
  return readFileSync(join(process.cwd(), ...p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

describe('group creation entry points', () => {
  it('the Groups screen create buttons all start in member selection', () => {
    const src = code('src', 'screens', 'messenger', 'GroupsScreen.tsx');
    expect(src).not.toMatch(/navigate\('NewChat'\)/);
    expect(src.match(/navigate\('NewChat', \{startGroup: true\}\)/g)).toHaveLength(3);
  });

  it('NewChat honours startGroup', () => {
    const src = code('src', 'screens', 'messenger', 'NewChatScreen.tsx');
    expect(src).toMatch(/const startGroup = route\.params\?\.startGroup === true && !addToGroupId;/);
    expect(src).toMatch(/useState\(startGroup\)/);
  });

  it('Add by Number is not hidden while choosing members, and selects in group mode', () => {
    const src = code('src', 'screens', 'messenger', 'NewChatScreen.tsx');
    expect(src).not.toMatch(/\{!groupMode && \(\s*<TouchableOpacity style=\{styles\.newGroupRow\}[^]*?'dialpad'/);
    const at = src.indexOf('const startChatByNumber');
    const fn = src.slice(at, src.indexOf('return (', at));
    const groupBranch = fn.indexOf('if (groupMode)');
    expect(groupBranch).toBeGreaterThan(fn.indexOf('if (addToGroupId)'));
    expect(fn.slice(groupBranch, groupBranch + 1200)).toMatch(/setSelectedIds\(/);
    expect(src).toMatch(/numberPicks\.map\(/);
  });

  it('failures use the shared copy, never the raw message', () => {
    const src = code('src', 'screens', 'messenger', 'NewChatScreen.tsx');
    const at = src.indexOf('const confirmCreateGroup');
    const fn = src.slice(at, src.indexOf('const usersClient', at));
    expect(fn).toMatch(/groupCreateFailureCopy\(e, nameOfPick\)/);
    expect(fn).not.toMatch(/Alert\.alert\('Could not create group', \(e as Error\)\.message\)/);
    expect(fn).toMatch(/groupCreatePartialNote\(leftOutUserIds, nameOfPick\)/);
  });

  it('a queued admin copy is reported as queued, by the outbox rule', () => {
    const src = code('src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');
    const at = src.indexOf('const deliverGroupAdminEnvelope = async');
    const fn = src.slice(at, src.indexOf('const reshareGroupKeyState', at));
    expect(fn).toMatch(/queued = true;/);
    expect(fn).toMatch(/throw markQueuedForRetry\(\s*e, queued && !isPermanentRelayRejection\(e\) && classifyOutboxFailure\(e\)\.kind !== 'rejected',?\s*\)/);
    const create = src.slice(src.indexOf('createGroupChat: async'), src.indexOf('MISSION-GROUP (batch area 5)'));
    expect(create).toMatch(/if \(isQueuedForRetry\(e\)\)/);
    expect(create).toMatch(/for \(const f of r\.failures\)/);
  });
});
