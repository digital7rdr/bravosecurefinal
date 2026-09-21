import {BookingPushBridge} from './booking-push-bridge.service';
import {PING_EXPIRY_MS} from '../attendance/attendance.service';
import type {RedisService} from '../redis/redis.service';
import type {NotificationsService} from '../notifications/notifications.service';

/**
 * P0-N8 / LB15 static opacity gate. The Redis `push:events` channel payload reaches
 * FCM/APNs in the clear (Google/Apple operate the intermediary), so it must be EXACTLY
 * {userId, eventClass, eventId} — never a bookingId/missionId/offerId/kind. The real
 * detail lives only in Redis behind the JWT-gated encrypted relay. This test fails if any
 * bridge method ever leaks a sensitive id onto the channel.
 */
function mk() {
  const publish = jest.fn().mockResolvedValue(1);
  const set = jest.fn().mockResolvedValue('OK');
  const redis = {client: {publish, set}} as unknown as RedisService;
  // N-20 — the durable inbox write rides alongside publish; it never touches
  // the FCM channel, so channel opacity is unaffected. Mock it here.
  const record = jest.fn().mockResolvedValue(undefined);
  const notifications = {record} as unknown as NotificationsService;
  const svc = new BookingPushBridge(redis, notifications);
  return {svc, publish, set, record};
}
function channelPayload(publish: jest.Mock): Record<string, unknown> {
  const call = publish.mock.calls.find(c => c[0] === BookingPushBridge.CHANNEL);
  if (!call) throw new Error('nothing published to the channel');
  return JSON.parse(call[1] as string) as Record<string, unknown>;
}

const ORG = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
// B-843 — the ROOT id a family refusal names is a real account identifier and
// joins the list: it must ride the JWT-gated blob, never the cleartext channel.
const SENSITIVE = ['b-booking-123', 'm-mission-456', 'o-offer-789', 'h-holder-777', ORG,
  // B-854 — the funding request id and the membership row id are real row
  // identifiers; a per-family fan-out map is exactly what P0-N8 forbids.
  'req-chain-1', 'fr-chain-2',
  // B-859 — the ping id addresses a location request and the shift id names a
  // real duty window; a per-shift fan-out map on the cleartext channel would
  // tell Google exactly who is on duty where, which is the P0-N8 leak.
  'p-ping-111', 'sh-shift-222'];

