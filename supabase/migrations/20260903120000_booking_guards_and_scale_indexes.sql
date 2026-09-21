-- ═══════════════════════════════════════════════════════════════════════════
-- 2026-09-03 — booking guards + sweeper index coverage
-- Source: SECURE_SERVICES_E2E_AUDIT_2026-09-03.md (E2E-22, E2E-23, E2E-26)
--
--  ⚠️  DEPLOY NOTE — READ BEFORE SHIPPING  ⚠️
--
--  TWO migrations are owed on staging AND production, in this order:
--
--     1. 20260902090000_scale_indexes_50k.sql   ← WRITTEN 2026-09-02, NEVER APPLIED
--     2. 20260903120000  (this file)
--
--  (1) is the 34-index scale pass. It is present in the repo and syntactically
--  complete (verified 2026-09-03: 30 CREATE INDEX / 1 CREATE UNIQUE INDEX /
--  1 CREATE EXTENSION / 4 DROP INDEX, every one IF [NOT] EXISTS, no unbalanced
--  quotes or dollar-quotes), but `DB_PAYMENT_SCALE_AUDIT_2026-09-02.md` and
--  `BUILD_RUNBOOK.md` both still list the staging apply as OWED, and the
--  2026-09-03 audit's every "index covered" verdict is conditional on it.
--  Nothing in this file substitutes for it.
--
--  CONCURRENTLY: `scripts/db-migrate.sh` runs migrations with
--  `--single-transaction`, and CREATE INDEX CONCURRENTLY CANNOT run inside a
--  transaction. On a database where `lite_bookings` has grown, run these BY HAND
--  outside a transaction as CONCURRENTLY first, then run the migration — every
--  statement is IF NOT EXISTS, so it will skip what already exists:
--
--    -- from 20260902090000 (the large tables):
--    CREATE INDEX CONCURRENTLY IF NOT EXISTS lite_bookings_client_created_idx
--      ON public.lite_bookings (client_id, created_at DESC);
--    CREATE INDEX CONCURRENTLY IF NOT EXISTS lite_bookings_provider_pickup_idx
--      ON public.lite_bookings (assigned_provider_user_id, pickup_time DESC)
--      WHERE assigned_provider_user_id IS NOT NULL;
--    CREATE INDEX CONCURRENTLY IF NOT EXISTS lite_bookings_created_at_idx
--      ON public.lite_bookings (created_at);
--    CREATE INDEX CONCURRENTLY IF NOT EXISTS notifications_created_at_idx
--      ON public.notifications (created_at);
--    CREATE INDEX CONCURRENTLY IF NOT EXISTS sealed_envelope_archive_ts_ms_idx
--      ON public.sealed_envelope_archive (ts_ms);
--    CREATE INDEX CONCURRENTLY IF NOT EXISTS psl_received_at_idx
--      ON public.protection_session_locations (received_at);
--    CREATE INDEX CONCURRENTLY IF NOT EXISTS mission_crew_agent_idx
--      ON public.mission_crew (agent_id);
--    -- the three pg_trgm GIN indexes on public.users likewise.
--
--    -- from THIS file:
--    CREATE INDEX CONCURRENTLY IF NOT EXISTS lite_bookings_scheduled_due_idx ...
--    CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS lite_bookings_one_active_per_client_uq ...
--
--  A CONCURRENTLY build that fails leaves an INVALID index — check with
--    SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
--  and DROP + rebuild any it names.
--
--  AFTER APPLYING, the §8.4 measurement is still owed and nothing here is a
--  substitute for it: EXPLAIN (ANALYZE, BUFFERS) on the dispatch RANKING_SQL,
--  both protection sweeps, and the booking-reminder / scheduled-dispatch selects.
--
--  `scripts/db-migrate.sh --apply` now RE-ASSERTS `lite_bookings_one_active_per_client_uq`
--  by name after the run and exits non-zero if it is absent — the DO block below
--  can legitimately skip the build with a WARNING, and a WARNING scrolls past.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  ⚠️  THE BOX'S COMPOSE FILE MUST BE EDITED BY HAND — THIS REPO CANNOT DO IT
-- ═══════════════════════════════════════════════════════════════════════════
--
--  `scripts/deploy-staging.sh` and `docs/runbooks/CICD_STAGING.md` are explicit:
--  staging runs `docker-compose.staging.yml` **ON THE BOX** (~/bravo), which is
--  NOT in this repository. The repo's own `docker-compose.yml` says in its first
--  line that it is for local dev, and the `infra/systemd/*.service` units are the
--  decommissioned EC2 path. So the E2E-21 container limits and the E2E-20
--  rollback lever added on 2026-09-03 are, as shipped, INERT for staging —
--  while `THROTTLE_ENFORCE` defaults to true IN CODE, so enforcement DOES turn on
--  there with no reachable escape hatch. That asymmetry is the risk.
--
--  Add to EACH Node service (`auth-service`, `messenger-service`) in the box's
--  `docker-compose.staging.yml`:
--
--      mem_limit: 1536m
--      memswap_limit: 1536m          # EQUAL to mem_limit ⇒ swap off for it
--      cpus: 1.5
--      environment:
--        NODE_OPTIONS: "--max-old-space-size=1024"   # ~2/3 of mem_limit
--        THROTTLE_ENFORCE: "true"                    # "false" = shadow mode
--
--  …to `redis`:
--
--      mem_limit: 512m
--      memswap_limit: 512m
--      cpus: 0.5
--      command: redis-server --maxmemory 384mb --maxmemory-policy allkeys-lru
--
--  …and to `coturn`:
--
--      mem_limit: 512m
--      memswap_limit: 512m
--      cpus: 1.0
--
--  Then `docker compose -f docker-compose.staging.yml up -d` and verify:
--      docker inspect -f '{{.Name}} {{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}' \
--        $(docker ps -q)
--  Every line must show non-zero values. A zero means the limit did not land.
--
--  Budget rationale (one 4-vCPU / 8 GB box shared by all of them, plus the ops
--  console): ~2 GB left for the host and page cache, no single service above
--  ~1.5 GB, so one leak is a fast restartable kill instead of an OOM that takes
--  Redis — and with it every fenced sweep lock and every live call — down too.
--
-- All statements are idempotent (IF NOT EXISTS / guarded DO blocks), so
-- re-applying this file is a no-op.
-- ═══════════════════════════════════════════════════════════════════════════


