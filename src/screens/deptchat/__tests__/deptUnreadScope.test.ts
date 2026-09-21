/**
 * B-848 / A13 — the Departmental tab BADGE is single-org whenever a workspace
 * context exists, and cross-org only in the picker state.
 *
 * This is a deliberate asymmetry with the three LIST surfaces, and it is worth
 * saying out loud because "make these consistent" is exactly the refactor that
 * would break it:
 *
 *   - A LIST must never mix organisations (the client's whole report). The
 *     directory, the workspace Home and the Vault company shelf now show the
 *     picker instead.
 *   - A COUNT is not a list. In the picker state the badge's job is "there is
 *     something new SOMEWHERE", because that is what makes a person open the
 *     tab and choose. Scoping it to an org nobody has chosen yet would mean
 *     scoping it to nothing, i.e. never alerting. Same reasoning as the hub's
 *     unscoped dot map (R1: the hub is where organisations are listed).
 *
 * Once a context exists — which, since B-848, is the DEFAULT for anyone with
 * exactly one affiliation — the badge counts that organisation alone, or a
 * member of two companies reads a number that no surface they can open
 * accounts for.
 *
 * The hook mounts React and subscribes to the messenger store; what is pinned
 * here is the pair of scoping helpers it delegates to (behaviourally, against
 * the REAL context store) plus a source scan proving it delegates to both.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));

import {
  activeWorkspaceOrgParam, scopeChannelsToActiveWorkspace, useActiveWorkspace,
} from '@store/activeWorkspace';

const ACME = 'aaaa1111-bbbb-4ccc-8ddd-eeeeffff0001';
const BOREALIS = 'aaaa2222-bbbb-4ccc-8ddd-eeeeffff0002';

const CHANNELS = [
  {id: 'c1', org_id: ACME, group_conversation_id: 'g1'},
  {id: 'c2', org_id: BOREALIS, group_conversation_id: 'g2'},
];

beforeEach(() => { useActiveWorkspace.getState().setActiveWorkspace(null); });
afterEach(() => { useActiveWorkspace.getState().setActiveWorkspace(null); });

describe('with a context, the badge counts ONE organisation', () => {
  it('names the org on the request AND filters what comes back', () => {
    useActiveWorkspace.getState().setActiveWorkspace({org_id: ACME, name: 'Acme', role: 'employee'});
    expect(activeWorkspaceOrgParam()).toEqual({orgId: ACME});
    expect(scopeChannelsToActiveWorkspace(CHANNELS).map(c => c.id)).toEqual(['c1']);
  });
});

describe('with NO context — the picker state — the badge stays cross-org', () => {
  it('asks for everything and filters nothing', () => {
    // A count, not a list: "something new somewhere" is what makes the person
    // open the tab and choose a workspace.
    expect(activeWorkspaceOrgParam()).toBeUndefined();
    expect(scopeChannelsToActiveWorkspace(CHANNELS).map(c => c.id)).toEqual(['c1', 'c2']);
  });
});

describe('useDeptUnread delegates to BOTH halves and re-keys on the org', () => {
  const SRC = readFileSync(
    join(process.cwd(), 'src', 'screens', 'deptchat', 'useDeptUnread.ts'), 'utf8',
  )
    .split(/\r?\n/)
    .filter(l => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

  it('scopes the request and the response', () => {
    // Dropping either one silently widens the badge back to every workspace,
    // and a count is the one surface where that failure is invisible.
    expect(SRC).toMatch(/departmentApi\.listChannels\(activeWorkspaceOrgParam\(\)\)/);
    expect(SRC).toMatch(/scopeChannelsToActiveWorkspace\(/);
  });

  it('refetches when the workspace changes', () => {
    // The helpers read the context non-reactively at call time, so the org id
    // has to appear as an explicit dependency or the badge keeps counting the
    // PREVIOUS workspace after a switch.
    expect(SRC).toMatch(/useActiveWorkspace\(s => s\.workspace\?\.org_id\)/);
    expect(SRC).toMatch(/\[groupConvoSig, activeOrgId\]/);
  });
});
