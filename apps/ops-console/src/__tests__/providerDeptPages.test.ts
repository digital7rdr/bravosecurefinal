/**
 * Provider console — Departmental pages (attendance, incidents, join
 * requests), 2026-10-31. Owner: "The Service provider, agent web portal should
 * have the same functions as the Mobile app."
 *
 * Pins the server paths each call hits (the same routes the app's
 * attendanceApi / incidentApi / enterpriseApi use), the review and decision
 * bodies, the page gate on the 'dept' module, and that incident evidence is
 * never fetched or decrypted on the web.
 */

import fs from 'fs';
import path from 'path';
import {
  correctionAfter, dayWindow, deptError, deptErrorText, incidentFrom, incidentNextSteps, canAssignIncident,
  isDeptKey, placeLabel, pvAttendanceApi, pvIncidentApi, pvJoinApi, qs,
} from '../lib/provider/api-dept';
import {setCurrentOrg} from '../lib/provider/api';
import {PROVIDER_NAV} from '../lib/provider/nav';
import {pvRoutes} from '../lib/provider/routes';

const SRC = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const PAGES = {
  attendance: 'app/provider/(app)/attendance/page.tsx',
  incidents: 'app/provider/(app)/incidents/page.tsx',
  incident: 'app/provider/(app)/incidents/[id]/page.tsx',
  approvals: 'app/provider/(app)/approvals/page.tsx',
};

/* ── Transport capture ───────────────────────────────────────────────── */

type Call = {url: string; method: string; body: unknown; headers: Record<string, string>};
let calls: Call[] = [];
const realFetch = global.fetch;
const ORG = '11111111-2222-4333-8444-555555555555';

beforeAll(() => {
  // pv() keeps the agency in module state; the localStorage write is try/caught.
  (global as unknown as {window: unknown}).window = {localStorage: {setItem() {}, removeItem() {}, getItem: () => null}};
  setCurrentOrg(ORG);
});
afterAll(() => {
  global.fetch = realFetch;
  delete (global as unknown as {window?: unknown}).window;
});
beforeEach(() => {
  calls = [];
  global.fetch = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url).replace(/^https?:\/\/[^/]+/, ''),
      method: (init?.method ?? 'GET').toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: init?.headers as Record<string, string>,
    });
    return {ok: true, status: 200, text: async () => '{}'} as unknown as Response;
  }) as unknown as typeof fetch;
});

const last = () => calls[calls.length - 1];

