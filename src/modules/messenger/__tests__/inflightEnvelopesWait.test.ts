/**
 * B-776 rider — waitForNoInFlightEnvelopes (inflightEnvelopes.ts).
 *
 *  - empty registry → resolves 'idle' immediately (no timer armed);
 *  - resolves 'idle' the moment the last hold is released;
 *  - a hold that never releases → 'timeout' after maxMs (the wake drain then
 *    pulls exactly as before);
 *  - a stale token's release (not the current holder) does not resolve it;
 *  - resetInflightRegistry() resolves waiters (logout must not strand a wake).
 */
import {
  tryAcquireEnvelope,
  releaseEnvelope,
  resetInflightRegistry,
  waitForNoInFlightEnvelopes,
  inFlightEnvelopeCount,
  INFLIGHT_STALE_MS,
} from '../runtime/inflightEnvelopes';

describe('waitForNoInFlightEnvelopes (B-776 rider)', () => {
  beforeEach(() => { resetInflightRegistry(); jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('resolves idle immediately when nothing is in flight', async () => {
    await expect(waitForNoInFlightEnvelopes(3000)).resolves.toBe('idle');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('resolves idle when the last hold is released', async () => {
    const t1 = tryAcquireEnvelope('env-1') as number;
    const t2 = tryAcquireEnvelope('env-2') as number;
    let result: string | null = null;
    void waitForNoInFlightEnvelopes(3000).then(r => { result = r; });
    releaseEnvelope('env-1', t1);
    await Promise.resolve();
    expect(result).toBeNull(); // one still in flight
    releaseEnvelope('env-2', t2);
    await Promise.resolve();
    expect(result).toBe('idle');
    expect(inFlightEnvelopeCount()).toBe(0);
    expect(jest.getTimerCount()).toBe(0); // the timeout was cleared
  });

  it('times out when a hold never releases', async () => {
    tryAcquireEnvelope('stuck');
    const p = waitForNoInFlightEnvelopes(3000);
    jest.advanceTimersByTime(2999);
    await Promise.resolve();
    jest.advanceTimersByTime(1);
    await expect(p).resolves.toBe('timeout');
  });

  it('a release with a stale token does not count', async () => {
    const t1 = tryAcquireEnvelope('env-1') as number;
    let result: string | null = null;
    void waitForNoInFlightEnvelopes(3000).then(r => { result = r; });
    releaseEnvelope('env-1', t1 + 999);
    await Promise.resolve();
    expect(result).toBeNull();
    releaseEnvelope('env-1', t1);
    await Promise.resolve();
    expect(result).toBe('idle');
  });

  it('a STALE hold (wedged receive) does not count — the next wake drain is not taxed forever (critic F3)', async () => {
    jest.setSystemTime(5_000_000);
    tryAcquireEnvelope('wedged'); // never released
    jest.setSystemTime(5_000_000 + INFLIGHT_STALE_MS + 1);
    expect(inFlightEnvelopeCount()).toBe(0);
    await expect(waitForNoInFlightEnvelopes(3000)).resolves.toBe('idle');
    // A LIVE hold next to the stale one still gates, and its release resolves.
    const t = tryAcquireEnvelope('live') as number;
    let result: string | null = null;
    void waitForNoInFlightEnvelopes(3000).then(r => { result = r; });
    await Promise.resolve();
    expect(result).toBeNull();
    releaseEnvelope('live', t);
    await Promise.resolve();
    expect(result).toBe('idle');
  });

  it('resetInflightRegistry resolves waiters', async () => {
    tryAcquireEnvelope('env-1');
    const p = waitForNoInFlightEnvelopes(3000);
    resetInflightRegistry();
    await expect(p).resolves.toBe('idle');
  });
});
