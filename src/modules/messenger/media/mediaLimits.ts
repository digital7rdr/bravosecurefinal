/**
 * B-728 — the memory ceilings on the base64 file lanes, and the error they raise.
 *
 * Its OWN module, with no RNFS / runtime imports, for the same reason
 * `attachmentError.ts` next door is: the classifier has to `instanceof` this
 * error, and it must stay importable without dragging a native module into
 * every suite and screen that touches it.
 *
 * ── WHY A CEILING EXISTS AT ALL ────────────────────────────────────────────
 * `RNFS.readFile` / `RNFS.writeFile` land in `RNFSManager`, whose method bodies
 * are wrapped in `catch (Exception ex)`. `OutOfMemoryError` extends `Error`, NOT
 * `Exception`, so an OOM in there is never caught, never becomes a rejected
 * promise, and escapes the `@ReactMethod` on the NativeModules thread; in a
 * release build `DisabledDevSupportManager` rethrows it on the UI thread and
 * Android kills the process. No JS `try/catch` can contain it.
 *
 * `android:largeHeap` is deliberately NOT set (it lengthens GC pauses on a JS
 * thread this repo has already measured as the bottleneck — B-279), so the
 * budget is the plain `heapgrowthlimit`: 256 MB on a lot of mid-range Android,
 * and the app is not starting from empty.
 *
 * ── WHY TWO NUMBERS, NOT ONE ───────────────────────────────────────────────
 * The two directions do NOT cost the same, and collapsing them into one
 * constant was a real regression (adversarial review, 2026-09-02): it stranded
 * content the SERVER legitimately accepts.
 *
 *   READ  (~5N)   ByteArrayOutputStream doubling (~2N) + toByteArray (N),
 *                 then Base64.encodeToString's internal byte[] (1.33N) + the
 *                 returned UTF-16 String (2.67N).
 *   WRITE (~3.7N) the base64 String we hand in (2.67N) + the decoded byte[] (N).
 *                 No accumulate-and-copy stage — we already know the length.
 *
 * So the read side must be the strict one. Using the read number on the write
 * side too meant a 40 MB video that another client legitimately sent (the
 * server cap is 50 MB) downloaded and decrypted fine and then could never be
 * materialised — an infinite re-download loop on the chat bubble, and a vault
 * row that charged an MFA proof before refusing. The write ceiling is set from
 * the write cost instead.
 */

/**
 * The UPLOAD ceiling — what we will read off the device and let into the system.
 * 25 MB * 5 = 125 MB peak, which leaves real headroom under a 256 MB budget.
 * Nothing new above this can be created, which is what keeps the write side's
 * exposure bounded going forward.
 */
export const MAX_INLINE_MEDIA_BYTES = 25 * 1024 * 1024;

/**
 * The OPEN ceiling — what we will materialise back to a plaintext temp file.
 * Higher than the upload ceiling ON PURPOSE: it has to cover bytes that already
 * exist and are not ours to refuse (older builds, iOS, the ops-console, or a
 * row stored before the upload ceiling landed). 40 MB * 3.7 = ~148 MB peak.
 *
 * The 40-50 MB band the server still accepts remains unopenable on a small-heap
 * phone. That band was CRASHING before, so this is a downgrade from process
 * death to an honest message — not a new limitation. Closing it properly needs
 * a streaming write, not a bigger constant.
 */
export const MAX_DECRYPT_WRITE_BYTES = 40 * 1024 * 1024;

/**
 * The same numbers as labels, so user-facing copy cannot drift from the gate.
 * It already had: four screens promised "up to 50 MB" while the pipeline died
 * north of ~35 MB, so the app advertised a size it could not survive.
 */
export const MAX_INLINE_MEDIA_MB = Math.floor(MAX_INLINE_MEDIA_BYTES / (1024 * 1024));
export const MAX_DECRYPT_WRITE_MB = Math.floor(MAX_DECRYPT_WRITE_BYTES / (1024 * 1024));

/**
 * Raised BEFORE the native call, so callers get a catchable error instead of a
 * dead process.
 *
 * `terminal` is what stops a refusal becoming a bandwidth loop: an oversized
 * attachment must classify as a permanent condition, not as "tap to retry",
 * because retrying re-downloads and re-decrypts tens of megabytes to fail in
 * exactly the same place.
 */
export class MediaTooLargeError extends Error {
  readonly sizeBytes: number;
  readonly limitBytes: number;
  readonly terminal = true as const;
  constructor(sizeBytes: number, limitBytes: number) {
    super(
      `This file is ${(sizeBytes / 1048576).toFixed(0)} MB, over the `
      + `${Math.floor(limitBytes / 1048576)} MB this device can handle.`,
    );
    this.name = 'MediaTooLargeError';
    this.sizeBytes = sizeBytes;
    this.limitBytes = limitBytes;
  }
}
