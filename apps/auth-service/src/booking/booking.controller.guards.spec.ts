import 'reflect-metadata';
import {GUARDS_METADATA, INTERCEPTORS_METADATA} from '@nestjs/common/constants';
import {ThrottlerGuard} from '@nestjs/throttler';
import {BookingController} from './booking.controller';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';
import {OptionalIdempotencyInterceptor} from '../common/interceptors/optional-idempotency.interceptor';

/**
 * E2E-23 / E2E-36 (audit 2026-09-03) — the LEGACY `POST /bookings` route.
 *
 * It was a bare `@Post()`: no throttle, no idempotency, and the only
 * one-active-booking enforcement was a read-then-throw two concurrent submits
 * walk straight through. It is NOT a legacy corner — the mobile client uses it
 * for every user whose `auto_dispatch_enabled` is false.
 *
 * These are decorator-metadata pins. They cannot prove runtime behaviour, but
 * they DO catch the way this regresses: someone reorders the decorators, moves
 * the guard to the class, or swaps the interceptor out.
 */
const THROTTLER_LIMIT_DEFAULT = 'THROTTLER:LIMITdefault';
const THROTTLER_TTL_DEFAULT = 'THROTTLER:TTLdefault';

type Ctor = new (...a: never[]) => unknown;
const guardsOn = (t: object): Ctor[] => (Reflect.getMetadata(GUARDS_METADATA, t) ?? []) as Ctor[];
const interceptorsOn = (t: object): Ctor[] => (Reflect.getMetadata(INTERCEPTORS_METADATA, t) ?? []) as Ctor[];

describe('POST /bookings — E2E-23 route hardening', () => {
  const create = BookingController.prototype.create;

  it('carries the SAME per-user throttle as /dispatch/request (5 per minute)', () => {
    expect(Reflect.getMetadata(THROTTLER_LIMIT_DEFAULT, create)).toBe(5);
    expect(Reflect.getMetadata(THROTTLER_TTL_DEFAULT, create)).toBe(60_000);
  });

  it('binds UserThrottlerGuard so the bucket is per-USER, not per-IP behind a carrier NAT', () => {
    expect(guardsOn(create).map(g => g.name)).toContain(UserThrottlerGuard.name);
  });

  it('binds the throttler guard on the HANDLER, never on the controller class', () => {
    // GlobalHttpThrottlerGuard.shouldSkip() reads the CLASS metadata too, so a
    // controller-level ThrottlerGuard here would silently remove the global
    // ceiling from EVERY other booking route (list, estimate, get, cancel…).
    const classGuards = guardsOn(BookingController);
    expect(classGuards.map(g => g.name)).toEqual([JwtAuthGuard.name]);
    expect(classGuards.some(g => g === ThrottlerGuard || g.prototype instanceof ThrottlerGuard)).toBe(false);
  });

  it('wraps create in the KEY-OPTIONAL idempotency interceptor', () => {
    const names = interceptorsOn(create).map(i => i.name);
    expect(names).toContain(OptionalIdempotencyInterceptor.name);
    // Deliberately NOT the strict one: `bookingApi.create` sends no
    // Idempotency-Key, so the strict interceptor would 400 every legacy booking
    // on every installed build. Swap it the moment the client sends a key.
    expect(names).not.toContain(IdempotencyInterceptor.name);
  });

  it('leaves the money routes on the STRICT interceptor (a missing key must still 400 there)', () => {
    for (const fn of [
      BookingController.prototype.payWithCredits,
      BookingController.prototype.confirmComplete,
      BookingController.prototype.dispute,
    ]) {
      const names = interceptorsOn(fn).map(i => i.name);
      expect(names).toContain(IdempotencyInterceptor.name);
      expect(names).not.toContain(OptionalIdempotencyInterceptor.name);
    }
  });

  it('does not throttle or key the READ routes (no behaviour change outside create)', () => {
    for (const fn of [BookingController.prototype.list, BookingController.prototype.getById]) {
      expect(Reflect.getMetadata(THROTTLER_LIMIT_DEFAULT, fn)).toBeUndefined();
      expect(guardsOn(fn)).toEqual([]);
    }
  });
});
