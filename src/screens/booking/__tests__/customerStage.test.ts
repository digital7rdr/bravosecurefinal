import {stageFor, stageCopy, isTeamDispatched, STAGE_COPY, fmtZ} from '../customerStage';

/**
 * 2026-09-04 — the customer-facing lifecycle: Finding provider → Provider accepted →
 * Team dispatched → Client received / Service started → Completed.
 * "Do not tell the customer 'team dispatched' merely because an agency accepted."
 */
describe('stageFor — the server stage wins, the local mirror only fills a gap', () => {
  it('honours a server-supplied stage verbatim', () => {
    expect(stageFor({status: 'CONFIRMED', mission_status: 'DISPATCHED', stage: 'team_assigned'})).toBe('team_assigned');
  });

  it('ignores an unknown server stage and re-derives', () => {
    expect(stageFor({status: 'CONFIRMED', mission_status: 'CREWED', stage: 'made_up'})).toBe('team_assigned');
  });

  it('CREWED is team_assigned — never team_dispatched', () => {
    expect(stageFor({status: 'CONFIRMED', mission_status: 'CREWED'})).toBe('team_assigned');
    expect(isTeamDispatched(stageFor({status: 'CONFIRMED', mission_status: 'CREWED'}))).toBe(false);
  });

  it('only the explicit DISPATCHED state (and later) reads as dispatched', () => {
    expect(stageFor({status: 'CONFIRMED', mission_status: 'DISPATCHED'})).toBe('team_dispatched');
    for (const m of ['DISPATCHED', 'PICKUP', 'LIVE', 'SOS']) {
      expect(isTeamDispatched(stageFor({status: 'CONFIRMED', mission_status: m}))).toBe(true);
    }
    expect(isTeamDispatched(stageFor({status: 'CONFIRMED'}))).toBe(false);
  });

  it('provider accepted with no crew is provider_accepted', () => {
    expect(stageFor({status: 'CONFIRMED'})).toBe('provider_accepted');
  });

  it('LIVE is service_started (client received)', () => {
    expect(stageFor({status: 'CONFIRMED', mission_status: 'LIVE'})).toBe('service_started');
    expect(stageFor({status: 'LIVE'})).toBe('service_started');
  });

  it('booking terminals outrank a stale mission row', () => {
    expect(stageFor({status: 'COMPLETED', mission_status: 'LIVE'})).toBe('completed');
    expect(stageFor({status: 'CANCELLED', mission_status: 'DISPATCHED'})).toBe('cancelled');
    expect(stageFor({status: 'NO_PROVIDER'})).toBe('no_provider');
    expect(stageFor({status: 'AGENCY_NO_SHOW'})).toBe('agency_no_show');
  });

  it('SOS outranks the booking and every other mission state', () => {
    expect(stageFor({status: 'CONFIRMED', mission_status: 'SOS'})).toBe('sos');
  });

  it('an ABORTED mission on a live booking falls back to the booking (re-dispatching)', () => {
    expect(stageFor({status: 'DISPATCHING', mission_status: 'ABORTED'})).toBe('finding_provider');
  });

  it('an approved scheduled booking is "scheduled"; an approved on-demand one is finding a provider', () => {
    expect(stageFor({status: 'OPS_APPROVED', booking_mode: 'later'})).toBe('scheduled');
    expect(stageFor({status: 'OPS_APPROVED', booking_mode: 'now'})).toBe('finding_provider');
    expect(stageFor({status: 'PENDING_OPS'})).toBe('awaiting_approval');
    expect(stageFor({status: 'DISPATCHING'})).toBe('finding_provider');
  });
});

describe('the copy', () => {
  it('uses the founder\'s words at each stage', () => {
    expect(stageCopy('finding_provider').headline).toBe('Finding a secure service provider');
    expect(stageCopy('provider_accepted').headline).toBe('Provider accepted your mission');
    expect(stageCopy('team_dispatched').headline).toBe('Team dispatched');
    expect(stageCopy('service_started').headline).toBe('Protection service started');
    expect(stageCopy('completed').headline).toBe('Service completed');
  });

  it('never claims the team is dispatched before it was — "not yet dispatched" is the one honest exception', () => {
    for (const s of ['provider_accepted', 'team_assigned', 'finding_provider', 'scheduled'] as const) {
      expect(stageCopy(s).label.toLowerCase()).not.toMatch(/dispatch/);
      // The headline may say "not yet dispatched"; it may never say the team IS.
      expect(stageCopy(s).headline.toLowerCase().replace(/not yet dispatched/g, '')).not.toMatch(/\bdispatched\b/);
    }
    expect(stageCopy('team_assigned').headline).toMatch(/not yet dispatched/);
  });

  it('every stage has copy and an open/closed flag', () => {
    for (const [stage, copy] of Object.entries(STAGE_COPY)) {
      expect(copy.label.length).toBeGreaterThan(0);
      expect(copy.headline.length).toBeGreaterThan(0);
      expect(typeof copy.open).toBe('boolean');
      expect(['completed', 'cancelled', 'no_provider', 'agency_no_show'].includes(stage)).toBe(!copy.open);
    }
  });
});

describe('fmtZ', () => {
  it('renders the client-received instant as HH:MMZ, or null when unset', () => {
    expect(fmtZ('2026-09-04T10:07:00.000Z')).toBe('10:07Z');
    expect(fmtZ(null)).toBeNull();
    expect(fmtZ('nonsense')).toBeNull();
  });
});
