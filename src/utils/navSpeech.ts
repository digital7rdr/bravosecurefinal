/**
 * Spoken navigation guidance — the SPEAKING half (navVoice.ts decides what to
 * say). Used by GeoRisk in-app navigation (2026-10-30).
 *
 * expo-speech is a NATIVE module, resolved lazily so a build without it
 * degrades to silent guidance instead of crashing the screen (same idiom as
 * AgentLiveTrackerScreen). Never speaks over a live call.
 */
import {getActiveCall} from '@modules/messenger/runtime/callRegistry';
import {getActiveGroupCall} from '@modules/messenger/runtime/groupCallRegistry';

type SpeechLike = {
  speak: (text: string, opts?: {language?: string}) => void;
  stop: () => Promise<void>;
};
const SILENT: SpeechLike = {speak: () => undefined, stop: () => Promise.resolve()};
let mod: SpeechLike | null = null;

function speech(): SpeechLike {
  if (!mod) {
    try {
      mod = require('expo-speech') as SpeechLike;
    } catch {
      mod = SILENT;
    }
  }
  return mod;
}

/**
 * Say `text` now, cutting off any older cue (only the newest instruction is
 * still true). Returns whether it was actually spoken, so the caller records
 * a cue as delivered only when it was.
 */
export function speakGuidance(text: string): boolean {
  if (!text) {return false;}
  if (getActiveCall() || getActiveGroupCall()) {return false;}
  try {
    speech().stop().catch(() => undefined);
    speech().speak(text, {language: 'en-GB'});
    return true;
  } catch {
    return false;
  }
}

export function stopGuidance(): void {
  try { speech().stop().catch(() => undefined); } catch { /* no engine */ }
}
