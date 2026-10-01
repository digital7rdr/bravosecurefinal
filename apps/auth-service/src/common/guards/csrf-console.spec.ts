import {ForbiddenException, type ExecutionContext} from '@nestjs/common';
import {CsrfGuard} from './csrf.guard';

const PROVIDER = 'https://provider.bravosecure.cloud';

function ctx(req: Record<string, unknown>): ExecutionContext {
  return {switchToHttp: () => ({getRequest: () => req})} as unknown as ExecutionContext;
}

describe('CsrfGuard — per-console cookies', () => {
  const prev = process.env.PROVIDER_CONSOLE_ORIGINS;
  beforeAll(() => { process.env.PROVIDER_CONSOLE_ORIGINS = PROVIDER; });
  afterAll(() => { process.env.PROVIDER_CONSOLE_ORIGINS = prev; });
  const guard = new CsrfGuard();

  it('provider console: pv cookie + matching header passes', () => {
    expect(guard.canActivate(ctx({
      method: 'POST', headers: {origin: PROVIDER, 'x-csrf-token': 'abc'},
      cookies: {bravo_pv_token: 't', bravo_pv_csrf: 'abc'},
    }))).toBe(true);
  });

  it('provider console: an OPS csrf value cannot satisfy a provider session', () => {
    expect(() => guard.canActivate(ctx({
      method: 'POST', headers: {origin: PROVIDER, 'x-csrf-token': 'ops-value'},
      cookies: {bravo_pv_token: 't', bravo_pv_csrf: 'pv-value', bravo_ops_csrf: 'ops-value'},
    }))).toThrow(ForbiddenException);
  });

  it('provider console: missing header is refused', () => {
    expect(() => guard.canActivate(ctx({
      method: 'PATCH', headers: {origin: PROVIDER},
      cookies: {bravo_pv_token: 't', bravo_pv_csrf: 'abc'},
    }))).toThrow(ForbiddenException);
  });

  it('ops console is unchanged', () => {
    expect(() => guard.canActivate(ctx({
      method: 'POST', headers: {origin: 'https://ops.bravosecure.cloud'},
      cookies: {bravo_ops_token: 't', bravo_ops_csrf: 'abc'},
    }))).toThrow(ForbiddenException);
    expect(guard.canActivate(ctx({
      method: 'POST', headers: {origin: 'https://ops.bravosecure.cloud', 'x-csrf-token': 'abc'},
      cookies: {bravo_ops_token: 't', bravo_ops_csrf: 'abc'},
    }))).toBe(true);
  });

  it('a Bearer caller (mobile) is exempt even if cookies ride along', () => {
    expect(guard.canActivate(ctx({
      method: 'POST', headers: {authorization: 'Bearer x'},
      cookies: {bravo_ops_token: 't'},
    }))).toBe(true);
  });

  it('reads stay exempt', () => {
    expect(guard.canActivate(ctx({method: 'GET', headers: {origin: PROVIDER}, cookies: {bravo_pv_token: 't'}}))).toBe(true);
  });
});
