/**
 * Audit fix 5.5 — real-DB integration test harness.
 *
 * Spins up an ephemeral Postgres container via testcontainers, applies
 * the full migration set in order, and exposes a pg `Pool` plus helpers
 * for individual tests. Slow (~10–30s for the container start + migration
 * apply) so this runs as a separate Jest project (`integration`) rather
 * than blocking the default unit suite.
 *
 * Prerequisites:
 *   - Docker reachable from the test runner (set DOCKER_HOST if remote).
 *   - The `@testcontainers/postgresql` package installed in
 *     `apps/auth-service/package.json` (devDependency).
 *
 * Skip behavior:
 *   - If `SKIP_INTEGRATION=1` is set, every itest auto-skips (CI without
 *     Docker still passes).
 *   - If the container fails to start (Docker daemon down), the helper
 *     calls `testSkip(...)` to skip with a clear reason instead of a
 *     cryptic timeout.
 *
 * Snapshot strategy:
 *   - One container shared across the whole `integration` project to
 *     amortize the start cost. Each test inserts its own rows with
 *     unique ids; cleanup is a `TRUNCATE … RESTART IDENTITY CASCADE` on
 *     the writeable tables before each test.
 */

import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Pool} from 'pg';

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations');

let pool: Pool | null = null;
let containerStop: (() => Promise<void>) | null = null;
let bootError: string | null = null;

/** True if integration tests should auto-skip. */
export function shouldSkipIntegration(): boolean {
  return process.env.SKIP_INTEGRATION === '1' || bootError !== null;
}

export function getBootError(): string | null {
  return bootError;
}

export function getPool(): Pool {
  if (!pool) throw new Error('integration_pool_not_initialized: call bootIntegrationDb() in beforeAll');
  return pool;
}

/**
 * Start the ephemeral pg container (if not already running) and apply
 * every SQL migration in `supabase/migrations/` in filename order. Idempotent
 * — subsequent calls in the same process reuse the running container.
 *
 * Returns true on success, false if Docker is unreachable (the suite's
 * `beforeAll` should call `skipIfNoDb(test)` on each test to bail out
 * gracefully when this returns false).
 */
