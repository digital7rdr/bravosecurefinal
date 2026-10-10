-- 2026-10-10 (owner decision) — keep every identity document an account has
-- uploaded. `identity_documents` stays EXACTLY as it was: one row per user,
-- the ACTIVE document, read by the booking gate (identityGate.ts), /auth/me and
-- the ops "reveal" route. Before a replacement overwrites that row, the
-- auth-service copies the outgoing row here in the same transaction
-- (IdentityDocumentService.submit), so nothing an account submitted is lost.
--
-- Same bounds as the active table (20260912200000_identity_documents.sql):
--   - the sealed blobs move byte-for-byte; the AES-GCM AAD is owner id + side,
--     both unchanged, so a version opens with the same derived key and a blob
--     copied onto another user still refuses to open;
--   - nobody reads bytes except ops through
--     GET /ops/users/:id/identity-document/versions/:versionId — SUPERVISOR+,
--     fail-closed ops_audit row ('identity_document.view', version_id in the
--     metadata) BEFORE anything is opened, plus a per-version view counter;
--   - the owner's app never reads versions back;
--   - account erasure deletes these rows explicitly (soft-deleted users never
--     fire the CASCADE), mirroring the active row.
--
-- Replacements made BEFORE this migration overwrote the old row in place —
-- those earlier documents are not recoverable.

CREATE TABLE IF NOT EXISTS public.identity_document_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  doc_type        TEXT NOT NULL CHECK (doc_type IN ('national_id', 'passport')),
  front_mime      TEXT NOT NULL CHECK (front_mime IN ('image/jpeg', 'image/png')),
  front_bytes_len INTEGER NOT NULL CHECK (front_bytes_len > 0),
  front_sealed    BYTEA NOT NULL,
  back_mime       TEXT CHECK (back_mime IN ('image/jpeg', 'image/png')),
  back_bytes_len  INTEGER CHECK (back_bytes_len > 0),
  back_sealed     BYTEA,
  CONSTRAINT identity_document_versions_back_side_chk CHECK (
    (back_mime IS NULL AND back_bytes_len IS NULL AND back_sealed IS NULL)
    OR (back_mime IS NOT NULL AND back_bytes_len IS NOT NULL AND back_sealed IS NOT NULL)
  ),
  -- When THAT document was uploaded (copied from identity_documents.submitted_at).
  submitted_at    TIMESTAMPTZ NOT NULL,
  -- When a newer upload replaced it.
  superseded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Views while it was the active document carry over; later reveals add to it.
  view_count      INTEGER NOT NULL DEFAULT 0,
  last_viewed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS identity_document_versions_user_idx
  ON public.identity_document_versions (user_id, superseded_at DESC);

ALTER TABLE public.identity_document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.identity_document_versions FORCE  ROW LEVEL SECURITY;

COMMENT ON TABLE public.identity_document_versions IS
  'Earlier (replaced) identity documents per account, sealed exactly like identity_documents. Ops-only reads, every read audited.';
