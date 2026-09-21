-- 2026-09-04 — mission FSM trigger learns CREWED (companion to 20260904120000).
--
-- The DB trigger is the LAST line of defence behind MissionStateMachine (TS):
-- an UPDATE that the service layer forgot to guard still cannot skip a state.
-- Mirrors apps/auth-service/src/ops/mission-state-machine.service.ts exactly;
-- mission-state-machine.drift.spec.ts parses THIS file and fails if the two
-- graphs disagree.
--
--   CREWED     → DISPATCHED  the explicit Dispatched action (agency / lead)
--   CREWED     → SOS         a panic must never be refused (parity with DISPATCHED)
--   CREWED     → ABORTED     ops abort, arrival no-show re-dispatch, client cancel,
--                            the crew-assign rollback
--   CREWED     → COMPLETED   drift-janitor data repair ONLY (booking already
--                            terminal); the TS FSM restricts this to SYSTEM and
--                            completeMissionCore additionally requires live_at
--
-- CREWED → PICKUP is deliberately ABSENT: a crew cannot "arrive" before it was
-- dispatched, which is the whole point of the new state.
--
-- One pre-existing edge is REMOVED: DISPATCHED → LIVE. The 2026-05-09 trigger
-- admitted it, but the TypeScript machine has never allowed it for any actor
-- (mission-state-machine.service.spec "rejects skipping PICKUP") and no writer
-- performs it as an UPDATE — the legacy ops instant-deploy INSERTs the row at
-- LIVE, which a BEFORE UPDATE trigger never sees. The drift spec introduced
-- alongside this migration is what surfaced the gap; the trigger now mirrors
-- the source of truth exactly. Every other edge is byte-identical to
-- 20260509100000_phase2_data_integrity.sql.

CREATE OR REPLACE FUNCTION public.missions_fsm_check() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status = 'CREWED'     AND NEW.status IN ('DISPATCHED','SOS','ABORTED','COMPLETED'))
    OR (OLD.status = 'DISPATCHED' AND NEW.status IN ('PICKUP','SOS','ABORTED','COMPLETED'))
    OR (OLD.status = 'PICKUP'   AND NEW.status IN ('LIVE','SOS','ABORTED','COMPLETED'))
    OR (OLD.status = 'LIVE'     AND NEW.status IN ('SOS','ABORTED','COMPLETED'))
    OR (OLD.status = 'SOS'      AND NEW.status IN ('LIVE','ABORTED','COMPLETED'))
  ) THEN
    RAISE EXCEPTION 'invalid_mission_transition: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 20260603110000 pinned every trigger function to pg_catalog; a CREATE OR
-- REPLACE resets function options, so re-pin here.
ALTER FUNCTION public.missions_fsm_check() SET search_path = pg_catalog;

-- The trigger itself is unchanged (BEFORE UPDATE, FOR EACH ROW); re-create it
-- idempotently so a database that somehow lost it is healed by this file.
DROP TRIGGER IF EXISTS missions_fsm_check ON public.missions;
CREATE TRIGGER missions_fsm_check
  BEFORE UPDATE ON public.missions
  FOR EACH ROW EXECUTE FUNCTION public.missions_fsm_check();

-- Defence in depth: nothing writes a mission without naming its status, but the
-- column default must not silently claim "dispatched" for a row that never was.
ALTER TABLE public.missions ALTER COLUMN status SET DEFAULT 'CREWED';
