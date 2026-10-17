import {ComplianceService} from './compliance.service';
import type {DatabaseService} from '../database/database.service';

function mk(opts: {agentType?: string; verifyRow?: unknown; armedRow?: unknown} = {}) {
  const txQ = jest.fn().mockResolvedValue([]);
  const txQOne = jest.fn().mockResolvedValue({id: 'cred-1'});
  const tx = {q: txQ, qOne: txQOne};
  const db = {
    q: jest.fn().mockResolvedValue([]),
    qOne: jest.fn().mockImplementation((sql: string) => {
      if (/FROM public\.agents/.test(sql)) return Promise.resolve(opts.agentType ? {type: opts.agentType} : null);
      if (/UPDATE public\.compliance_credentials/.test(sql)) return Promise.resolve(opts.verifyRow ?? null);
      if (/UPDATE public\.armed_authorizations/.test(sql)) return Promise.resolve(opts.armedRow ?? null);
      return Promise.resolve(null);
    }),
    withTransaction: (fn: (t: unknown) => unknown) => fn(tx),
  } as unknown as DatabaseService;
  return {svc: new ComplianceService(db), db, tx, txQ, txQOne};
}

const FUTURE = new Date(Date.now() + 365 * 24 * 3600_000).toISOString();
const PAST = new Date(Date.now() - 1000).toISOString();

