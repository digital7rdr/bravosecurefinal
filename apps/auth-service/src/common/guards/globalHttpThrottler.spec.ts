import type {ExecutionContext} from '@nestjs/common';
import type {ThrottlerLimitDetail} from '@nestjs/throttler';

/**
 * E2E-20 (audit 2026-09-03) — global rate limiting was SHADOW MODE, forever.
 *
 * The guard read `THROTTLE_ENFORCE === 'true'` and that variable appeared in no
 * `.env*`, no compose file and no `infra/` file anywhere in the repo. The "ship
 * one release in shadow mode, then flip" plan in its own comment could therefore
 * never be executed: nothing was ever set, no `[throttle-shadow]` line was ever
 * read, and the limiter was decorative. At 5k users that is fleet-wide: one
 * runaway client loop saturates the 20-connection pg pool and every request then
 * blocks on `connectionTimeoutMillis`.
 *
 * The flag is read at CONSTRUCTION, so each case re-imports the module with the
 * env it wants (`jest.isolateModules` + `resetModules`).
 */

type Guard = {throwThrottlingException(c: ExecutionContext, d: ThrottlerLimitDetail): Promise<void>};

async function guardWith(value: string | undefined): Promise<Guard> {
  const prev = process.env['THROTTLE_ENFORCE'];
  if (value === undefined) {delete process.env['THROTTLE_ENFORCE'];}
  else {process.env['THROTTLE_ENFORCE'] = value;}
  try {
    jest.resetModules();
    const mod = await import('./global-http-throttler.guard');
    return new (mod.GlobalHttpThrottlerGuard as unknown as new () => Guard)();
  } finally {
    if (prev === undefined) {delete process.env['THROTTLE_ENFORCE'];}
    else {process.env['THROTTLE_ENFORCE'] = prev;}
  }
}

const ctx = {
  getType: () => 'http',
  switchToHttp: () => ({getRequest: () => ({method: 'GET', url: '/bookings', ip: '1.2.3.4'})}),
} as unknown as ExecutionContext;
const detail = {limit: 600, ttl: 60_000} as ThrottlerLimitDetail;

/** The guard's superclass throw is what a real 429 looks like. */
async function outcome(g: Guard): Promise<'threw' | 'passed'> {
  try {
    await g.throwThrottlingException(ctx, detail);
    return 'passed';
  } catch {
    return 'threw';
  }
}

describe('GlobalHttpThrottlerGuard — E2E-20 enforcement default', () => {
  beforeEach(() => jest.resetModules());

  it('ENFORCES when THROTTLE_ENFORCE is unset — the shipped default is safe, not silent', async () => {
    expect(await outcome(await guardWith(undefined))).toBe('threw');
  });

  it('ENFORCES on the explicit true (what every env example now ships)', async () => {
    expect(await outcome(await guardWith('true'))).toBe('threw');
  });

  it('falls back to shadow logging ONLY on an explicit false — the documented escape hatch', async () => {
    expect(await outcome(await guardWith('false'))).toBe('passed');
    expect(await outcome(await guardWith('FALSE'))).toBe('passed');
  });

  it('any other value enforces — a typo must fail CLOSED, never silently open', async () => {
    for (const v of ['', 'no', '0', 'off', 'yes', 'True']) {
      expect(await outcome(await guardWith(v))).toBe('threw');
    }
  });
});
