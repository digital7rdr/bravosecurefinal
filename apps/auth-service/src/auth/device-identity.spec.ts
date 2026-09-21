import {normalizeDeviceIdentity} from './dto/device-identity.dto';

/**
 * B-794 — device identity capture.
 *
 * The invariant worth a permanent test is NOT "we store the model" (a schema
 * fact) but "a refresh cannot erase it". `issueSession` runs on the refresh
 * path too, and refresh() has no identity to report — so the upsert has to
 * COALESCE onto the existing row. A bare `device_model = EXCLUDED.device_model`
 * type-checks, passes every functional test, and silently wipes the captured
 * name within one access-token lifetime (15 minutes) of it being written. That
 * is the shape of bug this file exists to catch.
 */
describe('normalizeDeviceIdentity', () => {
  it('passes through reported values', () => {
    expect(normalizeDeviceIdentity({
      deviceModel: 'Redmi Note 11', deviceBrand: 'Xiaomi', osVersion: '11', appVersion: '1.0.290',
    })).toEqual({model: 'Redmi Note 11', brand: 'Xiaomi', os: '11', app: '1.0.290'});
  });

  it('maps absent, blank and non-string input to null, never to a lie', () => {
    // NULL must mean "not reported". An empty string stored instead would read
    // in the console as a device whose model is genuinely blank.
    expect(normalizeDeviceIdentity(undefined)).toEqual({model: null, brand: null, os: null, app: null});
    expect(normalizeDeviceIdentity({deviceModel: '   ', deviceBrand: ''}))
      .toMatchObject({model: null, brand: null});
    expect(normalizeDeviceIdentity({deviceModel: 42 as unknown as string}))
      .toMatchObject({model: null});
  });

  it('clamps to the column budget', () => {
    const long = 'x'.repeat(500);
    const out = normalizeDeviceIdentity({deviceModel: long, deviceBrand: long, osVersion: long, appVersion: long});
    expect(out.model).toHaveLength(64);
    expect(out.brand).toHaveLength(64);
    expect(out.os).toHaveLength(64);
    expect(out.app).toHaveLength(32);
  });
});

describe('the session upsert', () => {
  // Source scan: the SQL lives in a template literal inside issueSession and no
  // unit test reaches it with a real Postgres. Comments are stripped first so
  // the prose ABOVE the query (which names COALESCE) cannot satisfy the check,
  // and the file is CRLF so nothing here anchors on a bare \n.
  const SQL = (() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {readFileSync} = require('fs') as typeof import('fs');
    const {join} = require('path') as typeof import('path');
    const raw = readFileSync(join(__dirname, 'auth.service.ts'), 'utf8');
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .filter(l => !l.trim().startsWith('//'))
      .join('\n');
  })();

  it('writes the four identity columns', () => {
    expect(SQL).toMatch(/INSERT INTO auth_devices/);
    for (const col of ['device_model', 'device_brand', 'os_version', 'app_version']) {
      expect(SQL).toContain(col);
    }
  });

  it.each(['device_model', 'device_brand', 'os_version', 'app_version'])(
    'preserves %s on conflict instead of overwriting it with the refresh path\'s null',
    col => {
      // The exact defect: `SET device_model = EXCLUDED.device_model`.
      const bare = new RegExp(`${col}\\s*=\\s*EXCLUDED\\.${col}\\b`);
      expect(SQL).not.toMatch(bare);
      const coalesced = new RegExp(`${col}\\s*=\\s*COALESCE\\(\\s*EXCLUDED\\.${col}\\s*,\\s*auth_devices\\.${col}\\s*\\)`);
      expect(SQL).toMatch(coalesced);
    },
  );

  it('never returns current_jti to the ops console', () => {
    // current_jti is a live bearer-token identifier. The ops read derives a
    // boolean from it; selecting the value itself would leak it into a JSON
    // response an admin browser can read.
    const {readFileSync} = require('fs') as typeof import('fs');
    const {join} = require('path') as typeof import('path');
    const opsSrc = readFileSync(join(__dirname, '..', 'ops', 'ops-data.service.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .filter(l => !l.trim().startsWith('//'))
      .join('\n');
    const deviceSelect = opsSrc.slice(
      opsSrc.indexOf('FROM auth_devices WHERE user_id = $1') - 800,
      opsSrc.indexOf('FROM auth_devices WHERE user_id = $1'),
    );
    expect(deviceSelect).toMatch(/is_live/);
    expect(deviceSelect).not.toMatch(/^\s*current_jti\s*,/m);
    expect(deviceSelect).not.toMatch(/,\s*current_jti\s*[,\n]/);
  });
});
