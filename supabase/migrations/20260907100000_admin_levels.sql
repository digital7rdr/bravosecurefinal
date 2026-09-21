-- B-818 (founder, 2026-09-07) — four console admin levels.
--
--   SUPER_ADMIN          controls everything; the only role that can mint
--                        console accounts (id + password) and change roles.
--   OPERATION_ADMIN      Bravo Secure services — Lite (secure transfer, recon,
--                        extraction), Executive Protection, Secure Pro, plus the
--                        people / finance / config surfaces those services run on.
--   COMMUNICATION_ADMIN  messenger + Enterprise workspaces.
--   RISK_ADMIN           safety — VBG (virtual bodyguard) monitoring and SOS.
--
-- The legacy ranked roles (OPS < SUPERVISOR < ADMIN) stay valid: ADMIN is a
-- SUPER_ADMIN alias (rank 3, every domain), SUPERVISOR/OPS keep their rank and
-- see every domain, region-scoped as before. Nothing existing changes meaning.
--
-- ADD VALUE is idempotent (IF NOT EXISTS) and, on PG ≥ 12, allowed inside a
-- transaction as long as the new label is not USED in the same transaction —
-- this file only adds labels.
ALTER TYPE admin_role ADD VALUE IF NOT EXISTS 'SUPER_ADMIN';
ALTER TYPE admin_role ADD VALUE IF NOT EXISTS 'OPERATION_ADMIN';
ALTER TYPE admin_role ADD VALUE IF NOT EXISTS 'COMMUNICATION_ADMIN';
ALTER TYPE admin_role ADD VALUE IF NOT EXISTS 'RISK_ADMIN';
