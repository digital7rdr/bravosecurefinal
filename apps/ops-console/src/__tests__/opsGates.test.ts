/**
 * E2E-18 / E2E-44 / E2E-48 — the console-side halves of the 2026-09-03
 * Secure Services audit (`docs/audits/SECURE_SERVICES_E2E_AUDIT_2026-09-03.md`).
 *
 * Two of these pin a ROLE GATE against the endpoint it mirrors. That drift is
 * invisible to a typecheck, a lint and a build — the console renders a button,
 * the operator clicks it, and the server 403s. It is also the class of bug that
 * regrows quietly, because loosening a gate always reads as a UX improvement in
 * the diff that does it. So each case names the server decorator it mirrors:
 * if someone changes the server, this test is where they find out the console
 * has to move too.
 *
 * Node project, no DOM — these are pure functions on purpose. `lib/format.ts`
 * is dependency-free for exactly this reason (lib/api.ts pulls in SWR + Next
 * and cannot be imported here).
 */

import * as rbac from '../lib/rbac';
import {
  approvalOutcome, approveRefusalOf,
  APPROVE_START_PASSED, APPROVE_LEAD_TOO_SHORT,
} from '../lib/format';
import {reservedDateAlert} from '../lib/proapps';
import {pollMs} from '../lib/pollCadence';

/** Stands in for `ApiError` — see the structural note on `approveRefusalOf`. */
function apiError(status: number, body: unknown, message = 'Bad Request') {
  return Object.assign(new Error(message), {status, body});
}

const ROLES = ['OPS', 'SUPERVISOR', 'ADMIN'] as const;

describe('E2E-18 — the SOS lane is SUPERVISOR+, end to end', () => {
  /**
   * `@RequireRoles('SUPERVISOR','ADMIN')` on POST /ops/sos/:id/ack
   * (ops.controller.ts:504-508, AUTHZ-5). `canAckSos` returned OPS, so
   * /live/[id] rendered an ACK button for a role that always 403s.
   */
  it('canAckSos matches its endpoint', () => {
    expect(rbac.canAckSos('OPS')).toBe(false);
    expect(rbac.canAckSos('SUPERVISOR')).toBe(true);
    expect(rbac.canAckSos('ADMIN')).toBe(true);
    expect(rbac.canAckSos(undefined)).toBe(false);
  });

  /**
   * The whole lane answers identically. The /sos page used to hand-roll
   * `role === 'SUPERVISOR' || role === 'ADMIN'` for escalate/resolve and gate
   * ack with nothing at all; a second dialect for one lane is how ack drifted
   * in the first place.
   */
  it('ack, escalate and resolve agree for every role', () => {
    for (const role of ROLES) {
      expect(rbac.canAckSos(role)).toBe(rbac.canEscalateSos(role));
      expect(rbac.canAckSos(role)).toBe(rbac.canResolveSos(role));
    }
  });
});

describe('E2E-44 — Pro internal notes are SUPERVISOR+', () => {
  /**
   * `@RequireRoles('SUPERVISOR','ADMIN')` on PUT
   * /ops/pro-applications/:id/internal-notes (pro-applications-ops.controller
   * .ts:117-118, OC-13). The textarea and SAVE NOTES button were ungated, so
   * an OPS operator typed a note and lost it on save.
   */
  it('canEditProInternalNotes matches its endpoint', () => {
    expect(rbac.canEditProInternalNotes('OPS')).toBe(false);
    expect(rbac.canEditProInternalNotes('SUPERVISOR')).toBe(true);
    expect(rbac.canEditProInternalNotes('ADMIN')).toBe(true);
    expect(rbac.canEditProInternalNotes(undefined)).toBe(false);
  });

  it('is its own capability, not an alias of the decision gate', () => {
    // They agree today. The pin is that BOTH exist: the RS-15 lesson is that a
    // borrowed gate is how two capabilities silently stop agreeing.
    expect(typeof rbac.canEditProInternalNotes).toBe('function');
    expect(typeof rbac.canDecideProApplication).toBe('function');
    expect(rbac.canEditProInternalNotes).not.toBe(rbac.canDecideProApplication);
  });
});

