-- 2026-09-01 — two root causes found while deploying the regions/pricing batch.
--
-- ═══ CAUSE 1: nothing recorded which migrations had actually been applied ═══
--
-- `20260831180000_exec_min_lead_hours.sql` had NEVER reached staging. The
-- service_pricing table held 13 keys instead of 14 and the key CHECK did not
-- admit `exec_min_lead_hours`, so Executive Protection's "ops-configurable lead
-- time" — recorded as deployed on 2026-08-31, with a runbook entry and an SQA
-- entry saying so — was silently running on its compiled 3h fallback, and any
-- ops attempt to change it would have been rejected by the constraint.
--
-- Nobody was careless. There was simply no way to ask the question: migrations
-- are applied by hand with psql, and `supabase_migrations.schema_migrations`
-- (238 rows, latest 20260830195701) is written by Supabase Studio/CLI with its
-- own timestamps, so it does not correspond to the files in this repo at all.
--
-- `public.applied_migrations` is keyed by the actual FILENAME in
-- supabase/migrations/, so `scripts/db-migrate.sh --check` can diff the
-- directory against the database and answer it in one command.
--
-- The checksum is stored so an EDITED migration is detectable. A file whose
-- content changed after being applied is a different migration wearing the same
-- name — the failure mode where two environments diverge and every probe still
-- says "applied".

CREATE TABLE IF NOT EXISTS public.applied_migrations (
  filename   text PRIMARY KEY,
  checksum   text,
  applied_at timestamptz NOT NULL DEFAULT NOW(),
  -- 'applied' = this database ran it. 'baseline' = it predates the ledger and
  -- was verified present by other means. The distinction is deliberate: a
  -- baseline row is an ASSERTION, not a receipt, and must not be mistaken for
  -- one when someone is debugging a drift six months from now.
  source     text NOT NULL DEFAULT 'applied' CHECK (source IN ('applied', 'baseline'))
);

ALTER TABLE public.applied_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.applied_migrations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.applied_migrations FROM anon, authenticated;

-- ═══ CAUSE 2: every new table ships with anon/authenticated DML grants ═══
--
-- Supabase's default privileges hand `anon` and `authenticated` full
-- INSERT/UPDATE/DELETE/TRUNCATE on any new table in `public`. That is how
-- `public.regions` acquired them hours after being created.
--
-- MEASURED BEFORE WRITING THIS (do not "improve" it without re-measuring):
--
--   114 public tables — RLS enabled on 114, forced on 95
--   104 carry anon + authenticated grants
--   pg_policies in schema public: ONE row, `notifications_self_select`
--
-- So 113 of 114 tables have RLS on with ZERO policies: deny-by-default for
-- anon/authenticated no matter what the grant says. The grants were never a
-- live hole — and that is exactly why revoking them is safe rather than risky.
-- The only table whose policy actually admits those roles is `notifications`,
-- which keeps its grants.
--
-- Client-side check done too: the mobile app's only supabase-js table calls are
-- `userService.getProfile` / `updateProfile` on `users`, and both have ZERO
-- callers — dead code that RLS would refuse anyway. Storage moved off the anon
-- key in DC-21.

DO $$
DECLARE
  t record;
  n int := 0;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public'
       AND c.relkind = 'r'
       -- Keep the grants on any table whose policies actually admit these
       -- roles; revoking there WOULD break a working read path.
       AND NOT EXISTS (
         SELECT 1 FROM pg_policies p
          WHERE p.schemaname = 'public'
            AND p.tablename = c.relname
            AND (p.roles::text LIKE '%anon%'
              OR p.roles::text LIKE '%authenticated%'
              OR p.roles::text = '{public}')
       )
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t.relname);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'revoked anon/authenticated on % tables', n;
END $$;

-- The prevention, not just the cleanup: stop the NEXT table inheriting them.
-- Scoped to the role that owns migrations here; a table created by another role
-- would still inherit its own defaults, which is why db-migrate.sh --check also
-- reports grant drift.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