describe('ComplianceService', () => {
  it('submit licence inserts an UNVERIFIED compliance_credentials row (superseding prior pending)', async () => {
    const {svc, txQ, txQOne} = mk();
    const r = await svc.submit('agency-1', 'agency', {docType: 'licence', regionCode: 'AE', expiresAt: FUTURE, reference: 'LIC-9'});
    expect(r).toEqual({id: 'cred-1', doc_type: 'licence', state: 'PENDING'});
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/DELETE FROM public\.compliance_credentials[\s\S]*NOT verified/), ['agency-1', 'licence', 'AE']);
    expect(txQOne).toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO public\.compliance_credentials[\s\S]*FALSE/), expect.arrayContaining(['agency-1', 'agency', 'licence', 'AE']));
  });

  it('submit armed_permit inserts an UN-authorized armed_authorizations row', async () => {
    const {svc, txQ} = mk();
    await svc.submit('cpo-1', 'cpo', {docType: 'armed_permit', regionCode: 'SA', expiresAt: FUTURE, reference: 'PERMIT-1'});
    expect(txQ).toHaveBeenCalledWith(expect.stringMatching(/DELETE FROM public\.armed_authorizations/), ['cpo-1', 'SA']);
  });

  it('rejects an expiry in the past', async () => {
    const {svc} = mk();
    await expect(svc.submit('a1', 'agency', {docType: 'licence', regionCode: 'AE', expiresAt: PAST})).rejects.toThrow('expiry_in_past');
  });

  it('submitForUser resolves a company agent to subject_kind=agency', async () => {
    const {svc, txQOne} = mk({agentType: 'company'});
    await svc.submitForUser('agency-1', {docType: 'insurance', regionCode: 'AE', expiresAt: FUTURE});
    expect(txQOne).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(['agency-1', 'agency', 'insurance']));
  });

  it('verify flips PENDING → VERIFIED and returns the subject', async () => {
    const {svc} = mk({verifyRow: {kind: 'licence', subject_user_id: 'agency-1'}});
    const r = await svc.verify('adm-1', 'cred-1');
    expect(r).toEqual({ok: true, doc_type: 'licence', subject_user_id: 'agency-1'});
  });

  it('verify is a no-op 404 when the credential is not PENDING (double-verify)', async () => {
    const {svc} = mk({verifyRow: null});
    await expect(svc.verify('adm-1', 'cred-1')).rejects.toThrow('credential_not_pending');
  });

  it('reject sets a reason (PENDING only)', async () => {
    const {svc, db} = mk();
    (db.qOne as jest.Mock).mockResolvedValueOnce({id: 'cred-1'}); // the UPDATE RETURNING
    const r = await svc.reject('adm-1', 'cred-1', 'expired cert');
    expect(r).toEqual({ok: true});
  });

  it('verifyArmed flips armed_authorizations.authorized', async () => {
    const {svc} = mk({armedRow: {cpo_user_id: 'cpo-1'}});
    const r = await svc.verifyArmed('adm-1', 'armed-1');
    expect(r).toEqual({ok: true, cpo_user_id: 'cpo-1'});
  });

  // Ops compliance review is NOT region-bounded (the ops controller passes no
  // admin.region) — a no-region call must return EVERY region's pending docs,
  // so e.g. an SA submission is visible to the (AE) ops admins.
  it('listPending with no region returns all regions (passes null)', async () => {
    const {svc, db} = mk();
    (db.q as jest.Mock).mockResolvedValueOnce([]);
    await svc.listPending();
    expect(db.q).toHaveBeenCalledWith(
      expect.stringMatching(/FROM public\.compliance_credentials[\s\S]*NOT c\.verified[\s\S]*region_code = \$1/),
      [null],
    );
  });

  it('listPending(region) still filters to that region when one is explicitly given', async () => {
    const {svc, db} = mk();
    (db.q as jest.Mock).mockResolvedValueOnce([]);
    await svc.listPending('SA');
    expect(db.q).toHaveBeenCalledWith(expect.anything(), ['SA']);
  });

  // IS-06 (audit 2026-08-07) — the review queue is not a blind list of UUIDs:
  // each row carries the provider display name and (for credentials) file_url.
  it('listPending projects provider_name + file_url on credential rows', async () => {
    const {svc, db} = mk();
    await svc.listPending();
    const credSql = (db.q as jest.Mock).mock.calls
      .map(c => c[0] as string)
      .find(s => /FROM public\.compliance_credentials/.test(s)) ?? '';
    expect(credSql).toMatch(/c\.file_url/);
    expect(credSql).toMatch(/u\.display_name AS provider_name/);
    const armedSql = (db.q as jest.Mock).mock.calls
      .map(c => c[0] as string)
      .find(s => /FROM public\.armed_authorizations/.test(s)) ?? '';
    expect(armedSql).toMatch(/u\.display_name AS provider_name/);
  });

  it('listPending maps provider_name/file_url into the rows (armed rows keep file_url null)', async () => {
    const {svc, db} = mk();
    (db.q as jest.Mock).mockImplementation((sql: string) => {
      if (/FROM public\.compliance_credentials/.test(sql)) {
        return Promise.resolve([{id: 'cred-1', kind: 'licence', subject_user_id: 'agency-1', provider_name: 'Falcon Security', file_url: 's3://bucket/enc-cert', region_code: 'AE', reference: 'LIC-9', expires_at: new Date(FUTURE), created_at: new Date('2026-08-01T00:00:00Z')}]);
      }
      if (/FROM public\.armed_authorizations/.test(sql)) {
        return Promise.resolve([{id: 'armed-1', cpo_user_id: 'cpo-1', provider_name: 'Officer K', region_code: 'AE', permit_ref: 'PERMIT-1', expires_at: new Date(FUTURE), created_at: new Date('2026-08-02T00:00:00Z')}]);
      }
      return Promise.resolve([]);
    });
    const rows = await svc.listPending();
    expect(rows[0]).toMatchObject({id: 'cred-1', provider_name: 'Falcon Security', file_url: 's3://bucket/enc-cert'});
    expect(rows[1]).toMatchObject({id: 'armed-1', provider_name: 'Officer K', file_url: null, armed: true});
  });

  // 2026-10-17 — owner: provider documents attached on the phone never showed
  // on the console's Compliance Review.
  describe('provider documents from mobile onboarding', () => {
    const cred = (extra: Record<string, unknown>) => ({id: 'cred-1', kind: 'licence', subject_user_id: 'agency-1', provider_name: 'Falcon', file_url: null, onboarding_file_url: null, region_code: 'AE', reference: null, expires_at: new Date(FUTURE), created_at: new Date('2026-08-01T00:00:00Z'), ...extra});

    it('a credential without a file shows the matching onboarding upload, flagged', async () => {
      const {svc, db} = mk();
      (db.q as jest.Mock).mockImplementation((sql: string) =>
        Promise.resolve(/FROM public\.compliance_credentials/.test(sql) ? [cred({onboarding_file_url: 'https://auth.test/uploads/agency-1/20261015T0930_TradeLicence_v1.pdf'})] : []));
      const rows = await svc.listPending();
      expect(rows[0]).toMatchObject({file_url: 'https://auth.test/uploads/agency-1/20261015T0930_TradeLicence_v1.pdf', file_from_onboarding: true});
      const sql = (db.q as jest.Mock).mock.calls.map(c => c[0] as string).find(q => /compliance_credentials/.test(q)) ?? '';
      expect(sql).toMatch(/agent_documents ad[\s\S]*ad\.state = 'done'[\s\S]*WHEN 'licence' THEN 'sia' WHEN 'insurance' THEN 'insurance'/);
    });

    it('a file attached to the credential itself wins and is not flagged', async () => {
      const {svc, db} = mk();
      (db.q as jest.Mock).mockImplementation((sql: string) =>
        Promise.resolve(/FROM public\.compliance_credentials/.test(sql) ? [cred({file_url: 'https://auth.test/uploads/agency-1/a.pdf', onboarding_file_url: 'https://auth.test/uploads/agency-1/b.pdf'})] : []));
      const rows = await svc.listPending();
      expect(rows[0]).toMatchObject({file_url: 'https://auth.test/uploads/agency-1/a.pdf', file_from_onboarding: false});
    });

    it('lists unreviewed company onboarding files, without repeating KYC mirrors', async () => {
      const {svc, db} = mk();
      (db.q as jest.Mock).mockResolvedValueOnce([
        {source: 'doc', key: 'insurance', provider_user_id: 'agency-1', provider_name: 'Falcon', title: 'Insurance', file_url: 'https://auth.test/uploads/agency-1/x.pdf', uploaded_at: new Date('2026-10-16T08:00:00Z'), agent_status: 'SUBMITTED'},
      ]);
      const rows = await svc.listProviderDocsPending();
      expect(rows).toEqual([{source: 'doc', key: 'insurance', provider_user_id: 'agency-1', provider_name: 'Falcon', title: 'Insurance', file_url: 'https://auth.test/uploads/agency-1/x.pdf', uploaded_at: '2026-10-16T08:00:00.000Z', agent_status: 'SUBMITTED'}]);
      const sql = (db.q as jest.Mock).mock.calls[0][0] as string;
      expect(sql).toMatch(/a\.type = 'company' AND d\.state = 'done' AND d\.reviewed_at IS NULL/);
      expect(sql).toMatch(/FROM public\.agent_kyc_checks[\s\S]*k\.reviewed_at IS NULL[\s\S]*NOT EXISTS[\s\S]*d2\.file_url = k\.file_url/);
    });

    it('submit accepts the submitter own upload and refuses any other link', async () => {
      const prev = process.env.PUBLIC_BASE_URL;
      process.env.PUBLIC_BASE_URL = 'https://auth.test';
      try {
        const {svc, txQOne} = mk();
        await svc.submit('agency-1', 'agency', {docType: 'licence', regionCode: 'AE', expiresAt: FUTURE, fileUrl: 'https://auth.test/uploads/agency-1/20261017T0800_Licence_v1.pdf'});
        expect(txQOne).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['https://auth.test/uploads/agency-1/20261017T0800_Licence_v1.pdf']));
        await expect(svc.submit('agency-1', 'agency', {docType: 'licence', regionCode: 'AE', expiresAt: FUTURE, fileUrl: 'https://auth.test/uploads/someone-else/a.pdf'})).rejects.toThrow('file_url_not_own_upload');
        await expect(svc.submit('agency-1', 'agency', {docType: 'licence', regionCode: 'AE', expiresAt: FUTURE, fileUrl: 'https://evil.example/uploads/agency-1/a.pdf'})).rejects.toThrow('file_url_not_own_upload');
      } finally {
        if (prev === undefined) {delete process.env.PUBLIC_BASE_URL;} else {process.env.PUBLIC_BASE_URL = prev;}
      }
    });
  });
});