const cases: Array<[string, (s: BookingPushBridge) => Promise<void>]> = [
  ['dispatchOffer',     s => s.dispatchOffer('u1', 'b-booking-123')],
  ['jobPublished',      s => s.jobPublished(['u1'], 'b-booking-123', 'j-job-999')],
  ['providerAccepted',  s => s.providerAccepted('u1', 'b-booking-123')],
  ['noProvider',        s => s.noProvider('u1', 'b-booking-123')],
  ['agencyNoShow',      s => s.agencyNoShow('u1', 'b-booking-123')],
  ['bookingApproved',   s => s.bookingApproved('u1', 'b-booking-123')],
  // B-405 — T-60 scheduled-start reminder rides the same opaque channel.
  ['bookingReminder',   s => s.bookingReminder('u1', 'b-booking-123')],
  ['missionDispatched', s => s.missionDispatched('u1', 'm-mission-456', 'b-booking-123')],
  ['missionAborted',    s => s.missionAborted('u1', 'm-mission-456', 'b-booking-123')],
  ['payoutSettled',     s => s.payoutSettled('u1', 'b-booking-123', 500)],
  ['agentDecided',      s => s.agentDecided('u1', 'APPROVED')],
  ['sosAlert',          s => s.sosAlert(['u1'], 'm-mission-456', 'b-booking-123')],
  // R13-2 — enterprise join loop. The blob carries only the kind; the channel
  // triple must stay opaque like every other class.
  ['enterpriseJoinRequested', s => s.enterpriseJoinRequested('u1')],
  ['enterpriseJoinDecided',   s => s.enterpriseJoinDecided('u1', 'approved')],
  // Dept Chat v2 incidents — previously uncovered by this spec (2026-08-07).
  ['incidentSubmitted',       s => s.incidentSubmitted(['u1'], 'ref-1', 'high')],
  ['incidentStatusChanged',   s => s.incidentStatusChanged('u1', 'ref-1', 'resolved')],
  // vs2 edge A1/A2 — the org id is a REAL tenant identifier. It rides the
  // JWT-gated blob and the recipient-scoped inbox row; it must never reach the
  // cleartext channel, where it would hand Google/Apple a per-org fan-out map.
  ['incidentSubmitted+org',       s => s.incidentSubmitted(['u1'], 'ref-1', 'high', {orgId: ORG})],
  ['enterpriseJoinRequested+org', s => s.enterpriseJoinRequested('u1', ORG)],
  ['enterpriseInviteAccepted+org', s => s.enterpriseInviteAccepted('u1', ORG)],
  // B-724 — the pre-charge family deny wake rides the same opaque channel.
  // B-843 — it now names the ROOT it was refused by; that id must stay off the
  // cleartext channel like every other real identifier.
  ['familySpendDenied', s => s.familySpendDenied('u1', 'h-holder-777')],
  // B-854 (A11) — the three chained-credit wakes. `requestId` and `familyRowId`
  // are real row identifiers and join the list: they ride the JWT-gated blob,
  // never the cleartext channel.
  ['familyFundingRequested', s => s.familyFundingRequested('u1', 'fr-chain-2', 'req-chain-1')],
  ['familyFundingDecided',   s => s.familyFundingDecided('u1', 'fr-chain-2', 'req-chain-1', 'approved')],
  ['familyFundingChanged',   s => s.familyFundingChanged('u1', 'fr-chain-2', true)],
  // E2E-06 — the client no-show closure wake.
  ['clientNoShow', s => s.clientNoShow('u1', 'b-booking-123')],
  // E2E-01 — the Pro reserved-date activation wake (carries TWO ids).
  ['proMissionLive', s => s.proMissionLive('u1', 'app-abc-1', 'sess-xyz-2')],
  // B-859 — the manager's "where are you" ping (carries TWO ids).
  ['attendancePing', s => s.attendancePing('u1', 'p-ping-111', 'sh-shift-222')],
];

