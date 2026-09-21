/**
 * B-831 — Report Incident takes its OWN photos and videos.
 *
 * Founder, 2026-09-08 (screenshot of step 2, "Cannot use camera for incident"):
 * the two camera rows launched the OS camera intent through
 * react-native-image-picker, and on that device the intent simply fails — the
 * same finding B-808 closed for chat by replacing the intent with the in-app
 * `CameraCapture` (one shutter: tap = photo, hold = video ≤ 30 s).
 *
 * Source scans (an RN screen cannot mount in this project) plus real unit
 * tests over the pure conversion helper. Comment-stripped, CRLF-normalised,
 * and every absence assertion carries a CONTROL so it cannot pass vacuously.
 */
const mockGetInfoAsync = jest.fn();
jest.mock('expo-file-system/legacy', () => ({getInfoAsync: mockGetInfoAsync}));

import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const DIR = join(process.cwd(), 'src', 'screens', 'deptchat');

function read(f: string): string {
  return readFileSync(join(DIR, f), 'utf8').replace(/\r\n/g, '\n');
}
function strip(s: string): string {
  return s
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
}
const SCREEN = () => strip(read('ReportIncidentDetailsScreen.tsx'));

describe('B-831 — the in-app camera is mounted and owns the capture', () => {
  it('the screen imports CameraCapture and mounts it on `cameraOpen`', () => {
    const src = SCREEN();
    expect(src).toMatch(/import \{CameraCapture\} from '@\/modules\/messenger\/ui\/CameraCapture'/);
    const at = src.indexOf('<CameraCapture');
    expect(at).toBeGreaterThan(-1);
    const mount = src.slice(at, at + 400);
    expect(mount).toMatch(/visible=\{cameraOpen\}/);
    expect(mount).toMatch(/onClose=\{closeCamera\}/);
    expect(mount).toMatch(/onCaptured=\{handleCaptured\}/);
    // Outside the ScrollView, like DepartmentChatScreen's mount: a Modal
    // rendered inside a scroll body inherits its clipping.
    expect(at).toBeGreaterThan(src.indexOf('</ScrollView>'));
  });

  it('the OS camera intent is GONE — no launchCamera anywhere in the file', () => {
    const src = SCREEN();
    expect(src).not.toMatch(/\blaunchCamera\b/);
    // CONTROL: the library path is untouched, so the absence above is real.
    expect(src).toMatch(/await launchImageLibrary\(\{/);
    expect(src).toMatch(/mediaType: 'mixed'/);
    expect(src).toMatch(/selectionLimit: remaining/);
    expect(src).toMatch(/import \{launchImageLibrary, type Asset\} from 'react-native-image-picker'/);
  });

  it('the sheet offers ONE camera row plus the library, with the shutter hint in the body', () => {
    const src = SCREEN();
    const at = src.indexOf("Alert.alert('Evidence', 'Attach photos or video");
    expect(at).toBeGreaterThan(-1);
    const sheet = src.slice(at, src.indexOf('};', at));
    expect(sheet).toMatch(/\{text: 'Open camera', onPress: openCamera\}/);
    expect(sheet).toMatch(/\{text: 'Choose from library'/);
    expect(sheet).toMatch(/\{text: 'Cancel', style: 'cancel'\}/);
    // The two OS-intent rows collapse into one: the in-app shutter does both.
    expect(sheet).not.toMatch(/Take photo/);
    expect(sheet).not.toMatch(/Record video/);
    // The body keeps the PDF p.12 sentence and gains the shutter subtitle.
    expect(sheet).toMatch(/safe and lawful/);
    expect(sheet).toMatch(/Tap for a photo . hold for a video \(30 s\)/);
  });

  it('the library catch names the library only — camera refusals are CameraCapture\'s own UI', () => {
    const src = SCREEN();
    expect(src).toMatch(/Could not open the photo library on this device\./);
    expect(src).not.toMatch(/Could not open the camera or library/);
  });

  it('opening the camera is guarded against a double tap with a ref, not state alone', () => {
    const src = SCREEN();
    const at = src.indexOf('const openCamera');
    expect(at).toBeGreaterThan(-1);
    const fn = src.slice(at, src.indexOf('};', at));
    // `cameraOpen` is set asynchronously, so two fast taps would both pass a
    // state read — the file's own `busy || submittedRef.current` pattern.
    expect(fn).toMatch(/if \(cameraOpenRef\.current\) \{return;\}/);
    expect(fn).toMatch(/cameraOpenRef\.current = true/);
    expect(src).toMatch(/const closeCamera = \(\) => \{/);
  });

  it('a captured asset runs through the SAME gateAsset caps before it is appended', () => {
    const src = SCREEN();
    const at = src.indexOf('const handleCaptured');
    expect(at).toBeGreaterThan(-1);
    const fn = src.slice(at, src.indexOf('\n  };', at));
    expect(fn).toMatch(/gateAsset\(captureGateAsset\(asset\)\)/);
    expect(fn).toMatch(/media\.length >= MAX_MEDIA/);
    expect(fn).toMatch(/captureToMedia\(asset\)/);
    expect(fn).toMatch(/\.slice\(0, MAX_MEDIA\)/);
  });
});

describe('B-831/B-149 — a capture the app created never outlives its usefulness', () => {
  it('the screen imports deleteEphemeralSource from the media module', () => {
    expect(SCREEN()).toMatch(/import \{deleteEphemeralSource\} from '@\/modules\/messenger\/media'/);
  });

  it('removing a row deletes the capture — and only a capture', () => {
    const src = SCREEN();
    const at = src.indexOf('const removeMedia');
    expect(at).toBeGreaterThan(-1);
    const fn = src.slice(at, src.indexOf('\n  };', at));
    expect(fn).toMatch(/gone\?\.ephemeralSource/);
    expect(fn).toMatch(/deleteEphemeralSource\(gone\.uri\)/);
    // The row is still actually removed.
    expect(fn).toMatch(/setMedia\(prev => prev\.filter\(\(_, j\) => j !== i\)\)/);
    // CONTROL: the list wires the handler, or the cleanup is unreachable.
    expect(src).toMatch(/onPress=\{\(\) => removeMedia\(i\)\}/);
  });

  it('a REFUSED capture is deleted immediately (it was never added to the row list)', () => {
    const src = SCREEN();
    const at = src.indexOf('const handleCaptured');
    const fn = src.slice(at, src.indexOf('\n  };', at));
    expect(fn).toMatch(/deleteEphemeralSource\(asset\.uri\)/);
  });

  it('after a durable submit every capture dies in the one exit funnel', () => {
    const src = SCREEN();
    const at = src.indexOf('const go = () =>');
    expect(at).toBeGreaterThan(-1);
    const fn = src.slice(at, src.indexOf('navigation.replace', at));
    expect(fn).toMatch(/m\.ephemeralSource/);
    expect(fn).toMatch(/deleteEphemeralSource\(m\.uri\)/);
    // `go` is the ONLY way off this screen after the POST — it is the Continue
    // button, the onDismiss and the clean-run tail — so one sweep covers them
    // all, including the partial-failure "continue without them" choice.
    expect(src).toMatch(/\{text: 'Continue', style: 'cancel', onPress: go\}/);
    expect(src).toMatch(/onDismiss: go/);
  });

  it('a library pick is never unlinked — the flag is the only trigger', () => {
    const src = SCREEN();
    // Every delete call site is gated on an ephemeralSource flag or is the
    // capture callback's own asset. A bare `deleteEphemeralSource(m.uri)` with
    // no flag test would delete the user's own gallery file (B-149's warning).
    const calls = src.split('\n').filter(l => l.includes('deleteEphemeralSource(') && !l.includes('import'));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const line of calls) {
      expect(`${line.trim()}`).toMatch(/ephemeralSource|asset\.uri/);
    }
  });
});

describe('B-831 — a restored draft never promises a capture the OS has evicted', () => {
  it('the screen probes restored capture rows on mount and drops the missing ones', () => {
    const src = SCREEN();
    // The CALL site, not the import line — anchoring on the bare name found
    // the import and passed against a screen with no probe at all.
    const at = src.indexOf('await captureFileExists(');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(Math.max(0, at - 400), at + 400);
    expect(block).toMatch(/m\.fromDraft && m\.ephemeralSource/);
    expect(block).toMatch(/setMedia\(prev => prev\.filter\(m => !evicted\.includes\(m\.uri\)\)\)/);
    // Restored rows carry the flag at all only because the draft persists it.
    expect(src).toMatch(/restoreDraftMedia\(params\.draft\?\.media \?\? \[\]\)/);
  });

  it('the draft store round-trips ephemeralSource', () => {
    const draft = strip(read('incidentDraft.ts'));
    expect(draft).toMatch(/ephemeralSource\?: boolean/);
    // The loader REBUILDS every row field by field, so a field it does not
    // name is silently dropped on restore.
    const loader = draft.slice(draft.indexOf('export async function loadIncidentDraft'),
      draft.indexOf('export async function saveIncidentDraft'));
    expect(loader).toMatch(/ephemeralSource/);
    // CONTROL: still URIs only, never bytes.
    for (const banned of ['base64', 'readUriBytes', 'Buffer']) {
      expect(`${banned}:${draft.includes(banned)}`).toBe(`${banned}:false`);
    }
  });

  it('discarding the draft from step 1 deletes its captures', () => {
    const src = strip(read('ReportIncidentCategoryScreen.tsx'));
    const at = src.indexOf('const discardDraft');
    expect(at).toBeGreaterThan(-1);
    const fn = src.slice(at, src.indexOf('\n  };', at));
    expect(fn).toMatch(/m\.ephemeralSource/);
    expect(fn).toMatch(/deleteEphemeralSource\(m\.uri\)/);
    // CONTROL: it still clears the draft.
    expect(fn).toMatch(/clearIncidentDraft\(userId, activeOrgId\)/);
  });
});

describe('B-831 — incidentCaptureAsset (pure)', () => {
  const {captureGateAsset, captureToMedia, restoreDraftMedia} = require('../incidentCaptureAsset');

  const photo = {
    uri: 'file:///cache/IMG_1.jpg', mime: 'image/jpeg', kind: 'image' as const,
    meta: {name: 'IMG_1.jpg', width: 1920, height: 1080}, ephemeralSource: true,
  };
  const clip = {
    uri: 'file:///cache/VID_1.mp4', mime: 'video/mp4', kind: 'video' as const,
    meta: {name: 'VID_1.mp4', durationMs: 29_400}, ephemeralSource: true,
  };

  it('converts a photo into the Asset shape gateAsset reads', () => {
    expect(captureGateAsset(photo)).toEqual({uri: photo.uri, type: 'image/jpeg'});
  });

  it('reports video duration in SECONDS — gateAsset compares against MAX_VIDEO_SECONDS', () => {
    // RNIP reports seconds for library videos and the gate is written against
    // that unit; CameraCapture measures milliseconds. Handing it 29400 would
    // drop every clip as "too long".
    expect(captureGateAsset(clip)).toEqual({uri: clip.uri, type: 'video/mp4', duration: 29.4});
    expect(captureGateAsset(clip).duration!).toBeLessThan(60);
  });

  it('passes a stat\'d size through as fileSize when the caller has one', () => {
    expect(captureGateAsset(photo, 1234).fileSize).toBe(1234);
    // Absent rather than undefined-valued: the gate's `typeof === 'number'`
    // test treats both the same, but an explicit key would lie about a stat
    // that never ran.
    expect('fileSize' in captureGateAsset(photo)).toBe(false);
  });

  it('converts to an evidence row that REMEMBERS the app owns the file', () => {
    expect(captureToMedia(photo)).toEqual({uri: photo.uri, mime: 'image/jpeg', kind: 'image', ephemeralSource: true});
    expect(captureToMedia(clip)).toEqual({uri: clip.uri, mime: 'video/mp4', kind: 'video', ephemeralSource: true});
  });

  it('never flags a row the app did not create', () => {
    const libraryPick = {...photo, ephemeralSource: undefined};
    expect('ephemeralSource' in captureToMedia(libraryPick)).toBe(false);
  });

  it('restores draft rows, preserving the ownership flag through the route param', () => {
    // The route param type cannot see `ephemeralSource` (it is declared in
    // src/navigation/types.ts), so the restore reads it structurally.
    const rows = [
      {uri: 'file:///cache/a.jpg', mime: 'image/jpeg', kind: 'image' as const, ephemeralSource: true},
      {uri: 'content://media/b.jpg', mime: 'image/jpeg', kind: 'image' as const},
    ];
    expect(restoreDraftMedia(rows)).toEqual([
      {uri: rows[0].uri, mime: 'image/jpeg', kind: 'image', fromDraft: true, ephemeralSource: true},
      {uri: rows[1].uri, mime: 'image/jpeg', kind: 'image', fromDraft: true},
    ]);
  });

  it('an empty draft restores to an empty list', () => {
    expect(restoreDraftMedia([])).toEqual([]);
  });
});

describe('B-831 — captureFileExists fails OPEN', () => {
  const {captureFileExists} = require('../incidentCaptureAsset');

  beforeEach(() => { mockGetInfoAsync.mockReset(); });

  it('a missing file is the only "drop the row" answer', async () => {
    mockGetInfoAsync.mockResolvedValueOnce({exists: false});
    await expect(captureFileExists('file:///cache/gone.jpg')).resolves.toBe(false);
  });

  it('an existing file keeps the row', async () => {
    mockGetInfoAsync.mockResolvedValueOnce({exists: true, size: 12});
    await expect(captureFileExists('file:///cache/here.jpg')).resolves.toBe(true);
  });

  it('a probe that THROWS keeps the row — evidence is never dropped on a bad stat', async () => {
    mockGetInfoAsync.mockRejectedValueOnce(new Error('nope'));
    await expect(captureFileExists('file:///cache/unknown.jpg')).resolves.toBe(true);
  });
});
