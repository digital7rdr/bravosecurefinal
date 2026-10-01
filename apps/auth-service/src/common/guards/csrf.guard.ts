import {Injectable, CanActivate, ExecutionContext, ForbiddenException} from '@nestjs/common';
import type {Request} from 'express';
import {sessionCookiesFor} from '../http/session-cookies';

/**
 * Audit fix 0.4 — double-submit CSRF guard.
 *
 * Applied alongside JwtAuthGuard on STATE-CHANGING /ops/* endpoints.
 * Read-only endpoints (GET) are safe by virtue of being GETs (browsers
 * don't auto-submit non-GET cross-origin without an explicit form POST,
 * and SameSite=Strict on the session cookie blocks that anyway).
 *
 * Two-track behavior:
 *   - **Cookie session (browser, ops-console):** require both a
 *     `bravo_ops_csrf` cookie and a matching `X-CSRF-Token` header.
 *     The cookie is set by /auth/verify; the JS reads it (it's NOT
 *     httpOnly) and echoes it on every mutating call. An attacker who
 *     CSRFs us can plant the cookie via SameSite=Lax, but they can't
 *     read its value to put in the header.
 *   - **Bearer token (mobile, scripts):** no cookie session, no CSRF
 *     check. Mobile uses Authorization: Bearer which CSRF can't forge —
 *     attacker would need the token itself, at which point the game's
 *     already over.
 *
 * Cookie names follow the console that sent the request (session-cookies.ts):
 * the provider console's `bravo_pv_*` pair or the ops console's `bravo_ops_*`.
 *
 * A request that carries `Authorization: Bearer` is a Bearer caller even if
 * the browser also attached cookies: JwtAuthGuard authenticates it from the
 * header, and a cross-site page cannot set that header without the token.
 *
 * Failure mode: 403 with code `csrf_token_invalid`. Don't leak whether
 * the cookie is missing vs the header is missing — both branches collapse
 * into the same error, same as Django's default.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & {cookies?: Record<string, string>}>();

    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;

    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) return true;

    const names = sessionCookiesFor(req);
    const usingCookieSession = !!req.cookies?.[names.token];
    if (!usingCookieSession) {
      // Bearer-token caller — CSRF doesn't apply.
      return true;
    }

    const cookieCsrf = req.cookies?.[names.csrf];
    const headerCsrf = req.headers['x-csrf-token'];
    if (
      typeof cookieCsrf !== 'string' || cookieCsrf.length === 0 ||
      typeof headerCsrf !== 'string' || headerCsrf.length === 0 ||
      cookieCsrf !== headerCsrf
    ) {
      throw new ForbiddenException('csrf_token_invalid');
    }
    return true;
  }
}
