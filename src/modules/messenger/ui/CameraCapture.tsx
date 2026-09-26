import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, Platform, StatusBar, useWindowDimensions, Animated, Easing,
  type GestureResponderEvent,
} from 'react-native';
import {CameraView, useCameraPermissions, useMicrophonePermissions, type CameraType} from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {haptics} from '@utils/haptics';
import {deleteEphemeralSource} from '@/modules/messenger/media';
import type {PickedAsset} from './pickedAssets';
import {
  HOLD_TO_RECORD_MS, MAX_VIDEO_MS, MAX_VIDEO_SECONDS, PHOTO_MAX_EDGE, PHOTO_QUALITY,
  RECORD_START_DELAY_MS, RECORD_START_MAX_ATTEMPTS, RECORD_START_RETRY_MS,
  VIDEO_BITRATE, VIDEO_QUALITY, buildPhotoAsset, buildVideoAsset, clipIsUsable, formatRecClock, isEarlyRecordReject,
  zoomChanged, zoomFromDrag,
} from './cameraCaptureRules';

/**
 * The messenger's in-app camera (2026-09-06). One shutter, WhatsApp
 * semantics: TAP takes a photo, PRESS-AND-HOLD records a video capped at
 * 30 s, release stops early, and while holding, SLIDE UP to zoom in / back
 * down to zoom out. Hands a `PickedAsset` to the caller's review tray — it
 * never sends, so the caption step (B-707) and the serial queue (MX-09) stay
 * the single send path.
 *
 * Why a Modal and not a route: the capture is a step INSIDE the chat, like
 * the attach sheet; a pushed screen would put a navigator transition and a
 * hardware-back handler (NAV loop N1) between the user and their conversation.
 * `onRequestClose` is the Android back press.
 *
 * Smoothness (founder): the outer component renders NOTHING while closed, so
 * the chat's frequent re-renders never build a camera tree or run the
 * permission getters; the 30 s progress bar animates on the native thread;
 * the clock re-renders once a second; zoom re-renders only on a 1% step;
 * every capture cost (encode, resize) is native and awaited.
 *
 * expo-camera binds ONE output use-case at a time (`mode`). After the hold
 * flips the view to 'video' the session re-binds asynchronously — and iOS does
 * NOT re-emit onCameraReady for it (it fires once, at session start; verified
 * in CameraSessionManager.swift). So the recorder is started from an effect on
 * a short delay and retried on an immediate rejection, on both platforms.
 *
 * The shutter is a raw responder View rather than a Pressable: the hold needs
 * MOVE events for the zoom slide, and a responder keeps the touch through any
 * drift (a Pressable's press rectangle would end the recording on a wander).
 */
const C = {
  bg: '#0A1F3F',
  accent: '#1E88FF',
  rec: '#F87171',
  white: '#FFFFFF',
  dim: 'rgba(255,255,255,0.72)',
  scrim: 'rgba(7,9,13,0.55)',
};

type Phase = 'idle' | 'armed' | 'recording' | 'busy';

/** Android re-binds and re-emits onCameraReady on a mode/facing change; iOS does not. */
const REBIND_FIRES_READY = Platform.OS === 'android';

export function CameraCapture(props: {
  visible: boolean;
  onClose: () => void;
  onCaptured: (asset: PickedAsset) => void;
}) {
  // Nothing mounted while closed: no permission getters, no camera tree, no
  // hooks paying for a sheet the user is not looking at.
  return props.visible ? <CameraCaptureInner onClose={props.onClose} onCaptured={props.onCaptured} /> : null;
}

