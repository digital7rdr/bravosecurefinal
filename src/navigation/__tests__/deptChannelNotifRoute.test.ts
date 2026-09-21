/**
 * F4 — a department-channel notification tap opened ChatScreen, which renders
 * phone + video buttons unconditionally. The PDF's A9/M9 rule is locked: "No
 * phone/call button appears in Department Channel chat; calls remain in
 * Messenger." A channel's conversation is stored with `type: 'group'`, so
 * `fcmBootstrap`'s `isGroup = conv.type === 'group'` could not tell it from an
 * ordinary group and every channel push landed on the banned surface.
 *
 * This file pins the NAVIGATION half:
 *   - the dept-vs-group signal itself (`resolveDeptConversation`), including the
 *     case the naive fix misses — a channel whose pointer row was never written
 *     on this device;
 *   - the three-shell path table for the two new targets, where the AGENCY shell
 *     is the one that used to silently degrade (AgentNavigator registers
 *     `Departmental` and nothing inside it);
 *   - the decision site in `fcmBootstrap`'s msg-wake branch, because no unit
 *     test in this project can import that module.
 *
 * The behavioural half (drive the real notifee handler, seeded store, cold-boot
 * persisted slice) is `src/modules/messenger/__tests__/deptChannelNotifTap.test.ts`.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {messengerRouteFor} from '../messengerDeepLink';
import {resolveDeptConversation} from '@/modules/messenger/push/deptChannelTarget';

const CLIENT = {accountKind: 'client'};
const AGENCY = {accountKind: 'agency'};
const CPO    = {accountKind: 'cpo'};

const CHAT_PARAMS = {
  channelId:           'ch-9',
  channelName:         'Operations',
  channelDesc:         '',
  groupConversationId: 'conv-9',
};

describe('resolveDeptConversation — the dept-vs-group signal', () => {
  it('returns the channel id when the pointer map knows this conversation', () => {
    expect(resolveDeptConversation('conv-9', {
      deptGroupByChannel: {'ch-9': 'conv-9'},
      deptConversationIds: {'conv-9': true},
    })).toEqual({channelId: 'ch-9', orgId: null});
  });

  /**
   * THE CASE A NAIVE FIX MISSES. `deptGroupByChannel` is written when a channel
   * thread is opened, and B-206 OVERWRITES it on a remap. `deptConversationIds`
   * is the additive registry `armDeptConversationRegistry()` fills from the
   * server at every messenger boot — so on a device that has never opened the
   * channel, the pointer is absent and only the registry answers. Reading the
   * pointer alone would route that tap to ChatScreen: the whole bug.
   */
  it('still reports DEPARTMENTAL when only the additive registry knows it', () => {
    expect(resolveDeptConversation('conv-9', {deptConversationIds: {'conv-9': true}}))
      .toEqual({channelId: null, orgId: null});
  });

  it('is null for an ordinary group — that tap keeps its Chat routing', () => {
    expect(resolveDeptConversation('g-1', {
      deptGroupByChannel: {'ch-9': 'conv-9'},
      deptConversationIds: {'conv-9': true},
    })).toBeNull();
  });

  it('is null (never a throw) with absent/empty maps or a blank id', () => {
    expect(resolveDeptConversation('conv-9', {})).toBeNull();
    expect(resolveDeptConversation('conv-9', null)).toBeNull();
    expect(resolveDeptConversation('', {deptConversationIds: {'': true} as never})).toBeNull();
  });
});

