/**
 * PG-M1/M2/M3 — reaction and mutation INTENTS route to the reseal lane.
 *
 * `sendReaction` / `sendMutationDirective` now write one intent row per
 * recipient BEFORE any crypto or network round-trip, so a cold offline boot
 * (no sender cert) queues instead of throwing. The drain must classify those
 * rows as re-sealable — `isUnresealableDeferred` used to admit only the direct
 * and group body shapes, which would have DROPPED them as 'unresealable'.
 */
import {
  buildDeferredMutationOutboxPayload,
  buildDeferredReactionOutboxPayload,
  isUnresealableDeferred,
  planOutboxDrain,
} from '../runtime/deferredOutbox';

const NOW_MS = 1_800_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);
const FRESH_CERT = NOW_SEC + 3600;

describe('PG-M2 — deferred reaction intent', () => {
  const payload = buildDeferredReactionOutboxPayload({
    reaction:    {targetMsgId: 'm-1', emoji: '👍'},
    group:       {groupId: 'g-1', kind: 'text', clientMsgId: 'c-1'},
    clientMsgId: 'c-1',
  });

  it('plans as a re-seal (never a drop), carrying the directive and the group stamp', () => {
    const plan = planOutboxDrain(JSON.stringify(payload), NOW_MS);
    expect(plan.mode).toBe('reseal');
    if (plan.mode !== 'reseal') {return;}
    expect(plan.staleCert).toBe(false);
    expect(plan.payload.resealKind).toBe('reaction');
    expect(plan.payload.reaction).toEqual({targetMsgId: 'm-1', emoji: '👍'});
    expect(plan.payload.group?.groupId).toBe('g-1');
  });

  it('a 1:1 intent (no group stamp) plans the same way', () => {
    const direct = buildDeferredReactionOutboxPayload({reaction: {targetMsgId: 'm-1', emoji: '❤️', remove: true}, clientMsgId: 'c-2'});
    expect(planOutboxDrain(JSON.stringify(direct), NOW_MS).mode).toBe('reseal');
    expect(isUnresealableDeferred(direct)).toBe(false);
  });

  it('an intent that lost its directive (downgrade) is unresealable and dropped, never looped', () => {
    const broken = {...payload, reaction: undefined};
    expect(isUnresealableDeferred(broken)).toBe(true);
    expect(planOutboxDrain(JSON.stringify(broken), NOW_MS)).toEqual({mode: 'drop', reason: 'unresealable'});
  });
});

describe('PG-M6r — a row queued past its TTL never ships', () => {
  it('an expired sealed or deferred row drops as expired (the drop handler reds the bubble)', () => {
    const sealed = JSON.stringify({outerSealed: 'X', certExpSec: FRESH_CERT, expiresAtSec: NOW_SEC - 10});
    expect(planOutboxDrain(sealed, NOW_MS)).toEqual({mode: 'drop', reason: 'expired'});
    const deferred = JSON.stringify({deferred: true, direct: true, body: 'x', clientMsgId: 'c', expiresAtSec: NOW_SEC - 10});
    expect(planOutboxDrain(deferred, NOW_MS)).toEqual({mode: 'drop', reason: 'expired'});
  });

  it('a future TTL still ships, and key-material rows are exempt (GF-2)', () => {
    const future = JSON.stringify({outerSealed: 'X', certExpSec: FRESH_CERT, expiresAtSec: NOW_SEC + 100});
    expect(planOutboxDrain(future, NOW_MS).mode).toBe('ship');
    const km = JSON.stringify({outerSealed: 'X', certExpSec: FRESH_CERT, keyMaterial: true, expiresAtSec: NOW_SEC - 10});
    expect(planOutboxDrain(km, NOW_MS).mode).toBe('ship');
  });

  it('PG-M10r — a sealed reaction/mutation ship plan carries noBubble', () => {
    const sealedReaction = JSON.stringify({outerSealed: 'X', certExpSec: FRESH_CERT, resealKind: 'reaction', reaction: {targetMsgId: 'm', emoji: 'x'}, clientMsgId: 'c'});
    const plan = planOutboxDrain(sealedReaction, NOW_MS);
    expect(plan.mode).toBe('ship');
    if (plan.mode === 'ship') {expect(plan.noBubble).toBe(true);}
    const text = JSON.stringify({outerSealed: 'X', certExpSec: FRESH_CERT});
    const textPlan = planOutboxDrain(text, NOW_MS);
    if (textPlan.mode === 'ship') {expect(textPlan.noBubble).toBeUndefined();}
  });
});

describe('PG-M1/M3 — deferred mutation intent', () => {
  it('a delete-for-everyone intent plans as a re-seal with the directive intact', () => {
    const del = buildDeferredMutationOutboxPayload({
      mutation:    {deleteFor: {targetMsgId: 'm-9', deletedAt: NOW_MS}},
      clientMsgId: 'c-3',
    });
    const plan = planOutboxDrain(JSON.stringify(del), NOW_MS);
    expect(plan.mode).toBe('reseal');
    if (plan.mode !== 'reseal') {return;}
    expect(plan.payload.resealKind).toBe('mutation');
    expect(plan.payload.deleteFor?.targetMsgId).toBe('m-9');
    expect(plan.payload.edit).toBeUndefined();
  });

  it('an edit intent in a group keeps its carrier stamp', () => {
    const edit = buildDeferredMutationOutboxPayload({
      mutation:    {edit: {targetMsgId: 'm-9', body: 'fixed', editedAt: NOW_MS}},
      group:       {groupId: 'g-1', kind: 'text', clientMsgId: 'c-4'},
      clientMsgId: 'c-4',
    });
    const plan = planOutboxDrain(JSON.stringify(edit), NOW_MS);
    expect(plan.mode).toBe('reseal');
    if (plan.mode !== 'reseal') {return;}
    expect(plan.payload.edit?.body).toBe('fixed');
    expect(plan.payload.group?.groupId).toBe('g-1');
  });

  it('a mutation intent with neither edit nor deleteFor is unresealable', () => {
    const broken = buildDeferredMutationOutboxPayload({mutation: {}, clientMsgId: 'c-5'});
    expect(isUnresealableDeferred(broken)).toBe(true);
    expect(planOutboxDrain(JSON.stringify(broken), NOW_MS)).toEqual({mode: 'drop', reason: 'unresealable'});
  });
});
