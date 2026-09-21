/**
 * In-app camera wiring (2026-09-06) — static source scans, because neither
 * chat screen nor the camera component can be mounted in the node project.
 *
 * What they pin:
 *  - BOTH chat surfaces open the in-app CameraCapture from the Camera row and
 *    no longer reach for the system picker's camera (no shutter to hold there).
 *  - A capture lands in the review tray, never straight into the send queue;
 *    a capture the user discards from the tray is unlinked (B-149).
 *  - The component enforces the 30 s cap ON THE RECORDER (`maxDuration`), names
 *    a codec on iOS (so the bitrate cap holds), starts the recorder from a
 *    state-driven effect (iOS never re-emits onCameraReady after the mode flip),
 *    stops on release, discards a clip on close, zooms on the slide.
 *  - The component never sends: its only exits are `onCaptured(` / `onClose(`.
 *  - The department surface threads `ephemeralSource` through its send.
 *
 * Trap notes (CLAUDE.md): strip comments first (the prose states these rules),
 * CRLF-normalise, and anchor INSIDE the block you mean.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const CHAT = join('src', 'screens', 'messenger', 'ChatScreen.tsx');
const DEPT = join('src', 'screens', 'messenger', 'DepartmentChatScreen.tsx');
const CAM  = join('src', 'modules', 'messenger', 'ui', 'CameraCapture.tsx');
const SCREENS = [CHAT, DEPT];

function codeOnly(rel: string): string {
  const lines = readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inBlock = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('//') || t.startsWith('*')) {continue;}
    out.push(raw);
  }
  return out.join('\n');
}

function between(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(end, a + start.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('the scan reads real code', () => {
  it.each([CHAT, DEPT, CAM])('%s is non-trivial, LF-normalised, comment-stripped', rel => {
    const src = codeOnly(rel);
    expect(src.length).toBeGreaterThan(2_000);
    expect(src).not.toContain('\r');
    expect(src).not.toMatch(/never re-emit onCameraReady/); // header prose — must be stripped
  });
});

describe('both chat surfaces route the Camera row through CameraCapture', () => {
  it.each(SCREENS)('%s imports the component and opens it from captureImage', rel => {
    const src = codeOnly(rel);
    expect(src).toMatch(/import \{CameraCapture\} from '@\/modules\/messenger\/ui\/CameraCapture'/);
    const body = between(src, 'const captureImage', 'const pickImage');
    expect(body).toMatch(/setAttachOpen\(false\)/);
    expect(body).toMatch(/setCameraOpen\(true\)/);
    expect(src).not.toMatch(/launchCamera/);
  });

  it.each(SCREENS)('%s: a capture goes to the review tray, closes the camera, never enqueues', rel => {
    const src = codeOnly(rel);
    const block = between(src, '<CameraCapture', '/>');
    expect(block).toMatch(/visible=\{cameraOpen\}/);
    expect(block).toMatch(/setCameraOpen\(false\)/);
    expect(block).toMatch(/setPendingAssets\(\[asset\]\)/);
    expect(block).not.toMatch(/enqueueMediaAssets|sendMedia/);
  });

  it.each(SCREENS)('%s: a capture discarded from the tray is unlinked (B-149), on cancel AND on remove', rel => {
    const src = codeOnly(rel);
    const tray = between(src, '<MediaPreviewTray', '/>');
    expect(tray).toMatch(/onRemoveAt=\{[\s\S]*discardPickedAssets\(\[gone\]\)/);
    expect(tray).toMatch(/onCancel=\{[\s\S]*discardPickedAssets\(prev\)/);
  });

  it.each(SCREENS)('%s: the row copy tells the user about the hold', rel => {
    expect(codeOnly(rel)).toMatch(/hold for video \(\{MAX_VIDEO_SECONDS\} s\)/);
  });

  it('DepartmentChatScreen threads ephemeralSource through its send and deletes the plaintext in finally', () => {
    const src = codeOnly(DEPT);
    const send = between(src, 'const sendPickedMedia = useCallback', 'const sendPickedMediaRef');
    expect(send).toMatch(/ephemeralSource\?: boolean/);
    expect(send).toMatch(/try \{\s*bytes = await readUriBytes\(uri\);\s*\} finally \{\s*if \(ephemeralSource\) \{await deleteEphemeralSource\(uri\);\}/);
    expect(src).toMatch(/sendPickedMediaRef\.current\(next\.uri, next\.mime, next\.kind, next\.meta, next\.caption, next\.ephemeralSource\)/);
  });
});

describe('CameraCapture enforces the founder rules on the recorder, not just the label', () => {
  const src = codeOnly(CAM);

  it('renders nothing while closed (the chat pays nothing for a closed camera)', () => {
    const outer = between(src, 'export function CameraCapture(', 'function CameraCaptureInner');
    expect(outer).toMatch(/props\.visible \? <CameraCaptureInner[\s\S]*: null/);
  });

  it('caps the recording at MAX_VIDEO_SECONDS on the recorder and names an iOS codec', () => {
    const rec = between(src, 'const recordOnce', 'useEffect(() => {\n    if (!(mode');
    expect(rec).toMatch(/recordAsync\(\{[\s\S]*maxDuration: MAX_VIDEO_SECONDS/);
    expect(rec).toMatch(/codec: Platform\.OS === 'ios' \? 'avc1' : undefined/);
  });

  it('flips into video mode only after the hold threshold; the recorder is started by the state effect with bounded retries', () => {
    const grant = between(src, 'const onGrant', 'const onMove');
    expect(grant).toMatch(/setTimeout\([\s\S]*HOLD_TO_RECORD_MS\)/);
    expect(grant).toMatch(/setMode\('video'\)/);
    expect(grant).not.toMatch(/recordAsync|recordOnce/);
    // Not from onCameraReady (iOS never re-fires it after the mode flip).
    const ready = between(src, 'const onCameraReady', 'const onGrant');
    expect(ready).not.toMatch(/recordOnce|startRecording/);
    const effect = between(src, "if (!(mode === 'video' && phase === 'armed'))", 'const onCameraReady');
    expect(effect).toMatch(/isEarlyRecordReject\(startedAt, Date\.now\(\)\)/);
    expect(effect).toMatch(/n \+ 1 < RECORD_START_MAX_ATTEMPTS/);
    expect(effect).toMatch(/RECORD_START_DELAY_MS\.android : RECORD_START_DELAY_MS\.ios/);
    expect(effect).toMatch(/useNativeDriver: true/);
  });

  it('a release while the mode is still flipping cancels instead of recording an unattended clip', () => {
    const effect = between(src, "if (!(mode === 'video' && phase === 'armed'))", 'const onCameraReady');
    expect(effect).toMatch(/if \(!pressedRef\.current\) \{[\s\S]*settle\(\);\s*return;/);
  });

  it('release before the threshold is a photo; release while recording stops the recorder', () => {
    const rel = between(src, 'const onRelease', 'const flip');
    expect(rel).toMatch(/clearTimeout\(holdTimer\.current\)/);
    expect(rel).toMatch(/void takePhoto\(\)/);
    expect(rel).toMatch(/stopRecording\(\)/);
  });

  it('close while recording DISCARDS the clip (unlinked, onClose) instead of handing it to the tray', () => {
    const close = between(src, 'const close', 'const denied');
    expect(close).toMatch(/discardRef\.current = true;[\s\S]*stopRecording\(\)/);
    const effect = between(src, "if (!(mode === 'video' && phase === 'armed'))", 'const onCameraReady');
    expect(effect).toMatch(/if \(discardRef\.current\) \{[\s\S]*deleteEphemeralSource\(clip\.uri\)[\s\S]*onClose\(\);/);
    expect(effect).toMatch(/if \(!clipIsUsable\(durationMs\)\) \{[\s\S]*deleteEphemeralSource\(clip\.uri\)/);
  });

  it('a resized photo deletes the full-resolution original (one plaintext, the one the tray holds)', () => {
    const photo = between(src, 'const takePhoto', 'const recordOnce');
    expect(photo).toMatch(/if \(out\.uri !== uri\) \{[\s\S]*deleteEphemeralSource\(uri\)/);
    expect(photo).toMatch(/onCaptured\(buildPhotoAsset\(/);
  });

  it('zooms on the slide while holding, on a 1 % step, and the responder keeps the touch through drift', () => {
    const move = between(src, 'const onMove', 'const onRelease');
    expect(move).toMatch(/zoomFromDrag\(pressStartY\.current - e\.nativeEvent\.pageY\)/);
    expect(move).toMatch(/zoomChanged\(zoomRef\.current, next\)/);
    expect(src).toMatch(/zoom=\{zoom\}/);
    const shutter = between(src, 'onStartShouldSetResponder', 'accessibilityLabel="Shutter"');
    expect(shutter).toMatch(/onResponderTerminationRequest=\{\(\) => false\}/);
    expect(shutter).toMatch(/onResponderMove=\{onMove\}/);
    expect(shutter).toMatch(/onResponderTerminate=\{onRelease\}/);
  });

  it('never sends — its only exits are onCaptured and onClose', () => {
    expect(src).toMatch(/onCaptured\(buildVideoAsset\(/);
    expect(src).not.toMatch(/sendMedia|enqueueMediaAssets|useMessengerStore|useNavigation|BackHandler/);
    expect(src).toMatch(/<Modal[\s\S]*onRequestClose=\{close\}/);
  });

  it('the shutter is guarded synchronously (phaseRef), not by a state flag alone', () => {
    const photo = between(src, 'const takePhoto', 'const recordOnce');
    expect(photo).toMatch(/phaseRef\.current !== 'idle'/);
    const grant = between(src, 'const onGrant', 'const onMove');
    expect(grant).toMatch(/phaseRef\.current !== 'idle' \|\| !ready/);
  });
});
