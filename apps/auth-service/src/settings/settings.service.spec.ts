import {randomBytes} from 'node:crypto';
import {SettingsService} from './settings.service';
import {SettingsCrypto} from './settings-crypto';

/** Minimal in-memory stand-ins for the injected deps. */
function makeDeps(envMap: Record<string, string> = {}) {
  const rows: Record<string, unknown>[] = [];
  const db = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    q: jest.fn(async (sql: string, params?: any[]) => {
      const s = sql.trim().toLowerCase();
      if (s.startsWith('select')) {return rows.slice();}
      if (s.startsWith('insert')) {
        const [key, category, third] = params as string[];
        // Secret insert = "values ($1, $2, $3, null, true, $4, ...)"; plain uses false.
        const isSecret = s.includes('null, true, $4');
        const i = rows.findIndex(r => r.key === key);
        const row = {
          key, category,
          value_enc: isSecret ? third : null,
          value_plain: isSecret ? null : third,
          is_secret: isSecret,
          updated_by: (params as string[])[3] ?? null,
          updated_at: new Date().toISOString(),
        };
        if (i >= 0) {rows[i] = row;} else {rows.push(row);}
        return [];
      }
      if (s.startsWith('delete')) {
        const key = (params as string[])[0];
        const i = rows.findIndex(r => r.key === key);
        if (i >= 0) {rows.splice(i, 1);}
        return [];
      }
      return [];
    }),
  };
  const config = {get: (k: string) => envMap[k]};
  const redis = {client: undefined};
  return {db, config, redis, rows};
}

const KEY = randomBytes(32).toString('base64');

describe('SettingsService', () => {
  beforeEach(() => {process.env.SETTINGS_ENCRYPTION_KEY = KEY;});

  it('falls back to the env value when no DB row exists', async () => {
    const {db, config, redis} = makeDeps({'stripe.proPriceId': 'price_env'});
    const svc = new SettingsService(db as never, config as never, redis as never);
    expect(await svc.get('stripe.proPriceId')).toBe('price_env');
  });

  it('a DB plain override wins over env', async () => {
    const {db, config, redis} = makeDeps({'stripe.proPriceId': 'price_env'});
    const svc = new SettingsService(db as never, config as never, redis as never);
    await svc.set('stripe.proPriceId', 'price_db', 'admin-1');
    expect(await svc.get('stripe.proPriceId')).toBe('price_db');
  });

  it('stores a secret encrypted and returns it decrypted', async () => {
    const {db, config, redis, rows} = makeDeps();
    const svc = new SettingsService(db as never, config as never, redis as never);
    await svc.set('stripe.secretKey', 'sk_live_secret_value', 'admin-1');
    // On disk it is an envelope, never the plaintext.
    const row = rows.find(r => r.key === 'stripe.secretKey')!;
    expect(row.value_plain).toBeNull();
    expect(String(row.value_enc)).toMatch(/^v1:/);
    expect(String(row.value_enc)).not.toContain('sk_live_secret_value');
    // Read back decrypts.
    expect(await svc.get('stripe.secretKey')).toBe('sk_live_secret_value');
  });

  it('status() masks secrets and reports the source', async () => {
    const {db, config, redis} = makeDeps({'twilio.accountSid': 'ACenv'});
    const svc = new SettingsService(db as never, config as never, redis as never);
    await svc.set('stripe.secretKey', 'sk_live_ABCD1234TAIL', 'admin-1');

    const all = await svc.status();
    const secret = all.find(s => s.key === 'stripe.secretKey')!;
    expect(secret.source).toBe('db');
    expect(secret.configured).toBe(true);
    expect(secret.preview).toMatch(/•+TAIL$/);
    expect(secret.preview).not.toContain('sk_live_ABCD1234');

    const envBacked = all.find(s => s.key === 'twilio.accountSid')!;
    expect(envBacked.source).toBe('env');
    expect(envBacked.preview).toBe('ACenv'); // non-secret shown in clear

    const unset = all.find(s => s.key === 'twilio.authToken')!;
    expect(unset.source).toBe('unset');
    expect(unset.configured).toBe(false);
    expect(unset.preview).toBeNull();
  });

  it('clear() removes the override so env wins again', async () => {
    const {db, config, redis} = makeDeps({'stripe.proPriceId': 'price_env'});
    const svc = new SettingsService(db as never, config as never, redis as never);
    await svc.set('stripe.proPriceId', 'price_db', 'admin-1');
    expect(await svc.get('stripe.proPriceId')).toBe('price_db');
    await svc.clear('stripe.proPriceId', 'admin-1');
    expect(await svc.get('stripe.proPriceId')).toBe('price_env');
  });

  it('serves env and backs off (no per-request re-query) when the table is missing', async () => {
    const {config, redis} = makeDeps({'stripe.proPriceId': 'price_env'});
    const db = {q: jest.fn(async () => {throw new Error('relation "platform_settings" does not exist');})};
    const svc = new SettingsService(db as never, config as never, redis as never);
    expect(await svc.get('stripe.proPriceId')).toBe('price_env');
    const callsAfterFirst = db.q.mock.calls.length;
    for (let i = 0; i < 20; i++) {svc.getSync('stripe.proPriceId');}
    await svc.get('stripe.proPriceId');
    expect(db.q.mock.calls.length).toBe(callsAfterFirst); // no hammering within the TTL
  });

  it('rejects an unknown key', async () => {
    const {db, config, redis} = makeDeps();
    const svc = new SettingsService(db as never, config as never, redis as never);
    await expect(svc.set('bogus.key', 'x', null)).rejects.toThrow(/unknown/);
  });

  it('a setting with options accepts only a listed value, and status() returns the options', async () => {
    const {db, config, redis} = makeDeps();
    const svc = new SettingsService(db as never, config as never, redis as never);
    await expect(svc.set('twilio.otpMode', 'carrier-pigeon', null)).rejects.toThrow(/must be one of/);
    expect(db.q.mock.calls.some(([sql]) => String(sql).trim().toLowerCase().startsWith('insert'))).toBe(false);
    await svc.set('twilio.otpMode', 'sms', 'admin-1');
    expect(await svc.get('twilio.otpMode')).toBe('sms');
    const row = (await svc.status()).find(s => s.key === 'twilio.otpMode')!;
    expect(row.options?.map(o => o.value)).toContain('verify');
  });

  it('refuses to store a secret when no encryption key is configured', async () => {
    delete process.env.SETTINGS_ENCRYPTION_KEY;
    const {db, config, redis} = makeDeps();
    const svc = new SettingsService(db as never, config as never, redis as never);
    await expect(svc.set('stripe.secretKey', 'sk_live_x', null)).rejects.toThrow();
  });
});
