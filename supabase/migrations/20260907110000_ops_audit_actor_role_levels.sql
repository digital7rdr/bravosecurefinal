-- B-818 critic P0 — `ops_audit_actor_role_chk` (20260509100000) admitted only
-- the legacy three admin labels, so an action by any NEW level failed its
-- audit INSERT: `createAccount` rolled back (a SUPER_ADMIN could not create the
-- very account the founder asked for), CRITICAL actions 5xx'd after their
-- mutation committed, and every other action silently lost its audit row.
-- Same shape as the original: drop + re-add, idempotent.
ALTER TABLE ops_audit
  DROP CONSTRAINT IF EXISTS ops_audit_actor_role_chk;
ALTER TABLE ops_audit
  ADD CONSTRAINT ops_audit_actor_role_chk
  CHECK (actor_role IN (
    'OPS', 'SUPERVISOR', 'ADMIN',
    'SUPER_ADMIN', 'OPERATION_ADMIN', 'COMMUNICATION_ADMIN', 'RISK_ADMIN',
    'SYSTEM', 'AGENT', 'CLIENT'
  ));
