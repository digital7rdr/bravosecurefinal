import {ExecutionContext, ForbiddenException} from '@nestjs/common';
import {JwtAuthGuard} from './jwt-auth.guard';
import {JwtService} from '../../auth/jwt.service';
import {RedisService} from '../../redis/redis.service';

/**
 * Bravo Web App (2026-10-03): a `bravo_web_*` cookie session must send the
 * double-submit CSRF header on every mutating request, because it reaches the
 * mobile routes (bookings, wallet, Secure Pro) that have no CsrfGuard.
 */
const CLAIMS = {sub: 'u-1', deviceId: 'd-1', role: 'individual', jti: 'j-1'};
const WEB = 'https://web.bravosecure.cloud';

function ctx(req: Record<string, unknown>): ExecutionContext {
  return {switchToHttp: () => ({getRequest: () => req})} as ExecutionContext;
}

describe('JwtAuthGuard — web app CSRF', () => {
  const jwt = {verifyAccessToken: jest.fn().mockResolvedValue(CLAIMS)};
  const redis = {isJtiValid: jest.fn().mockResolvedValue(true)};
  const guard = new JwtAuthGuard(jwt as unknown as JwtService, redis as unknown as RedisService);
  const prev = process.env.WEB_APP_ORIGINS;
  beforeAll(() => { process.env.WEB_APP_ORIGINS = WEB; });
  afterAll(() => { process.env.WEB_APP_ORIGINS = prev; });

  const webReq = (method: string, headers: Record<string, string> = {}, csrf = 'c-1') => ({
    method,
    headers: {origin: WEB, ...headers},
    cookies: {bravo_web_token: 'tok', bravo_web_csrf: csrf},
  });

  it('lets a web GET through without the header', async () => {
    await expect(guard.canActivate(ctx(webReq('GET')))).resolves.toBe(true);
  });

  it('refuses a web POST without the header, or with a wrong one', async () => {
    await expect(guard.canActivate(ctx(webReq('POST')))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(ctx(webReq('POST', {'x-csrf-token': 'other'})))).rejects.toThrow('csrf_token_invalid');
    await expect(guard.canActivate(ctx(webReq('DELETE', {'x-csrf-token': ''}, '')))).rejects.toThrow('csrf_token_invalid');
  });

  it('accepts a web POST with the matching header', async () => {
    await expect(guard.canActivate(ctx(webReq('POST', {'x-csrf-token': 'c-1'})))).resolves.toBe(true);
  });

  it('reads only the web cookie on the web origin (an ops cookie does not authenticate)', async () => {
    const req = {method: 'GET', headers: {origin: WEB}, cookies: {bravo_ops_token: 'tok'}};
    await expect(guard.canActivate(ctx(req))).rejects.toThrow('missing_token');
  });

  it('leaves Bearer callers and the ops console unchanged', async () => {
    const bearer = {method: 'POST', headers: {origin: WEB, authorization: 'Bearer x'}, cookies: {}};
    await expect(guard.canActivate(ctx(bearer))).resolves.toBe(true);
    const ops = {method: 'POST', headers: {origin: 'https://ops.bravosecure.cloud'}, cookies: {bravo_ops_token: 'tok'}};
    await expect(guard.canActivate(ctx(ops))).resolves.toBe(true);
  });
});