describe('Departmental API paths (same routes as the app)', () => {
  it('attendance reads', async () => {
    await pvAttendanceApi.summary({from: '2026-10-31T00:00:00.000Z', department: 'North'});
    expect(last()).toMatchObject({method: 'GET', url: '/attendance/org/summary?from=2026-10-31T00%3A00%3A00.000Z&department=North'});
    await pvAttendanceApi.pending();
    expect(last()).toMatchObject({method: 'GET', url: '/attendance/org/pending'});
    await pvAttendanceApi.day({status: 'late', from: 'a', to: 'b'});
    expect(last().url).toBe('/attendance/org/day?status=late&from=a&to=b');
    await pvAttendanceApi.shifts();
    expect(last().url).toBe('/attendance/shifts');
    await pvAttendanceApi.sessions();
    expect(last().url).toBe('/attendance/org/sessions');
    await pvAttendanceApi.photo('s1');
    expect(last()).toMatchObject({method: 'GET', url: '/attendance/sessions/s1/photo'});
    await pvAttendanceApi.corrections('s1');
    expect(last().url).toBe('/attendance/roster/corrections/s1');
  });

  it('every call carries the agency and the provider credentials', async () => {
    await pvAttendanceApi.pending();
    expect(last().headers['X-Org-Context']).toBe(ORG);
    expect((global.fetch as jest.Mock).mock.calls[0][1]).toMatchObject({credentials: 'include'});
  });

  it('review: PATCH with the decision; notes trimmed, and left out when empty (server wants 1–500 chars)', async () => {
    await pvAttendanceApi.review('s1', 'approve', '   ');
    expect(last()).toEqual(expect.objectContaining({method: 'PATCH', url: '/attendance/sessions/s1/review', body: {decision: 'approve'}}));
    await pvAttendanceApi.review('s1', 'reject', '  wrong site ');
    expect(last().body).toEqual({decision: 'reject', notes: 'wrong site'});
  });

  it('corrections: POST to the append-only roster route', async () => {
    await pvAttendanceApi.recordCorrection({session_id: 's1', reason: 'Forgot to check out', after: {clock_out_at: 'x'}});
    expect(last()).toEqual(expect.objectContaining({
      method: 'POST', url: '/attendance/roster/corrections',
      body: {session_id: 's1', reason: 'Forgot to check out', after: {clock_out_at: 'x'}},
    }));
  });

  it('incidents', async () => {
    await pvIncidentApi.queue({severity: 'high', status: undefined, department: 'North'});
    expect(last().url).toBe('/incidents/queue?severity=high&department=North');
    await pvIncidentApi.detail('i1');
    expect(last()).toMatchObject({method: 'GET', url: '/incidents/i1'});
    await pvIncidentApi.updateStatus('i1', 'received');
    expect(last()).toEqual(expect.objectContaining({method: 'PATCH', url: '/incidents/i1/status', body: {to: 'received'}}));
    await pvIncidentApi.updateStatus('i1', 'resolved', ' done ');
    expect(last().body).toEqual({to: 'resolved', note: 'done'});
    await pvIncidentApi.assign('i1', 'u2');
    expect(last()).toEqual(expect.objectContaining({method: 'POST', url: '/incidents/i1/assign', body: {assignee_user_id: 'u2'}}));
    await pvIncidentApi.addNote('i1', 'checked CCTV');
    expect(last()).toEqual(expect.objectContaining({method: 'POST', url: '/incidents/i1/note', body: {note: 'checked CCTV', internal: true}}));
    await pvIncidentApi.attachments('i1');
    expect(last().url).toBe('/incidents/i1/attachments');
  });

  it('join requests and invites', async () => {
    await pvJoinApi.requests();
    expect(last().url).toBe('/enterprise/join-requests');
    await pvJoinApi.approve('r1');
    expect(last()).toMatchObject({method: 'POST', url: '/enterprise/join-requests/r1/approve'});
    await pvJoinApi.decline('r1');
    expect(last()).toMatchObject({method: 'POST', url: '/enterprise/join-requests/r1/decline'});
    await pvJoinApi.invites();
    expect(last().url).toBe('/enterprise/invites');
    await pvJoinApi.revokeInvite('AB C');
    expect(last()).toMatchObject({method: 'POST', url: '/enterprise/invites/AB%20C/revoke'});
  });

  it('qs drops empty values', () => {
    expect(qs({a: '', b: undefined, c: null})).toBe('');
    expect(qs({a: '1', b: 'x y'})).toBe('?a=1&b=x%20y');
  });
});

