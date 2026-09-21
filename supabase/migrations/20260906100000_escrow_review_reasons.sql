-- B-807 (2026-09-06) — the proof-of-completion gate's failing checks are persisted
-- on the hold it parks.
--
-- Before this the gate returned its reason ids to the caller, which logged them
-- (`dispatch.completion_gate_fail booking=… reasons=…`) and wrote ONLY
-- `review_required = TRUE`. The operator who later has to release or refund the
-- hold from the Finance › Escrow page was therefore deciding blind: the console
-- could say "parked for review" and nothing else, and the evidence lived in a
-- container log line nobody at the console can reach.
--
-- `review_reasons` is the gate's reason-id list (e.g. {never_reached_pickup,
-- insufficient_telemetry}) — internal enum-like ids, no PII, no coordinates. It is
-- written at the same instant as review_required and is NEVER cleared: after the
-- operator resolves the hold it stays as the record of why the hold was parked
-- (the audit row carries the operator's decision; this carries the machine's).
--
-- The reasons are shown to OPERATORS only (SUPERVISOR+ finance reads). They are
-- deliberately not returned to the lead / agency (`proof-of-completion.service.ts`:
-- "never expose the reason to the lead"), so a gate failure cannot be tuned around.
--
-- Additive, idempotent; safe to re-run.

ALTER TABLE public.escrow_holds
  ADD COLUMN IF NOT EXISTS review_reasons text[];

COMMENT ON COLUMN public.escrow_holds.review_reasons IS
  'B-807: the proof-of-completion gate check ids that failed when review_required was set (operator evidence; never cleared, never shown to the lead).';
