-- S1 — the ping answer must carry the device mock-location flag.
--
-- B-859 shipped the manager location ping without it. Location integrity is
-- the whole purpose of that feature ("if an admin or higher pings a person
-- they should see their location while on shift"), and a mock-location app
-- turns the answer into a number the device chose. The device already knows:
-- the live on-duty lane ships is_mocked on every heartbeat and agent.service
-- grades it. The ping answer is the OTHER place a coordinate enters this
-- system, and it was the only one dropping the flag on the floor — so the
-- manager sheet rendered a fabricated pin exactly like a real one.
--
-- ADDITIVE ONLY. 20260912100000_attendance_pings.sql is already applied on
-- staging; editing an applied migration is a no-op there and a divergence
-- everywhere else.

ALTER TABLE public.cpo_shift_pings
  ADD COLUMN IF NOT EXISTS mocked BOOLEAN;

-- NULL is not false. A client built before this column existed reports
-- nothing, and recording that as "the device checked and the fix is real" is
-- the one assurance this column must never give on its own.
COMMENT ON COLUMN public.cpo_shift_pings.mocked IS
  'device-reported mock-location flag; NULL = unknown/old client';

-- The same answered-only floor the coordinates already have, kept as its OWN
-- constraint rather than a widened cpo_shift_pings_fix_only_when_answered: a
-- CHECK has no ALTER form, so widening that one means DROP + ADD, which
-- re-validates every existing row to bolt on a column that is NULL in all of
-- them. A refusal (off shift, no permission, no fix, declined) carries no
-- device claim at all, and the service writes none — this is the floor under
-- that, not a substitute for it.
--
-- DROP IF EXISTS then ADD is the repo pattern (family_quota_audit): a CHECK
-- has no IF NOT EXISTS form, so this is what makes a re-run clean.
ALTER TABLE public.cpo_shift_pings
  DROP CONSTRAINT IF EXISTS cpo_shift_pings_mocked_only_when_answered;

ALTER TABLE public.cpo_shift_pings
  ADD CONSTRAINT cpo_shift_pings_mocked_only_when_answered
  CHECK (status = 'answered' OR mocked IS NULL);