describe('BookingPushBridge — channel opacity (P0-N8)', () => {
  it.each(cases)('%s publishes EXACTLY {userId,eventClass,eventId} — no sensitive id', async (_name, fn) => {
    const {svc, publish, set} = mk();
    await fn(svc);
    // The channel payload carries only the opaque triple.
    const payload = channelPayload(publish);
    expect(Object.keys(payload).sort()).toEqual(['eventClass', 'eventId', 'userId']);
    const raw = JSON.stringify(payload);
    for (const id of SENSITIVE) expect(raw).not.toContain(id);
    // The sensitive detail goes to Redis (push-event:<id>), never the channel.
    expect(set).toHaveBeenCalledWith(expect.stringMatching(/^push-event:/), expect.any(String), 'EX', expect.any(Number));
  });

  it('eventClass stays coarse (one of the allowed category labels)', async () => {
    const allowed = new Set(['agent', 'booking', 'mission', 'payout', 'sos', 'dispatch', 'enterprise', 'incident']);
    for (const [, fn] of cases) {
      const {svc, publish} = mk();
      await fn(svc);
      expect(allowed.has(channelPayload(publish).eventClass as string)).toBe(true);
    }
  });

  /**
   * E2E-06 — the client's no-show wake used to ride `refundIssued`, which reads
   * as an ordinary refund and never says the detail was closed because the team
   * could not reach them. `detail-*`, not `mission-*`: this is the CLIENT copy
   * and `kindToActivityClass` keys the activity class off the prefix.
   *
   * NOTE for the mobile lane: a new `kind:` literal in the bridge must gain a row
   * in all three client maps or `src/screens/booking/__tests__/
   * serverWakeKindParity.test.ts` (app project) goes red — AGENT_WAKE_META,
   * activitySync KIND_META, and the fcmBootstrap tap router.
   */
  /**
   * E2E-01 — the Pro reserved-date activation. It used to ride
   * `pro-mission-update`, whose copy answers a REQUEST and whose tap route opens
   * the application thread — the wrong screen on the one day the product delivers.
   *
   * NOTE for the push-routing lane: same three client maps as `detail-no-show`
   * (AGENT_WAKE_META, activitySync KIND_META, fcmBootstrap) or the app-project
   * `serverWakeKindParity.test.ts` goes red.
   */
  it('proMissionLive publishes pro-mission-live on the booking class with BOTH ids, ids only', async () => {
    const {svc, set, record} = mk();
    await svc.proMissionLive('u1', 'app-abc-1', 'sess-xyz-2');
    const blob = JSON.parse(set.mock.calls[0][1] as string) as Record<string, unknown>;
    expect(blob).toEqual({kind: 'pro-mission-live', applicationId: 'app-abc-1', sessionId: 'sess-xyz-2'});
    // Distinct from the request-answered kind it used to reuse.
    expect(blob.kind).not.toBe('pro-mission-update');
    expect(record).toHaveBeenCalledWith('u1', expect.objectContaining({
      eventClass: 'booking', kind: 'pro-mission-live',
    }));
  });

  /**
   * B-854 (A11) — the three chained-credit kinds.
   *
   * NOTE for the mobile lane: each new `kind:` literal needs a row in all three
   * client maps or `src/screens/booking/__tests__/serverWakeKindParity.test.ts`
   * (app project) goes red — AGENT_WAKE_META, activitySync KIND_META, and the
   * fcmBootstrap tap router (root → the members screen, member → their
   * memberships card).
   */
  it('the funding wakes carry ids + enums ONLY — no name, no amount, no balance', async () => {
    // Every one of the three carries the ROW id: it is the only handle that
    // addresses a card/row on either side. The holder's roster is keyed by
    // membership row, and a request id alone focuses nothing.
    const {svc, set, record} = mk();
    await svc.familyFundingRequested('u1', 'fr-chain-2', 'req-chain-1');
    expect(JSON.parse(set.mock.calls[0][1] as string)).toEqual({
      kind: 'family-funding-requested', familyRowId: 'fr-chain-2', requestId: 'req-chain-1',
    });
    expect(record).toHaveBeenCalledWith('u1', expect.objectContaining({
      eventClass: 'booking', kind: 'family-funding-requested',
    }));

    // The decision wake carries the ROW id as well as the request id: the
    // client keys its card highlight on `familyRowId` (a member may be under
    // several roots, and the request id alone addresses no card). Ids + enum.
    const b = mk();
    await b.svc.familyFundingDecided('u2', 'fr-chain-2', 'req-chain-1', 'declined');
    expect(JSON.parse(b.set.mock.calls[0][1] as string)).toEqual({
      kind: 'family-funding-decided', familyRowId: 'fr-chain-2',
      requestId: 'req-chain-1', decision: 'declined',
    });

    // A console approve with no request on file still addresses the card.
    const d = mk();
    await d.svc.familyFundingDecided('u2', 'fr-chain-2', null, 'approved');
    expect(JSON.parse(d.set.mock.calls[0][1] as string)).toEqual({
      kind: 'family-funding-decided', familyRowId: 'fr-chain-2',
      requestId: null, decision: 'approved',
    });

    const c = mk();
    await c.svc.familyFundingChanged('u3', 'fr-chain-2', false);
    expect(JSON.parse(c.set.mock.calls[0][1] as string)).toEqual({
      kind: 'family-funding-changed', familyRowId: 'fr-chain-2', enabled: false,
    });
  });

  it('all three funding kinds carry familyRowId — the one handle that addresses a row', async () => {
    // Asserted as a SET rather than three separate cases: the client focuses a
    // row off this field on both sides, so a kind that omits it lands the user
    // on a list with nothing highlighted. Cheap to add, invisible when missing.
    const blobs: Array<Record<string, unknown>> = [];
    for (const fn of [
      (s: BookingPushBridge) => s.familyFundingRequested('u1', 'fr-chain-2', 'req-chain-1'),
      (s: BookingPushBridge) => s.familyFundingDecided('u1', 'fr-chain-2', 'req-chain-1', 'approved'),
      (s: BookingPushBridge) => s.familyFundingChanged('u1', 'fr-chain-2', true),
    ]) {
      const h = mk();
      await fn(h.svc);
      blobs.push(JSON.parse(h.set.mock.calls[0][1] as string) as Record<string, unknown>);
    }
    expect(blobs.map(b => b.familyRowId)).toEqual(['fr-chain-2', 'fr-chain-2', 'fr-chain-2']);
  });

  /**
   * B-859 — the attendance location ping.
   *
   * The wake is the ONLY thing that reaches a worker whose app is not on
   * screen, and the whole feature is a single location fix, so the payload is
   * held to two ids: the ping id (the handle the answer route takes) and the
   * shift id (which duty it belongs to). A manager name, a site label or a
   * department here would put "who is on duty where" on the cleartext lane.
   *
   * NOTE for the mobile lane: this new `kind:` literal needs a row in all three
   * client maps or `src/screens/booking/__tests__/serverWakeKindParity.test.ts`
   * (app project) goes red — AGENT_WAKE_META, activitySync KIND_META, and the
   * fcmBootstrap tap router (→ the responder that takes the fix).
   */
  it('attendancePing publishes attendance-ping on the incident class with BOTH ids, ids only', async () => {
    const {svc, set, record} = mk();
    await svc.attendancePing('worker-1', 'p-ping-111', 'sh-shift-222');
    const blob = JSON.parse(set.mock.calls[0][1] as string) as Record<string, unknown>;
    expect(blob).toEqual({kind: 'attendance-ping', pingId: 'p-ping-111', shiftId: 'sh-shift-222'});
    // The high-priority lane: messenger-service promotes 'incident', and the
    // ask is dead in 10 minutes. A normal-priority class would let Doze eat it.
    expect(record).toHaveBeenCalledWith('worker-1', expect.objectContaining({
      eventClass: 'incident', kind: 'attendance-ping',
    }));
    // Recipient-bound blob key — the worker is the only account that can
    // hydrate their own location request.
    expect(String(set.mock.calls[0][0])).toMatch(/^push-event:worker-1:/);
  });

  /**
   * B-859 — THE HYDRATION BLOB MUST OUTLIVE THE THING IT IS THE ONLY WAY TO ACT ON.
   *
   * The wake carries opaque ids only, so a device that hydrates to a 404 gets
   * `kind === ''`: no card, no bell row, and — for a ping — no way to answer
   * before it expires. Two floors apply and the SMALLER TTL always loses:
   *
   *   - messenger-service's `android.ttl` is 600 s (push.service.ts). A blob
   *     shorter than that dies while FCM still considers the wake deliverable,
   *     which is verbatim the N-27 defect that raised this constant 300→900.
   *   - the ping itself lives PING_EXPIRY_MS (600 s), imported here rather than
   *     retyped so the two cannot drift apart silently.
   *
   * A per-kind 600 s override for `attendance-ping` was proposed and REJECTED
   * on exactly this arithmetic: it would have made the ping the one kind whose
   * blob dies before its own wake. Do not re-propose it — raise the shared
   * constant if a future kind needs longer.
   */
  const FCM_ANDROID_TTL_SECONDS = 600; // messenger-service push.service.ts

  /**
   * CONTENT-ADDRESSED, never `set.mock.calls[0]`: `familySpendDenied` claims a
   * `family:deny-notify:` throttle marker through the same `set` BEFORE the
   * blob, so a positional read silently asserts against the marker's TTL
   * instead — which is how the first cut of this test reported two TTLs.
   */
  const blobTtl = (set: jest.Mock): number => {
    const call = set.mock.calls.find(c => String(c[0]).startsWith('push-event:'));
    if (!call) {throw new Error('no hydration blob was stored');}
    return call[3] as number;
  };

  it('the attendance-ping blob outlives BOTH the ping and the FCM wake that carries it', async () => {
    const {svc, set} = mk();
    await svc.attendancePing('u1', 'p-ping-111', 'sh-shift-222');
    const call = set.mock.calls.find(c => String(c[0]).startsWith('push-event:'))!;
    expect(call[0]).toMatch(/^push-event:u1:/);
    expect(call[2]).toBe('EX');
    expect(blobTtl(set)).toBeGreaterThanOrEqual(PING_EXPIRY_MS / 1000);
    expect(blobTtl(set)).toBeGreaterThanOrEqual(FCM_ANDROID_TTL_SECONDS);
  });

  it('ONE TTL for every kind — no per-kind override exists to drift', async () => {
    // The shape that made the override tempting is the shape that would let a
    // future kind quietly get a blob shorter than its own wake. There is one
    // number; this asserts every publisher still uses it.
    const ttls = new Set<number>();
    for (const [, fn] of cases) {
      const {svc, set} = mk();
      await fn(svc);
      ttls.add(blobTtl(set));
    }
    expect(ttls.size).toBe(1);
    expect([...ttls][0]).toBeGreaterThanOrEqual(FCM_ANDROID_TTL_SECONDS);
  });

  it('clientNoShow publishes the detail-no-show kind on the booking class, ids only', async () => {
    const {svc, set, record} = mk();
    await svc.clientNoShow('u1', 'b-booking-123');
    const blob = JSON.parse(set.mock.calls[0][1] as string) as Record<string, unknown>;
    expect(blob).toEqual({kind: 'detail-no-show', bookingId: 'b-booking-123'});
    expect(record).toHaveBeenCalledWith('u1', expect.objectContaining({
      eventClass: 'booking', kind: 'detail-no-show', bookingId: 'b-booking-123',
    }));
  });
});