describe('messengerRouteFor — where DepartmentChat lives in each shell', () => {
  it('CLIENT: Main -> MessengerTab -> DepartmentChat, initial:false', () => {
    expect(messengerRouteFor('DepartmentChat', CHAT_PARAMS, CLIENT, {initial: false})).toEqual({
      name:   'Main',
      params: {screen: 'MessengerTab', params: {screen: 'DepartmentChat', initial: false, params: CHAT_PARAMS}},
    });
  });

  it('CPO: CpoTabs -> CpoComms -> DepartmentChat', () => {
    expect(messengerRouteFor('DepartmentChat', CHAT_PARAMS, CPO, {initial: false})).toEqual({
      name:   'CpoTabs',
      params: {screen: 'CpoComms', params: {screen: 'DepartmentChat', initial: false, params: CHAT_PARAMS}},
    });
  });

  /**
   * THE AGENCY DEGRADE. AgentNavigator registers `Departmental` and nothing
   * inside it, so the pre-existing "not on the agency root -> MessengerHome"
   * rule would drop an agency owner (a persona who is in every channel) on the
   * chat list instead of the post they tapped.
   */
  it('AGENCY: Departmental -> Channels -> DepartmentChat, never MessengerHome', () => {
    const route = messengerRouteFor('DepartmentChat', CHAT_PARAMS, AGENCY, {initial: false});
    expect(route).toEqual({
      name:   'Departmental',
      params: {screen: 'Channels', params: {screen: 'DepartmentChat', initial: false, params: CHAT_PARAMS}},
    });
    expect(route.name).not.toBe('MessengerHome');
  });

  it('AGENCY: the directory degrade lands in the workspace too', () => {
    expect(messengerRouteFor('DepartmentChannels', {}, AGENCY, {initial: false})).toEqual({
      name:   'Departmental',
      params: {screen: 'Channels', params: {screen: 'DepartmentChannels', initial: false}},
    });
  });

  it('CLIENT: the directory degrade is the messenger tab route', () => {
    expect(messengerRouteFor('DepartmentChannels', {}, CLIENT, {initial: false})).toEqual({
      name:   'Main',
      params: {screen: 'MessengerTab', params: {screen: 'DepartmentChannels', initial: false}},
    });
  });

  it('leaves every pre-existing target routed exactly as before', () => {
    // Regression guard on the shared table: the agency branch grew a second
    // arm, and a mis-scoped condition there would silently re-route calls.
    expect(messengerRouteFor('CallScreen', {callId: 'c1'}, AGENCY)).toEqual({
      name: 'CallScreen', params: {callId: 'c1'},
    });
    // N2 — CallsLog is now registered in AgentNavigator, so it routes directly
    // in the agency shell instead of degrading to MessengerHome.
    expect(messengerRouteFor('CallsLog', {}, AGENCY)).toEqual({name: 'CallsLog', params: undefined});
    expect(messengerRouteFor('Chat', {conversationId: 'c'}, CLIENT)).toEqual({
      name: 'Main', params: {screen: 'MessengerTab', params: {screen: 'Chat', params: {conversationId: 'c'}}},
    });
  });
});

/**
 * The decision site. `fcmBootstrap.ts` transitively imports react-native +
 * firebase, so this project scans it as TEXT (same pattern as
 * pushNavigateParamSweep). Comments are stripped first, and the assertions are
 * scoped to the BALANCED msg-wake branch — a file-wide "no 'Chat'" scan would be
 * both wrong (the missed-call handler legitimately opens Chat) and worthless.
 */
