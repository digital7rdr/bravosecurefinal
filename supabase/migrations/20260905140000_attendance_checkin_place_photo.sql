-- Attendance verification for managers (founder, 2026-09-05):
--
--  1. WHERE the check-in / check-out happened, as a place NAME the manager can
--     read ("Sandton City, Johannesburg"), not a code or a coordinate pair. The
--     coordinates already stored drive the map; the name is reverse-geocoded
--     server-side at clock-in (best effort — a geocode miss leaves it NULL and
--     the app falls back to the coordinates).
--
--  2. The check-in FACE PHOTO, viewable by the responsible manager while the
--     session is under review, then DELETED once the review is decided and the
--     shift is over. This deliberately supersedes the 2026-07-02 "the frame
--     never leaves the device" stop-condition, on the founder's instruction of
--     2026-09-05, with these bounds:
--       - bytes are sealed at rest (AES-256-GCM, a key derived for this purpose
--         only, the session id bound as AAD);
--       - only an org manager in the member's branch can read them, every read
--         is written to org_audit_log;
--       - the row's bytes are wiped (sealed = NULL, deleted_at set) when the
--         review is no longer pending AND the shift has ended, and in any case
--         after a hard TTL; the export stays biometric-free.

ALTER TABLE public.cpo_shift_sessions
  ADD COLUMN IF NOT EXISTS clock_in_place  TEXT,
  ADD COLUMN IF NOT EXISTS clock_out_place TEXT;

CREATE TABLE IF NOT EXISTS public.attendance_checkin_photos (
  session_id     UUID PRIMARY KEY REFERENCES public.cpo_shift_sessions(id) ON DELETE CASCADE,
  org_user_id    UUID NOT NULL,
  cpo_user_id    UUID NOT NULL,
  mime           TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png')),
  bytes_len      INTEGER NOT NULL CHECK (bytes_len > 0),
  -- NULL once purged; the row itself stays as the audit trail of the view count.
  sealed         BYTEA,
  view_count     INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS attendance_checkin_photos_live_idx
  ON public.attendance_checkin_photos(org_user_id, created_at)
  WHERE deleted_at IS NULL;

ALTER TABLE public.attendance_checkin_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_checkin_photos FORCE  ROW LEVEL SECURITY;

COMMENT ON TABLE public.attendance_checkin_photos IS
  'Sealed check-in face photo for manager verification. Purged (sealed = NULL) once the review is decided and the shift has ended, or after the hard TTL.';
COMMENT ON COLUMN public.cpo_shift_sessions.clock_in_place IS
  'Reverse-geocoded place name of the check-in fix (server-side, best effort). NULL = not geocoded.';
