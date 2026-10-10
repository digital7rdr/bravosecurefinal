/**
 * B-867 — the console's identity-document normaliser. The console deploys
 * separately from the API, so an absent field must read as "not reported",
 * never as "missing" (which would tell an operator a client skipped a step
 * the API never described) and never throw.
 */
import {docTypeLabel, identityPill, resolveIdentityDocument} from '../lib/identityDocument';

describe('resolveIdentityDocument', () => {
  it('an API that never sent the field is "unknown", not "missing"', () => {
    expect(resolveIdentityDocument(undefined)).toEqual({kind: 'unknown'});
    expect(resolveIdentityDocument(null)).toEqual({kind: 'unknown'});
    expect(resolveIdentityDocument('garbage')).toEqual({kind: 'unknown'});
    expect(resolveIdentityDocument({})).toEqual({kind: 'unknown'});
  });

  it('missing splits on whether the account is asked at all', () => {
    expect(resolveIdentityDocument({status: 'missing', required: true})).toEqual({kind: 'missing'});
    expect(resolveIdentityDocument({status: 'missing', required: false})).toEqual({kind: 'not_required'});
    // required unknown → still a gap worth showing, not a "not required" pass.
    expect(resolveIdentityDocument({status: 'missing'})).toEqual({kind: 'missing'});
  });

  it('submitted carries type, date and the back-side fact, with bad values coerced', () => {
    expect(resolveIdentityDocument({status: 'submitted', doc_type: 'passport', submitted_at: '2026-09-12T10:00:00.000Z', has_back: false}))
      .toEqual({kind: 'submitted', doc_type: 'passport', submitted_at: '2026-09-12T10:00:00.000Z', has_back: false});
    expect(resolveIdentityDocument({status: 'submitted', doc_type: 'driving_licence', submitted_at: 12, has_back: 'yes'}))
      .toEqual({kind: 'submitted', doc_type: null, submitted_at: null, has_back: false});
  });
});

describe('identityPill / docTypeLabel', () => {
  it('reads at a glance and never paints a warning for an account that is not asked', () => {
    expect(identityPill({kind: 'submitted', doc_type: 'national_id', submitted_at: null, has_back: true}))
      .toEqual({text: 'ON FILE · NATIONAL ID', className: 'pill pill-ok'});
    expect(identityPill({kind: 'missing'})).toEqual({text: 'NOT SUBMITTED', className: 'pill pill-warn'});
    expect(identityPill({kind: 'not_required'}).className).toBe('pill');
    expect(identityPill({kind: 'unknown'}).text).toBe('NOT REPORTED');
    expect(docTypeLabel('passport')).toBe('Passport');
    expect(docTypeLabel(null)).toBe('Document');
  });
});

/**
 * 2026-10-10 — earlier identity uploads on the user page. Pins the posture the
 * active card already has: the history list is SUPERVISOR+ only (rendered only
 * when canReveal), facts are listed but images are fetched per version on an
 * explicit click through the audited route, and nothing is prefetched or polled.
 */
describe('IdentityDocumentCard — earlier uploads', () => {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const card = fs.readFileSync(path.join(__dirname, '..', 'features', 'people', 'IdentityDocumentCard.tsx'), 'utf8');
  const api = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api.ts'), 'utf8');

  it('renders the history only for a reveal-capable operator', () => {
    expect(card).toMatch(/\{canReveal \? <EarlierUploads userId=\{userId\} Card=\{Card\} \/> : null\}/);
  });

  it('lists facts on mount but opens images only on click, per version', () => {
    const list = card.indexOf('listUserIdentityDocumentVersions(userId)');
    const effect = card.lastIndexOf('useEffect(', list);
    expect(list).toBeGreaterThan(-1);
    expect(effect).toBeGreaterThan(-1);
    // The image read lives in the click handler, never in an effect.
    const openFn = card.slice(card.indexOf('async function open(versionId: string)'));
    expect(openFn).toMatch(/getUserIdentityDocumentVersion\(userId, versionId\)/);
    expect(card.match(/getUserIdentityDocumentVersion\(/g)).toHaveLength(1);
    expect(card).not.toMatch(/setInterval|refreshInterval|useSWR/);
  });

  it('calls the two server routes the auth-service exposes', () => {
    expect(api).toMatch(/`\/ops\/users\/\$\{id\}\/identity-document\/versions`/);
    expect(api).toMatch(/`\/ops\/users\/\$\{id\}\/identity-document\/versions\/\$\{versionId\}`/);
  });
});
