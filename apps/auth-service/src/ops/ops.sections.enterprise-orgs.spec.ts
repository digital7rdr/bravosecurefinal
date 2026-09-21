/**
 * Enterprise organisations (the /enterprise/departments list + detail).
 *
 * The console shows one row per ORGANISATION and a detail page per org; before
 * this the page was a flat, cross-tenant channel table. These pins keep the
 * read model honest about the three things that would silently regress into a
 * wrong page rather than a crash:
 *
 *  - the tenant set is the UNION of enterprise-tier users, workspace owners and
 *    channel owners — dropping any one source hides real organisations;
 *  - search and region are BOUND parameters, never interpolated;
 *  - the by-id read is region-scoped exactly like getAgency (AUTH-01), 404s on
 *    an unknown id, and every fan-out query is keyed on the same org id.
 */
import {ForbiddenException, NotFoundException} from '@nestjs/common';
import {OpsSectionsService} from './ops-sections.service';
import type {AdminContext} from './admin.guard';

const GLOBAL: AdminContext = {user_id: 'adm-1', role: 'ADMIN', call_sign: 'OPS-1', region: 'AE'};
const SCOPED: AdminContext = {user_id: 'adm-2', role: 'OPS', call_sign: 'OPS-2', region: 'AE'};

type Cap = {sql: string; params?: unknown[]};

function mk(qOne?: (sql: string) => unknown) {
  const qCalls: Cap[] = [];
  const qOneCalls: Cap[] = [];
  const db = {
    q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qCalls.push({sql, params});
      return Promise.resolve([]);
    }),
    qOne: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qOneCalls.push({sql, params});
      return Promise.resolve(qOne ? qOne(sql) : null);
    }),
  };
  const svc = new OpsSectionsService(db as never);
  return {svc, qCalls, qOneCalls};
}

describe('listEnterpriseOrgs — the tenant set and its parameters', () => {
  it('unions enterprise users, workspace owners and channel owners', async () => {
    const {svc, qCalls} = mk();
    await svc.listEnterpriseOrgs(undefined, 200, GLOBAL);
    const sql = qCalls[0].sql;
    expect(sql).toMatch(/subscription_tier = 'enterprise'/);
    expect(sql).toMatch(/FROM public\.org_workspaces/);
    expect(sql).toMatch(/SELECT DISTINCT org_id FROM public\.department_channels WHERE archived_at IS NULL/);
    expect(sql).toMatch(/JOIN public\.users u ON u\.id = t\.org_id/);
    // Deleted accounts never appear even if they still own rows.
    expect(sql).toMatch(/WHERE u\.deleted_at IS NULL/);
  });

  it('binds the search needle — never interpolates it — and trims it', async () => {
    const {svc, qCalls} = mk();
    await svc.listEnterpriseOrgs("  o'reilly  ", 50, GLOBAL);
    const cap = qCalls[0];
    expect(cap.params).toEqual(["o'reilly", null, 50]);
    expect(cap.sql).not.toMatch(/reilly/);
    expect(cap.sql).toMatch(/\$1::text IS NULL/);
    expect(cap.sql).toMatch(/LIKE '%' \|\| \$1 \|\| '%'/);
    expect(cap.sql).toMatch(/LIMIT \$3/);
  });

  it('escapes LIKE wildcards a user types (B-636 rule), backslash first', async () => {
    const {svc, qCalls} = mk();
    await svc.listEnterpriseOrgs('100%_a\\b', 50, GLOBAL);
    expect(qCalls[0].params?.[0]).toBe('100\\%\\_a\\\\b');
  });

  it('a global admin sees every region; a scoped operator is bound to theirs', async () => {
    const a = mk();
    await a.svc.listEnterpriseOrgs(undefined, 10, GLOBAL);
    expect(a.qCalls[0].params?.[1]).toBeNull();

    const b = mk();
    await b.svc.listEnterpriseOrgs(undefined, 10, SCOPED);
    expect(b.qCalls[0].params?.[1]).toBe('AE');
    // Orgs with no recorded region stay visible to everyone (fail-open on a
    // missing profile field, same as getAgency's `if (home_region)` guard).
    expect(b.qCalls[0].sql).toMatch(/u\.home_region IS NULL OR u\.home_region = \$2/);
  });
});

describe('getEnterpriseOrg — the by-id read', () => {
  it('404s on an unknown or deleted organisation', async () => {
    const {svc} = mk(() => null);
    await expect(svc.getEnterpriseOrg('11111111-1111-1111-1111-111111111111', GLOBAL))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a region-scoped operator another region by UUID (AUTH-01)', async () => {
    const {svc, qCalls} = mk(() => ({id: 'org-1', home_region: 'SA'}));
    await expect(svc.getEnterpriseOrg('org-1', SCOPED)).rejects.toBeInstanceOf(ForbiddenException);
    // The refusal happens BEFORE any fan-out — nothing about the org leaked.
    expect(qCalls).toHaveLength(0);
  });

  it('keys every fan-out query on the same org id and folds attendance corrections', async () => {
    const {svc, qCalls, qOneCalls} = mk(sql =>
      /FROM tenants t/.test(sql) ? {id: 'org-1', home_region: 'AE', display_name: 'Acme'} : null);
    const out = await svc.getEnterpriseOrg('org-1', GLOBAL);

    // The head row is bound by id, not by anything an operator typed.
    expect(qOneCalls[0].params).toEqual(['org-1']);
    expect(qOneCalls[0].sql).toMatch(/WHERE u\.id = \$1 AND u\.deleted_at IS NULL/);

    const everything = [...qCalls, ...qOneCalls.slice(1)];
    expect(everything.length).toBeGreaterThanOrEqual(8);
    for (const c of everything) expect(c.params).toEqual(['org-1']);

    const channels = qCalls.find(c => /FROM public\.department_channels c/.test(c.sql))!;
    // The graph needs hierarchy AND policy fields; archived rows stay out.
    for (const col of ['c.parent_id', 'c.level', 'c.is_broadcast', 'c.is_lateral', 'c.post_mode', 'c.access']) {
      expect(channels.sql).toContain(col);
    }
    expect(channels.sql).toMatch(/c\.org_id = \$1 AND c\.archived_at IS NULL/);

    const attendance = qCalls.find(c => /FROM public\.cpo_shift_sessions ses/.test(c.sql) && /GROUP BY 1/.test(c.sql))!;
    // The fold is the SAME expression the attendance page uses
    // (AttendanceService.effectiveField), so a corrected session moves bucket here too.
    expect(attendance.sql).toMatch(/attendance_corrections/);
    expect(attendance.sql).toMatch(/interval '30 days'/);

    // Response shape the console types against.
    expect(Object.keys(out).sort()).toEqual(
      ['activity', 'attendance_30d', 'channels', 'incidents', 'invites', 'join_requests', 'members', 'org'].sort());
    expect(out.attendance_30d).toEqual({counts: {}, total: 0, pending_review: 0, shifts_upcoming: 0, sessions_open: 0});
  });

  it('never selects message content or group key material', async () => {
    const {svc, qCalls, qOneCalls} = mk(sql =>
      /FROM tenants t/.test(sql) ? {id: 'org-1', home_region: null} : null);
    await svc.getEnterpriseOrg('org-1', GLOBAL);
    for (const c of [...qCalls, ...qOneCalls]) {
      expect(c.sql).not.toMatch(/group_conversation_id(?! IS NOT NULL)/);
      expect(c.sql).not.toMatch(/\bmessages\b|\bciphertext\b|master_key|sender_key/i);
    }
  });
});
