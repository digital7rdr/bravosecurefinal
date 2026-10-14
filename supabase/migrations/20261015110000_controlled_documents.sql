-- Bravo controlled-document library (ISO 9001:2015 file naming, 2026-10-15).
--
-- The owner adopted the "ISO 9001:2015 File Naming Conventions" deck for files,
-- documents and folders on the Bravo platform. Its folder structure becomes a
-- library in the ops console:
--
--   main folder  = department (EX Executive Director … QH Quality/HSSE, 13 codes)
--   sub-folder   = category 100 Policy / Procedures · 200 Work Instructions ·
--                  300 Forms · 400 Organizational Charts and Drawings
--   document     = "BRV-FN 100-001 Expense Tracking Procedure", numbered per
--                  department + category, never reused
--   file         = "BRV-FN-100-001_ExpenseTrackingProcedure_v2.pdf", one row
--                  per version, every version kept
--
-- WHY THE BYTES LIVE IN THE DATABASE. The only file store auth-service has is
-- `uploads/`, which main.ts serves PUBLICLY as static assets — the wrong place
-- for internal policies. Postgres keeps them private, inside the existing
-- backups, with no new volume. Files are capped at 20 MB (controlled
-- documents: policies, forms, charts), and list queries never select `content`.
--
-- NOTHING IS DELETED. ISO 9001 7.5.3 asks for retained, retrievable history:
-- a superseded version stays readable, and a withdrawn document is marked
-- 'obsolete', not removed. There is no DELETE path in the service, and the FK
-- below is RESTRICT so a stray delete of a document with versions fails.
--
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS public.controlled_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_code  text NOT NULL CHECK (department_code IN
                     ('EX','MS','SS','GR','EC','TR','BC','HR','SC','LG','IT','FN','QH')),
  category         smallint NOT NULL CHECK (category IN (100, 200, 300, 400)),
  seq              integer NOT NULL CHECK (seq BETWEEN 1 AND 999),
  title            text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'obsolete')),
  current_version  integer NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  created_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT controlled_documents_number_unique UNIQUE (department_code, category, seq)
);

COMMENT ON TABLE public.controlled_documents IS
  'ISO 9001 controlled documents (2026-10-15): one row per document number '
  'BRV-<dept> <category>-<seq>. Never deleted; withdrawn = status obsolete.';

CREATE TABLE IF NOT EXISTS public.controlled_document_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id    uuid NOT NULL REFERENCES public.controlled_documents(id) ON DELETE RESTRICT,
  version        integer NOT NULL CHECK (version >= 1),
  -- The convention name the file is served under, e.g.
  -- BRV-FN-100-001_ExpenseTrackingProcedure_v2.pdf. Recorded, not recomputed,
  -- so a later title change never renames an issued version.
  stored_name    text NOT NULL CHECK (stored_name ~ '^[A-Za-z0-9_-]+(\.[a-z0-9]{1,5})?$'),
  -- What the uploader called it — a label only.
  original_name  text NOT NULL,
  mime           text NOT NULL,
  size_bytes     integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 20971520),
  sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content        bytea NOT NULL,
  change_note    text NULL CHECK (change_note IS NULL OR char_length(change_note) <= 500),
  uploaded_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT controlled_document_versions_unique UNIQUE (document_id, version)
);

CREATE INDEX IF NOT EXISTS controlled_documents_folder_idx
  ON public.controlled_documents (department_code, category, seq);

-- Server-only tables: deny-by-default for PostgREST roles, like every other
-- table behind auth-service.
ALTER TABLE public.controlled_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.controlled_document_versions ENABLE ROW LEVEL SECURITY;
