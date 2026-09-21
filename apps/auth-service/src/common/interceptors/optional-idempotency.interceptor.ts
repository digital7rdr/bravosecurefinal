import {ExecutionContext, Injectable, CallHandler} from '@nestjs/common';
import type {Observable} from 'rxjs';
import type {Request} from 'express';
import {IdempotencyInterceptor} from './idempotency.interceptor';

/**
 * E-10 — idempotency for routes the INSTALLED BASE already calls WITHOUT a key.
 *
 * The strict interceptor 400s (`idempotency_key_required`) when the header is
 * absent, which is right for routes that always shipped with keys — but
 * mounting it on an existing route (subscription subscribe) would break every
 * old client. This variant applies the full replay protection when the header
 * is present and passes through unchanged when it is not: new builds get
 * double-charge protection, old builds keep today's behavior.
 *
 * E2E-23 (audit 2026-09-03) — SECOND consumer: the legacy `POST /bookings`.
 * `bookingApi.create` (`src/services/api.ts`) sends no `Idempotency-Key`, and
 * the mobile client still uses that route for every user whose
 * `auto_dispatch_enabled` is false, so the strict interceptor would 400 every
 * legacy booking on every installed build. The RACE that route actually had
 * (two concurrent creates ⇒ two active bookings) is closed at the DATABASE by
 * the partial unique index `lite_bookings_one_active_per_client_uq`
 * (`20260903120000_booking_guards_and_scale_indexes.sql`), which holds with or
 * without a key; this adds response-replay collapse on top.
 *
 * ➜ FOLLOW-UP: once the client sends a key on `POST /bookings`, swap this for
 *   `IdempotencyInterceptor` in `booking.controller.ts` — a one-word change —
 *   so a missing key becomes a 400 again.
 */
@Injectable()
export class OptionalIdempotencyInterceptor extends IdempotencyInterceptor {
  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.header('idempotency-key') ?? req.header('Idempotency-Key');
    if (!header) {
      return next.handle();
    }
    return super.intercept(ctx, next);
  }
}