describe('page gate and rail', () => {
  it('each page is gated on the dept module and shows NotGranted otherwise', () => {
    for (const p of Object.values(PAGES)) {
      const code = stripComments(read(p));
      expect([p, /can\('dept'\)/.test(code)]).toEqual([p, true]);
      expect([p, /<NotGranted what="Departmental"\/>/.test(code)]).toEqual([p, true]);
      expect([p, code.startsWith("'use client'")]).toEqual([p, true]);
      // Provider session only: never the ops client.
      expect([p, /from '@\/lib\/api'/.test(code)]).toEqual([p, false]);
    }
  });

  it('the rail links each page under the dept module', () => {
    const items = PROVIDER_NAV.flatMap(g => g.items);
    for (const href of [pvRoutes.attendance, pvRoutes.incidents, pvRoutes.approvals]) {
      expect(items.find(i => i.href === href)?.modules).toEqual(['dept']);
    }
  });

  it('the review queue offers approve and reject, both through the review call', () => {
    const code = stripComments(read(PAGES.attendance));
    expect(code).toMatch(/decision: 'approve'/);
    expect(code).toMatch(/decision: 'reject'/);
    expect(code).toMatch(/pvAttendanceApi\.review\(/);
    expect(code).toMatch(/pvAttendanceApi\.recordCorrection\(/);
  });

  it('join requests use the two separate decision routes behind a confirm', () => {
    const code = stripComments(read(PAGES.approvals));
    expect(code).toMatch(/pvJoinApi\.approve\(/);
    expect(code).toMatch(/pvJoinApi\.decline\(/);
    expect(code).toMatch(/pvJoinApi\.revokeInvite\(/);
    expect(code).toMatch(/<ConfirmDialog/);
  });

  it('incident evidence is counted, never fetched or decrypted on the web', () => {
    const all = Object.values(PAGES).map(read).join('\n') + read('lib/provider/api-dept.ts');
    expect(stripComments(all)).not.toMatch(/\/key\b|attachments\/\$\{[^}]+\}\/key|getAttachmentKey|storage_key\}/);
    expect(read(PAGES.incident)).toMatch(/open this incident in the Bravo Secure app/);
  });
});

describe('behaviour', () => {
  it('a manager cannot be offered reopening a closed incident; the owner can', () => {
    expect(incidentNextSteps('closed', false)).toEqual([]);
    expect(incidentNextSteps('closed', true)).toEqual(['under_review']);
    expect(incidentNextSteps('resolved', false)).toEqual(['closed', 'under_review']);
    expect(incidentNextSteps('submitted', false)).toEqual(['received']);
    expect(canAssignIncident('action_assigned')).toBe(true);
    expect(canAssignIncident('resolved')).toBe(false);
    expect(canAssignIncident('closed')).toBe(false);
  });

  it('dayWindow spans local midnights; "all" is unbounded', () => {
    const now = new Date(2026, 9, 31, 15, 30);
    const w = dayWindow('7d', now);
    expect(new Date(w.from!).getDate()).toBe(25);
    expect(new Date(w.from!).getHours()).toBe(0);
    expect(new Date(w.to!).getDate()).toBe(1);
    expect(dayWindow('all', now)).toEqual({});
    expect(incidentFrom('all')).toBeUndefined();
    expect(incidentFrom('7d', Date.UTC(2026, 9, 31))).toBe(new Date(Date.UTC(2026, 9, 24)).toISOString());
  });

  it('correctionAfter sends only what changed and rolls an overnight check-out to the next day', () => {
    const inAt = new Date(2026, 9, 30, 22, 0).toISOString();
    const outAt = new Date(2026, 9, 31, 6, 0).toISOString();
    const s = {attendance_status: 'late' as const, clock_in_at: inAt, clock_out_at: outAt};
    expect(correctionAfter(s, {status: 'late', inTime: '22:00', outTime: '06:00'})).toEqual({});
    expect(correctionAfter(s, {status: 'present', inTime: '', outTime: ''})).toEqual({attendance_status: 'present'});
    const after = correctionAfter(s, {status: '', inTime: '', outTime: '05:30'});
    const out = new Date(after.clock_out_at as string);
    expect([out.getDate(), out.getHours(), out.getMinutes()]).toEqual([31, 5, 30]);
    expect(correctionAfter(s, {status: '', inTime: '9:00', outTime: ''})).toEqual({});
  });

  it('placeLabel never shows a blank or a 0,0 fix', () => {
    expect(placeLabel({clock_in_place: ' Gate 2 ', clock_in_lat: 1, clock_in_lng: 2, site_label: null})).toBe('Gate 2');
    expect(placeLabel({clock_in_place: null, clock_in_lat: 25.2, clock_in_lng: 55.3, site_label: null})).toBe('25.20000, 55.30000');
    expect(placeLabel({clock_in_place: null, clock_in_lat: 0, clock_in_lng: 0, site_label: 'HQ'})).toBe('HQ');
    expect(placeLabel({clock_in_place: null, clock_in_lat: null, clock_in_lng: null, site_label: null})).toBe('Location not recorded');
  });

  it('server codes read as plain English', () => {
    const err = (status: number, message?: string) => ({status, body: message ? {message} : null, message: message ?? ''});
    expect(deptErrorText(err(409, 'join_request_already_decided'))).toMatch(/already approved or declined/);
    expect(deptErrorText(err(403, 'invalid_incident_transition:closed->under_review:manager'))).toBe('Only the agency owner can reopen a closed incident.');
    expect(deptErrorText(err(404, 'Not Found'))).toBe('This is not switched on for your agency yet.');
    expect(deptErrorText(err(400, 'not_pending_review'))).toBe('This check-in has already been reviewed.');
    expect(deptErrorText(err(403, 'org_module_not_granted:dept'))).toBe('Your agency owner has not given you access to this.');
    const thrown = deptError(err(409, 'invite_already_accepted'));
    expect((thrown as unknown as {body: {message: string}}).body.message).toMatch(/already joined/);
  });

  it('refreshes only Departmental keys', () => {
    expect(isDeptKey(['pv', ORG, 'dept:att:pending:'])).toBe(true);
    expect(isDeptKey(['pv', ORG, 'roster'])).toBe(false);
    expect(isDeptKey('dept:x')).toBe(false);
  });
});