-- ─── E2E-23 — one ACTIVE booking per client, enforced by the DATABASE ────────
--
-- `BookingService.create()` has always had this rule, as a read-then-throw:
-- SELECT any non-terminal booking for the client, and 400 `active_booking_exists`
-- if one is found. That is a TOCTOU. Two concurrent submits (double-tap, a
-- network-blip retry, two devices) both read "none" and both INSERT, and the
-- orphan then blocks the client's NEXT booking and confuses every sweeper that
-- assumes one live row per client. The legacy `POST /bookings` route had neither
-- an idempotency key nor a throttle until 2026-09-03, so the window was wide
-- open; it is still the route the mobile client uses whenever
-- `users.auto_dispatch_enabled` is false.
--
-- ⚠️ THE INDEX PREDICATE IS **NOT** A COPY OF THE READ GUARD. It deliberately
-- covers only `booking_mode = 'now'`, and that difference is load-bearing.
--
-- A read guard is evaluated ONCE, at INSERT, against a snapshot. An index
-- predicate is re-evaluated on EVERY UPDATE, so its exempt set must be CLOSED
-- UNDER THE TRANSITIONS THOSE ROWS ACTUALLY MAKE. The read guard's exempt set is
-- not, and mirroring it here destroyed a legitimate booking:
--
--     A client legally holds a parked `later` reservation AND an active `now`
--     booking — that is precisely what B-405 exists to allow. The `now` row is
--     in the index. The `later` row is exempt, until its lead window arrives and
--     `DispatchService.start()` runs `UPDATE … SET status = 'DISPATCHING'`. That
--     row is now `later` + DISPATCHING, no longer matches the exemption, ENTERS
--     the index, and collides with the `now` row → 23505. `start()` has no
--     handler for it, the scheduled sweep's per-row catch just logs and retries
--     every minute, and 30 minutes past `pickup_time` the stale-start sweep
--     CANCELS the booking and refunds it. A scheduled protection detail deleted
--     because the client also had a transfer running. Same shape for a legacy
--     `later` row on ops approval.
--
-- Scoping to `now` closes the set: `booking_mode` is immutable, so a row's index
-- membership can only ever change by reaching a terminal status — which REMOVES
-- it. No transition can move a row IN beside a sibling.
--
--   * TERMINAL SET — COMPLETED, CANCELLED, NO_PROVIDER, AGENCY_NO_SHOW. Derived
--     from the code, not guessed: LB17 made NO_PROVIDER and AGENCY_NO_SHOW free
--     the slot so a client whose search failed can immediately re-request.
--     DRAFT / DISPATCHING / PAYMENT_PENDING / CONFIRMED / LIVE all HOLD the slot.
--
--   * WHAT IS GIVEN UP, AND WHY IT IS NOTHING. Uniqueness over `later` rows buys
--     no enforcement: a parked `later` reservation is EXEMPT from the one-active
--     rule at INSERT anyway (B-405 — zero commitment, no escrow, no crew), and
--     the only OTHER `later` state the read guard treats as active is one that
--     has already been dispatched, which cannot be created concurrently because
--     it is reached by a sweep, not by a client submit. The race this index is
--     here to close — two concurrent `POST /bookings` for the same client — is
--     a `now`-vs-`now` race, and that is exactly what it still catches. The read
--     guard in `create()` is UNCHANGED and remains the broader rule.
--
--   * THE ≤3 PARKED CAP IS NOT EXPRESSED HERE, and cannot be: "at most three
--     rows per client" is a counting constraint, not a uniqueness one. A partial
--     unique index cannot say it; only a trigger or an exclusion constraint over
--     a materialised counter could, and both are heavier than the risk (the cap
--     is an anti-stacking courtesy, not a money guard — a parked reservation
--     charges nothing). It stays a read-then-throw in `create()`.
--
-- `create()` translates this index's 23505 into the SAME `active_booking_exists`
-- 400 the read path throws, matching on the CONSTRAINT NAME (never a bare 23505 —
-- this INSERT can also violate the referral FK).
DO $$
DECLARE
  offending_clients int;
