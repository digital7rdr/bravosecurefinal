import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Adversarial review 2026-09-03 — the three findings whose whole substance lives
 * in a FILE, not in a function, and which therefore have no other pin.
 *
 *   E2E-20 (P0-2) the global throttle bucket is now ENFORCED, so its SIZE is a
 *                 real 429 boundary. It is IP-keyed and an IP is a whole office
 *                 or CGNAT pool, so it must be a DDoS backstop, not a rate limit.
 *   E2E-21 (P0-3) the limits and the throttle rollback lever cannot reach staging
 *                 from this repo at all — the live compose file is on the box —
 *                 so the runbook is the deliverable.
 *   (P1-6)        the migration can legitimately SKIP its unique-index build with
 *                 a WARNING; `db-migrate.sh` must re-assert the object by name.
 *
 * Every scan below strips `//`, `#` and `--` comment lines first. These files
 * all DISCUSS the values they set, at length, so a raw substring match would hit
 * prose and pass vacuously — the single most common way a source scan lies. They
 * are also CRLF, so every split is `\r?\n`, never `\n`.
 */

const ROOT = join(__dirname, '..', '..', '..', '..', '..');

function stripped(relPath: string, marker: '//' | '#' | '--'): string {
  return readFileSync(join(ROOT, relPath), 'utf8')
    .split(/\r?\n/)
    .filter(l => !l.trimStart().startsWith(marker))
    .join('\n');
}

describe('E2E-20 — the global throttle bucket is a DDoS backstop, not a rate limit', () => {
  const src = stripped('apps/auth-service/src/app.module.ts', '//');

  it('ThrottlerModule ships a 3000/min ceiling', () => {
    expect(src).toMatch(/limit:\s*3_?000\b/);
  });

  it('is NOT back at a per-user-sized number', () => {
    // 120 was the original (dead) value; 600 was a first cut that would have
    // 429'd four ops-console seats behind one office NAT — the console polls at
    // 2 s/5 s with 5-10 SWR hooks per page, ~120-200 req/min PER SEAT.
    expect(src).not.toMatch(/limit:\s*(120|600)\b/);
  });

  it('keeps the one-minute window (a long window locks a shared NAT out for its whole length)', () => {
    expect(src).toMatch(/ttl:\s*60_?000\b/);
  });
});

describe('E2E-21 / E2E-20 — the box compose keys are documented where the deploy happens', () => {
  const runbook = stripped('docs/runbooks/CICD_STAGING.md', '#');

  it('states plainly that docker-compose.staging.yml is NOT in this repo', () => {
    // Without this the next person edits the repo's docker-compose.yml (which
    // says "local dev" in its first line) or infra/systemd/*.service (the
    // decommissioned EC2 path) and believes staging is limited. It is not.
    expect(runbook).toMatch(/docker-compose\.staging\.yml.*(LIVES ON THE BOX|ON THE BOX|on the box)/i);
  });

  it.each([
    ['mem_limit', /mem_limit:\s*1536m/],
    ['memswap_limit', /memswap_limit:\s*1536m/],
    ['cpus', /cpus:\s*1\.5/],
    ['NODE_OPTIONS', /NODE_OPTIONS:\s*'--max-old-space-size=1024'/],
    ['THROTTLE_ENFORCE', /THROTTLE_ENFORCE:\s*'true'/],
    ['redis maxmemory', /--maxmemory 384mb/],
    ['redis limit', /mem_limit:\s*512m/],
  ])('names the required %s key', (_label, re) => {
    expect(runbook).toMatch(re);
  });

  it('gives a verification command, so "I added it" is checkable', () => {
    expect(runbook).toMatch(/docker inspect[\s\S]*HostConfig\.Memory/);
  });

  it('names the rollback lever for enforcement', () => {
    expect(runbook).toMatch(/THROTTLE_ENFORCE:\s*'false'/);
  });

  it('the migration header carries the same list (it is what a deployer reads)', () => {
    // Deliberately NOT comment-stripped here: in a .sql file this list IS the
    // header comment, so stripping `--` lines would delete the thing under test.
    const mig = readFileSync(
      join(ROOT, 'supabase/migrations/20260903120000_booking_guards_and_scale_indexes.sql'), 'utf8');
    expect(mig).toMatch(/docker-compose\.staging\.yml/);
    expect(mig).toMatch(/THROTTLE_ENFORCE/);
    expect(mig).toMatch(/max-old-space-size=1024/);
    expect(mig).toMatch(/memswap_limit/);
  });
});

describe('P1-6 — db-migrate.sh re-asserts the objects a migration promised', () => {
  const src = stripped('scripts/db-migrate.sh', '#');

  it('asserts the one-active-booking index by name after --apply', () => {
    // The migration's DO block can find duplicates, RAISE WARNING and return.
    // psql exits 0, the ledger records the file as applied, and the
    // COMMENT ON TABLE in that same file then asserts a guard that is not there.
    expect(src).toMatch(/lite_bookings_one_active_per_client_uq/);
    expect(src).toMatch(/to_regclass\('\$obj'\) IS NOT NULL/);
  });

  it('exits NON-ZERO when a promised object is missing (a warning alone is not a check)', () => {
    expect(src).toMatch(/missing.*-eq 0.*\|\|\s*fail/);
  });

  it('only asserts objects whose migration actually ran (stays correct on a behind database)', () => {
    expect(src).toMatch(/\[\[ -z "\$ran" \]\] && continue/);
  });
});