describe('no console gate is looser than its server counterpart', () => {
  /**
   * A blanket sweep over every SUPERVISOR+ endpoint the console mirrors. The
   * point is not the individual assertions (several are pinned above) — it is
   * that an OPS operator is never shown a control whose endpoint will refuse
   * them. Add a row here when you add a capability for a SUPERVISOR+ route.
   */
  const supervisorOnly: Array<[string, (r: 'OPS') => boolean]> = [
    ['canAckSos', rbac.canAckSos],
    ['canEscalateSos', rbac.canEscalateSos],
    ['canResolveSos', rbac.canResolveSos],
    ['canEditProInternalNotes', rbac.canEditProInternalNotes],
    ['canResolveReviewHold', rbac.canResolveReviewHold],
    ['canAbortMission', rbac.canAbortMission],
    ['canCompleteMission', rbac.canCompleteMission],
    ['canReroute', rbac.canReroute],
    ['canDecideProApplication', rbac.canDecideProApplication],
    ['canEndProtectionSession', rbac.canEndProtectionSession],
    ['canManageFamily', rbac.canManageFamily],
  ];

  it.each(supervisorOnly)('%s refuses OPS', (_name, fn) => {
    expect(fn('OPS')).toBe(false);
  });
});

describe('E2E-48 — the approve toast branches on evidence, never on a guess', () => {
  /**
   * The server publishes a job-feed row ONLY on the legacy manual lane; on the
   * auto lane it starts the offer cascade (ops.service.ts:750-754 vs :805).
   * The toast said "published to the job feed" either way, sending half of all
   * operators to watch a feed the booking would never appear on.
   */
  it('never claims a job feed publish on either auto path', () => {
    const now = approvalOutcome({dispatch_path: 'auto_dispatch', job_published: false}, 'auto');
    const later = approvalOutcome({dispatch_path: 'auto_scheduled', job_published: false}, 'auto');
    expect(now.kind).toBe('ok');
    expect(later.kind).toBe('ok');
    for (const o of [now, later]) expect(o.text).not.toMatch(/job feed/i);
    // The two auto paths are distinguishable — "offering now" vs "will search".
    expect(now.text).not.toBe(later.text);
  });

  it('says published only when the server says a job row was created', () => {
    const o = approvalOutcome({dispatch_path: 'job_feed', job_published: true}, null);
    expect(o.kind).toBe('ok');
    expect(o.text).toMatch(/job feed/i);
  });

  /**
   * The case the whole helper exists for. A legacy approve whose publish step
   * threw commits the approval anyway (ops.service.ts:761-805 deliberately does
   * not roll it back), so the booking is approved and invisible to every agent.
   * The old `job: null` response could not tell this from a healthy auto
   * approval, and it was toasted as a success.
   */
  it('a failed job-feed publish is an ERROR, not a success', () => {
    const o = approvalOutcome({dispatch_path: 'job_feed', job_published: false}, null);
    expect(o.kind).toBe('err');
    expect(o.text).toMatch(/manual/i);
  });

  it('degrades honestly against a server with no dispatch_path', () => {
    // job_published:true is unambiguous on its own.
    expect(approvalOutcome({job_published: true}, 'auto').text).toMatch(/job feed/i);
    // job_published:false is NOT — the booking's own lane breaks the tie.
    expect(approvalOutcome({job_published: false}, 'auto').kind).toBe('ok');
    expect(approvalOutcome({job_published: false}, null).kind).toBe('err');
    // Nothing at all on the wire: fall back to the row the browser holds.
    expect(approvalOutcome({}, 'auto').text).not.toMatch(/job feed/i);
    expect(approvalOutcome(undefined, 'auto').text).not.toMatch(/job feed/i);
  });

  it('claims nothing specific when the lane is genuinely unknown', () => {
    // `undefined` means the field was never on the wire at all. Asserting
    // either lane there would be the same guess this fix removed.
    const o = approvalOutcome(undefined, undefined);
    expect(o.kind).toBe('ok');
    expect(o.text).not.toMatch(/job feed|auto-dispatch/i);
  });
});

