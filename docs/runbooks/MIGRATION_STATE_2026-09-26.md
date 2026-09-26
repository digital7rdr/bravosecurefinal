# Migration state — verified 2026-09-26

Written during production-release preparation for `ops.bravosecure.cloud`.
Everything below is evidence from files in this repo, not inference.

## Method

The only artefact describing the live database is
`HANDOVER_SCHEMA_live_public_with_grants_2026-09-20.sql` — a schema-only
`pg_dump` of the live Supabase project `qkkfkicgoncxslbwhyhz`, taken
2026-09-20 (PostgreSQL 17.6, `pg_dump` 17.11). It is **gitignored**: no rows
and no credentials, but it publishes the full internal schema plus ~200
`GRANT`s and nothing in the repo references it. Ask the holder of the local
working copy if you need it.

Each September migration's declared objects were checked against that dump.

## Verdict: the live database is AT HEAD

All 186 migrations appear applied. Spot-checked, all present in the dump:

| Migration                              | Object checked              | In live |
| -------------------------------------- | --------------------------- | ------- |
| `20260907100000_admin_levels`          | 4 new `admin_role` values   | yes     |
| `20260912100000_attendance_pings`      | `cpo_shift_pings`           | yes     |
| `20260912200000_identity_documents`    | `identity_documents`        | yes     |
| `20260914130000_transfer_block_hours`  | `transfer_block_hours` key  | yes     |

No migration in `supabase/migrations/**` declares a table absent from the
dump.

## ⚠️ A stale DEPLOY NOTE that says the opposite

`supabase/migrations/20260903120000_booking_guards_and_scale_indexes.sql`
opens with a boxed warning:

> TWO migrations are owed on staging AND production …
> `20260902090000_scale_indexes_50k.sql` ← WRITTEN 2026-09-02, NEVER APPLIED

**That note is out of date.** Every index it names is present in the
2026-09-20 live dump:

`lite_bookings_client_created_idx` · `lite_bookings_provider_pickup_idx` ·
`lite_bookings_created_at_idx` · `notifications_created_at_idx` ·
`sealed_envelope_archive_ts_ms_idx` · `psl_received_at_idx` ·
`mission_crew_agent_idx` · `lite_bookings_scheduled_due_idx` ·
`lite_bookings_one_active_per_client_uq`

The migration file itself is **deliberately left unedited** — it is already
applied to a shared environment, and this repo's rule is not to rewrite
those. Correcting a comment would also risk a statement mismatch in
`supabase_migrations.schema_migrations`. This document is the correction.

Still genuinely owed from that note, and NOT done by anything here: the §8.4
measurement — `EXPLAIN (ANALYZE, BUFFERS)` on the dispatch `RANKING_SQL`,
both protection sweeps, and the booking-reminder / scheduled-dispatch
selects.

## Two migrations share one timestamp

```
20260903120000_booking_guards_and_scale_indexes.sql
20260903120000_booking_history_index.sql
```

`supabase db push` applies in lexicographic order, so the tie resolves
deterministically (`booking_guards…` before `booking_history…`) and both are
applied. **Do not rename either** — they are in shared environments and a
rename creates a new version that re-runs. Worth avoiding on new work; not
worth fixing here.

## What a `pg_dump` does NOT cover

Storage buckets. `avatars` and `kyc` hold uploaded files; `pg_dump` captures
the `storage.objects` metadata rows, not the bytes. A database restore
without a matching storage copy leaves rows pointing at objects that 404 —
profile photos and KYC documents. See §5 of `DATABASE_BACKUP_RESTORE.md` for
the S3-protocol sync.

## Authoritative source

Supabase project `qkkfkicgoncxslbwhyhz` is the system of record, per
`DATABASE_BACKUP_RESTORE.md` §1. The self-hosted Contabo Postgres
(`bravo-staging-pg`, `94.136.184.52`) is explicitly **not** — see
`CONTABO_MIGRATION_GUIDE.md` §6.6. Nothing here has been restored, copied or
overwritten; this was read-only verification against a dump file.
