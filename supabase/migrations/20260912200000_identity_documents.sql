-- B-867 — Identity verification for every individual account (founder,
-- 2026-09-12): "all individual users have to submit their ID / passport on the
-- registration process; if they missed it, the settings page is where they
-- submit; after submission they can start a Secure booking, if not the system
-- tells them where to go; ops sees the photo they uploaded."
--
-- ONE row per user. A row EXISTS ⇔ the document is submitted — there is no
-- separate status column to drift from the bytes. The booking gate
-- (identityGate.ts) and /auth/me both read exactly this existence.
--
-- Bounds (same posture as attendance_checkin_photos, 20260905140000):
--   - bytes are sealed at rest (AES-256-GCM, a key derived for THIS purpose
--     only, the user id + side bound as AAD so a blob moved onto another row
--     refuses to open); mime is sniffed from the bytes, never trusted;
--   - the owner may write (submit / replace) and read their own status —
--     never the bytes back (the app keeps nothing);
--   - ops reads the bytes ONLY through /ops/users/:id/identity-document, and
--     every read is written to ops_audit (subject_type 'pii',
--     action 'identity_document.view') with a view counter on the row;
--   - a passport has one side; a national ID may carry a back side.
--
-- This is a KYC record, not evidence of a single event, so unlike the check-in
-- photo it has NO purge sweep: it lives as long as the account (CASCADE).

CREATE TABLE IF NOT EXISTS public.identity_documents (
  user_id         UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  doc_type        TEXT NOT NULL CHECK (doc_type IN ('national_id', 'passport')),
  front_mime      TEXT NOT NULL CHECK (front_mime IN ('image/jpeg', 'image/png')),
  front_bytes_len INTEGER NOT NULL CHECK (front_bytes_len > 0),
  front_sealed    BYTEA NOT NULL,
  back_mime       TEXT CHECK (back_mime IN ('image/jpeg', 'image/png')),
  back_bytes_len  INTEGER CHECK (back_bytes_len > 0),
  back_sealed     BYTEA,
  -- The back side is all-or-nothing.
  CONSTRAINT identity_documents_back_side_chk CHECK (
    (back_mime IS NULL AND back_bytes_len IS NULL AND back_sealed IS NULL)
    OR (back_mime IS NOT NULL AND back_bytes_len IS NOT NULL AND back_sealed IS NOT NULL)
  ),
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  view_count      INTEGER NOT NULL DEFAULT 0,
  last_viewed_at  TIMESTAMPTZ
);

ALTER TABLE public.identity_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.identity_documents FORCE  ROW LEVEL SECURITY;

COMMENT ON TABLE public.identity_documents IS
  'Sealed ID / passport photo per individual account (B-867). Row exists = submitted. Read by ops only, every read audited.';
