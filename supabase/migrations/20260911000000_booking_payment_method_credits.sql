-- B-847 — relabel historical bookings that say 'card' but were paid in Bravo Credits.
--
-- There has never been a card lane for BOOKINGS. Stripe is wired for wallet
-- top-ups only (`wallet/stripe.client.ts`); every booking debit — the escrow
-- hold taken when an agency accepts, and `payWithCredits` (which is what sets
-- `payment_captured`) — spends Bravo Credits. The 'card' value came from the
-- mobile wizard's draft default (`bookingStore.ts`), which no screen ever let
-- the client change, and the column's own `DEFAULT 'card'`.
--
-- Safe to run because NOTHING branches on this column: it is display-only.
-- Readers are the ops console `BookingDetail` ("Payment · CARD · PENDING"), the
-- mobile Trip Summary, and `booking-history.service.ts` (`method`, which already
-- coalesces a NULL to 'bravo_credits'). Each renders the value verbatim, so this
-- UPDATE changes labels and nothing else — no money, no state, no escrow.
--
-- The write side is fixed in the same commit: the client default is now
-- 'bravo_credits', and `booking.service.ts` create() normalises a 'card' from an
-- older client (<= 1.0.307) before the INSERT, so this backfill is one-shot.

UPDATE public.lite_bookings SET payment_method = 'bravo_credits' WHERE payment_method = 'card';

-- The column default was the THIRD producer (20260423113000_booking_module.sql:62) — any
-- INSERT that omits the column would re-mint a 'card' row behind the two code fixes.
ALTER TABLE public.lite_bookings ALTER COLUMN payment_method SET DEFAULT 'bravo_credits';
