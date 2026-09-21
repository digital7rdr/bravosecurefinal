-- B-843 (founder, 2026-09-10) — one person, MANY root accounts.
--
-- NEW DOCTRINE. A person may be an open (pending or active) member under any
-- number of root accounts at once — their family, their employer, several
-- companies — with no limit. The invariant that survives is narrower:
--
--     exactly ONE OPEN ROW per (root, member).
--
-- That pair is what every money path already keys on. The escrow charge
-- re-resolves the membership at charge time by (member_id, holder_id) under
-- FOR UPDATE (B-384), the spend bump and the refund reversal key the same row,
-- and `resolvePayer(user, holder)` reads it. Without the pair being unique,
-- each of those reads becomes "pick an arbitrary row", which on a money path
-- is a silent charge to the wrong root.
--
-- WHO PAYS is therefore no longer a property of the person — it is a property
-- of the BOOKING: `lite_bookings.payer_user_id`, stamped at creation from the
-- member's explicit choice and re-validated against the (member, holder) row
-- at every debit. A member with two roots is ASKED; they are never guessed at.
--
-- An index, not a check-then-insert: two simultaneous accepts both pass any
-- preceding SELECT, and only a unique index can decide between them. Both
-- predicate halves are load-bearing — `member_id IS NOT NULL` keeps the legacy
-- pending-by-phone rows (member_id NULL) out, and the status filter lets a
-- revoked member be re-invited by the same root.
--
-- The holder+phone pending index (family_members_holder_phone_pending) is
-- unrelated and stays.

DROP INDEX IF EXISTS public.family_members_one_active_per_member;

-- ── Dedupe FIRST, or the CREATE below aborts the whole migration ─────────────
--
-- Nothing has ever enforced uniqueness on (holder_id, member_id) for PENDING
-- rows. The old index covered `status = 'active'` only; the holder+phone index
-- needs a non-null `invite_phone`, and `invite()` stopped writing those in
-- 2026-08; and `invite()`'s bare `ON CONFLICT DO NOTHING` names no conflict
-- target, so it matched neither. An app invite racing a console-batch invite
-- could therefore already have left TWO pending rows for one pair.
--
-- The losers are REVOKED, never deleted: `wallet_transactions.metadata->>
-- 'family_row_id'` pins a refund reversal to the CHARGE-TIME membership row, so
-- deleting one would orphan money. Ranking keeps the row a human would expect —
-- an active row beats a pending one, then the oldest membership wins, with the
-- id as a deterministic final tie-break.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY holder_id, member_id
           ORDER BY (status = 'active') DESC, accepted_at ASC NULLS LAST, invited_at ASC, id ASC
         ) AS rn
    FROM public.family_members
   WHERE member_id IS NOT NULL AND status IN ('pending','active')
)
UPDATE public.family_members fm
   SET status = 'revoked'
  FROM ranked r
 WHERE fm.id = r.id AND r.rn > 1;

-- OPERATOR NOTE: on production build this CONCURRENTLY, outside a transaction
-- (`CREATE UNIQUE INDEX CONCURRENTLY family_members_holder_member_open …`) — the
-- non-concurrent form below takes a SHARE lock on family_members for the whole
-- build, which blocks every member INSERT/UPDATE, including a live escrow
-- charge's `spent_credits` bump. Staging is small enough not to care.
CREATE UNIQUE INDEX IF NOT EXISTS family_members_holder_member_open
  ON public.family_members(holder_id, member_id)
  WHERE member_id IS NOT NULL AND status IN ('pending','active');

COMMENT ON INDEX public.family_members_holder_member_open IS
  'B-843: one OPEN row per (root, member). A member may belong to many roots; which root PAYS is the booking''s stamped payer_user_id, never a property of the person.';
