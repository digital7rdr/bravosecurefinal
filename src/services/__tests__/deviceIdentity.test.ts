/**
 * B-794 — the client half of "which device is this person using?".
 *
 * Read from RN's own `Platform.constants` rather than a new native dependency.
 * The two things worth pinning:
 *
 *  1. It NEVER throws and never reports a partial lie. Every consumer spreads
 *     the result straight into a login body, so a build where a constant is
 *     missing must omit that field, not send `undefined`-as-a-string or blow up
 *     the sign-in it is attached to.
 *  2. iOS reports no hardware model. Sending the platform word as a "model"
 *     would put "ios" in the console's Device column for every iPhone.
 */

import {Platform} from 'react-native';

jest.mock('@utils/constants', () => ({
  API_BASE_URL: 'http://localhost:3001',
  APP_VERSION: '1.0.290',
}));

function load() {
  let mod: typeof import('../api');
  jest.isolateModules(() => { mod = require('../api') as typeof import('../api'); });
  return mod!.getDeviceIdentity;
}

function setPlatform(os: 'android' | 'ios', constants: Record<string, unknown>) {
  Object.defineProperty(Platform, 'OS', {value: os, configurable: true});
  Object.defineProperty(Platform, 'constants', {value: constants, configurable: true});
}

describe('getDeviceIdentity', () => {
  it('reports brand, model and OS release on Android', () => {
    setPlatform('android', {Model: 'Redmi Note 11', Brand: 'Xiaomi', Manufacturer: 'Xiaomi', Release: '11'});
    expect(load()()).toEqual({
      deviceModel: 'Redmi Note 11', deviceBrand: 'Xiaomi', osVersion: '11', appVersion: '1.0.290',
    });
  });

  it('falls back to Manufacturer when Brand is absent', () => {
    setPlatform('android', {Model: 'SM-G991B', Manufacturer: 'samsung', Release: '13'});
    expect(load()()).toMatchObject({deviceBrand: 'samsung', deviceModel: 'SM-G991B'});
  });

  it('leaves the iOS model undefined instead of sending the platform word', () => {
    setPlatform('ios', {osVersion: '17.4', systemName: 'iOS'});
    const out = load()();
    expect(out.deviceModel).toBeUndefined();
    expect(out).toMatchObject({deviceBrand: 'Apple', osVersion: '17.4'});
  });

  it('omits fields it cannot read rather than sending empty strings', () => {
    // An empty string would be stored as a device whose model is genuinely
    // blank; the server needs a NULL meaning "not reported".
    setPlatform('android', {Model: '   ', Brand: '', Release: undefined});
    const out = load()();
    expect(out.deviceModel).toBeUndefined();
    expect(out.deviceBrand).toBeUndefined();
  });

  it('always carries the app version, so support can see a stale build', () => {
    setPlatform('android', {});
    expect(load()().appVersion).toBe('1.0.290');
  });

  it('clamps to the lengths the DTO accepts', () => {
    setPlatform('android', {Model: 'x'.repeat(300), Brand: 'y'.repeat(300), Release: 'z'.repeat(300)});
    const out = load()();
    expect(out.deviceModel).toHaveLength(64);
    expect(out.deviceBrand).toHaveLength(64);
    expect(out.osVersion).toHaveLength(64);
  });

  it('does not throw when constants are missing entirely', () => {
    // A login must never fail because a cosmetic label could not be read.
    setPlatform('android', {});
    expect(() => load()()).not.toThrow();
  });
});
