/**
 * Provider console — Job Portal, Compliance and Region (2026-10-31, owner:
 * "the Service provider, agent web portal should have the same functions as
 * the Mobile app"). Pins the server routes each page calls, who they act for,
 * the claim's per-tap idempotency key, the multipart upload, and the module
 * gates.
 */

import fs from 'fs';
import path from 'path';

const get = jest.fn((..._a: unknown[]) => Promise.resolve({}));
const send = jest.fn((..._a: unknown[]) => Promise.resolve({}));
let keySeq = 0;
class FakeApiError extends Error {
  constructor(public status: number, public body: unknown, message: string) { super(message); }
}

// Not hoisted (jest.doMock), so the factory can use the fakes above.
jest.doMock('@/lib/provider/api', () => ({
  get: (...a: unknown[]) => get(...a),
  send: (...a: unknown[]) => send(...a),
  useOrgSWR: jest.fn(),
  actionKey: (prefix: string) => `${prefix}-k${++keySeq}`,
  readPvCsrf: () => 'csrf-123',
  ApiError: FakeApiError,
}));

/* eslint-disable @typescript-eslint/no-require-imports -- must load after doMock */
const {
  REGIONS, REGION_NONE, actsAsAgency, agencyApi, agencyErrorText, claimErrorText, jobAvailability,
  managerRegionTarget, regionForPoint, uploadFile, uploadProblem,
} = require('../lib/provider/api-agency') as typeof import('../lib/provider/api-agency');
/* eslint-enable @typescript-eslint/no-require-imports */

const SRC = path.join(__dirname, '..');
const ROOT = path.join(SRC, '..', '..', '..');
const read = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf8');
const server = (p: string) => fs.readFileSync(path.join(ROOT, 'apps', 'auth-service', 'src', p), 'utf8');

beforeEach(() => { get.mockClear(); send.mockClear(); });

describe('agency API paths match the app and the server', () => {
  it('lists open jobs, with the region only when one is chosen', async () => {
    await agencyApi.openJobs('ALL');
    await agencyApi.openJobs('AE');
    await agencyApi.openJobs();
    expect(get.mock.calls.map(c => c[0])).toEqual([
      '/agents/me/open-jobs', '/agents/me/open-jobs?region=AE', '/agents/me/open-jobs',
    ]);
  });

  it('claims with a fresh Idempotency-Key per tap (a relisted job must not replay an old success)', async () => {
    await agencyApi.claimOpenJob('b-1');
    await agencyApi.claimOpenJob('b-1');
    const [a, b] = send.mock.calls;
    expect(a.slice(0, 3)).toEqual(['POST', '/dispatch/open-jobs/b-1/claim', undefined]);
    expect(a[3]).toMatch(/^claim-b-1-/);
    expect(b[3]).toMatch(/^claim-b-1-/);
    expect(a[3]).not.toBe(b[3]);
  });

  it('agency profile, compliance and me', async () => {
    await agencyApi.setAgencyProfile({region_code: 'AE', dpa_accepted: false});
    await agencyApi.submitCompliance({doc_type: 'licence', region_code: 'AE', expires_at: '2030-01-01T00:00:00Z', file_url: 'u'});
    await agencyApi.complianceDocs();
    await agencyApi.me();
    expect(send.mock.calls[0]).toEqual(['PATCH', '/agents/me/agency-profile', {dpa_version: 'v1', region_code: 'AE', dpa_accepted: false}]);
    expect(send.mock.calls[1].slice(0, 2)).toEqual(['POST', '/compliance']);
    expect(get.mock.calls.map(c => c[0])).toEqual(['/compliance/me', '/agents/me']);
  });

  it('uploads as multipart with the cookie session and CSRF, never a JSON content type', async () => {
    const fetchMock = jest.fn(async () => ({ok: true, status: 200, statusText: 'OK',
      text: async () => JSON.stringify({file_url: 'https://api/uploads/u1/x.pdf'})}));
    (global as unknown as {fetch: unknown}).fetch = fetchMock;
    const file = new Blob(['%PDF'], {type: 'application/pdf'}) as Blob & {name?: string};
    file.name = 'licence.pdf';
    await expect(uploadFile(file)).resolves.toBe('https://api/uploads/u1/x.pdf');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/agents\/me\/upload$/);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('file')).toBeTruthy();
    expect(init.headers).toEqual({'X-CSRF-Token': 'csrf-123'});
  });

  it('an upload failure surfaces the server code', async () => {
    (global as unknown as {fetch: unknown}).fetch = jest.fn(async () => ({ok: false, status: 413, statusText: 'Payload Too Large',
      text: async () => JSON.stringify({message: 'File too large'})}));
    const err = await uploadFile(new Blob(['x'])).catch(e => e);
    expect(err).toBeInstanceOf(FakeApiError);
    expect(agencyErrorText(err)).toMatch(/25 MB/);
  });
});

