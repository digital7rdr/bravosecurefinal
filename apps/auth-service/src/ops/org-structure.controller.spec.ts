import {ForbiddenException} from '@nestjs/common';
import {OrgStructureController} from './org-structure.controller';

/**
 * Departments in the provider console (2026-10-15). The org id always comes
 * from OrgManagerGuard's resolution, never the request; a manager delegated to
 * one department reads the structure but cannot reshape it.
 */
describe('OrgStructureController', () => {
  const svc = {
    structure: jest.fn().mockResolvedValue({channels: []}),
    createNode: jest.fn().mockResolvedValue({node: {id: 'n'}}),
    place: jest.fn().mockResolvedValue({results: []}),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctl = new OrgStructureController(svc as any);
  const owner = {user_id: 'agency-1', org_user_id: 'agency-1', department: null};
  const scoped = {user_id: 'mgr-2', org_user_id: 'agency-1', department: 'Gauteng'};

  beforeEach(() => jest.clearAllMocks());

  it('reads the resolved organisation and says whether the caller may edit', async () => {
    await expect(ctl.get(owner)).resolves.toEqual(expect.objectContaining({can_edit: true}));
    await expect(ctl.get(scoped)).resolves.toEqual(expect.objectContaining({can_edit: false}));
    expect(svc.structure).toHaveBeenCalledWith('agency-1', {user_id: 'mgr-2'});
  });

  it('the owner (or an unscoped manager) writes, named as themselves', async () => {
    await ctl.createNode(owner, {name: 'Gauteng Province'});
    expect(svc.createNode).toHaveBeenCalledWith('agency-1', {user_id: 'agency-1'}, {name: 'Gauteng Province'});
  });

  it('a department-scoped manager cannot reshape the tree or move people', () => {
    expect(() => ctl.createNode(scoped, {name: 'X'})).toThrow(ForbiddenException);
    expect(() => ctl.place(scoped, {user_ids: ['u'], channel_id: null})).toThrow('department_manager_cannot_edit_structure');
    expect(svc.createNode).not.toHaveBeenCalled();
    expect(svc.place).not.toHaveBeenCalled();
  });
});
