import 'reflect-metadata';
import {BadRequestException, NotFoundException} from '@nestjs/common';
import {OpsDataService} from './ops-data.service';
import {OpsDataController} from './ops-data.controller';
import {OrgController} from '../org/org.controller';
import {OrgInviteController} from '../org/org-invite.controller';
import {REQUIRED_ROLES_KEY} from './admin.guard';
import {PATH_METADATA} from '@nestjs/common/constants';
import {MAX_OPEN_INVITES} from '../org/invite-code';

/**
 * B-812 — the ops-console half of roster invitation codes, plus the route
 * facts that make the whole feature safe: minting is SUPERVISOR+ on the
 * console, sits behind OrgManagerGuard in the agency app, and the joiner's
 * redeem route (JwtAuthGuard only, now per-user throttled) never grew a mint
 * sibling.
 */
function mk() {
  const q = jest.fn().mockResolvedValue([]);
  const qOne = jest.fn();
  const svc = new OpsDataService({q, qOne} as never);
  return {svc, q, qOne};
}
/** qOne router: agents type → open count → INSERT / UPDATE. */
function route(qOne: jest.Mock, opts: {type?: string | null; open?: number; insert?: (p: unknown[]) => unknown; update?: unknown}) {
  qOne.mockImplementation(async (sql: string, params: unknown[]) => {
    if (/SELECT type FROM public\.agents/.test(sql)) {return opts.type === null ? null : {type: opts.type ?? 'company'};}
    if (/count\(\*\)::text AS n/.test(sql)) {return {n: String(opts.open ?? 0)};}
    if (/INSERT INTO provider_invite_codes/.test(sql)) {
      return opts.insert ? opts.insert(params) : {id: 'row-1', code: params[0], call_sign: params[3], expires_at: new Date('2026-09-13T00:00:00Z'), created_at: new Date()};
    }
    if (/UPDATE provider_invite_codes/.test(sql)) {return 'update' in opts ? opts.update : null;}
    return null;
  });
}

