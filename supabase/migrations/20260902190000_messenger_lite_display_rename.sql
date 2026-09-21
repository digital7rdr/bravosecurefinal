-- 2026-09-02 (B-775) — founder: the free messenger plan is "Bravo Messenger",
-- never "Bravo Messenger Lite" (same product rule as the B-750 "Bravo Secure"
-- rename). The B-750 round fixed the CLIENT fallbacks, but the Messenger Plans
-- screen renders the ops-editable plan_catalog row, which still carried the
-- seeded name — so the card kept saying "Lite" on every build.
--
-- The tier id 'lite' and the catalog key 'messenger_lite' are wire/DB
-- identifiers and stay untouched. Guarded on the seeded value so an
-- ops-console rename made after this ships is never clobbered.
--
-- Applied to staging via the Supabase MCP on 2026-09-02 (migration name
-- messenger_lite_display_rename); this file keeps every other environment in
-- step.
UPDATE public.plan_catalog
   SET display_name = 'Bravo Messenger', updated_at = NOW()
 WHERE key = 'messenger_lite' AND display_name = 'Bravo Messenger Lite';
