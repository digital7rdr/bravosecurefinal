/**
 * Bravo Web App (web.* host, 2026-10-03) — pins.
 *
 * Messenger + online booking for every Bravo account, served by the same
 * Next.js app as the two consoles. These tests keep it apart from them (host,
 * route group, session cookie, CSRF) and pin the booking rules it shares with
 * the mobile app.
 */
import fs from 'fs';
import path from 'path';
import {
  isInternalWebPath, isWebHost, toInternalWebPath, WEB_PUBLIC_PATHS, isProviderHost,
} from '../lib/provider/host';
import {canBook, type WebMe} from '../lib/web/access';
import {toE164} from '../lib/web/phone';
import {canCancel, needsPayment, stageOf, webErrorText, STAGE} from '../lib/web/labels';
import {WEB_NAV, webNavActive} from '../lib/web/nav';

const SRC = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
function walk(dir: string): string[] {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []);
}

const me = (over: Partial<WebMe> & {role?: string} = {}): WebMe => ({
  user: {id: 'u', email: null, display_name: 'A', role: over.role ?? 'individual', phone_e164: '+971500000000', avatar_url: null},
  account_kind: 'individual', must_set_password: false, is_org_manager: false, auto_dispatch_enabled: false, ...over,
});

describe('web host routing', () => {
  it('detects the web host and keeps it apart from the provider host', () => {
    expect(isWebHost('web.bravosecure.cloud')).toBe(true);
    expect(isWebHost('WEB.localhost:3033')).toBe(true);
    expect(isWebHost('ops.bravosecure.cloud')).toBe(false);
    expect(isWebHost('webmail.bravosecure.cloud')).toBe(false);
    expect(isProviderHost('web.bravosecure.cloud')).toBe(false);
  });

  it('maps clean paths onto the internal /web group', () => {
    expect(toInternalWebPath('/')).toBe('/web');
    expect(toInternalWebPath('/bookings/x')).toBe('/web/bookings/x');
    expect(isInternalWebPath('/web/book')).toBe(true);
    expect(isInternalWebPath('/webhooks')).toBe(false);
    expect(WEB_PUBLIC_PATHS).toEqual(['/login']);
  });

  it('the middleware gates the web host on the WEB cookie and 404s /web elsewhere', () => {
    const mw = stripComments(read('middleware.ts'));
    expect(mw).toMatch(/isWebHost\(req\.headers\.get\('host'\)\)/);
    expect(mw).toMatch(/cookie: 'bravo_web_token'/);
    expect(mw.indexOf('isInternalWebPath(pathname)')).toBeLessThan(mw.indexOf("req.cookies.has('bravo_ops_token')"));
  });

  it('the ops legacy redirects skip the web host', () => {
    const cfg = fs.readFileSync(path.join(SRC, '..', 'next.config.ts'), 'utf8');
    const m = /PROVIDER_HOST_PATTERN = '([^']+)'/.exec(cfg);
    expect(m).not.toBeNull();
    const re = new RegExp(`^${m![1].replace(/\\\\/g, '\\')}$`);
    expect(re.test('web.bravosecure.cloud')).toBe(true);
    expect(re.test('provider.bravosecure.cloud')).toBe(true);
    expect(re.test('ops.bravosecure.cloud')).toBe(false);
  });
});

describe('web pages stay on the web session', () => {
  const files = [...walk(path.join(SRC, 'app', 'web')), ...walk(path.join(SRC, 'components', 'web')), ...walk(path.join(SRC, 'lib', 'web'))];

  it('never call the ops or provider API objects or read their cookies', () => {
    for (const f of files) {
      const s = stripComments(fs.readFileSync(f, 'utf8'));
      expect([f, /\bopsApi\b|\bopsDataApi\b|\bpvApi\b|\bpvAuth\b/.test(s)]).toEqual([f, false]);
      expect([f, /bravo_ops_|bravo_pv_/.test(s)]).toEqual([f, false]);
    }
  });

  it('every web call sends the web CSRF cookie as X-CSRF-Token, and the shared messenger reads it on the web host', () => {
    const api = stripComments(read('lib/web/api.ts'));
    expect(api).toMatch(/'X-CSRF-Token': csrf/);
    expect(api).toMatch(/bravo_web_csrf=/);
    expect(api).toMatch(/credentials: 'include'/);
    expect(stripComments(read('lib/provider/host.ts'))).toMatch(/isWebHost\(window\.location\.host\)\) return 'bravo_web_csrf'/);
    expect(stripComments(read('components/messenger/MessengerProvider.tsx'))).toMatch(/host === 'web' \? \(webMe\?\.user\.id \?\? null\)/);
    expect(stripComments(read('components/web/WebShell.tsx'))).toMatch(/wipeMessenger\(\)/);
  });

  it('payment and completion keys match the app (no colon, stable per booking)', () => {
    const api = stripComments(read('lib/web/api.ts'));
    expect(api).toMatch(/`paywc-\$\{id\}`/);
    expect(api).toMatch(/`confirm-\$\{id\}`/);
    expect(api).toMatch(/`rate-\$\{id\}`/);
    expect(api).toMatch(/`proapp-activate-\$\{id\}`/);
    expect(api).not.toMatch(/paywc:/);
  });

  it('there is no card top-up on the web', () => {
    for (const f of files) expect([f, /wallet\/topup|stripe/i.test(stripComments(fs.readFileSync(f, 'utf8')))]).toEqual([f, false]);
  });

  it('the chat directory finds people by exact phone number only', () => {
    const dir = stripComments(read('lib/web/directory.ts'));
    expect(dir).toMatch(/webApi\.lookupPhones\(\[phone\]\)/);
    expect(dir).not.toMatch(/listUsers|\/ops\//);
  });
});

