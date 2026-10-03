import {Injectable, CanActivate, ExecutionContext, ForbiddenException, UnauthorizedException} from '@nestjs/common';
import type {Request} from 'express';
import {JwtService} from '../../auth/jwt.service';
import {RedisService} from '../../redis/redis.service';
import {sessionCookiesFor} from '../http/session-cookies';

/**
 * Audit fix 0.4 — accept token from EITHER Authorization header (mobile
 * native app, where there's no cookie jar) OR `bravo_ops_token` httpOnly
 * cookie (ops-console browser, where localStorage is XSS-readable).
 *
 * Header takes precedence so a mobile dev tool inspecting cookies can't
 * accidentally race with the bearer flow.
 *
 * The cookie read is the one belonging to the console that sent the request
 * (`bravo_pv_token` from the provider console, `bravo_ops_token` otherwise;
 * see common/http/session-cookies.ts), so one console never authenticates
 * with the other console's session.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt:   JwtService,
    private readonly redis: RedisService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req    = ctx.switchToHttp().getRequest<Request & {user?: unknown; cookies?: Record<string, string>}>();
    const header = req.headers['authorization'];
    let token: string | null = null;
    if (header?.startsWith('Bearer ')) {
      token = header.slice(7);
    } else {
      const names = sessionCookiesFor(req);
      if (req.cookies?.[names.token]) {
        token = req.cookies[names.token];
        if (names.console === 'web') assertWebCsrf(req, names.csrf);
      }
    }
    if (!token) throw new UnauthorizedException('missing_token');

    let claims: Awaited<ReturnType<JwtService['verifyAccessToken']>>;
    try {
      claims = await this.jwt.verifyAccessToken(token);
    } catch {
      throw new UnauthorizedException('invalid_token');
    }

    if (!(await this.redis.isJtiValid(claims.jti))) {
      throw new UnauthorizedException('token_revoked');
    }

    req.user = claims;
    return true;
  }
}

/** Double-submit check for a web-app cookie session (see the class comment). */
function assertWebCsrf(req: Request & {cookies?: Record<string, string>}, csrfCookie: string): void {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  const cookie = req.cookies?.[csrfCookie];
  const sent = req.headers['x-csrf-token'];
  if (typeof cookie !== 'string' || !cookie || typeof sent !== 'string' || !sent || cookie !== sent) {
    throw new ForbiddenException('csrf_token_invalid');
  }
}