describe('E2E-04 — the approve start-time refusals', () => {
  /**
   * Mirrors `OpsService.APPROVE_START_PASSED` / `APPROVE_LEAD_TOO_SHORT`
   * (ops.service.ts:618-619). Retyped strings are how a console stops
   * recognising its own server's refusal and falls back to showing the raw
   * code to an operator.
   */
  it('the codes match the server constants', () => {
    expect(APPROVE_START_PASSED).toBe('booking_start_time_passed');
    expect(APPROVE_LEAD_TOO_SHORT).toBe('booking_insufficient_lead_time');
  });

  it('recognises a lead refusal and carries its numbers through', () => {
    const r = approveRefusalOf(apiError(400, {
      code: 'booking_insufficient_lead_time',
      message: 'This booking starts inside its 3-hour dispatch lead.',
      lead_hours: 3,
      start_time: '2026-09-04T10:00:00.000Z',
      earliest_start: '2026-09-04T12:00:00.000Z',
    }));
    expect(r?.code).toBe(APPROVE_LEAD_TOO_SHORT);
    // The floor is ops-editable per service — the console must never retype it.
    expect(r?.lead_hours).toBe(3);
    expect(r?.earliest_start).toBe('2026-09-04T12:00:00.000Z');
  });

  it('recognises a passed-start refusal, which carries no lead numbers', () => {
    const r = approveRefusalOf(apiError(400, {
      code: 'booking_start_time_passed',
      message: 'This booking\'s start time has already passed.',
      start_time: '2026-09-03T10:00:00.000Z',
    }));
    expect(r?.code).toBe(APPROVE_START_PASSED);
    expect(r?.lead_hours).toBeUndefined();
  });

  /**
   * The narrowing has to be strict: only these two codes may reach the
   * "confirm and retry with approve_late" affordance. A future refusal that
   * fell through into it would hand the operator an override button for a rule
   * `approve_late` does not override — and, worse, one that overrides NOTHING
   * would make the retry silently loop.
   */
  it('refuses to recognise anything else', () => {
    expect(approveRefusalOf(new Error('network down'))).toBeNull();
    expect(approveRefusalOf(apiError(409, {code: 'booking_not_pending'}, 'Conflict'))).toBeNull();
    expect(approveRefusalOf(apiError(400, null))).toBeNull();
    expect(approveRefusalOf(apiError(400, 'plain string body'))).toBeNull();
    expect(approveRefusalOf(undefined)).toBeNull();
    expect(approveRefusalOf(null)).toBeNull();
  });

  it('falls back to the error message when the body carries none', () => {
    const r = approveRefusalOf(apiError(400, {code: 'booking_start_time_passed'}, 'Bad Request'));
    expect(r?.message).toBe('Bad Request');
  });
});

