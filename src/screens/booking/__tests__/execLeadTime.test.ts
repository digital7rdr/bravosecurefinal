/**
 * Client mirror of the Executive Protection lead-time rule.
 *
 * EP became ALWAYS SCHEDULED on 2026-08-31 and its minimum lead time is
 * ops-configurable (`exec_min_lead_hours` on the live service-pricing board).
 * The client's job is to keep the picker from OFFERING an invalid start; the
 * server re-decides on every estimate and create against its own clock and its
 * own current config (BookingService.assertExecLeadTime), so nothing here is a
 * security boundary.
 *
 * What these pins protect:
 *   * the value is READ, never captured — hydration is async and "now" moves
 *     while the screen is open;
 *   * it FAILS OPEN to the shipped 3 h, so an offline or old-server client still
 *     agrees with the server rather than blocking every booking;
 *   * a nonsense override cannot make EP unbookable.
 */
import {
  execMinLeadHours,
  execEarliestStart,
  MIN_LEAD_HOURS,
  EXEC_LEAD_HOURS_MAX,
} from '../scheduleGate';
import {setServicePricingOverrides} from '../servicePricingOverrides';

const H = 3600_000;

afterEach(() => setServicePricingOverrides(null));

describe('execMinLeadHours — configurable, never hardcoded', () => {
  it('falls open to the shipped default when nothing has hydrated', () => {
    setServicePricingOverrides(null);
    expect(execMinLeadHours()).toBe(MIN_LEAD_HOURS);
    expect(MIN_LEAD_HOURS).toBe(3);
  });

  it.each([1, 3, 6, 12, 24, 48])('honours an ops-configured %ih lead', hours => {
    setServicePricingOverrides({exec_min_lead_hours: hours});
    expect(execMinLeadHours()).toBe(hours);
  });

  it('picks up a CHANGED value without a reload — it is read, not captured', () => {
    // Ops can raise the lead while a client sits on the booking screen. A value
    // captured in a module const or a mount-time memo would keep offering the
    // old minimum until the app restarted.
    setServicePricingOverrides({exec_min_lead_hours: 3});
    expect(execMinLeadHours()).toBe(3);
    setServicePricingOverrides({exec_min_lead_hours: 6});
    expect(execMinLeadHours()).toBe(6);
  });

  it.each([
    ['zero', 0],
    ['negative', -4],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['past the ceiling', EXEC_LEAD_HOURS_MAX + 1],
  ])('%s falls back to the default rather than blocking every booking', (_l, bad) => {
    setServicePricingOverrides({exec_min_lead_hours: bad as number});
    expect(execMinLeadHours()).toBe(MIN_LEAD_HOURS);
  });

  it('accepts the ceiling itself', () => {
    setServicePricingOverrides({exec_min_lead_hours: EXEC_LEAD_HOURS_MAX});
    expect(execMinLeadHours()).toBe(EXEC_LEAD_HOURS_MAX);
  });

  it('mirrors the server ceiling so the two cannot disagree', () => {
    // pricing.service.ts EXEC_LEAD_HOURS_MAX and the ops BOUNDS max.
    expect(EXEC_LEAD_HOURS_MAX).toBe(168);
  });
});

describe('execEarliestStart — the picker floor', () => {
  it('is exactly the configured lead from the given instant, snapped up to 5 min', () => {
    setServicePricingOverrides({exec_min_lead_hours: 3});
    // 10:00:00 -> +3h = 13:00, already on a 5-minute boundary.
    const at10 = new Date('2026-09-01T10:00:00.000Z').getTime();
    const e = execEarliestStart(at10);
    expect(e.getTime()).toBe(at10 + 3 * H);
  });

  it('snaps UP, never down — a rounded-down floor would offer an invalid start', () => {
    setServicePricingOverrides({exec_min_lead_hours: 3});
    const at = new Date('2026-09-01T10:02:30.000Z').getTime(); // +3h = 13:02:30
    const e = execEarliestStart(at);
    expect(e.getTime()).toBeGreaterThan(at + 3 * H);
    expect(e.getMinutes() % 5).toBe(0);
    expect(e.getSeconds()).toBe(0);
    expect(e.getMilliseconds()).toBe(0);
  });

  it('moves with the clock — a screen open for two hours must not keep its old floor', () => {
    // The §21/22 case: opened at 10:00 (floor 13:00), still open at 12:00 -> the
    // floor is 15:00. ExecReviewScreen re-floors on focus for exactly this.
    setServicePricingOverrides({exec_min_lead_hours: 3});
    const opened = new Date('2026-09-01T10:00:00.000Z').getTime();
    const later = opened + 2 * H;
    expect(execEarliestStart(later).getTime() - execEarliestStart(opened).getTime()).toBe(2 * H);
  });

  it('tracks a lead raised by ops mid-session', () => {
    const at = new Date('2026-09-01T10:00:00.000Z').getTime();
    setServicePricingOverrides({exec_min_lead_hours: 3});
    const three = execEarliestStart(at).getTime();
    setServicePricingOverrides({exec_min_lead_hours: 6});
    expect(execEarliestStart(at).getTime() - three).toBe(3 * H);
  });

  it('a floor ON a 5-minute boundary but carrying SECONDS still rounds UP (B-861 P2-1)', () => {
    setServicePricingOverrides({exec_min_lead_hours: 3});
    // 10:05:30 + 3h = 13:05:30. The old setMinutes(Math.ceil(5 / 5) * 5, 0, 0)
    // dropped the seconds and returned 13:05:00 — thirty seconds UNDER the
    // server's own lead gate, which is the only value the picker offers.
    const at = new Date('2026-09-01T10:05:30.000Z').getTime();
    const e = execEarliestStart(at);
    expect(e.getTime()).toBeGreaterThanOrEqual(at + 3 * H);
    expect(e.getSeconds()).toBe(0);
    expect(e.getMilliseconds()).toBe(0);
    expect(e.getMinutes() % 5).toBe(0);
  });

  it('crosses midnight correctly — a late-evening booking rolls to the next day', () => {
    // 23:00 + 3h = 02:00 the following day. Nothing may clamp this back into the
    // same calendar day; overnight EP blocks are ordinary.
    setServicePricingOverrides({exec_min_lead_hours: 3});
    const at2300 = new Date('2026-09-01T23:00:00.000Z').getTime();
    const e = execEarliestStart(at2300);
    expect(e.getTime()).toBe(at2300 + 3 * H);
    expect(e.getTime()).toBeGreaterThan(new Date('2026-09-02T00:00:00.000Z').getTime());
  });
});
