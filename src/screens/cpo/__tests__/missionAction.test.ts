import {missionAction, missionActionView, missionActionConfirm} from '../missionAction';

describe('missionAction — lead-only context-aware mission control (Step 21)', () => {
  it('maps each lead state to its single next transition', () => {
    // 2026-09-04 — CREWED (crew named, not sent) → the explicit Dispatch action.
    expect(missionAction('CREWED', true)).toBe('dispatch');
    expect(missionAction('DISPATCHED', true)).toBe('start');
    expect(missionAction('PICKUP', true)).toBe('go-live');
    expect(missionAction('LIVE', true)).toBe('finish');
  });

  it('gives a non-lead NO advance action in any state (read-only ride-along)', () => {
    for (const st of ['CREWED', 'DISPATCHED', 'PICKUP', 'LIVE', 'SOS', 'COMPLETED']) {
      expect(missionAction(st, false)).toBe('none');
    }
  });

  it('gives the lead no advance from SOS / terminal / unknown states', () => {
    expect(missionAction('SOS', true)).toBe('none');
    expect(missionAction('COMPLETED', true)).toBe('none');
    expect(missionAction('ABORTED', true)).toBe('none');
    expect(missionAction('', true)).toBe('none');
    expect(missionAction(null, true)).toBe('none');
  });

  it('is case-insensitive', () => {
    expect(missionAction('live', true)).toBe('finish');
    expect(missionAction('crewed', true)).toBe('dispatch');
  });

  it('view: the labels name the EVENT the driver is confirming, not the FSM', () => {
    // Founder's August 2026 device-feedback deck + the 2026-09-04 lifecycle brief:
    // Dispatch team / Arrived at pickup / Client received / Client Dropped Off.
    expect(missionActionView('CREWED', true)).toMatchObject({label: 'Dispatch team'});
    expect(missionActionView('DISPATCHED', true)).toMatchObject({label: 'Arrived at pickup'});
    expect(missionActionView('PICKUP', true)).toMatchObject({label: 'Client received'});
    expect(missionActionView('LIVE', true)).toMatchObject({label: 'Client Dropped Off'});
    expect(missionActionView('LIVE', false).action).toBe('none');
  });

  it('view: confirming a person is with you, and dispatching a team, are deliberate confirmed acts', () => {
    // PICKUP→LIVE stamps live_at = client_received_at, which drives billing, the
    // proof gate, the pre-LIVE full-refund boundary and the executive check-in
    // schedule. Dispatch tells the client "team dispatched". Neither may fire on
    // one unconfirmed tap.
    expect(missionActionView('CREWED', true).confirm).toBe(true);
    expect(missionActionView('PICKUP', true).confirm).toBe(true);
    expect(missionActionView('LIVE', true).confirm).toBe(true);
    // Arriving at the pickup point commits nothing irreversible — no dialog.
    expect(missionActionView('DISPATCHED', true).confirm).toBe(false);
  });

  it('confirm copy: the officer reads the sentence they are attesting to', () => {
    expect(missionActionConfirm('dispatch')).toMatchObject({cta: 'Dispatch team', destructive: false});
    expect(missionActionConfirm('go-live')?.body).toMatch(/billable time/);
    expect(missionActionConfirm('go-live')).toMatchObject({cta: 'Client received', destructive: false});
    expect(missionActionConfirm('finish')).toMatchObject({destructive: true});
    expect(missionActionConfirm('start')).toBeNull();
    expect(missionActionConfirm('none')).toBeNull();
  });
});
