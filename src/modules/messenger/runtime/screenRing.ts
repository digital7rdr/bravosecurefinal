/**
 * 2026-10-25 (owner: "use the default phone ring for the app") — how an
 * in-app incoming-call screen rings.
 *
 * Before, a ring screen played the app's own WAV through expo-av: MEDIA volume
 * (often low or muted), quiet, and silenced whenever the app BELIEVED the
 * notification had started the device ringtone, even when the phone had in
 * fact skipped it — so calls could ring in total silence.
 *
 * Now every ring screen asks for the DEVICE-DEFAULT ringtone (ringer volume,
 * the user's own ringtone, silent/vibrate respected) through ringIncoming().
 * The bundled tone is only a fallback when the phone's ringtone could not be
 * played at all ('no-uri' / 'failed' / no native module) — never when the
 * ringer is deliberately silent.
 */
import {Vibration} from 'react-native';
import {ringIncoming, stopIncomingRingtone} from '../push/incomingRingtone';

export const RING_VIBRATION: number[] = [0, 800, 1200, 800];

/** Start ringing for `callId`; returns the stop function (idempotent). */
export function startScreenRing(callId: string, opts: {vibrateDelayMs?: number} = {}): () => void {
  let stopped = false;
  let usingFallback = false;
  const vibTimer = setTimeout(() => {
    if (!stopped) {Vibration.vibrate(RING_VIBRATION, true);}
  }, opts.vibrateDelayMs ?? 0);

  void ringIncoming(callId).then(result => {
    if (stopped) {
      // The screen left while the start was in flight: make sure nothing keeps ringing.
      if (result === 'started') {stopIncomingRingtone(callId, 'screen-left-early');}
      return;
    }
    if (result === 'started' || result === 'silent') {return;}
    usingFallback = true;
    const tones = require('./bravoTones') as typeof import('./bravoTones');
    void tones.startRingtone();
  });

  return () => {
    if (stopped) {return;}
    stopped = true;
    clearTimeout(vibTimer);
    Vibration.cancel();
    stopIncomingRingtone(callId, 'ring-screen');
    if (usingFallback) {
      const tones = require('./bravoTones') as typeof import('./bravoTones');
      void tones.stopRingtone();
    }
  };
}
