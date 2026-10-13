/**
 * "Share to Bravo" (2026-10-13) — the JS side of Bravo as an Android share
 * target. The native BravoShareIntentModule keeps the share intent and copies
 * each shared item into the app's private cache; this module turns that into
 * the PickedAsset shape the chat's media tray already sends.
 *
 * The copies are app-owned plaintext, so every item is `ephemeralSource`: the
 * media pipeline deletes the copy once its bytes are read (B-149), and a
 * cancelled share deletes them all (discardShareFiles).
 */
import {NativeEventEmitter, NativeModules, Platform} from 'react-native';
import type {PickedAsset} from '../ui/pickedAssets';
import {MAX_PICKED_ASSETS} from '../ui/pickedAssets';

export interface IncomingShare {
  /** Shared text (a link, a note), with the subject line when one came along. */
  text:  string | null;
  items: PickedAsset[];
}

interface RawItem { uri?: unknown; mimeType?: unknown; name?: unknown; size?: unknown }
interface RawShare { text?: unknown; subject?: unknown; items?: unknown }

interface NativeShare {
  getPending(): Promise<RawShare | null>;
  clear(): Promise<void>;
  discardFiles(): Promise<void>;
}

function native(): NativeShare | null {
  if (Platform.OS !== 'android') {return null;}
  const m = (NativeModules as {BravoShareIntent?: NativeShare}).BravoShareIntent;
  return m && typeof m.getPending === 'function' ? m : null;
}

export function kindForMime(mime: string): PickedAsset['kind'] {
  if (mime.startsWith('image/')) {return 'image';}
  if (mime.startsWith('video/')) {return 'video';}
  if (mime.startsWith('audio/')) {return 'audio';}
  return 'file';
}

/** Pure: the native payload → what the chat can send. Null when there is nothing. */
export function normalizeShare(raw: RawShare | null | undefined): IncomingShare | null {
  if (!raw || typeof raw !== 'object') {return null;}
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const subject = str(raw.subject);
  const body = str(raw.text);
  const text = subject && body && !body.includes(subject) ? `${subject}\n${body}` : (body || subject);
  const items: PickedAsset[] = [];
  for (const r of (Array.isArray(raw.items) ? raw.items : []) as RawItem[]) {
    const uri = str(r?.uri);
    if (!uri.startsWith('file://')) {continue;}
    const mime = str(r?.mimeType).toLowerCase() || 'application/octet-stream';
    const name = str(r?.name) || undefined;
    items.push({uri, mime, kind: kindForMime(mime), meta: {name}, ephemeralSource: true});
    if (items.length >= MAX_PICKED_ASSETS) {break;}
  }
  if (!text && items.length === 0) {return null;}
  return {text: text ? text.slice(0, 20_000) : null, items};
}

/** Read (and consume) the share that opened / reached the app, if any. */
export async function takePendingShare(): Promise<IncomingShare | null> {
  const m = native();
  if (!m) {return null;}
  try {
    const raw = await m.getPending();
    if (raw) {await m.clear();}
    return normalizeShare(raw);
  } catch (e) {
    console.warn('[share-in] read failed:', (e as Error).message);
    try { await m.clear(); } catch { /* ignore */ }
    return null;
  }
}

/** Delete the cached copies of a share the user cancelled. */
export async function discardShareFiles(): Promise<void> {
  try { await native()?.discardFiles(); } catch { /* best-effort */ }
}

/** A share arrived while the app was already running. */
export function onShareIntent(fn: () => void): () => void {
  const m = native();
  if (!m) {return () => undefined;}
  const emitter = new NativeEventEmitter(m as never);
  const sub = emitter.addListener('BravoShareIntent', fn);
  return () => sub.remove();
}

/** "1 screenshot", "3 photos", "a document and 2 photos" — for the picker header. */
export function describeShare(share: IncomingShare): string {
  const n = (k: PickedAsset['kind']) => share.items.filter(i => i.kind === k).length;
  const parts: string[] = [];
  const add = (count: number, one: string, many: string) => {
    if (count) {parts.push(count === 1 ? `1 ${one}` : `${count} ${many}`);}
  };
  add(n('image'), 'photo', 'photos');
  add(n('video'), 'video', 'videos');
  add(n('audio'), 'audio file', 'audio files');
  add(n('file'), 'document', 'documents');
  if (share.text) {parts.push(share.items.length ? 'text' : 'a message');}
  return parts.join(' and ') || 'Shared item';
}