describe('BookingPushBridge — durable-row independence (N-20, edge-case review 2026-08-07)', () => {
  // The inbox row is the ONE sink that exists for when the transient lane
  // fails. With the row written last-and-inside the Redis try, a Redis outage
  // (ioredis MaxRetriesPerRequestError) skipped it too — no wake AND no bell
  // row, ever. The row is now written AFTER the wake but OUTSIDE the Redis
  // try: latency first, durability unconditional.
  it('a Redis outage does NOT lose the durable inbox row', async () => {
    const {svc, set, record} = mk();
    set.mockRejectedValue(new Error('MaxRetriesPerRequestError'));
    await svc.enterpriseJoinRequested('u1');
    expect(record).toHaveBeenCalledWith('u1', expect.objectContaining({
      eventClass: 'enterprise', kind: 'enterprise.join.requested',
    }));
  });

  it('wake first, durable row after — but UNCONDITIONAL (mutation: move record back inside the try → RED above)', async () => {
    // Wake latency wins the ordering (an SOS fan-out must not queue behind
    // Postgres inserts); durability is preserved by keeping record OUTSIDE the
    // Redis try — the outage test above is the half that pins that.
    const {svc, set, record} = mk();
    await svc.enterpriseJoinDecided('u1', 'declined');
    const recordOrder = record.mock.invocationCallOrder[0];
    const setOrder = set.mock.invocationCallOrder[0];
    expect(setOrder).toBeLessThan(recordOrder);
  });

  it('vs2 edge A1/A2 — the org id reaches BOTH lanes (blob and durable row)', async () => {
    // The transient blob and the durable row are read by different doors (push
    // tap vs bell row) and the bell row is the one that survives a killed app
    // past the hydration TTL — i.e. exactly the cold tap that fails on every
    // non-default org. Threading it into only one lane fixes half the bug.
    const {svc, set, record} = mk();
    await svc.incidentSubmitted(['u1'], 'ref-1', 'high', {incidentId: 'inc-1', orgId: ORG});
    const blob = JSON.parse(set.mock.calls[0][1] as string) as Record<string, unknown>;
    expect(blob.orgId).toBe(ORG);
    expect(record).toHaveBeenCalledWith('u1', expect.objectContaining({orgUserId: ORG}));
  });

  it('an org-less wake writes NULL, never the string "undefined"', async () => {
    const {svc, record} = mk();
    await svc.enterpriseJoinDecided('u1', 'approved');
    expect(record).toHaveBeenCalledWith('u1', expect.objectContaining({orgUserId: null}));
  });

  it('a rejecting record() still never rejects to the caller', async () => {
    const {svc, record} = mk();
    record.mockRejectedValue(new Error('pg down'));
    await expect(svc.enterpriseJoinRequested('u1')).resolves.toBeUndefined();
  });

  it('a publish failure never rejects to the caller (fire-and-forget contract)', async () => {
    const {svc, set} = mk();
    set.mockRejectedValue(new Error('down'));
    await expect(svc.enterpriseJoinRequested('u1')).resolves.toBeUndefined();
  });

  // B-724 — the deny wake is NX-throttled: a re-tap storm cannot ding per tap.
  it('familySpendDenied publishes once per throttle window', async () => {
    const {svc, publish, set} = mk();
    await svc.familySpendDenied('u1', 'h1');      // marker SET → 'OK' → publishes
    set.mockResolvedValueOnce(null);              // second attempt loses the NX claim
    await svc.familySpendDenied('u1', 'h1');
    const channelPubs = publish.mock.calls.filter(c => c[0] === BookingPushBridge.CHANNEL);
    expect(channelPubs).toHaveLength(1);
  });

  // B-843 — the throttle is per (member, ROOT). It used to be member-wide, so a
  // member refused by root A went SILENT about root B for ten minutes — two
  // different roots are two different problems with two different fixes.
  it('B-843: the deny throttle is keyed per ROOT, so a second root still wakes', async () => {
    const {svc, publish, set} = mk();
    await svc.familySpendDenied('u1', 'h1');
    await svc.familySpendDenied('u1', 'h2');
    const keys = set.mock.calls.map(c => String(c[0])).filter(k => k.startsWith('family:deny-notify:'));
    expect(keys).toEqual(['family:deny-notify:u1:h1', 'family:deny-notify:u1:h2']);
    const channelPubs = publish.mock.calls.filter(c => c[0] === BookingPushBridge.CHANNEL);
    expect(channelPubs).toHaveLength(2);
  });

  it('B-843: a SELF-payer denial keys on the literal "self", never on "undefined"', async () => {
    const {svc, set} = mk();
    await svc.familySpendDenied('u1', null);
    const keys = set.mock.calls.map(c => String(c[0])).filter(k => k.startsWith('family:deny-notify:'));
    expect(keys).toEqual(['family:deny-notify:u1:self']);
  });

  it('familySpendDenied fails OPEN when the throttle marker read errors', async () => {
    const {svc, publish, set} = mk();
    set.mockRejectedValueOnce(new Error('redis down'));  // marker claim fails…
    set.mockResolvedValue('OK');                         // …wake blob write still works
    await svc.familySpendDenied('u1', 'h1');
    const channelPubs = publish.mock.calls.filter(c => c[0] === BookingPushBridge.CHANNEL);
    expect(channelPubs).toHaveLength(1); // a duplicate ding beats silence
  });
});
