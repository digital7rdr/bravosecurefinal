'use client';
/**
 * 2026-10-27 (owner) — files in the web messenger: the 📎 button in the
 * composer and the file card in a bubble. Shared by 1:1 chats
 * (ChatWorkspace) and linked groups (LinkedGroups).
 *
 * Files are end-to-end encrypted in the browser before upload and decrypted
 * in the browser on download (lib/messenger/mediaClient.ts).
 */
import {useRef, useState} from 'react';
import type {WebAttachment} from '@/lib/messenger/mediaClient';
import {saveBlob, sizeLabel, WEB_FILE_MAX_BYTES} from '@/lib/messenger/mediaClient';

/** Anything that can open a file from a message (both runtimes can). */
export interface FileOpener { openFile(att: WebAttachment): Promise<Blob> }

/** What a failed file send means, in words. */
export function fileSendError(e: unknown): string {
  const m = (e as Error)?.message ?? '';
  if (m === 'file_too_large') return `That file is too large. Files up to ${WEB_FILE_MAX_BYTES / (1024 * 1024)} MB can be sent.`;
  if (m === 'empty_file') return 'That file is empty.';
  if (m === 'phone_app_too_old_for_files') return 'Update the Bravo app on your phone to send files from this browser.';
  if (/upload_failed|Failed to fetch|NetworkError/i.test(m)) return 'The file could not be uploaded. Check your connection and try again.';
  return 'The file was not sent. Please try again.';
}

/** A failed row that was a FILE send (retrying it as text would be wrong). */
export function isFileRow(m: {attachment?: WebAttachment | null; body: string}): boolean {
  return !!m.attachment || m.body.startsWith('📎 ');
}

export function AttachButton({onPick, disabled, title}: {
  onPick: (file: File) => void; disabled?: boolean; title?: string;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input ref={input} type="file" hidden
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onPick(f); }} />
      <button type="button" className="btn chat-attach" disabled={disabled}
        title={title ?? 'Attach a file'} aria-label={title ?? 'Attach a file'}
        onClick={() => input.current?.click()}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
        </svg>
      </button>
    </>
  );
}

export function FileCard({att, opener}: {att: WebAttachment; opener: FileOpener | null}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const name = att.name || (att.kind === 'image' ? 'Photo' : att.kind === 'video' ? 'Video' : att.kind === 'audio' ? 'Audio' : 'File');
  const fetchBlob = async (): Promise<Blob | null> => {
    if (!opener) return null;
    setBusy(true); setErr(null);
    try { return await opener.openFile(att); }
    catch { setErr('Could not open this file.'); return null; }
    finally { setBusy(false); }
  };
  const download = async () => { const b = await fetchBlob(); if (b) saveBlob(b, name); };
  const show = async () => { const b = await fetchBlob(); if (b) setPreview(URL.createObjectURL(b)); };
  return (
    <div className="chat-file">
      {preview && att.kind === 'image'
        ? <img className="chat-file-img" src={preview} alt={name} />
        : null}
      <div className="chat-file-row">
        <span className="chat-file-icon" aria-hidden="true">{att.kind === 'image' ? '🖼' : att.kind === 'video' ? '🎬' : att.kind === 'audio' ? '🎤' : '📄'}</span>
        <span className="chat-file-text">
          <span className="chat-file-name">{name}</span>
          <span className="chat-file-size">{sizeLabel(att.size)}</span>
        </span>
        {att.kind === 'image' && !preview && (
          <button type="button" className="chat-file-btn" disabled={busy || !opener} onClick={() => void show()}>View</button>
        )}
        <button type="button" className="chat-file-btn" disabled={busy || !opener} onClick={() => void download()}>
          {busy ? '…' : 'Download'}
        </button>
      </div>
      {err && <div className="chat-file-err">{err}</div>}
    </div>
  );
}
