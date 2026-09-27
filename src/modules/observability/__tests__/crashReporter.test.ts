/**
 * 2026-09-27 — Crashlytics → Sentry-protocol swap. Pins the privacy posture of
 * the new transport and that the old wrapper API forwards to it.
 */
const mockSdk = {
  init: jest.fn(),
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
  setUser: jest.fn(),
  setTag: jest.fn(),
  nativeCrash: jest.fn(),
};
jest.mock('@sentry/react-native', () => mockSdk);

type SentryMod = typeof import('../sentry');
type WrapperMod = typeof import('../crashlytics');

function load(dsn?: string): {sentry: SentryMod; wrapper: WrapperMod} {
  jest.resetModules();
  for (const f of Object.values(mockSdk)) {f.mockClear();}
  if (dsn) {process.env.EXPO_PUBLIC_SENTRY_DSN = dsn;} else {delete process.env.EXPO_PUBLIC_SENTRY_DSN;}
  const sentry = require('../sentry') as SentryMod;
  const wrapper = require('../crashlytics') as WrapperMod;
  return {sentry, wrapper};
}

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

afterAll(() => {delete process.env.EXPO_PUBLIC_SENTRY_DSN;});

describe('crash reporter — no DSN', () => {
  it('never initialises the SDK and every call is a silent no-op', () => {
    const {sentry, wrapper} = load();
    wrapper.initCrashlytics();
    wrapper.recordError(new Error('x'));
    wrapper.log('[bravo.test] hi');
    wrapper.setUser('u-1');
    expect(sentry.isSentryEnabled()).toBe(false);
    expect(mockSdk.init).not.toHaveBeenCalled();
    expect(mockSdk.captureException).not.toHaveBeenCalled();
  });
});

describe('crash reporter — with DSN', () => {
  it('initialises with PII, screenshots, view hierarchy and tracing off', () => {
    const {wrapper} = load('https://k@glitchtip.example/1');
    wrapper.initCrashlytics();
    expect(mockSdk.init).toHaveBeenCalledTimes(1);
    const opts = mockSdk.init.mock.calls[0][0];
    expect(opts).toMatchObject({
      dsn: 'https://k@glitchtip.example/1',
      sendDefaultPii: false, attachScreenshot: false, attachViewHierarchy: false, tracesSampleRate: 0,
    });
    expect(typeof opts.beforeSend).toBe('function');
    expect(typeof opts.beforeBreadcrumb).toBe('function');
  });

  it('recordError redacts the message, stack and string context before capture', () => {
    const {wrapper} = load('https://k@sentry.example/1');
    const err = new Error(`decrypt failed for token ${JWT}`);
    wrapper.recordError(err, {kind: 'x', note: `Bearer ${'a'.repeat(30)}`, n: 3});
    const [captured, ctx] = mockSdk.captureException.mock.calls[0];
    expect(captured.message).toBe('decrypt failed for token <jwt>');
    expect(String(captured.stack)).not.toContain(JWT);
    expect(ctx).toEqual({extra: {kind: 'x', note: 'Bearer <token>', n: 3}});
  });

  it('log → breadcrumb (redacted); setUser → id only; setAttribute → tag', () => {
    const {wrapper} = load('https://k@sentry.example/1');
    wrapper.log(`[bravo.area] key=${'f'.repeat(64)}`);
    expect(mockSdk.addBreadcrumb).toHaveBeenLastCalledWith({category: 'bravo', message: '[bravo.area] key=<hex>', level: 'info'});
    wrapper.setUser('pseudo-1');
    expect(mockSdk.setUser).toHaveBeenLastCalledWith({id: 'pseudo-1'});
    wrapper.setUser(null);
    expect(mockSdk.setUser).toHaveBeenLastCalledWith(null);
    wrapper.setAttribute('runtime_mode', 'prod');
    expect(mockSdk.setTag).toHaveBeenLastCalledWith('runtime_mode', 'prod');
  });
});

describe('sentry scrubbers', () => {
  it('beforeSend redacts messages / exception values / breadcrumbs / extras and strips request + user PII', () => {
    const {sentry} = load();
    const ev = sentry.scrubEvent({
      message: `m ${JWT}`,
      exception: {values: [{value: `v ${JWT}`}]},
      breadcrumbs: [{message: `b ${JWT}`}],
      extra: {s: `e ${JWT}`, n: 1},
      request: {url: 'https://api.example/x?token=abc#f', query_string: 'token=abc', cookies: 'c', headers: {a: 'b'}},
      user: {id: 'u-1', email: 'a@b.c', ip_address: '1.2.3.4'} as {id: string},
    })!;
    expect(ev.message).toBe('m <jwt>');
    expect(ev.exception!.values![0].value).toBe('v <jwt>');
    expect(ev.breadcrumbs![0].message).toBe('b <jwt>');
    expect(ev.extra).toEqual({s: 'e <jwt>', n: 1});
    expect(ev.request).toEqual({url: 'https://api.example/x'});
    expect(ev.user).toEqual({id: 'u-1'});
  });

  it('beforeBreadcrumb drops console crumbs and strips URL query strings', () => {
    const {sentry} = load();
    expect(sentry.scrubBreadcrumb({category: 'console', message: 'secret'})).toBeNull();
    expect(sentry.scrubBreadcrumb({category: 'xhr', data: {url: 'https://h/p?code=123456', status_code: 200}}))
      .toEqual({category: 'xhr', data: {url: 'https://h/p', status_code: 200}});
  });

  it('the privacy toggle drops events until switched back on', async () => {
    const {sentry, wrapper} = load();
    await wrapper.setCollectionEnabled(false);
    expect(sentry.scrubEvent({message: 'x'})).toBeNull();
    await wrapper.setCollectionEnabled(true);
    expect(sentry.scrubEvent({message: 'x'})).toEqual({message: 'x'});
  });
});
