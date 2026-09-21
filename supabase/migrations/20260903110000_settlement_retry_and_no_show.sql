-- SECURE_SERVICES_E2E_AUDIT_2026-09-03 — E2E-05 / E2E-06 / E2E-13 / E2E-14.
--
-- Three additive column groups on escrow_holds plus the two partial indexes the
-- new bounded sweeps select on. Nothing here changes an existing value, an
-- existing constraint, or the meaning of any column money is settled from.
--
-- E2E-05 (settlement failure after completion strands escrow HELD with no retry)
--   AgentService.settleEscrowOnFinish runs OUTSIDE the completion txn and its catch
--   only logs; re-running completion returns early because the mission is already
--   COMPLETED, the release sweep matches only PENDING_RELEASE, and reconciliation is
--   read-only. So a HELD hold behind a COMPLETED mission is stranded forever
--   (production evidence: 16 completed missions with zero payout rows).
--   settle_attempts / last_settle_attempt_at are the per-row CONDITIONAL CLAIM the
--   retry pass uses: it bumps the counter with `WHERE settle_attempts = <the value it
--   read>`, so two pods (or two ticks) cannot both work the same row, and a row that
--   keeps failing is bounded rather than retried forever. settle_alerted_at throttles
--   the "this one needs a human" alert to one per row per 6h.
--
-- E2E-06 (no client no-show path)
--   no_show_at / no_show_by record that this hold's PARTIAL split came from a
--   lead-declared client no-show rather than a client cancellation — the two settle on
--   the same cancel_fee_pct basis, so `basis` alone cannot tell them apart on the
--   receipt, in reconciliation, or for a later dispute widening.
--
-- Idempotent (IF NOT EXISTS throughout); safe to re-run.

ALTER TABLE public.escrow_holds
  ADD COLUMN IF NOT EXISTS settle_attempts        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_settle_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS settle_alerted_at      timestamptz,
  ADD COLUMN IF NOT EXISTS no_show_at             timestamptz,
  ADD COLUMN IF NOT EXISTS no_show_by             uuid;

COMMENT ON COLUMN public.escrow_holds.settle_attempts IS
  'E2E-05: how many times the settle-retry sweep has claimed this stranded HELD hold. The claim is conditional on this exact value, which is what makes the retry single-writer.';
COMMENT ON COLUMN public.escrow_holds.no_show_at IS
  'E2E-06: set when the PARTIAL split was produced by a lead-declared client no-show (never by a client cancellation).';

-- The E2E-05 retry pass selects HELD, not-under-review holds ordered by how long ago
-- they were last attempted. Without this it is a seq scan of every hold ever taken.
CREATE INDEX IF NOT EXISTS escrow_holds_settle_retry_due
  ON public.escrow_holds (last_settle_attempt_at NULLS FIRST)
  WHERE status = 'HELD' AND NOT review_required;

-- The E2E-13 block-end pass and the E2E-14 overdue-check-in pass both start from
-- "missions still LIVE". Partial so it stays tiny (live missions are a handful at any
-- moment) regardless of how large the missions table grows.
CREATE INDEX IF NOT EXISTS missions_live_booking_idx
  ON public.missions (booking_id)
  WHERE status = 'LIVE';