BEGIN
  IF to_regclass('public.lite_bookings_one_active_per_client_uq') IS NOT NULL THEN
    RAISE NOTICE 'lite_bookings_one_active_per_client_uq already exists — skipping';
    RETURN;
  END IF;

  -- Pre-flight. A UNIQUE index build fails outright on existing duplicates, and
  -- under --single-transaction that aborts the WHOLE migration run. Count first
  -- and degrade to a loud WARNING instead of bricking the deploy: the guard is
  -- worth having, it is not worth taking the release down for.
  SELECT count(*) INTO offending_clients FROM (
    SELECT client_id
      FROM public.lite_bookings
     WHERE booking_mode = 'now'
       AND status NOT IN ('COMPLETED','CANCELLED','NO_PROVIDER','AGENCY_NO_SHOW')
     GROUP BY client_id
    HAVING count(*) > 1
  ) dupes;

  IF offending_clients > 0 THEN
    RAISE WARNING
      'lite_bookings_one_active_per_client_uq NOT created: % client(s) already hold more than one active booking. '
      'Resolve them (cancel the stale row, or complete it), then re-run this migration — it is IF NOT EXISTS. '
      'List them with: SELECT client_id, array_agg(id ORDER BY created_at) FROM public.lite_bookings '
      'WHERE booking_mode = ''now'' '
      'AND status NOT IN (''COMPLETED'',''CANCELLED'',''NO_PROVIDER'',''AGENCY_NO_SHOW'') '
      'GROUP BY client_id HAVING count(*) > 1;',
      offending_clients;
    RETURN;
  END IF;

  -- `booking_mode = 'now'` FIRST and deliberately: it is what makes the predicate
  -- closed under UPDATE. Do not "align" it with the read guard — read the header.
  EXECUTE $ix$
    CREATE UNIQUE INDEX lite_bookings_one_active_per_client_uq
      ON public.lite_bookings (client_id)
      WHERE booking_mode = 'now'
        AND status NOT IN ('COMPLETED','CANCELLED','NO_PROVIDER','AGENCY_NO_SHOW')
  $ix$;
  RAISE NOTICE 'lite_bookings_one_active_per_client_uq created';
