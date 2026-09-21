-- B-873 (founder 2026-09-14): the Lite 'comms' add-on is ESCM.
--
-- "change this name to 'ESCM' - Electronic Surveillance Counter Measures".
-- Label/description only. The wire id stays 'comms': every booking row already
-- persisted carries it inside `add_ons`, and the client, the ops console and
-- pricing all key on it. Renaming an id would orphan live bookings.
--
-- Idempotent (plain UPDATE, no schema change) and safe to re-run. The executive
-- catalogue's own 'comms' copy lives in pricing.service.ts (EXEC_ADDON_DEFS,
-- "Secure Communications Support") — a different product, deliberately untouched.
UPDATE lite_booking_add_ons
   SET label = 'ESCM', description = 'Electronic Surveillance Counter Measures'
 WHERE id = 'comms';
