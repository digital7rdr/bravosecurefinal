import {OpsDataService} from './ops-data.service';
import type {AdminContext} from './admin.guard';

/**
 * B-807 — the Finance › Escrow and › Disputes read models carry the evidence
 * the resolve dialogs explain a decision with. The console renders whatever
 * columns come back, so a column silently dropped from one of these SELECTs
 * does not break a build — the dialog just goes quiet ("parked for review",
 * no reasons; "resolve", no idea whether it is a settle or a clawback). These
 * pins extract the SQL and assert the columns by name.
 */
const ADMIN: AdminContext = {user_id: 'adm-1', role: 'SUPERVISOR', call_sign: 'SUP-1', region: 'AE'};

function mk() {
  const q = jest.fn().mockResolvedValue([]);
  const svc = new OpsDataService({q, qOne: jest.fn()} as never);
  return {svc, q};
}

function sqlOf(q: jest.Mock): string {
  expect(q).toHaveBeenCalledTimes(1);
  return String(q.mock.calls[0][0]);
}

describe('B-807 — escrow read models carry the resolve evidence', () => {
  it('listEscrows selects the gate reasons and the no-show marker', async () => {
    const {svc, q} = mk();
    await svc.listEscrows(ADMIN, undefined, 50);
    const sql = sqlOf(q);
    expect(sql).toMatch(/\be\.review_reasons\b/);
    expect(sql).toMatch(/\be\.no_show_at\b/);
    // The timeline the page derives the dispute window from.
    expect(sql).toMatch(/\be\.completed_at\b/);
    expect(sql).toMatch(/\be\.release_eligible_at\b/);
    expect(sql).toMatch(/\be\.basis\b/);
  });

  it('listDisputes selects the HOLD\'s executed split under hold_* names, distinct from the dispute decision', async () => {
    const {svc, q} = mk();
    await svc.listDisputes(ADMIN, 'OPEN', 50);
    const sql = sqlOf(q);
    for (const col of [
      'hold_basis', 'hold_to_provider_credits', 'hold_to_client_credits',
      'hold_platform_fee_credits', 'hold_no_show_at', 'hold_settled_at',
    ]) {
      expect(sql).toMatch(new RegExp(`AS ${col}\\b`));
    }
    // The dispute's own decided legs are still there, unprefixed — the two
    // must never collapse into one name.
    expect(sql).toMatch(/\bd\.to_client_credits\b/);
    expect(sql).toMatch(/\bd\.to_provider_credits\b/);
    expect(sql).toMatch(/\be\.status AS escrow_status\b/);
  });
});