describe('fcmBootstrap msg-wake branch routes through the one door', () => {
  const src = readFileSync(
    join(process.cwd(), 'src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts'), 'utf8',
  );
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');   // [^\n] also eats the trailing \r — CRLF-safe

  function balancedFrom(idx: number): string {
    const open = code.indexOf('{', idx);
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') {depth++;}
      else if (code[i] === '}') { depth--; if (depth === 0) {return code.slice(open, i + 1);} }
    }
    throw new Error('unbalanced msg-wake branch');
  }

  const branchIdx = code.indexOf("if (data.kind === 'msg-wake')");
  const branch = balancedFrom(branchIdx);

  it('the msg-wake branch exists and was actually found', () => {
    expect(branchIdx).toBeGreaterThan(-1);
    // Non-vacuous: the slice must contain the branch's own landmarks.
    expect(branch).toMatch(/resolveDeptRouteForTap\(/);
    expect(branch).toMatch(/navigateToThread\(/);
  });

  it('NO navigate inside it hard-codes the Chat screen any more', () => {
    // This is the mutation the fix undoes: `navigateToMessengerScreen(nav,
    // 'Chat', …)` at either navigate site sends a channel post to the surface
    // with the banned call buttons. Scoped to the CALL — `current.name ===
    // 'Chat'` (the B-324 "is the user still where I put them" read) is a
    // different use of the same token and must survive.
    expect(branch).not.toMatch(/navigateToMessengerScreen\([^,]+,\s*'Chat'/);
    // MessengerHome (the unresolvable-conversation degrade) is the only screen
    // this branch is still allowed to name directly.
    const direct = branch.match(/navigateToMessengerScreen\([^,]+,\s*'([A-Za-z]+)'/g) ?? [];
    expect(direct.every(m => m.endsWith("'MessengerHome'"))).toBe(true);
  });

  it('BOTH navigate sites go through it — the immediate one and the B-324 re-route', () => {
    expect(branch.match(/navigateToThread\(/g)).toHaveLength(2);
    // …and the re-route resolves department-ness for ITS target, not the
    // banner's (they can be different conversations).
    expect(branch.match(/resolveDeptRouteForTap\(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * B-848 / A9 — the org the tap is about must reach the surface it lands on.
   *
   * The directory IS the workspace surface: it is one organisation's channel
   * list, it refuses to show more than one at a time now, and no shell leaves
   * the user outside that org after landing there. So a DIRECTORY destination
   * adopts on EVERY shell — the previous rule (agency shell only) would open a
   * list scoped to a different company than the message that was tapped.
   *
   * A CHAT destination keeps the narrower rule, because `adoptOrgContext`'s
   * contract is explicit that a door which does not put the user inside that
   * org's surface must not repoint a context that also decides where clock-in
   * and incident submit LAND.
   */
  it('A9 — a DIRECTORY destination adopts on every shell; a CHAT one does not', () => {
    const door = balancedFrom(code.indexOf('): void {', code.indexOf('function navigateToThread')));
    // Non-vacuous: the slice must hold the decision it is being asked about.
    expect(door).toMatch(/adoptOrgContextFromWake/);
    expect(door).toMatch(
      /threadRouteName\(dept\) === 'DepartmentChannels'\s*\|\|\s*deptThreadEntersWorkspaceSurface\(\)/,
    );
    /**
     * …and `dept?.orgId` comes FIRST, in the same expression.
     *
     * `deptThreadEntersWorkspaceSurface()` lazily requires `authStore` (axios,
     * AsyncStorage, supabase). Hoisting the predicate into a `const` above the
     * guard — which is how the first cut of this was written — evaluates it on
     * EVERY tap, including an ordinary 1:1 Chat tap on a killed process, which
     * is exactly the path this file's lazy requires exist to keep light. The
     * short-circuit is behaviour.
     */
    expect(door).toMatch(
      /if \(dept\?\.orgId\s*&&\s*\(threadRouteName\(dept\) === 'DepartmentChannels' \|\| deptThreadEntersWorkspaceSurface\(\)\)\)/,
    );
  });

  it('A9 — an UNKNOWN org on a directory destination RELEASES the context', () => {
    // The conversation→org registry is empty after a 403 or an offline cold
    // boot, and the directory would then be scoped to whatever the surface
    // happens to name — a company this message is not from.
    const door = balancedFrom(code.indexOf('): void {', code.indexOf('function navigateToThread')));
    expect(door).toMatch(
      /if \(!dept\?\.orgId && threadRouteName\(dept\) === 'DepartmentChannels'\)/,
    );
    expect(door).toMatch(/releaseOrgContextForUnknownWake\(\)/);
    // The release lives in adoptOrgContext, so this file writes no context of
    // its own — the one-writer rule, pinned in activityCenterWiring.
    expect(door).not.toMatch(/setActiveWorkspace/);
  });

  it('A9(d) — the DepartmentChat route carries the org it belongs to', () => {
    const door = balancedFrom(code.indexOf('): void {', code.indexOf('function navigateToThread')));
    expect(door).toMatch(/orgId:\s*dept\?\.orgId/);
  });

  it('the one door reads the channel id before choosing DepartmentChat', () => {
    // From `): void {`, not the first `{` — the signature's own type literals
    // would otherwise be mistaken for the body.
    const door = balancedFrom(code.indexOf('): void {', code.indexOf('function navigateToThread')));
    expect(door).toMatch(/dept\?\.channelId/);
    expect(door).toMatch(/'DepartmentChat'/);
    // The dept-but-unmapped degrade is the DIRECTORY, never Chat.
    expect(door).toMatch(/'DepartmentChannels'/);
  });
});