describe('server routes the pages rely on', () => {
  const agent = server('agents/agent.controller.ts');
  const jobs = server('dispatch/dispatch-jobs.controller.ts');
  const compliance = server('compliance/compliance.controller.ts');

  it('exist with the expected verbs', () => {
    expect(agent).toMatch(/@Get\('me'\)/);
    expect(agent).toMatch(/@Get\('me\/open-jobs'\)/);
    expect(agent).toMatch(/@Patch\('me\/agency-profile'\)/);
    expect(agent).toMatch(/@Post\('me\/upload'\)\s*\n\s*@UseInterceptors\(FileInterceptor\('file'/);
    expect(compliance).toMatch(/@Get\('me'\)/);
    expect(compliance).toMatch(/@Post\(\)/);
  });

  it('the claim is org-scoped, idempotent and open to managers granted portal or jobs', () => {
    expect(jobs).toMatch(/@UseGuards\(JwtAuthGuard, CsrfGuard, OrgManagerGuard/);
    const claim = jobs.slice(jobs.indexOf("@Post('open-jobs/:bookingId/claim')") - 300, jobs.indexOf("@Post('open-jobs/:bookingId/claim')"));
    expect(claim).toMatch(/IdempotencyInterceptor/);
    expect(claim).toMatch(/@OrgModules\('portal', 'jobs'\)/);
  });

  it('the region list is the server one', () => {
    const regions = server('common/regions.ts');
    const block = regions.slice(regions.indexOf('DEFAULT_REGIONS'), regions.indexOf('];', regions.indexOf('DEFAULT_REGIONS')));
    const codes = [...block.matchAll(/code: '([A-Z]{2})'/g)].map(m => m[1]);
    expect(REGIONS.map(r => r.code)).toEqual(codes);
  });
});

describe('who the caller-scoped routes act for', () => {
  const ctx = (orgs: Array<{org_id: string; role: 'owner' | 'manager'}>) => ({
    user: {id: 'me', display_name: null},
    orgs: orgs.map(o => ({...o, name: '', modules: [], department: null})),
  });

  it('only the owner account is the agency', () => {
    expect(actsAsAgency(ctx([{org_id: 'me', role: 'owner'}]), 'me')).toBe(true);
    expect(actsAsAgency(ctx([{org_id: 'org1', role: 'manager'}]), 'org1')).toBe(false);
    expect(actsAsAgency(ctx([{org_id: 'me', role: 'owner'}, {org_id: 'org1', role: 'manager'}]), 'org1')).toBe(false);
  });

  it('a manager may set the region only when they run exactly one agency', () => {
    expect(managerRegionTarget(ctx([{org_id: 'org1', role: 'manager'}]), 'org1')).toBe(true);
    expect(managerRegionTarget(ctx([{org_id: 'org1', role: 'manager'}, {org_id: 'org2', role: 'manager'}]), 'org2')).toBe(false);
    expect(managerRegionTarget(ctx([{org_id: 'me', role: 'owner'}, {org_id: 'org1', role: 'manager'}]), 'org1')).toBe(false);
  });
});

describe('page rules', () => {
  it('job availability mirrors the app card', () => {
    expect(jobAvailability({status: 'OPS_APPROVED', dispatch_mode: 'auto'})).toBe('claimable');
    expect(jobAvailability({status: 'DISPATCHING'})).toBe('claimable');
    expect(jobAvailability({status: 'PENDING_OPS', dispatch_mode: 'auto'})).toBe('awaiting_approval');
    expect(jobAvailability({status: 'OPS_APPROVED', dispatch_mode: 'manual'})).toBe('assigned_by_bravo');
  });

  it('claim errors read in plain English', () => {
    const e = (message: string, status = 409) => new FakeApiError(status, {message}, message);
    expect(claimErrorText(e('job_taken'))).toMatch(/Another agency took this job/);
    expect(claimErrorText(e('provider_not_eligible', 403))).toMatch(/not verified/);
    expect(agencyErrorText(e('provider_only', 403))).toMatch(/owner/);
  });

  it('region from a location: country first, box as the fallback', () => {
    expect(regionForPoint('ae', 0, 0)).toBe('AE');
    expect(regionForPoint('FR', 48.8, 2.3)).toBe(REGION_NONE);
    expect(regionForPoint(null, 25.2, 55.3)).toBe('AE');      // Dubai
    expect(regionForPoint(null, 24.7, 46.7)).toBe('SA');      // Riyadh
    expect(regionForPoint(null, 40.7, -74)).toBe(REGION_NONE); // New York
  });

  it('upload checks', () => {
    expect(uploadProblem(null)).toMatch(/Attach/);
    expect(uploadProblem({type: 'application/zip', size: 10})).toMatch(/photo/);
    expect(uploadProblem({type: 'application/pdf', size: 26 * 1024 * 1024})).toMatch(/25 MB/);
    expect(uploadProblem({type: 'image/png', size: 10})).toBeNull();
  });
});

describe('pages', () => {
  const pages = {
    portal: read('app/provider/(app)/portal/page.tsx'),
    compliance: read('app/provider/(app)/compliance/page.tsx'),
    region: read('app/provider/(app)/region/page.tsx'),
  };

  it('each page is gated on its own module with NotGranted', () => {
    for (const [mod, code] of Object.entries(pages)) {
      expect([mod, code.includes(`can('${mod}')`)]).toEqual([mod, true]);
      expect([mod, /if \(!granted\) return <PvPage[^>]*><NotGranted/.test(code)]).toEqual([mod, true]);
      expect(code.startsWith("'use client';")).toBe(true);
    }
  });

  it('caller-scoped reads only run for the owner account', () => {
    expect(pages.portal).toMatch(/const on = granted && self;/);
    expect(pages.portal).toMatch(/useOpenJobs\(orgId, region, on\)/);
    expect(pages.compliance).toMatch(/useComplianceDocs\(orgId, on\)/);
    expect(pages.region).toMatch(/useAgentMe\(orgId, granted && self\)/);
  });

  it('the portal asks before accepting; the region change checks the location first', () => {
    expect(pages.portal).toMatch(/<ConfirmDialog[\s\S]*Accept this job\?/);
    expect(pages.region).toMatch(/const here = await detect\(\);[\s\S]*if \(here !== code\)/);
  });

  it('use plain words on screen', () => {
    for (const code of Object.values(pages)) {
      const jsxText = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(jsxText).not.toMatch(/\bLite\b/);
      expect(jsxText).not.toMatch(/\bCPOs?\b/);
      expect(jsxText).not.toMatch(/\bops\b/i);
    }
  });
});