describe('who can book', () => {
  it('clients only; officers, agencies and managers get Messenger', () => {
    expect(canBook(me())).toBe(true);
    expect(canBook(me({account_kind: 'cpo'}))).toBe(false);
    expect(canBook(me({account_kind: 'agency'}))).toBe(false);
    expect(canBook(me({is_org_manager: true}))).toBe(false);
    expect(canBook(me({role: 'service_provider'}))).toBe(false);
    expect(canBook(undefined)).toBe(false);
    expect(WEB_NAV.filter(i => !i.clientsOnly).map(i => i.label)).toEqual(['Chats', 'Account']);
    expect(webNavActive('/', '/')).toBe(true);
    expect(webNavActive('/bookings', '/bookings/abc')).toBe(true);
    expect(webNavActive('/book', '/bookings')).toBe(false);
  });
});

describe('phone numbers for the chat search', () => {
  it('accepts E.164 with spaces or a 00 prefix, refuses everything else', () => {
    expect(toE164('+971 50 123 4567')).toBe('+971501234567');
    expect(toE164('0044 7700-900123')).toBe('+447700900123');
    expect(toE164('050 123 4567')).toBeNull();
    expect(toE164('alice')).toBeNull();
    expect(toE164('+12')).toBeNull();
  });
});

describe('booking stages and actions', () => {
  it('prefers the server stage, else derives it like the app', () => {
    expect(stageOf({status: 'CONFIRMED', mission_status: null, booking_mode: 'later', stage: 'team_arrived'})).toBe('team_arrived');
    expect(stageOf({status: 'CONFIRMED', mission_status: 'CREWED', booking_mode: 'later'})).toBe('team_assigned');
    expect(stageOf({status: 'OPS_APPROVED', mission_status: null, booking_mode: 'later'})).toBe('scheduled');
    expect(stageOf({status: 'PENDING_OPS', mission_status: null, booking_mode: 'later'})).toBe('awaiting_approval');
    expect(STAGE[stageOf({status: 'COMPLETED', mission_status: null, booking_mode: null})].open).toBe(false);
  });

  it('asks for payment only on the HQ-approved flow, never on an auto booking', () => {
    expect(needsPayment({status: 'OPS_APPROVED', dispatch_mode: null})).toBe(true);
    expect(needsPayment({status: 'PAYMENT_PENDING', dispatch_mode: 'legacy'})).toBe(true);
    expect(needsPayment({status: 'PAYMENT_PENDING', dispatch_mode: 'auto'})).toBe(false);
    expect(needsPayment({status: 'CONFIRMED', dispatch_mode: null})).toBe(false);
  });

  it('offers cancel only before the team moves', () => {
    expect(canCancel({status: 'DISPATCHING', mission_status: null})).toBe(true);
    expect(canCancel({status: 'CONFIRMED', mission_status: 'CREWED'})).toBe(true);
    expect(canCancel({status: 'CONFIRMED', mission_status: 'DISPATCHED'})).toBe(false);
    expect(canCancel({status: 'COMPLETED', mission_status: null})).toBe(false);
  });

  it('turns server codes into sentences', () => {
    expect(webErrorText({body: {code: 'insufficient_credits', message: 'x'}})).toMatch(/credits are not enough/);
    expect(webErrorText({body: {error: 'module_disabled'}})).toMatch(/not available/);
    expect(webErrorText({body: {message: 'Minimum 3-hour lead time required. Earliest: x'}})).toMatch(/3 hours/);
    expect(webErrorText({body: {message: 'identity_document_required'}})).toMatch(/ID or passport/);
  });
});
