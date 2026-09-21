/**
 * B-794 — "which device is this person using?" rendered from four independent
 * nullables.
 *
 * Every field is optional end-to-end on purpose (rows predating the capture,
 * web sessions, iOS builds with no hardware model), so the display has to
 * degrade one step at a time. The failure this pins is a label that INVENTS
 * something the server does not know — "Unknown device" for a perfectly good
 * Android session, or "Google Google Pixel 7a".
 */

import {deviceLabel, since} from '../lib/format';

const base = {platform: 'android', device_model: null, device_brand: null};

describe('deviceLabel', () => {
  it('joins brand and model', () => {
    expect(deviceLabel({...base, device_brand: 'Xiaomi', device_model: 'Redmi Note 11'}))
      .toBe('Xiaomi Redmi Note 11');
  });

  it('does not repeat a brand the model already carries', () => {
    expect(deviceLabel({...base, device_brand: 'Google', device_model: 'Google Pixel 7a'}))
      .toBe('Google Pixel 7a');
    // Case must not defeat the check — Android reports brand lowercase.
    expect(deviceLabel({...base, device_brand: 'google', device_model: 'Google Pixel 7a'}))
      .toBe('Google Pixel 7a');
  });

  it('uses the model alone when the brand is missing', () => {
    expect(deviceLabel({...base, device_model: 'SM-G991B'})).toBe('SM-G991B');
  });

  it('degrades to the platform rather than claiming the device is unknown', () => {
    // The pre-capture case, which is EVERY row until a user re-logs in on a
    // new build. "Unknown device" would read as a problem; it is not one.
    expect(deviceLabel(base)).toBe('Android');
    expect(deviceLabel({...base, platform: 'ios'})).toBe('Ios');
    expect(deviceLabel({...base, platform: 'web'})).toBe('Web browser');
  });

  it('names an iOS session by its brand when no model is reported', () => {
    expect(deviceLabel({platform: 'ios', device_brand: 'Apple', device_model: null}))
      .toBe('Apple iPhone / iPad');
  });

  it('treats whitespace-only values as missing', () => {
    expect(deviceLabel({...base, device_brand: '  ', device_model: '   '})).toBe('Android');
  });

  it('survives a null platform', () => {
    expect(deviceLabel({platform: null, device_model: null, device_brand: null})).toBe('Unknown device');
  });
});

describe('since', () => {
  const now = Date.parse('2026-09-04T12:00:00.000Z');
  const at = (iso: string) => since(iso, now);

  it('reads in the units a human asks in', () => {
    expect(at('2026-09-04T11:59:30.000Z')).toBe('just now');
    expect(at('2026-09-04T11:45:00.000Z')).toBe('15 min ago');
    expect(at('2026-09-04T09:00:00.000Z')).toBe('3 hrs ago');
    expect(at('2026-09-04T11:00:00.000Z')).toBe('1 hr ago');
    expect(at('2026-09-01T12:00:00.000Z')).toBe('3 days ago');
  });

  it('never renders a negative age from clock skew', () => {
    // A device whose last_used_at is a few seconds ahead of the console's clock
    // must not read "-1 min ago".
    expect(at('2026-09-04T12:00:30.000Z')).toBe('just now');
  });

  it('handles a missing or unparseable timestamp', () => {
    expect(since(null, now)).toBe('never');
    expect(at('not-a-date')).toBe('never');
  });
});
