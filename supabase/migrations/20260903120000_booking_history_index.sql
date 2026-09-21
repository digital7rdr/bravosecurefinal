-- B-786 — index for the client booking-history read model.
--
-- GET /bookings/history keysets on (client_id, pickup_time, id): the page query,
-- the COUNT and the cursor comparison all use exactly that predicate, in both
-- directions (past/cancelled read DESC, upcoming reads ASC — one btree serves
-- both). The existing lite_bookings_client_created_idx is on created_at, which
-- is the ordering B-786g replaces; lite_bookings_client_idx alone leaves the
-- sort unindexed, so a client with a long history pays a sort per page.
--
-- `id` is included so the keyset tie-break is covered too, making the whole
-- cursor comparison an index-only range scan.
--
-- NOTE: scripts/db-migrate.sh applies migrations with --single-transaction, so
-- this is a plain CREATE INDEX (brief write lock). If lite_bookings has grown
-- large, run it by hand as CREATE INDEX CONCURRENTLY outside a transaction and
-- re-run the migration — IF NOT EXISTS makes it skip.
CREATE INDEX IF NOT EXISTS lite_bookings_client_pickup_id_idx
  ON public.lite_bookings (client_id, pickup_time DESC, id DESC);

-- The history joins wallet_transactions by (booking_id, user_id) for the payer's
-- ledger, and the summary aggregates every booking row for one user. Both are
-- served by this partial index; the WHERE keeps top-ups (booking_id NULL) out.
CREATE INDEX IF NOT EXISTS wallet_transactions_booking_user_idx
  ON public.wallet_transactions (booking_id, user_id)
  WHERE booking_id IS NOT NULL;
