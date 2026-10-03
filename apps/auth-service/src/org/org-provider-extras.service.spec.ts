import {OrgProviderExtrasService} from './org-provider-extras.service';
import type {DatabaseService} from '../database/database.service';

function svc(rows: unknown[] = []) {
  const q = jest.fn().mockResolvedValue(rows);
  return {s: new OrgProviderExtrasService({q} as unknown as DatabaseService), q};
}

describe('Secure Pro assignments for the agency', () => {
  it('scopes to the agency and never returns the mission code', async () => {
    const {s, q} = svc();
    await s.proAssignments('org-A', 'current');
    const [sql, params] = q.mock.calls[0];
    expect(params).toEqual(['org-A']);
    expect(sql).toMatch(/WHERE pca\.org_user_id = \$1/);
    expect(sql).not.toMatch(/mission_code/);
  });
});

describe('payout statement', () => {
  it('validates dates and range', async () => {
    const {s} = svc();
    await expect(s.statement('org-A', '2026-13-01x', '2026-10-01')).rejects.toThrow('dates_must_be_YYYY-MM-DD');
    await expect(s.statement('org-A', '2026-10-05', '2026-10-01')).rejects.toThrow('from_after_to');
    await expect(s.statement('org-A', '2024-01-01', '2026-10-01')).rejects.toThrow('range_max_366_days');
  });

  it('sums only released money as paid; the rest is pending', async () => {
    const {s, q} = svc();
    q.mockResolvedValueOnce([
      {booking_id: 'b1', hold_status: 'RELEASED', gross_credits: 100, platform_fee_credits: 15, to_provider_credits: 85, settled_at: null},
      {booking_id: 'b2', hold_status: 'PENDING_RELEASE', gross_credits: 50, platform_fee_credits: null, to_provider_credits: null, settled_at: null},
    ]).mockResolvedValueOnce([]);
    const out = await s.statement('org-A', '2026-10-01', '2026-10-31');
    expect(out.totals).toEqual({jobs: 2, gross_credits: 100, fee_credits: 15, net_credits: 85, pending_credits: 50});
    for (const [, params] of q.mock.calls) expect((params as unknown[])[0]).toBe('org-A');
  });
});
