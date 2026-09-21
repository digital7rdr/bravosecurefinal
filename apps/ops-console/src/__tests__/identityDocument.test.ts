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
