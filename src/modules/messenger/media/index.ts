export {encryptAttachment, decryptAttachment, type EncryptedAttachment} from './aesCbc';
export {MediaClient, MediaHttpError, type MediaClientOptions, type UploadedAttachment} from './mediaClient';
export {MediaBlobCache, type MediaBlobCacheOptions} from './mediaBlobCache';
export {
  readUriBytes, writeTempBytes, deleteTempBytes, statTempBytes, deleteEphemeralSource,
  // B-728 — the OOM ceiling and its label. Screens import the LABEL rather than
  // typing a size into user-facing copy, so the promise and the gate cannot drift.
  MAX_INLINE_MEDIA_BYTES, MAX_INLINE_MEDIA_MB, MediaTooLargeError,
} from './mediaFiles';
export {
  useAttachmentUri, attachmentErrorText, seedResolvedAttachmentUri,
  resolveAttachmentFileUri,
  type AttachmentState, type AttachmentErrorReason,
} from './useAttachmentUri';
