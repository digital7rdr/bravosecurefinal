/**
 * 2026-10-25 (owner: "use the default phone ring for the app") — every in-app
 * ring screen rings with the DEVICE-DEFAULT ringtone; the bundled tone is only
 * a fallback when the phone's ringtone cannot play, and a silent ringer stays
 * silent. Replaces the NA-06 ownership mirror test: the screens no longer
 * guess who owns the ring.
 */
const mockRingIncoming = jest.fn();
const mockStopIncoming = jest.fn();
const mockStartTone = jest.fn(async () => undefined);
const mockStopTone = jest.fn(async () => undefined);
const mockVibrate = jest.fn();
const mockVibCancel = jest.fn();

jest.mock('react-native', () => ({Vibration: {vibrate: (...a: unknown[]) => mockVibrate(...a), cancel: () => mockVibCancel()}}));
jest.mock('../push/incomingRingtone', () => ({
  ringIncoming: (id: string) => mockRingIncoming(id),
  stopIncomingRingtone: (id: string | null, r: string) => mockStopIncoming(id, r),
}));
jest.mock('../runtime/bravoTones', () => ({startRingtone: () => mockStartTone(), stopRingtone: () => mockStopTone()}));

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {startScreenRing, RING_VIBRATION} from '../runtime/screenRing';

const flush = () => new Promise(r => setTimeout(r, 5));

beforeEach(() => {
  jest.useRealTimers();
  [mockRingIncoming, mockStopIncoming, mockStartTone, mockStopTone, mockVibrate, mockVibCancel].forEach(m => m.mockClear());
});

describe('startScreenRing', () => {
  it('rings with the phone ringtone and does not play the bundled tone', async () => {
    mockRingIncoming.mockResolvedValue('started');
    const stop = startScreenRing('c1');
    await flush();
    expect(mockRingIncoming).toHaveBeenCalledWith('c1');
    expect(mockStartTone).not.toHaveBeenCalled();
    expect(mockVibrate).toHaveBeenCalledWith(RING_VIBRATION, true);
    stop();
    expect(mockStopIncoming).toHaveBeenCalledWith('c1', 'ring-screen');
    expect(mockVibCancel).toHaveBeenCalled();
  });

  it('a silent / vibrate ringer stays silent (vibration only)', async () => {
    mockRingIncoming.mockResolvedValue('silent');
    const stop = startScreenRing('c2');
    await flush();
    expect(mockStartTone).not.toHaveBeenCalled();
    stop();
  });

  it.each(['failed', 'no-uri', 'unavailable'])('"%s" falls back to the bundled tone, so the call is never silent by accident', async r => {
    mockRingIncoming.mockResolvedValue(r);
    const stop = startScreenRing('c3');
    await flush();
    expect(mockStartTone).toHaveBeenCalledTimes(1);
    stop();
    expect(mockStopTone).toHaveBeenCalledTimes(1);
  });

  it('leaving before the phone answered the start still stops the ring', async () => {
    let resolve!: (v: string) => void;
    mockRingIncoming.mockReturnValue(new Promise(r => { resolve = r; }));
    const stop = startScreenRing('c4');
    stop();
    resolve('started');
    await flush();
    expect(mockStopIncoming).toHaveBeenCalledWith('c4', 'screen-left-early');
    expect(mockStartTone).not.toHaveBeenCalled();
  });

  it('stop is idempotent', async () => {
    mockRingIncoming.mockResolvedValue('started');
    const stop = startScreenRing('c5');
    stop(); stop();
    expect(mockStopIncoming).toHaveBeenCalledTimes(1);
  });
});

describe('both ring screens use it', () => {
  const read = (f: string) => readFileSync(join(process.cwd(), 'src', 'screens', 'messenger', f), 'utf8');
  it('1:1 CallScreen', () => {
    expect(read('CallScreen.tsx')).toMatch(/return startScreenRing\(callId\);/);
  });
  it('group IncomingGroupCallScreen', () => {
    expect(read('IncomingGroupCallScreen.tsx')).toMatch(/return startScreenRing\(roomId, \{vibrateDelayMs: 50\}\);/);
  });
});
