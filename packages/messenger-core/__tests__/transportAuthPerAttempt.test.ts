/**
 * B-778 — the handshake token is read PER CONNECT ATTEMPT.
 *
 * socket.io reuses the `auth` option for every automatic reconnect. With a
 * static object, the connect-time token is what every later attempt presents,
 * and the HTTP layer's own refresh (401 → rotate → revoke old jti) makes it
 * `token_revoked` on the wire: measured 20 s to the device instead of 4 s on
 * the founder's phone (2026-09-02). `auth` is now a function that reads the
 * store each time.
 *
 * Pins:
 *  1. `auth` is a function, and each evaluation yields the CURRENT stored token.
 *  2. The non-token fields (signalDeviceId, bg, pid/offset) still ride along.
 *  3. A getToken rejection / null falls back to the connect-time token —
 *     never an empty handshake.
 *  4. `cb` is invoked exactly once per evaluation.
 */
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

type AuthFn = (cb: (data: Record<string, unknown>) => void) => void;
const ioCalls: Array<{opts: {auth?: unknown}}> = [];
jest.mock('socket.io-client', () => ({
  __esModule: true,
  io: jest.fn((_base: string, opts: {auth?: unknown}) => {
    ioCalls.push({opts});
    return {
      connected: true,
      on() { /* not needed */ },
      onAny() { /* not needed */ },
      removeAllListeners() { /* no-op */ },
      emit() { /* no-op */ },
      disconnect() { /* no-op */ },
      io: {on() { /* no-op */ }, off() { /* no-op */ }},
    };
  }),
}));

import {TransportClient} from '../src/transport/client';

function jwt(secondsFromNow: number, tag: string): string {
  const payload = {exp: Math.floor(Date.now() / 1000) + secondsFromNow, sub: 'u1', tag};
  const b64 = (s: string) => Buffer.from(s).toString('base64').replace(/[=]+$/, '');
  return `${b64('{"alg":"none"}')}.${b64(JSON.stringify(payload))}.sig`;
}

const evaluate = (auth: unknown): Promise<Record<string, unknown>> =>
  new Promise(res => (auth as AuthFn)(res));

describe('TransportClient — handshake auth is evaluated per attempt (B-778)', () => {
  beforeEach(() => { ioCalls.length = 0; });

  it('auth is a function and re-reads the stored token on every evaluation', async () => {
    let stored = jwt(3600, 'first');
    const client = new TransportClient({
      url: 'http://localhost:3100',
      signalDeviceId: 1,
      getToken: async () => stored,
      onFrame: () => undefined,
    });
    await client.connect();
    expect(ioCalls).toHaveLength(1);
    const auth = ioCalls[0].opts.auth;
    expect(typeof auth).toBe('function');

    // Evaluation 1 = the initial connect: the connect-time token, no store read.
    const first = await evaluate(auth);
    expect(first.token).toBe(stored);
    expect(first.signalDeviceId).toBe(1);

    // The HTTP layer rotates the token behind the socket's back…
    stored = jwt(3600, 'rotated');
    // …and socket.io's next automatic reconnect attempt must present the NEW one.
    const second = await evaluate(auth);
    expect(second.token).toBe(stored);
    expect(second.token).not.toBe(first.token);
    stored = jwt(3600, 'rotated-again');
    expect((await evaluate(auth)).token).toBe(stored);
  });

  it('background hint and recovery fields ride along on every evaluation', async () => {
    const client = new TransportClient({
      url: 'http://localhost:3100',
      signalDeviceId: 2,
      background: true,
      getToken: async () => jwt(3600, 'x'),
      onFrame: () => undefined,
    });
    await client.connect();
    const data = await evaluate(ioCalls[0].opts.auth);
    expect(data.bg).toBe('1');
    expect(data.signalDeviceId).toBe(2);
    expect(data).not.toHaveProperty('pid');
  });

  it('falls back to the connect-time token when the store read rejects or returns null', async () => {
    const initial = jwt(3600, 'initial');
    let mode: 'ok' | 'reject' | 'null' = 'ok';
    const client = new TransportClient({
      url: 'http://localhost:3100',
      signalDeviceId: 1,
      getToken: async () => {
        if (mode === 'reject') {throw new Error('AsyncStorage blip');}
        if (mode === 'null') {return null;}
        return initial;
      },
      onFrame: () => undefined,
    });
    await client.connect();
    const auth = ioCalls[0].opts.auth;
    await evaluate(auth); // evaluation 1 — the initial connect (no store read)
    mode = 'reject';
    expect((await evaluate(auth)).token).toBe(initial);
    mode = 'null';
    expect((await evaluate(auth)).token).toBe(initial);
  });

  it('a superseded evaluation NEVER hands a CONNECT to the next engine (critic F1 — the superseded/sign-out hazard)', async () => {
    // Evaluation 2's store read is slow (degraded keychain); the engine drops and
    // reopens, evaluation 3 runs and resolves first. When evaluation 2 finally
    // resolves it must stay silent — otherwise two CONNECTs land on one engine
    // and the gateway's duplicate handling ends in `superseded` → signOut().
    let release: (t: string) => void = () => undefined;
    let calls = 0;
    const client = new TransportClient({
      url: 'http://localhost:3100',
      signalDeviceId: 1,
      getToken: async () => {
        calls += 1;
        if (calls === 2) {return new Promise<string>(res => { release = res; });}
        return jwt(3600, `t${calls}`);
      },
      onFrame: () => undefined,
    });
    await client.connect();
    const auth = ioCalls[0].opts.auth as AuthFn;
    await evaluate(auth); // evaluation 1 (initial connect)
    const cb2 = jest.fn();
    auth(cb2);            // evaluation 2 — parked on the slow read
    const cb3 = jest.fn();
    auth(cb3);            // evaluation 3 — the engine reopened meanwhile
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(cb3).toHaveBeenCalledTimes(1);
    release(jwt(3600, 'late'));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(cb2).not.toHaveBeenCalled();
  });

  it('after close(), a pending evaluation stays silent', async () => {
    let release: (t: string) => void = () => undefined;
    let calls = 0;
    const client = new TransportClient({
      url: 'http://localhost:3100',
      signalDeviceId: 1,
      getToken: async () => {
        calls += 1;
        if (calls >= 2) {return new Promise<string>(res => { release = res; });}
        return jwt(3600, 'init');
      },
      onFrame: () => undefined,
    });
    await client.connect();
    const auth = ioCalls[0].opts.auth as AuthFn;
    await evaluate(auth);
    const cb = jest.fn();
    auth(cb);
    client.close();
    release(jwt(3600, 'late'));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(cb).not.toHaveBeenCalled();
  });

  it('invokes cb exactly once per evaluation', async () => {
    const client = new TransportClient({
      url: 'http://localhost:3100',
      signalDeviceId: 1,
      getToken: async () => jwt(3600, 'once'),
      onFrame: () => undefined,
    });
    await client.connect();
    const cb = jest.fn();
    (ioCalls[0].opts.auth as AuthFn)(cb);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