describe('OpsDataService — provider invitation codes', () => {
  it('list: a non-company user answers provider:false with no rows (the card hides itself)', async () => {
    const {svc, qOne, q} = mk();
    route(qOne, {type: 'cpo'});
    await expect(svc.listProviderInvites('u1')).resolves.toEqual({provider: false, invites: []});
    expect(q).not.toHaveBeenCalled();
    route(qOne, {type: null});
    await expect(svc.listProviderInvites('u2')).resolves.toEqual({provider: false, invites: []});
  });

  it('list: a company account gets its codes with statuses and who minted / redeemed them', async () => {
    const {svc, qOne, q} = mk();
    route(qOne, {});
    q.mockResolvedValueOnce([{code: 'BRAVO-AAAAAA', member_role: 'cpo', call_sign: null, expires_at: null, created_at: new Date(), redeemed_at: null, revoked_at: new Date(), redeemed_by_name: null, created_by_name: 'OPS-1'}]);
    const out = await svc.listProviderInvites('org-1');
    expect(out.provider).toBe(true);
    expect(out.invites[0]).toMatchObject({code: 'BRAVO-AAAAAA', status: 'revoked', created_by_name: 'OPS-1'});
    expect(String(q.mock.calls[0][0])).toMatch(/WHERE i\.org_user_id = \$1/);
  });

  it('mint: refuses a non-provider target (a code for a CPO would seed a roster nobody owns) and 404s an unknown one', async () => {
    const {svc, qOne} = mk();
    route(qOne, {type: 'cpo'});
    await expect(svc.mintProviderInvite('adm', 'u1', {})).rejects.toBeInstanceOf(BadRequestException);
    route(qOne, {type: null});
    await expect(svc.mintProviderInvite('adm', 'u2', {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('mint: inserts for the company with the admin as created_by, defaults applied, and returns the row id for the audit', async () => {
    const {svc, qOne} = mk();
    route(qOne, {});
    const r = await svc.mintProviderInvite('adm-1', 'org-1', {call_sign: 'r9'});
    expect(r.code).toMatch(/^BRAVO-[A-HJ-NP-Z2-9]{6}$/);
    expect(r).toMatchObject({id: 'row-1', call_sign: 'R9'});
    const ins = qOne.mock.calls.find(c => /INSERT INTO provider_invite_codes/.test(String(c[0]))) as [string, unknown[]];
    expect(ins[0]).toMatch(/RETURNING id, code/);
    expect(ins[1].slice(1)).toEqual(['org-1', 'cpo', 'R9', '7', 'adm-1']);
  });

  it('mint: caps OPEN codes per provider', async () => {
    const {svc, qOne} = mk();
    route(qOne, {open: MAX_OPEN_INVITES});
    await expect(svc.mintProviderInvite('adm-1', 'org-1', {})).rejects.toBeInstanceOf(BadRequestException);
    expect(qOne.mock.calls.find(c => /INSERT INTO/.test(String(c[0])))).toBeUndefined();
  });

  it('revoke: conditional on the provider + open code, returns the row id', async () => {
    const {svc, qOne} = mk();
    route(qOne, {update: {id: 'row-7', code: 'BRAVO-AAAAAA'}});
    await expect(svc.revokeProviderInvite('org-1', 'bravo-aaaaaa')).resolves.toEqual({ok: true, id: 'row-7', code: 'BRAVO-AAAAAA'});
    const upd = qOne.mock.calls.find(c => /UPDATE provider_invite_codes/.test(String(c[0]))) as [string, unknown[]];
    expect(upd[0]).toMatch(/redeemed_at IS NULL AND revoked_at IS NULL/);
    expect(upd[1]).toEqual(['org-1', 'BRAVO-AAAAAA']);
    route(qOne, {update: null});
    await expect(svc.revokeProviderInvite('org-1', 'BRAVO-ZZZZZZ')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('B-812 route facts', () => {
  const roles = (ctrl: object, name: string) =>
    Reflect.getMetadata(REQUIRED_ROLES_KEY, (ctrl as Record<string, object>)[name]) as unknown;
  const path = (ctrl: object, name: string) =>
    Reflect.getMetadata(PATH_METADATA, (ctrl as Record<string, object>)[name]) as unknown;

  it('the three console routes are SUPERVISOR+', () => {
    for (const m of ['listProviderInvites', 'mintProviderInvite', 'revokeProviderInvite']) {
      expect(roles(OpsDataController.prototype, m)).toEqual(['SUPERVISOR', 'ADMIN']);
    }
    expect(path(OpsDataController.prototype, 'mintProviderInvite')).toBe('users/:id/provider-invites');
    expect(path(OpsDataController.prototype, 'revokeProviderInvite')).toBe('users/:id/provider-invites/:code/revoke');
  });

  it('the agency mint/list/revoke live on OrgController (OrgManagerGuard); the joiner controller still only redeems, per-user throttled', () => {
    expect(path(OrgController.prototype, 'mintInvite')).toBe('invites');
    expect(path(OrgController.prototype, 'listInvites')).toBe('invites');
    expect(path(OrgController.prototype, 'revokeInvite')).toBe('invites/:code/revoke');
    const joiner = Object.getOwnPropertyNames(OrgInviteController.prototype).filter(n => n !== 'constructor');
    expect(joiner).toEqual(['redeem']);
    // @Throttle({default:{limit:10, ttl:60_000}}) on redeem (nestjs/throttler metadata key).
    const redeem = (OrgInviteController.prototype as unknown as Record<string, object>).redeem;
    const keys = Reflect.getMetadataKeys(redeem).map(String);
    expect(keys.some(k => /THROTTLER:LIMIT|THROTTLER:TTL|THROTTLER/.test(k))).toBe(true);
  });
});
