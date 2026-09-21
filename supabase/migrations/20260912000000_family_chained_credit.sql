-- B-854 — chained family credit.
--
-- A linked member B (a member of root A) who holds their OWN members C can have
-- C's bookings paid from A's wallet, counted against B's allowance on A's plan
-- AND against C's own limit under B. Exactly ONE hop: if A is itself funded by
-- Z, C's booking never climbs to Z.
--
-- What this migration adds, and why each piece exists:
--   1. family_members.funds_sub_members — the switch, on the (holder = A,
--      member = B) row. Default false, so nothing changes until A approves.
--   2. A partial unique on (member_id) WHERE funds_sub_members AND status =
--      'active' — a member funds their own members from AT MOST ONE root, even
--      though B-843 lets B belong to several. Restricted to 'active' on purpose
--      (plan A9): a merely PENDING row must not be able to squat the one slot.
--   3. lite_bookings.payer_via_user_id — the chain, stamped at create. NULL for
--      every non-chained booking, so `payer_user_id` keeps its existing meaning
--      ("the wallet that pays") for refunds, ops and history.
--   4. Two expression indexes on wallet_transactions.metadata so the family
--      spend readers can key on the LEDGER ROW ID instead of the actor (plan
--      A6 — a C-originated charge carries actor C, which is invisible on B's
--      line).
--   5. family_quota_audit.action gains the four FUND_MEMBERS_* verbs. The
--      existing CHECK is UPPERCASE; these match it.
--   6. family_funding_requests — B REQUESTS, A APPROVES (plan A11). Every
--      money-widening act in this product is the payer's, and the payer here
--      is A.
--
-- Additive everywhere: an old server ignores the columns, an old APK never
-- sends the new routes, and `funds_sub_members = false` is exactly today.

-- ── 1. The switch ──────────────────────────────────────────────────────────

ALTER TABLE public.family_members
  ADD COLUMN IF NOT EXISTS funds_sub_members BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.family_members.funds_sub_members IS
  'B-854 — on the (holder = root, member = B) row: B''s own members may spend this allowance, paid from the root wallet. Approved by the ROOT, never set by invite/accept.';

-- At most ONE funding root per member (plan D1 + A9). The predicate is
-- deliberately status = active and NOT status IN (pending, active): the flag
-- is only ever set on an ACTIVE row (approve refuses a non-active one),
-- so admitting 'pending' would only let a dead row hold the slot.
--
-- PROD NOTE: on a live table use
--   CREATE UNIQUE INDEX CONCURRENTLY family_members_one_funding_root ...
-- outside a transaction block. This file runs on a table whose funded-row count
-- is zero at deploy time (staging has no member who is also a holder), so the
-- plain form is correct here and is what keeps the migration re-runnable.
CREATE UNIQUE INDEX IF NOT EXISTS family_members_one_funding_root
  ON public.family_members(member_id)
  WHERE funds_sub_members AND status = 'active';

-- ── 2. The chain stamp on the booking ──────────────────────────────────────

ALTER TABLE public.lite_bookings
  ADD COLUMN IF NOT EXISTS payer_via_user_id UUID NULL REFERENCES public.users(id);

COMMENT ON COLUMN public.lite_bookings.payer_via_user_id IS
  'B-854 — the INTERMEDIARY (B) on a chained family booking: payer_user_id is the wallet (A), client_id is the spender (C). NULL on every non-chained booking.';

CREATE INDEX IF NOT EXISTS lite_bookings_payer_via_idx
  ON public.lite_bookings(payer_via_user_id)
  WHERE payer_via_user_id IS NOT NULL;

-- ── 3. Ledger-row-id readers (plan A6) ─────────────────────────────────────
--
-- `memberSpend`/`usage` filter on metadata->>'family_row_id' /
-- 'via_family_row_id'. Without these, A opening B's line scans B's whole
-- wallet history. Expression indexes, partial so they only cover the family
-- rows (the vast majority of wallet_transactions carry neither key).

CREATE INDEX IF NOT EXISTS wallet_tx_family_row_idx
  ON public.wallet_transactions ((metadata->>'family_row_id'))
  WHERE metadata ? 'family_row_id';

CREATE INDEX IF NOT EXISTS wallet_tx_via_family_row_idx
  ON public.wallet_transactions ((metadata->>'via_family_row_id'))
  WHERE metadata ? 'via_family_row_id';

-- ── 4. Audit verbs ─────────────────────────────────────────────────────────
--
-- UPPERCASE to match the constraint that already exists (the four QUOTA_* verbs
-- plus CREDIT_APPROVED). Dropped and re-added rather than edited — a CHECK has
-- no ALTER form — and the DROP is IF EXISTS so a re-run is clean.

ALTER TABLE public.family_quota_audit
  DROP CONSTRAINT IF EXISTS family_quota_audit_action_check;

ALTER TABLE public.family_quota_audit
  ADD CONSTRAINT family_quota_audit_action_check
  CHECK (action IN ('QUOTA_CREATED','QUOTA_INCREASED','QUOTA_DECREASED',
                    'QUOTA_CLEARED','CREDIT_APPROVED',
                    'FUND_MEMBERS_REQUESTED','FUND_MEMBERS_APPROVED',
                    'FUND_MEMBERS_DECLINED','FUND_MEMBERS_OFF'));

-- ── 5. The approval loop (plan A11) ────────────────────────────────────────
--
-- Modelled on family_credit_requests, which is the same shape of question
-- ("member asks, root decides") and whose lifecycle rules are already proven:
-- one PENDING row per membership enforced by a partial unique index rather
-- than a check-then-insert, and a lazy expiry so a forgotten request cannot
-- block the member from asking again.

CREATE TABLE IF NOT EXISTS public.family_funding_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The (holder = A, member = B) membership row the request is about. Requests
  -- follow the ROW: a revoke then re-invite mints a new row, and an old row's
  -- request must never switch funding on for the new one.
  family_row_id   UUID NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  holder_id       UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  member_id       UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','declined','cancelled','expired')),
  reason          TEXT,
  decided_by      UUID REFERENCES public.users(id),
  decided_at      TIMESTAMPTZ,
  decision_reason TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
);

CREATE UNIQUE INDEX IF NOT EXISTS family_funding_requests_one_pending
  ON public.family_funding_requests(family_row_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS family_funding_requests_holder_idx
  ON public.family_funding_requests(holder_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS family_funding_requests_member_idx
  ON public.family_funding_requests(member_id, created_at DESC);

-- ── Deny-by-default RLS ────────────────────────────────────────────────────
-- House rule: the anon key ships in the APK, so a public table without RLS is
-- readable through PostgREST. auth-service reaches this through the direct
-- Postgres pool, which RLS does not constrain.

ALTER TABLE public.family_funding_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_funding_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.family_funding_requests FROM anon, authenticated;

COMMENT ON TABLE public.family_funding_requests IS
  'B-854 — a linked member asks their root to let the root allowance fund the member''s OWN members. One PENDING row per membership (unique index); the root approves, and can switch it off again at any time.';