export async function bootIntegrationDb(): Promise<boolean> {
  if (pool) return true;
  if (shouldSkipIntegration()) return false;

  // ── 1. Provision a database. A failure HERE means no Docker / no server,
  //       which skips the suite by design ("CI without Docker still passes").
  try {
    let url: string;
    const external = process.env.INTEGRATION_DATABASE_URL;
    if (external) {
      // 2026-09-27 — no-Docker mode: point at a Postgres SERVER (with postgis
      // installed). Each boot creates its own throwaway database, so test files
      // stay independent exactly as they are with one container each.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const {Client} = require('pg') as {Client: new (cfg: {connectionString: string}) => {
        connect: () => Promise<void>; query: (q: string) => Promise<unknown>; end: () => Promise<void>;
      }};
      const dbName = `bravo_it_${process.pid}_${Date.now().toString(36)}`;
      const admin = new Client({connectionString: external});
      await admin.connect();
      await admin.query(`CREATE DATABASE ${dbName}`);
      await admin.end();
      const u = new URL(external);
      u.pathname = `/${dbName}`;
      url = u.toString();
      containerStop = async () => {
        const drop = new Client({connectionString: external});
        await drop.connect();
        await drop.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
        await drop.end();
      };
    } else {
      // Dynamic require so the testcontainers package is optional —
      // running `npm test` without Docker won't fail the unit suite.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const {PostgreSqlContainer} = require('@testcontainers/postgresql') as {
        PostgreSqlContainer: new () => {
          withImage:    (img: string) => unknown;
          withDatabase: (db: string)  => unknown;
          withUsername: (u: string)   => unknown;
          withPassword: (p: string)   => unknown;
          start:        () => Promise<{
            getConnectionUri: () => string;
            stop:             () => Promise<void>;
          }>;
        };
      };

      const container = new PostgreSqlContainer() as {
        withImage:    (img: string) => unknown;
        withDatabase: (db: string)  => unknown;
        withUsername: (u: string)   => unknown;
        withPassword: (p: string)   => unknown;
        start:        () => Promise<{getConnectionUri: () => string; stop: () => Promise<void>}>;
      };
      // postgis/postgis carries the geometry extension used by sos_events.
      container.withImage('postgis/postgis:15-3.3');
      container.withDatabase('bravo_test');
      container.withUsername('bravo');
      container.withPassword('bravo');

      const started = await container.start();
      containerStop = () => started.stop();
      url = started.getConnectionUri();
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const {Pool} = require('pg') as {Pool: new (cfg: {connectionString: string}) => Pool};
    pool = new Pool({connectionString: url});
    await pool.query('SELECT 1');
  } catch (e) {
    bootError = (e as Error).message;
    // eslint-disable-next-line no-console
    console.warn(`[integration] DB boot failed: ${bootError}`);
    return false;
  }

  // ── 2. Schema. A failure HERE is a real defect — a migration that does not
  //       apply to a fresh database — so it FAILS the suite instead of being
  //       swallowed (every itest early-returns when `booted` is false, so a
  //       swallowed schema failure used to read as a green run).
  const failed: string[] = [];
  try {
    // Postgis is in the image but the migrations assume it is enabled.
    await pool.query('CREATE EXTENSION IF NOT EXISTS postgis;');
    await pool.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');
    // The auth/storage schemas + roles a Supabase project provides.
    await pool.query(readFileSync(join(__dirname, 'supabase-platform-shim.sql'), 'utf8'));
    // Apply migrations in order (lexical sort matches the timestamp prefix).
    const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    for (const f of files) {
      try {
        await pool.query(portableSql(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')));
      } catch (e) {
        failed.push(`${f}: ${(e as Error).message.split('\n')[0]}`);
      }
    }
  } catch (e) {
    failed.push(`schema bootstrap: ${(e as Error).message}`);
  }
  if (failed.length > 0) {
    await teardownIntegrationDb();
    throw new Error(
      `[integration] ${failed.length} migration(s) did not apply to a fresh database:\n  ${failed.join('\n  ')}`,
    );
  }
  return true;
}

/**
 * Two quirks of ALREADY-APPLIED migrations (not rewritten — they ran on the
 * shared database) that psql absorbs but a driver does not:
 *   - 20260705110000_lite_mission_compat_bridge.sql starts with a UTF-8 BOM;
 *   - 20260817000000_purge_legacy_workspace_broadcasts.sql has a psql
 *     meta-command line (`\set ON_ERROR_STOP on`).
 */
export function portableSql(sql: string): string {
  return sql.replace(/^\uFEFF/, '').split('\n').filter(l => !/^\s*\\[a-z]/i.test(l)).join('\n');
}

export async function teardownIntegrationDb(): Promise<void> {
  if (pool) {
    await pool.end().catch(() => undefined);
    pool = null;
  }
  if (containerStop) {
    await containerStop().catch(() => undefined);
    containerStop = null;
  }
}

/**
 * Truncate the writeable tables to a clean slate. Call from each test's
 * `beforeEach` so tests don't pollute each other. CASCADE handles the FK
 * graph in one pass.
 */
export async function resetWriteableTables(): Promise<void> {
  if (!pool) return;
  // Order doesn't matter because of CASCADE; the names are the tables
  // touched by the FSM / concurrency tests.
  await pool.query(`
    TRUNCATE TABLE
      ops_audit,
      sos_events,
      mission_waypoints,
      mission_crew,
      missions,
      escrow_holds,
      wallet_transactions,
      lite_bookings,
      job_applications,
      jobs,
      live_feed_events,
      cpo_pool,
      admin_users,
      agents,
      org_members,
      public.users
    RESTART IDENTITY CASCADE;
  `).catch(() => {
    // If one of the tables doesn't exist in this partial-apply schema,
    // the test should detect it via `bootError` and skip.
  });
}
