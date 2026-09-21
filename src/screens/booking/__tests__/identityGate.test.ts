/**
 * B-867 — identity verification (ID / passport) for every individual account.
 *
 * The SERVER is the boundary (identity-document.spec.ts pins it). These pins
 * keep the CLIENT courtesy layer honest:
 *  - the gate helper: fail-OPEN until the server reports, closed on
 *    `required && !submitted`, open again the moment the upload lands;
 *  - the refusal matcher sees every shape the 403 reaches a screen in;
 *  - the wiring: the registration step is hosted by the root for a freshly
 *    registered individual only; the booking entry (ServiceType) holds
 *    Continue and shows the card; BOTH submit screens and the Pro apply
 *    screen route the server refusal; the Profile row exists for individuals
 *    with the REQUIRED / ON FILE pill; the route is registered; the upload is
 *    one multipart request; the store carries the facts across a profile edit.
 *
 * Source scans strip comments and are CRLF-tolerant (CLAUDE.md scan traps).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

jest.mock('@utils/alert', () => ({Alert: {alert: jest.fn()}}));

import {Alert} from '@utils/alert';
import {
  IDENTITY_DOCUMENT_REQUIRED, isIdentityRequiredError, needsIdentityDocument, promptIdentityRequired,
} from '@modules/identity/identityGate';

const ROOT = join(__dirname, '..', '..', '..', '..');
function src(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\r\n/g, '\n');
}

describe('needsIdentityDocument', () => {
  it('is fail-open until the server has reported', () => {
    expect(needsIdentityDocument(null)).toBe(false);
    expect(needsIdentityDocument(undefined)).toBe(false);
    expect(needsIdentityDocument({})).toBe(false);
    expect(needsIdentityDocument({identity_document_status: 'missing'})).toBe(false);
  });

  it('closes on required + missing and opens again on submitted', () => {
    expect(needsIdentityDocument({identity_document_status: 'missing', identity_document_required: true})).toBe(true);
    expect(needsIdentityDocument({identity_document_status: 'submitted', identity_document_required: true})).toBe(false);
    expect(needsIdentityDocument({identity_document_status: 'missing', identity_document_required: false})).toBe(false);
  });
});

describe('isIdentityRequiredError', () => {
  it('matches the raw axios body, the booking store re-throw and the Pro store re-throw', () => {
    expect(isIdentityRequiredError({response: {data: {code: IDENTITY_DOCUMENT_REQUIRED, message: 'Add your ID…'}}})).toBe(true);
    expect(isIdentityRequiredError(Object.assign(new Error('x'), {code: IDENTITY_DOCUMENT_REQUIRED}))).toBe(true);
    expect(isIdentityRequiredError({response: {data: {message: IDENTITY_DOCUMENT_REQUIRED}}})).toBe(true);
    expect(isIdentityRequiredError({response: {data: {code: 'insufficient_credits'}}})).toBe(false);
    expect(isIdentityRequiredError(new Error('identity_document_required'))).toBe(false);
    expect(isIdentityRequiredError(null)).toBe(false);
    expect(isIdentityRequiredError('identity_document_required')).toBe(false);
  });
});

describe('promptIdentityRequired', () => {
  it('tells the user where to go and offers the route', () => {
    const go = jest.fn();
    promptIdentityRequired(go);
    const [title, body, buttons] = (Alert.alert as jest.Mock).mock.calls[0];
    expect(title).toBe('Identity verification required');
    expect(body).toMatch(/Profile → Identity verification/);
    const verify = (buttons as Array<{text: string; onPress?: () => void}>).find(b => b.text === 'Verify now');
    expect(verify).toBeDefined();
    verify!.onPress!();
    expect(go).toHaveBeenCalledTimes(1);
  });
});

describe('wiring', () => {
  it('the root hosts the registration step for a FRESHLY registered individual only', () => {
    const s = src('src/navigation/index.tsx');
    expect(s).toMatch(/const justRegistered = useAuthStore\(s => s\.justRegistered\);/);
    expect(s).toMatch(/const needsIdentity = useAuthStore\(s => needsIdentityDocument\(s\.user\)\);/);
    expect(s).toMatch(/const showIdentity = !showAuth && permsShown === true && justRegistered && needsIdentity;/);
    expect(s).toMatch(/const showMain\s*= !showAuth && permsShown === true && !showIdentity;/);
    expect(s).toMatch(/<Stack\.Screen name="IdentityGate">\s*\{\(\) => <IdentityDocumentScreen onDone=\{clearJustRegistered\} \/>\}/);
    // N11 — no bare useAuthStore() destructuring in the container.
    expect(s).not.toMatch(/const \{[^}]*\} = useAuthStore\(\)/);
  });

  it('registerVerify seeds the facts and the flag; a profile edit carries them across', () => {
    const s = src('src/store/authStore.ts');
    const reg = s.slice(s.indexOf('verifyRegister: async'), s.indexOf('login: async'));
    expect(reg).toMatch(/identity_document_status: 'missing',\s*identity_document_required: resp\.user\.role === 'individual',/);
    // A "Service Provider" signup is minted as an individual too — no identity step for them.
    expect(reg).toMatch(/const isProvider = await pendingProvider\.get\(\)\.catch\(\(\) => false\);/);
    expect(reg).toMatch(/s\.justRegistered = resp\.user\.role === 'individual' && !isProvider;/);
    const routing = s.slice(s.indexOf('function routingOf('), s.indexOf('function toUser('));
    expect(routing).toMatch(/identity_document_status: u\.identity_document_status,/);
    expect(routing).toMatch(/identity_document_required: u\.identity_document_required,/);
    // Every /auth/me consumer carries the two fields (4 sites at the time of writing).
    const sites = s.match(/owns_agency, identity_document_status, identity_document_required\} = await authApi\.me\(\);/g) ?? [];
    expect(sites.length).toBeGreaterThanOrEqual(4);
    expect(s).toMatch(/markIdentitySubmitted: \(\) => \{\s*set\(s => \{ if \(s\.user\) \{s\.user\.identity_document_status = 'submitted';\} \}\);/);
    // signOut drops the flag — the next account on this device never inherits the step.
    const out = s.slice(s.indexOf('signOut: async'), s.indexOf('setObservabilityUser(null);', s.indexOf('signOut: async')));
    expect(out).toMatch(/s\.justRegistered = false;/);
  });

  it('ServiceType holds Continue and shows the gate card routing to IdentityDocument', () => {
    const s = src('src/screens/booking/ServiceTypeScreen.tsx');
    expect(s).toMatch(/const identityBlocked = useAuthStore\(st => needsIdentityDocument\(st\.user\)\);/);
    expect(s).toMatch(/const canContinue = !!pickedDef && !pickedDef\.comingSoon && !identityBlocked;/);
    expect(s).toMatch(/testID="identity-gate-card"/);
    expect(s).toMatch(/onPress=\{\(\) => navigateOnce\(navigation, 'IdentityDocument'\)\}/);
  });

  it('both submit screens and the Pro apply screen ROUTE the server refusal, ahead of the generic alert', () => {
    for (const rel of ['src/screens/booking/CustomizeAddOnsScreen.tsx', 'src/screens/executive/ExecReviewScreen.tsx']) {
      const s = src(rel);
      const at = s.indexOf('if (isIdentityRequiredError(e)) {');
      expect(at).toBeGreaterThan(0);
      expect(s.slice(at, at + 200)).toMatch(/promptIdentityRequired\(\(\) => navigation\.navigate\('IdentityDocument'\)\);\s*return;/);
      expect(at).toBeLessThan(s.indexOf("'Booking failed'"));
    }
    const pro = src('src/screens/securepro/SecureProApplyScreen.tsx');
    expect(pro).toMatch(/if \(isIdentityRequiredError\(e\)\) \{\s*promptIdentityRequired\(\(\) => navigation\.navigate\('IdentityDocument'\)\);/);
    const store = src('src/store/secureProStore.ts');
    expect(store).toMatch(/if \(typeof code === 'string'\) \{out\.code = code;\}/);
    expect(store).toMatch(/msg === 'identity_document_required'/);
  });

  it('Profile shows the row to individuals with the REQUIRED / ON FILE pill', () => {
    const s = src('src/screens/settings/ProfileScreen.tsx');
    expect(s).toMatch(/label:'Identity verification', identity:true, action:\{kind:'route', screen:'IdentityDocument'\}/);
    expect(s).toMatch(/if \(row\.identity\) \{return user\?\.role === 'individual';\}/);
    expect(s).toMatch(/testID="identity-pill-required"/);
    expect(s).toMatch(/testID="identity-pill-submitted"/);
    // Three states: ON FILE only on the server's own fact — "not required"
    // (kill-switch / older server) must never paint a green pill over a gap.
    expect(s).toMatch(/const identitySubmitted = user\?\.identity_document_status === 'submitted';/);
    expect(s).toMatch(/\{row\.identity && identitySubmitted \? \(/);
    expect(s).toMatch(/\) : row\.identity && identityMissing \? \(/);
  });

  it('the route is registered in the booking stack and hosted under PROFILE in the footer', () => {
    expect(src('src/navigation/BookingNavigator.tsx')).toMatch(/name="IdentityDocument"\s*component=\{IdentityDocumentScreen\}/);
    expect(src('src/navigation/types.ts')).toMatch(/IdentityDocument: undefined;/);
    const main = src('src/navigation/MainNavigator.tsx');
    const hosted = main.slice(main.indexOf('const PROFILE_HOSTED_ROUTES'), main.indexOf(']);', main.indexOf('const PROFILE_HOSTED_ROUTES')));
    expect(hosted).toMatch(/'IdentityDocument'/);
  });

  it('the upload is ONE multipart request carrying doc_type + front (+ back)', () => {
    const s = src('src/services/api.ts');
    const api = s.slice(s.indexOf('export const identityApi'), s.indexOf('export const preferencesApi'));
    expect(api).toMatch(/form\.append\('doc_type', dto\.docType\);/);
    expect(api).toMatch(/form\.append\('front',/);
    expect(api).toMatch(/if \(dto\.backUri\) \{\s*form\.append\('back',/);
    expect(api).toMatch(/authHttp\.post<IdentityDocumentFacts>\('\/users\/me\/identity-document', form/);
  });

  it('the screen never keeps or shows the photo back after a submit, and its submit is ref-guarded (N4)', () => {
    const s = src('src/screens/settings/IdentityDocumentScreen.tsx');
    expect(s).toMatch(/if \(submitRef\.current \|\| !front\) \{return;\}\s*submitRef\.current = true;/);
    expect(s).toMatch(/finally \{\s*submitRef\.current = false;/);
    // After a successful submit the picked images are dropped.
    const ok = s.slice(s.indexOf('markIdentitySubmitted();', s.indexOf('const submit = useCallback')), s.indexOf('} catch (e) {', s.indexOf('const submit = useCallback')));
    expect(ok).toMatch(/void discard\(front\.uri, back\?\.uri\);\s*setFront\(null\);\s*setBack\(null\);/);
    // "Nothing is kept on this phone": the cache copies are deleted, and multer's own 413 is named.
    expect(s).toMatch(/FileSystem\.deleteAsync\(u, \{idempotent: true\}\)/);
    expect(s).toMatch(/err\?\.response\?\.status === 413/);
    // Back press on the stack surface goes through the guard, never raw goBack.
    expect(s).toMatch(/onPress=\{\(\) => goBackOnce\(navigation\)\}/);
    expect(s).not.toMatch(/onPress=\{\(\) => navigation\.goBack\(\)\}/);
  });
});
