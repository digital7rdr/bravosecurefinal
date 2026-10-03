/**
 * Service provider console (provider.* host) — pins.
 *
 * One Next.js app serves both consoles. These tests keep the two apart:
 * host detection, the internal /provider route group never served directly,
 * provider pages never using the ops API client (whose cookies and CSRF are
 * the ops session's), and the module gates the rail relies on.
 */

import fs from 'fs';
import path from 'path';
import {
  isInternalProviderPath, isProviderHost, toInternalProviderPath, PROVIDER_PUBLIC_PATHS,
} from '../lib/provider/host';
import {missionState, productOf, errorText, CONSOLE_MODULES} from '../lib/provider/labels';
import {PROVIDER_NAV, navActive} from '../lib/provider/nav';

const SRC = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []);
}

describe('provider host routing', () => {
  it('detects the provider host with or without a port', () => {
    expect(isProviderHost('provider.bravosecure.cloud')).toBe(true);
    expect(isProviderHost('PROVIDER.bravosecure.cloud:443')).toBe(true);
    expect(isProviderHost('provider.localhost:3033')).toBe(true);
    expect(isProviderHost('ops.bravosecure.cloud')).toBe(false);
    expect(isProviderHost('api.ops.bravosecure.cloud')).toBe(false);
    expect(isProviderHost('notprovider.bravosecure.cloud')).toBe(false);
    expect(isProviderHost(null)).toBe(false);
  });

  it('maps clean paths onto the internal route group', () => {
    expect(toInternalProviderPath('/')).toBe('/provider');
    expect(toInternalProviderPath('/jobs/abc')).toBe('/provider/jobs/abc');
    expect(isInternalProviderPath('/provider')).toBe(true);
    expect(isInternalProviderPath('/provider/jobs')).toBe(true);
    expect(isInternalProviderPath('/providers')).toBe(false);
    expect(PROVIDER_PUBLIC_PATHS).toEqual(['/login']);
  });

  it('the middleware gates the provider host on the PROVIDER cookie and 404s /provider on the ops host', () => {
    const mw = stripComments(read('middleware.ts'));
    expect(mw).toMatch(/isProviderHost\(req\.headers\.get\('host'\)\)/);
    expect(mw).toMatch(/req\.cookies\.has\('bravo_pv_token'\)/);
    // the ops-host 404 for internal provider paths comes BEFORE the ops cookie gate
    expect(mw.indexOf('isInternalProviderPath(pathname)')).toBeLessThan(mw.indexOf("req.cookies.has('bravo_ops_token')"));
  });
});

describe('provider pages stay on the provider session', () => {
  const files = [...walk(path.join(SRC, 'app', 'provider')), ...walk(path.join(SRC, 'components', 'provider'))];

  it('never call the ops API objects or read ops cookies', () => {
    for (const f of files) {
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      expect([f, /\b(opsApi|opsDataApi|authApi|clearSession)\b/.test(code)]).toEqual([f, false]);
      expect([f, /bravo_ops_/.test(code)]).toEqual([f, false]);
    }
  });

  it('the provider client reads the provider csrf cookie and sends the agency context', () => {
    const api = stripComments(read('lib/provider/api.ts'));
    expect(api).toMatch(/bravo_pv_csrf=/);
    expect(api).not.toMatch(/bravo_ops_/);
    expect(api).toMatch(/'X-Org-Context': currentOrg/);
    expect(api).toMatch(/credentials: 'include'/);
  });

  it('sign-out sends the deviceId the server requires (both consoles)', () => {
    expect(stripComments(read('lib/provider/api.ts'))).toMatch(/'\/auth\/session'[\s\S]{0,120}deviceId: deviceId\(\)/);
    expect(stripComments(read('lib/api.ts'))).toMatch(/'\/auth\/session'[\s\S]{0,120}deviceId: deviceId\(\)/);
  });
});

describe('provider nav and labels', () => {
  it('every module-gated rail item uses a console module, and Managers is owner-only', () => {
    const items = PROVIDER_NAV.flatMap(g => g.items);
    for (const i of items) for (const m of i.modules ?? []) expect(CONSOLE_MODULES).toContain(m);
    expect(items.find(i => i.href === '/managers')?.ownerOnly).toBe(true);
    expect(items.find(i => i.href === '/earnings')?.modules).toEqual(['earn']);
  });

  it('nav highlighting', () => {
    expect(navActive('/', '/')).toBe(true);
    expect(navActive('/', '/jobs')).toBe(false);
    expect(navActive('/jobs', '/jobs/123')).toBe(true);
    expect(navActive('/jobs', '/jobsx')).toBe(false);
  });

  it('Lite vs Executive', () => {
    expect(productOf('executive_protection')).toBe('executive');
    expect(productOf('secure_transfer')).toBe('lite');
  });

  it('CREWED never reads as dispatched; a confirmed booking with no mission needs crew', () => {
    expect(missionState({mission_id: 'm', mission_status: 'CREWED', booking_status: 'CONFIRMED'}).label).toBe('Not dispatched');
    expect(missionState({mission_id: null, mission_status: null, booking_status: 'CONFIRMED'}).label).toBe('Needs crew');
  });

  it('server refusals read as sentences', () => {
    expect(errorText({body: {message: 'org_module_not_granted:earn'}})).toMatch(/not given you access/);
    expect(errorText({body: {message: 'crew_count_mismatch'}})).toMatch(/exactly/);
  });
});

describe('ops-issued sign-in passwords', () => {
  it('the password is only ever held in component state', () => {
    const code = stripComments(read('features/people/IssuePassword.tsx'));
    expect(code).not.toMatch(/localStorage|sessionStorage|console\.|indexedDB/);
    expect(stripComments(read('lib/api.ts'))).toMatch(/issueInvitePassword[\s\S]{0,200}\/invite\/password`, \{method: 'POST'\}/);
  });

  it('the provider console offers a password change and the temporary-password banner', () => {
    const shell = stripComments(read('components/provider/ProviderShell.tsx'));
    expect(shell).toMatch(/password_temporary/);
    expect(shell).toMatch(/ChangePasswordDialog/);
    expect(stripComments(read('lib/provider/api.ts'))).toMatch(/'\/auth\/me\/password'/);
  });
});

describe('Phase 2 — vehicles, Secure Pro, statement', () => {
  it('the rail offers Secure Pro and Vehicles behind their own modules', () => {
    const items = PROVIDER_NAV.flatMap(g => g.items);
    expect(items.find(i => i.label === 'Secure Pro')?.modules).toEqual(['pro']);
    expect(items.find(i => i.label === 'Vehicles')?.modules).toEqual(['fleet']);
    expect(CONSOLE_MODULES).toEqual(expect.arrayContaining(['pro', 'fleet']));
  });

  it('the Pro page never renders a mission code', () => {
    expect(stripComments(read('app/provider/(app)/pro/page.tsx'))).not.toMatch(/mission_code/);
    expect(stripComments(read('lib/provider/api.ts'))).not.toMatch(/mission_code/);
  });

  it('the statement CSV goes through the escaping helper', () => {
    const page = stripComments(read('app/provider/(app)/earnings/page.tsx'));
    expect(page).toMatch(/import \{downloadCsv\} from '@\/lib\/csv'/);
    expect(page).not.toMatch(/new Blob|text\/csv/);
  });

  it('vehicle errors read as sentences', () => {
    expect(errorText({body: {message: 'vehicle_not_verified'}})).toMatch(/not verified/);
    expect(errorText({body: {message: 'vehicle_busy'}})).toMatch(/another mission/);
  });
});