describe('E2E-43 — a malformed poll env must cost the override, not the polling', () => {
  /**
   * SWR reads BOTH `NaN` and `0` as falsy on `refreshInterval` and responds by
   * DISABLING polling — silently. A console whose polls are dead still renders
   * its last payload and still looks live, so one typo in a deploy env used to
   * stop the console-wide SosAlertBar sweep (POLL_AMBER derives from POLL_DASH)
   * AND the Shell's `STALE_AFTER_MS = 3 * POLL_DASH`, which as NaN fails every
   * comparison — disabling the one indicator that would have revealed it.
   */
  it('honours a sane override', () => {
    expect(pollMs('8000', 5000)).toBe(8000);
    expect(pollMs('1', 5000)).toBe(1);
  });

  it.each([
    ['5s (unit suffix)', '5s'],
    ['empty (unset var)', ''],
    ['whitespace', '   '],
    ['zero — reaches SWR as "never poll"', '0'],
    ['negative', '-1000'],
    ['not a number', 'fast'],
    ['Infinity', 'Infinity'],
    ['undefined', undefined],
    ['null', null],
  ])('falls back on %s', (_label, raw) => {
    expect(pollMs(raw as string | undefined | null, 5000)).toBe(5000);
  });

  it('never returns a value SWR would treat as falsy', () => {
    const inputs = ['5s', '', '0', '-1', 'x', 'Infinity', 'NaN', undefined, null, '3000'];
    for (const raw of inputs) {
      const v = pollMs(raw as string | undefined | null, 5000);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });
});

describe('E2E-08 — a reserved Secure Pro date that will not happen', () => {
  /**
   * The row shape mirrors `reserved_today`. `officers_on_date` (cover on the
   * row's OWN date) and `officers_today` (cover on today) are BOTH present on
   * the wire and differ by one word — the extra field here is deliberate, so a
   * spec that reads the wrong one is visible rather than merely absent.
   */
  const row = (o: {
    officers_on_date?: number; officers_today?: number;
    is_today?: boolean; activated_at?: string | null;
  } = {}) => ({
    officers_on_date: 1, officers_today: 1,
    is_today: true, activated_at: '2026-09-04T06:00:00.000Z', ...o,
  });

  it('a covered, activated date raises nothing', () => {
    expect(reservedDateAlert(row())).toBeNull();
  });

  /**
   * The founder's question. The client's calendar says booked and the team chip
   * says ON DUTY; without this the console said nothing either.
   */
  it('no officer covering the date is the loudest failure', () => {
    expect(reservedDateAlert(row({officers_on_date: 0, officers_today: 0}))).toBe('no_officers');
  });

  it('today arrived and nothing activated', () => {
    expect(reservedDateAlert(row({activated_at: null}))).toBe('not_activated');
  });

  /**
   * The regression that shipped once. `officers_today` counts cover on TODAY
   * (pro-management.service.ts:406-408) while this row is tomorrow's, so a
   * reservation staffed by an officer starting tomorrow reports
   * `officers_today: 0` while being perfectly healthy. Reading that field would
   * paint it with a pulsing red NO OFFICERS ASSIGNED and tell the operator to
   * assign or cancel a booking that is fine.
   */
  it('a staffed TOMORROW row is healthy even though officers_today is 0', () => {
    expect(reservedDateAlert(row({
      is_today: false, officers_on_date: 1, officers_today: 0,
    }))).toBeNull();
  });

  /**
   * And the flip side — the alert this restores. An unassigned tomorrow date is
   * precisely what ops needs a day's notice on, so it must NOT be silenced.
   */
  it('an unassigned TOMORROW row alerts', () => {
    expect(reservedDateAlert(row({
      is_today: false, officers_on_date: 0, officers_today: 0,
    }))).toBe('no_officers');
  });

  /**
   * Rule 2 — a tomorrow row has not had its chance to activate yet. Flagging it
   * would put a permanent warning on every healthy future reservation and train
   * operators to ignore the flag.
   */
  it('a TOMORROW row is never "not activated"', () => {
    expect(reservedDateAlert(row({is_today: false, activated_at: null}))).toBeNull();
  });

  /**
   * Precedence matters because the two states have DIFFERENT ops actions:
   * unstaffed → assign officers or cancel; staffed-but-dead → chase the client
   * and officer. Reporting the downstream symptom sends the operator to the
   * wrong one.
   */
  it('no_officers outranks not_activated when both hold', () => {
    expect(reservedDateAlert(row({officers_on_date: 0, activated_at: null}))).toBe('no_officers');
  });

  it('treats a negative/absent count as uncovered, never as covered', () => {
    expect(reservedDateAlert(row({officers_on_date: -1}))).toBe('no_officers');
  });

  /**
   * The field-name pin, stated as a property rather than a single case: the
   * verdict must not move when only `officers_today` moves. Reverting the
   * implementation to `officers_today` fails this on both rows.
   */
  it('ignores officers_today entirely, on today AND tomorrow rows', () => {
    for (const is_today of [true, false]) {
      for (const officers_on_date of [0, 2]) {
        const withCover = reservedDateAlert(row({is_today, officers_on_date, officers_today: 5}));
        const without   = reservedDateAlert(row({is_today, officers_on_date, officers_today: 0}));
        expect(withCover).toBe(without);
      }
    }
  });
});

describe('B-812 — provider invitation codes are SUPERVISOR+ on the console', () => {
  /**
   * `@RequireRoles('SUPERVISOR','ADMIN')` on POST /ops/users/:id/provider-invites and
   * …/provider-invites/:code/revoke (ops-data.controller.ts). The card hides the
   * mint form and the REVOKE buttons for OPS, who would otherwise click into a 403.
   */
  it('canMintProviderInvite matches its endpoints', () => {
    expect(rbac.canMintProviderInvite('OPS')).toBe(false);
    expect(rbac.canMintProviderInvite('SUPERVISOR')).toBe(true);
    expect(rbac.canMintProviderInvite('ADMIN')).toBe(true);
    expect(rbac.canMintProviderInvite(undefined)).toBe(false);
  });
});

describe('B-836 — the linked-members roster is SUPERVISOR+ on the console', () => {
  /**
   * `@RequireRoles('SUPERVISOR','ADMIN')` on every `/ops/users/:id/family/*`
   * route (ops-data.controller.ts): the paged GET, the single and batch adds,
   * the limit and hold PATCHes, the revoke DELETE and the per-member spend
   * read. LinkedMembersCard gates its FETCH on this, not just its buttons — an
   * OPS viewer would otherwise 403 on every user page they open.
   */
  it('canManageFamily matches its endpoints', () => {
    expect(rbac.canManageFamily('OPS')).toBe(false);
    expect(rbac.canManageFamily('SUPERVISOR')).toBe(true);
    expect(rbac.canManageFamily('ADMIN')).toBe(true);
    expect(rbac.canManageFamily(undefined)).toBe(false);
  });

  it('is its own capability, not an alias of the provider-invite gate', () => {
    // Same RS-15 lesson as canEditProInternalNotes: they agree today, and a
    // borrowed gate is how two capabilities silently stop agreeing.
    expect(typeof rbac.canManageFamily).toBe('function');
    expect(rbac.canManageFamily).not.toBe(rbac.canMintProviderInvite);
  });
});