EXCEPTION
  -- A booking created between the pre-flight count and the build. Same posture:
  -- warn, do not abort the run. (A caught exception in PL/pgSQL rolls back only
  -- this block's subtransaction, so the rest of the migration still commits.)
  WHEN unique_violation THEN
    RAISE WARNING
      'lite_bookings_one_active_per_client_uq build raced a concurrent insert and found a duplicate — re-run this migration.';
  -- The index appeared between the to_regclass check and the build (a hand-run
  -- CONCURRENTLY from the deploy note landing in parallel). Nothing to do.
  WHEN duplicate_table THEN
    RAISE NOTICE 'lite_bookings_one_active_per_client_uq was created concurrently — nothing to do';
END$$;

COMMENT ON TABLE public.lite_bookings IS
  'Lite/EP/auto booking rows. At most one non-terminal ON-DEMAND (booking_mode=''now'') booking per '
  'client is enforced by the partial unique index lite_bookings_one_active_per_client_uq. It is '
  'deliberately NARROWER than BookingService.create()''s read guard: an index predicate is '
  're-evaluated on every UPDATE, so scoping it to ''now'' (an immutable column) is what keeps a '
  'B-405 parked ''later'' reservation from colliding with a live booking when a sweep dispatches it. '
  'Scheduled reservations stay governed by the read guard and the <=3 parked cap.';


-- ─── E2E-26 — the two hot sweeper predicates ────────────────────────────────

-- scheduled-dispatch.service.ts — the 'later' cohort, swept every 60 s. Four
-- passes now read this shape: the DUE selection (service-aware lead window), the
-- E2E-04 stale-start close-out (the same cohort past the floor), and both order
-- by pickup_time. The predicate is the cheap, highly selective part; the
-- service-aware CASE in the DUE query is a heap recheck on the few rows this
-- returns, not a scan driver.
CREATE INDEX IF NOT EXISTS lite_bookings_scheduled_due_idx
  ON public.lite_bookings (pickup_time)
  WHERE dispatch_mode = 'auto'
    AND booking_mode = 'later'
    AND status IN ('OPS_APPROVED', 'DRAFT')
    AND dispatch_started_at IS NULL;

-- booking-reminder.service.ts:71-72 — the audit lists this predicate as
-- UNINDEXED, but `lite_bookings_reminder_due_idx` already covers it exactly
-- (20260809140000_booking_reminder_sent.sql:13-15, same column, same partial
-- predicate). Re-asserted here IF NOT EXISTS so the coverage is guaranteed in one
-- place: on a database where 20260809140000 was applied this is a no-op, and on
-- one where it was not, this creates it. The sweep's `status IN (…)` list is a
-- heap recheck — deliberately left out of the predicate, per that migration's own
-- note that enum literals in index predicates survive enum changes poorly.
CREATE INDEX IF NOT EXISTS lite_bookings_reminder_due_idx
  ON public.lite_bookings (pickup_time)
  WHERE booking_mode = 'later' AND reminder_sent_at IS NULL;
