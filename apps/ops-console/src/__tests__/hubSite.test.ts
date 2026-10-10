/**
 * Bravo Secure home site (bravosecure.cloud, 2026-10-10) — pins: host routing,
 * its own session, single sign-on only through the server's launch endpoint,
 * the /sso landing on every app, and the Super Admin Apps page.
 */
import fs from 'fs';
import path from 'path';
import {
  HUB_PUBLIC_PATHS, isHubHost, isInternalHubPath, isProviderHost, isWebHost, toInternalHubPath,
  PROVIDER_PUBLIC_PATHS, WEB_PUBLIC_PATHS,
} from '../lib/provider/host';
import {PUBLIC_PATHS, isPublicAsset} from '../lib/publicRoutes';
import {homeSiteUrl, safeNext} from '../lib/sso';
import {routes} from '../lib/routes';

const SRC = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
function walk(dir: string): string[] {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []);
}

describe('home site host routing', () => {
  it('the bare domain, www and hub.* are the home site; the app hosts are not', () => {
    for (const h of ['bravosecure.cloud', 'www.bravosecure.cloud', 'BRAVOSECURE.cloud:443', 'hub.localhost:3033']) expect(isHubHost(h)).toBe(true);
    for (const h of ['ops.bravosecure.cloud', 'web.bravosecure.cloud', 'provider.bravosecure.cloud', 'api.ops.bravosecure.cloud',
      'web.localhost:3033', 'localhost:3033', '127.0.0.1:3033', null]) expect(isHubHost(h)).toBe(false);
    expect(isWebHost('bravosecure.cloud')).toBe(false);
    expect(isProviderHost('bravosecure.cloud')).toBe(false);
  });

  it('clean paths map onto the internal /hub group; only sign-in and registration are public', () => {
    expect(toInternalHubPath('/')).toBe('/hub');
    expect(toInternalHubPath('/security')).toBe('/hub/security');
    expect(isInternalHubPath('/hub/security')).toBe(true);
    expect(isInternalHubPath('/hubs')).toBe(false);
    expect(HUB_PUBLIC_PATHS).toEqual(['/login', '/register']);
  });

  it('the middleware gates the home site on its own cookie and 404s /hub on every other host', () => {
    const mw = strip(read('middleware.ts'));
    expect(mw).toMatch(/isHubHost\(req\.headers\.get\('host'\)\)/);
    expect(mw).toMatch(/cookie: 'bravo_hub_token'/);
    expect(mw).toMatch(/isInternalProviderPath\(p\) \|\| isInternalWebPath\(p\) \|\| isInternalHubPath\(p\)/);
    expect(mw.indexOf('isInternalAppPath(pathname)')).toBeLessThan(mw.indexOf("req.cookies.has('bravo_ops_token')"));
  });

  it('every app has a public /sso landing; the world map background is public', () => {
    expect(PUBLIC_PATHS).toContain('/sso');
    expect(PROVIDER_PUBLIC_PATHS).toContain('/sso');
    expect(WEB_PUBLIC_PATHS).toContain('/sso');
    expect(isPublicAsset('/hub-world.svg')).toBe(true);
    for (const f of ['app/sso/page.tsx', 'app/provider/sso/page.tsx', 'app/web/sso/page.tsx']) {
      expect(strip(read(f))).toMatch(/<SsoLanding expiresKey=/);
    }
  });
});

describe('single sign-on', () => {
  it('the landing only follows same-site paths', () => {
    expect(safeNext('/book')).toBe('/book');
    expect(safeNext('/')).toBe('/');
    for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', '', null, 'book']) expect(safeNext(bad)).toBe('/');
  });

  it('points back to the home site from any app host', () => {
    expect(homeSiteUrl({protocol: 'https:', host: 'ops.bravosecure.cloud'})).toBe('https://bravosecure.cloud/');
    expect(homeSiteUrl({protocol: 'http:', host: 'web.localhost:3033'})).toBe('http://hub.localhost:3033/');
  });

  it('the landing wipes the code from the address bar and trades it at /auth/sso/exchange', () => {
    const s = strip(read('components/SsoLanding.tsx'));
    expect(s).toMatch(/window\.location\.hash/);
    expect(s).toMatch(/history\.replaceState/);
    expect(s.indexOf('history.replaceState')).toBeLessThan(s.indexOf('/auth/sso/exchange'));
    expect(s).toMatch(/credentials: 'include'/);
  });

  it('the launcher opens apps only through the server (no app URL in the client)', () => {
    const files = [...walk(path.join(SRC, 'app', 'hub')), ...walk(path.join(SRC, 'components', 'hub')), ...walk(path.join(SRC, 'lib', 'hub'))];
    for (const f of files) {
      const s = strip(fs.readFileSync(f, 'utf8'));
      expect([f, /ops\.bravosecure|provider\.bravosecure|web\.bravosecure/.test(s)]).toEqual([f, false]);
      expect([f, /bravo_ops_|bravo_pv_|bravo_web_/.test(s)]).toEqual([f, false]);
    }
    expect(strip(read('app/hub/(app)/page.tsx'))).toMatch(/hubApi\.launch\(t\.key\)/);
    expect(strip(read('lib/hub/api.ts'))).toMatch(/'X-CSRF-Token': csrf/);
  });

  it('the shared CSRF reader knows the home site cookie', () => {
    expect(strip(read('lib/provider/host.ts'))).toMatch(/isHubHost\(window\.location\.host\)\) return 'bravo_hub_csrf'/);
  });
});

describe('Super Admin Apps page', () => {
  it('lives under Internal and is Super Admin only', () => {
    expect(routes.internal.apps).toBe('/internal/apps');
    expect(strip(read('lib/nav.tsx'))).toMatch(/label: 'Apps', href: routes\.internal\.apps, icon: iconAdminKey, minRole: 'ADMIN'/);
    const page = strip(read('app/(console)/internal/apps/page.tsx'));
    expect(page).toMatch(/canManagePlatformApps\(me\?\.admin\.role\)/);
    expect(page).toMatch(/opsApi\.updatePlatformApp\(/);
  });
});