function CameraCaptureInner({onClose, onCaptured}: {onClose: () => void; onCaptured: (asset: PickedAsset) => void}) {
  const insets = useSafeAreaInsets();
  const {width: winW} = useWindowDimensions();
  const camRef = useRef<CameraView | null>(null);
  const [camPerm, requestCam] = useCameraPermissions();
  const [micPerm, requestMic] = useMicrophonePermissions();
  const [facing, setFacing] = useState<CameraType>('back');
  const [mode, setMode] = useState<'picture' | 'video'>('picture');
  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [zoom, setZoom] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  // The 30 s progress bar runs on the NATIVE animation thread (scaleX, native
  // driver): zero JS work per frame while recording.
  const progress = useRef(new Animated.Value(0)).current;

  // Synchronous guards — a double-tap on the shutter must not fire two
  // captures, and a hold timer must not outlive its press.
  const phaseRef = useRef<Phase>('idle');
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressedRef = useRef(false);
  const pressStartY = useRef(0);
  const zoomRef = useRef(0);
  const recStartRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Close / back pressed while recording: the clip that resolves is discarded.
  const discardRef = useRef(false);
  const mountedRef = useRef(true);

  const setPhaseBoth = useCallback((p: Phase) => { phaseRef.current = p; if (mountedRef.current) {setPhase(p);} }, []);
  const resetZoom = useCallback(() => { zoomRef.current = 0; if (mountedRef.current) {setZoom(0);} }, []);

  // Ask for both permissions on open; the mic one is only needed for video,
  // so a mic denial still allows photos (muted video is not offered — a
  // silent clip surprises the recipient).
  useEffect(() => {
    if (camPerm && !camPerm.granted && camPerm.canAskAgain) {void requestCam();}
    if (micPerm && !micPerm.granted && micPerm.canAskAgain) {void requestMic();}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camPerm?.granted, micPerm?.granted]);

  useEffect(() => () => {
    mountedRef.current = false;
    if (holdTimer.current) {clearTimeout(holdTimer.current);}
    if (tickRef.current) {clearInterval(tickRef.current);}
    // A recording in flight when the sheet unmounts is stopped; its resolve
    // path sees `discardRef` and unlinks the file rather than emitting it.
    if (phaseRef.current === 'recording') { discardRef.current = true; camRef.current?.stopRecording(); }
  }, []);

  const stopTick = () => { if (tickRef.current) {clearInterval(tickRef.current); tickRef.current = null;} };

  const backToPicture = useCallback(() => {
    if (REBIND_FIRES_READY) {setReady(false);}
    setMode('picture');
  }, []);

  const takePhoto = useCallback(async () => {
    const cam = camRef.current;
    if (!cam || phaseRef.current !== 'idle') {return;}
    setPhaseBoth('busy');
    haptics.tap();
    try {
      const shot = await cam.takePictureAsync({quality: PHOTO_QUALITY, skipProcessing: false});
      if (!shot?.uri) {throw new Error('no_photo');}
      let {uri, width, height} = shot;
      // G10 parity with the old picker path: a full-sensor still is the single
      // biggest send+receive cost; resize the long edge to 1920. The original
      // full-resolution plaintext is deleted the moment the resized copy exists
      // (B-149 — only ONE app-owned plaintext may exist, and it is the one the
      // tray holds).
      if (Math.max(width ?? 0, height ?? 0) > PHOTO_MAX_EDGE) {
        const landscape = (width ?? 0) >= (height ?? 0);
        const out = await ImageManipulator.manipulateAsync(
          uri, [{resize: landscape ? {width: PHOTO_MAX_EDGE} : {height: PHOTO_MAX_EDGE}}],
          {compress: PHOTO_QUALITY, format: ImageManipulator.SaveFormat.JPEG},
        );
        if (out.uri !== uri) { try { await deleteEphemeralSource(uri); } catch { /* best-effort */ } }
        uri = out.uri; width = out.width; height = out.height;
      }
      setErr(null);
      onCaptured(buildPhotoAsset({uri, width, height}));
    } catch {
      setErr('Could not take the photo. Try again.');
    } finally {
      setPhaseBoth('idle');
    }
  }, [onCaptured, setPhaseBoth]);

  /** One recordAsync attempt; resolves when the clip is done. Throws if the start was refused. */
  const recordOnce = useCallback(async (): Promise<{uri: string} | undefined> => {
    const cam = camRef.current;
    if (!cam) {throw new Error('no_camera');}
    return cam.recordAsync({
      maxDuration: MAX_VIDEO_SECONDS,
      // iOS applies `videoBitrate` only when a codec is named; without it a 30 s
      // 720p clip at the default H.264 rate can cross the 25 MB inline cap and be
      // refused AFTER the user recorded it.
      codec: Platform.OS === 'ios' ? 'avc1' : undefined,
    });
  }, []);

  // The recorder start, driven by state (mode flipped + hold confirmed), with a
  // short delay and bounded retries — see the header comment for why not
  // onCameraReady.
  useEffect(() => {
    if (!(mode === 'video' && phase === 'armed')) {return;}
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = () => {
      stopTick();
      progress.stopAnimation();
      progress.setValue(0);
      setPhaseBoth('idle');
      backToPicture();
      resetZoom();
      if (mountedRef.current) {setElapsed(0);}
    };

    const attempt = async (n: number) => {
      if (cancelled || !mountedRef.current) {return;}
      if (!pressedRef.current) {
        // Released while the mode was still flipping: cancel, no stray clip.
        settle();
        return;
      }
      const startedAt = Date.now();
      let clip: {uri: string} | undefined;
      try {
        // Optimistic: the clock + bar start with the attempt so the user sees
        // REC the instant the hold is confirmed; an early reject rewinds them.
        if (phaseRef.current !== 'recording') {
          setPhaseBoth('recording');
          recStartRef.current = startedAt;
          setElapsed(0);
          stopTick();
          tickRef.current = setInterval(() => { if (mountedRef.current) {setElapsed(Date.now() - recStartRef.current);} }, 1000);
          progress.setValue(0);
          Animated.timing(progress, {toValue: 1, duration: MAX_VIDEO_MS, easing: Easing.linear, useNativeDriver: true}).start();
        }
        clip = await recordOnce();
      } catch {
        if (!cancelled && isEarlyRecordReject(startedAt, Date.now()) && n + 1 < RECORD_START_MAX_ATTEMPTS && pressedRef.current) {
          // Not bound yet — keep the REC state, try again shortly.
          retryTimer = setTimeout(() => { void attempt(n + 1); }, RECORD_START_RETRY_MS);
          return;
        }
        settle();
        setErr(pressedRef.current ? 'Could not start recording. Try again.' : 'Recording was cancelled.');
        return;
      }
      const durationMs = Date.now() - recStartRef.current;
      settle();
      if (!clip?.uri) { setErr('Could not record the video. Try again.'); return; }
      if (discardRef.current) {
        // Closed / backed out while recording: the clip was never wanted.
        discardRef.current = false;
        try { await deleteEphemeralSource(clip.uri); } catch { /* best-effort */ }
        onClose();
        return;
      }
      if (!clipIsUsable(durationMs)) {
        try { await deleteEphemeralSource(clip.uri); } catch { /* best-effort */ }
        setErr('Hold the button to record a video.');
        return;
      }
      setErr(null);
      onCaptured(buildVideoAsset({uri: clip.uri, durationMs}));
    };

    const delay = Platform.OS === 'android' ? RECORD_START_DELAY_MS.android : RECORD_START_DELAY_MS.ios;
    const t = setTimeout(() => { void attempt(0); }, delay);
    return () => { cancelled = true; clearTimeout(t); if (retryTimer) {clearTimeout(retryTimer);} };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, phase]);

  const onCameraReady = useCallback(() => { setReady(true); }, []);

  // ── Shutter responder: grant = press-in, move = zoom slide, release = press-out ──
  const onGrant = (e: GestureResponderEvent) => {
    if (phaseRef.current !== 'idle' || !ready) {return;}
    pressedRef.current = true;
    pressStartY.current = e.nativeEvent.pageY;
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      if (!pressedRef.current || phaseRef.current !== 'idle') {return;}
      if (micPerm && !micPerm.granted) {
        setErr('Microphone access is needed to record a video.');
        return;
      }
      // Haptic at ARM time, before the recorder opens the mic — a buzz during
      // the first frames would be captured on the audio track.
      haptics.impact();
      setPhaseBoth('armed');
      if (REBIND_FIRES_READY) {setReady(false);}
      setMode('video'); // → the start effect above
    }, HOLD_TO_RECORD_MS);
  };

  const onMove = (e: GestureResponderEvent) => {
    if (!pressedRef.current) {return;}
    const p = phaseRef.current;
    if (p !== 'armed' && p !== 'recording') {return;}
    // Slide UP (pageY decreasing) zooms in; back down zooms out. Only a 1 %
    // step reaches setState, so a resting finger costs nothing.
    const next = zoomFromDrag(pressStartY.current - e.nativeEvent.pageY);
    if (zoomChanged(zoomRef.current, next)) { zoomRef.current = next; setZoom(next); }
  };

  const onRelease = () => {
    pressedRef.current = false;
    if (holdTimer.current) {
      // Released before the hold threshold: a tap.
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
      void takePhoto();
      return;
    }
    if (phaseRef.current === 'recording') {
      camRef.current?.stopRecording();
    }
    // 'armed' (mode still flipping): the start effect sees pressedRef=false and cancels.
  };

  const flip = () => {
    if (phaseRef.current !== 'idle') {return;}
    if (REBIND_FIRES_READY) {setReady(false);}
    resetZoom();
    setFacing(f => (f === 'back' ? 'front' : 'back'));
  };

  const close = () => {
    if (phaseRef.current === 'recording') { discardRef.current = true; camRef.current?.stopRecording(); return; }
    if (phaseRef.current === 'busy') {return;}
    onClose();
  };

  const denied = camPerm !== null && !camPerm.granted;
  const shutterSize = Math.min(84, Math.round(winW * 0.22));
  const holding = phase === 'armed' || phase === 'recording';

  return (
    <Modal visible animationType="slide" statusBarTranslucent onRequestClose={close} supportedOrientations={['portrait']}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
      <View style={styles.root}>
        {camPerm?.granted ? (
          <CameraView
            ref={camRef}
            style={StyleSheet.absoluteFill}
            facing={facing}
            mode={mode}
            zoom={zoom}
            mirror={facing === 'front'}
            videoQuality={VIDEO_QUALITY}
            videoBitrate={VIDEO_BITRATE}
            onCameraReady={onCameraReady}
            onMountError={() => setErr('The camera could not start on this device.')}
          />
        ) : (
          <View style={styles.deniedWrap}>
            <Icon name={denied ? 'camera-off-outline' : 'camera-outline'} size={56} color={C.dim} />
            <Text style={styles.deniedTitle}>{denied ? 'Camera access needed' : 'Starting camera…'}</Text>
            {denied && (
              <Text style={styles.deniedSub}>
                Allow camera access in Settings to take photos and record videos here. Library sends still work.
              </Text>
            )}
          </View>
        )}

        {/* Top bar: close, REC clock, flip. */}
        <View style={[styles.topBar, {paddingTop: insets.top + 8}]}>
          <TouchableOpacity onPress={close} style={styles.roundBtn} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
            accessibilityRole="button" accessibilityLabel={phase === 'recording' ? 'Discard recording and close' : 'Close camera'}>
            <Icon name="close" size={24} color={C.white} />
          </TouchableOpacity>
          {phase === 'recording' ? (
            <View style={styles.recPill} accessibilityLiveRegion="polite">
              <View style={styles.recDot} />
              <Text style={styles.recText}>{formatRecClock(elapsed)} / 0:{MAX_VIDEO_SECONDS}</Text>
            </View>
          ) : <View style={{width: 1}} />}
          <TouchableOpacity onPress={flip} style={styles.roundBtn} disabled={phase !== 'idle'} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
            accessibilityRole="button" accessibilityLabel="Flip camera">
            <Icon name="camera-flip-outline" size={24} color={phase === 'idle' ? C.white : C.dim} />
          </TouchableOpacity>
        </View>

        {/* Progress toward the 30 s cap, along the top edge under the bar (native-driven). */}
        {phase === 'recording' && (
          <View style={[styles.progressTrack, {top: insets.top + 64}]}>
            <Animated.View style={[styles.progressFill, {transform: [{scaleX: progress}]}]} />
          </View>
        )}

        {/* Zoom readout while holding — only when the finger has actually moved. */}
        {holding && zoom > 0 && (
          <View style={styles.zoomPill} pointerEvents="none">
            <Icon name="magnify-plus-outline" size={14} color={C.white} />
            <Text style={styles.zoomText}>{Math.round(zoom * 100)}%</Text>
          </View>
        )}

        {/* Bottom: hint + shutter. */}
        <View style={[styles.bottom, {paddingBottom: insets.bottom + 22}]}>
          {err ? <Text style={styles.err} accessibilityRole="alert">{err}</Text> : null}
          <Text style={styles.hint}>
            {phase === 'recording'
              ? 'Release to stop · slide up to zoom'
              : phase === 'armed' ? 'Starting…' : `Tap for photo · hold for video (up to ${MAX_VIDEO_SECONDS} s)`}
          </Text>
          <View
            onStartShouldSetResponder={() => !!camPerm?.granted && phase !== 'busy'}
            onMoveShouldSetResponder={() => false}
            onResponderTerminationRequest={() => false}
            onResponderGrant={onGrant}
            onResponderMove={onMove}
            onResponderRelease={onRelease}
            onResponderTerminate={onRelease}
            accessible
            accessibilityRole="button"
            accessibilityLabel="Shutter"
            accessibilityHint={`Tap to take a photo. Press and hold to record up to ${MAX_VIDEO_SECONDS} seconds of video; slide up while holding to zoom.`}
            accessibilityState={{disabled: !camPerm?.granted || phase === 'busy'}}
            style={[
              styles.shutter,
              {width: shutterSize, height: shutterSize, borderRadius: shutterSize / 2},
              phase === 'recording' && styles.shutterRec,
              (phase === 'busy' || !camPerm?.granted) && styles.shutterDisabled,
            ]}>
            <View style={[
              styles.shutterCore,
              phase === 'recording'
                ? {width: shutterSize * 0.38, height: shutterSize * 0.38, borderRadius: 6, backgroundColor: C.rec}
                : {width: shutterSize * 0.72, height: shutterSize * 0.72, borderRadius: shutterSize * 0.36},
            ]} />
          </View>
          <Text style={styles.encNote}>Encrypted before upload · reviewed before it sends</Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: C.bg},
  deniedWrap: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 12},
  deniedTitle: {color: C.white, fontSize: 17, fontWeight: '800', textAlign: 'center'},
  deniedSub: {color: C.dim, fontSize: 13, lineHeight: 19, textAlign: 'center'},
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12,
  },
  roundBtn: {
    width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.scrim,
  },
  recPill: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 16, backgroundColor: C.scrim,
  },
  recDot: {width: 10, height: 10, borderRadius: 5, backgroundColor: C.rec},
  recText: {color: C.white, fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums']},
  progressTrack: {position: 'absolute', left: 16, right: 16, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.22)', overflow: 'hidden'},
  progressFill: {height: 3, borderRadius: 2, backgroundColor: C.rec, width: '100%', transformOrigin: 'left'},
  zoomPill: {
    position: 'absolute', alignSelf: 'center', top: '46%',
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 16, backgroundColor: C.scrim,
  },
  zoomText: {color: C.white, fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums']},
  bottom: {position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', gap: 14, paddingTop: 18, backgroundColor: 'transparent'},
  hint: {color: C.white, fontSize: 13, fontWeight: '600', textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 6},
  err: {color: C.rec, fontSize: 13, fontWeight: '700', textAlign: 'center', paddingHorizontal: 24},
  shutter: {
    borderWidth: 4, borderColor: C.white, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  shutterRec: {borderColor: C.rec},
  shutterDisabled: {opacity: 0.45},
  shutterCore: {backgroundColor: C.white},
  encNote: {color: C.dim, fontSize: 11, fontWeight: '600', letterSpacing: 0.3},
});
