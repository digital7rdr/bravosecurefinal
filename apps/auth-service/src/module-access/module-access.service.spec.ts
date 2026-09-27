import {ForbiddenException, BadRequestException} from '@nestjs/common';
import {ModuleAccessService} from './module-access.service';

jest.mock('../auth/account-kind', () => ({resolveAccountKind: jest.fn()}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {resolveAccountKind} = require('../auth/account-kind') as {resolveAccountKind: jest.Mock};

type Row = Record<string, unknown>;
function makeDb(state: {matrix: Row[]; overrides: Row[]; userExists?: boolean}) {
  return {
    q: jest.fn(async (sql: string, params?: unknown[]) => {
      const s = sql.toLowerCase();
      const isSelect = s.trimStart().startsWith('select');
      if (isSelect && s.includes('from public.module_access')) {return state.matrix;}
      if (isSelect && s.includes('from public.user_module_overrides')) {
        return state.overrides.filter(o => o.user_id === (params as string[])[0]);
      }
      if (s.includes('insert into public.module_access')) {
        const [g, k, en] = params as [string, string, boolean];
        state.matrix = state.matrix.filter(r => !(r.account_group === g && r.module_key === k));
        state.matrix.push({account_group: g, module_key: k, enabled: en, updated_at: 'now'});
        return [];
      }
      if (s.includes('insert into public.user_module_overrides')) {
        const [u, k, en] = params as [string, string, boolean];
        state.overrides = state.overrides.filter(r => !(r.user_id === u && r.module_key === k));
        state.overrides.push({user_id: u, module_key: k, enabled: en});
        return [];
      }
      if (s.includes('delete from public.user_module_overrides')) {
        const [u, k] = params as [string, string];
        state.overrides = state.overrides.filter(r => !(r.user_id === u && r.module_key === k));
        return [];
      }
      return [];
    }),
    qOne: jest.fn(async () => (state.userExists === false ? null : {id: 'u1'})),
  };
}
const noRedis = {client: undefined};
const kind = (account_kind: string, extra: Row = {}) => ({account_kind, owns_workspace: false, workspaces: [], ...extra});

describe('ModuleAccessService', () => {
  beforeEach(() => resolveAccountKind.mockReset());

  describe('groupFrom — the same facts /auth/me routes on', () => {
    it.each([
      [kind('cpo'), 'cpo'],
      [kind('agency'), 'agency'],
      [kind('individual', {owns_workspace: true}), 'enterprise'],
      [kind('individual', {workspaces: [{org_user_id: 'o'}]}), 'enterprise'],
      [kind('individual'), 'individual'],
    ])('%j → %s', (k, g) => {
      expect(ModuleAccessService.groupFrom(k as never)).toBe(g);
    });
  });

  it('empty tables disable nothing — exactly the pre-feature behaviour', async () => {
    resolveAccountKind.mockResolvedValue(kind('individual'));
    const svc = new ModuleAccessService(makeDb({matrix: [], overrides: []}) as never, noRedis as never);
    expect(await svc.effective('u1')).toEqual({group: 'individual', disabled: []});
  });

  it('a group switch disables the module for that group only', async () => {
    const db = makeDb({matrix: [{account_group: 'individual', module_key: 'vbg', enabled: false, updated_at: 't'}], overrides: []});
    resolveAccountKind.mockResolvedValue(kind('individual'));
    const svc = new ModuleAccessService(db as never, noRedis as never);
    expect((await svc.effective('u1')).disabled).toEqual(['vbg']);

    resolveAccountKind.mockResolvedValue(kind('individual', {owns_workspace: true}));
    const svc2 = new ModuleAccessService(db as never, noRedis as never);
    expect((await svc2.effective('u2')).disabled).toEqual([]); // enterprise unaffected
  });

  it('a module is NEVER disabled for a group it does not apply to', async () => {
    // A (bogus) row switching a client module off for agencies must not bite.
    const db = makeDb({matrix: [{account_group: 'agency', module_key: 'secure_lite', enabled: false, updated_at: 't'}], overrides: []});
    resolveAccountKind.mockResolvedValue(kind('agency'));
    const svc = new ModuleAccessService(db as never, noRedis as never);
    expect((await svc.effective('u1')).disabled).toEqual([]);
  });

  it('a user override wins over the group, both ways', async () => {
    const db = makeDb({
      matrix: [
        {account_group: 'individual', module_key: 'news', enabled: false, updated_at: 't'},
        {account_group: 'individual', module_key: 'family', enabled: true, updated_at: 't'},
      ],
      overrides: [
        {user_id: 'u1', module_key: 'news', enabled: true},
        {user_id: 'u1', module_key: 'family', enabled: false},
      ],
    });
    resolveAccountKind.mockResolvedValue(kind('individual'));
    const svc = new ModuleAccessService(db as never, noRedis as never);
    expect((await svc.effective('u1')).disabled).toEqual(['family']);
  });

  it('assertEnabled throws 403 module_disabled with a readable message', async () => {
    const db = makeDb({matrix: [{account_group: 'cpo', module_key: 'departmental', enabled: false, updated_at: 't'}], overrides: []});
    resolveAccountKind.mockResolvedValue(kind('cpo'));
    const svc = new ModuleAccessService(db as never, noRedis as never);
    const err = await svc.assertEnabled('u1', 'departmental').catch(e => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({error: 'module_disabled', module: 'departmental'});
    await expect(svc.assertEnabled('u1', 'news')).resolves.toBeUndefined();
  });

  it('FAILS OPEN when the lookup errors — an outage must not lock everyone out', async () => {
    resolveAccountKind.mockRejectedValue(new Error('db down'));
    const svc = new ModuleAccessService(makeDb({matrix: [], overrides: []}) as never, noRedis as never);
    expect(await svc.isEnabled('u1', 'vbg')).toBe(true);
    expect(await svc.effectiveOrNull('u1')).toBeNull();
  });

  it('refuses unknown groups/modules and non-applicable pairs', async () => {
    const svc = new ModuleAccessService(makeDb({matrix: [], overrides: []}) as never, noRedis as never);
    await expect(svc.setGroupModule('corporate', 'vbg', false, 'a')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setGroupModule('individual', 'sos', false, 'a')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setGroupModule('cpo', 'secure_lite', false, 'a')).rejects.toThrow('module_not_applicable');
  });

  it('a group edit takes effect on the next read; an override can be removed with null', async () => {
    const state = {matrix: [] as Row[], overrides: [] as Row[]};
    const db = makeDb(state);
    resolveAccountKind.mockResolvedValue(kind('individual'));
    const svc = new ModuleAccessService(db as never, noRedis as never);
    await svc.setGroupModule('individual', 'vbg', false, 'admin');
    expect((await svc.effective('u1')).disabled).toEqual(['vbg']);
    await svc.setUserOverride('u1', 'vbg', true, 'admin');
    expect((await svc.effective('u1')).disabled).toEqual([]);
    await svc.setUserOverride('u1', 'vbg', null, 'admin');
    expect((await svc.effective('u1')).disabled).toEqual(['vbg']);
  });
});
