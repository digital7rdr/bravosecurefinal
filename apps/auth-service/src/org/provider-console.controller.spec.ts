import {ProviderConsoleController} from './provider-console.controller';
import {OrgCpoService} from './org-cpo.service';
import type {DatabaseService} from '../database/database.service';
import type {AccessClaims} from '../auth/jwt.service';

const ME = '33333333-3333-4333-8333-333333333333';
const user = {sub: ME} as AccessClaims;

function controller(rows: unknown[], me: unknown = {id: ME, display_name: 'Sam'}) {
  const db = {qOne: jest.fn().mockResolvedValue(me), q: jest.fn().mockResolvedValue(rows)};
  return {c: new ProviderConsoleController(db as unknown as DatabaseService), db};
}

describe('GET /org/console/context', () => {
  it('an agency owner gets every module', async () => {
    const {c} = controller([{org_id: ME, name: 'Falcon Security', role: 'owner', permitted_modules: null, department: null}]);
    const out = await c.context(user);
    expect(out.orgs).toEqual([{org_id: ME, name: 'Falcon Security', role: 'owner',
      modules: [...OrgCpoService.MANAGER_MODULES], department: null}]);
  });

  it('a manager gets exactly the grant, minus unknown keys', async () => {
    const {c} = controller([{org_id: 'org-1', name: 'Falcon', role: 'manager', permitted_modules: ['jobs', 'bogus'], department: 'Dubai'}]);
    const out = await c.context(user);
    expect(out.orgs[0]).toMatchObject({role: 'manager', modules: ['jobs'], department: 'Dubai'});
  });

  it('a person with no agency gets an empty list, not an error', async () => {
    const {c} = controller([]);
    await expect(c.context(user)).resolves.toEqual({user: {id: ME, display_name: 'Sam', password_temporary: false}, orgs: []});
  });

  it('flags an admin-issued password that was never changed', async () => {
    const {c} = controller([], {id: ME, display_name: 'Sam', password_temporary: true});
    expect((await c.context(user)).user.password_temporary).toBe(true);
  });

  it('only ACTIVE company agents count, so workspaces never appear', async () => {
    const {c, db} = controller([]);
    await c.context(user);
    const sql = db.q.mock.calls[0][0] as string;
    expect(sql.match(/a\.type = 'company' AND a\.status = 'ACTIVE'/g)?.length).toBe(2);
    expect(sql).not.toMatch(/org_workspaces/);
    expect(db.q.mock.calls[0][1]).toEqual([ME]);
  });
});
