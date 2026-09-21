/**
 * B-847 — the backfill that relabels history.
 *
 * The write side is fixed in the same commit (the wizard draft defaults to
 * 'bravo_credits'; `create()` normalises a legacy client's 'card' before the
 * INSERT), so this migration is the one-shot that makes the 302 existing staging
 * rows agree with what was actually charged.
 *
 * No database runs in unit tests, so the migration is pinned by reading the
 * file. Comments are stripped first — this migration's header prose says both
 * 'card' and 'bravo_credits' several times, which is the single most common
 * source of a false green here (CLAUDE.md source-scan rules). CRLF-safe.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

// jest runs with cwd = apps/auth-service
const MIGRATIONS_DIR = join(process.cwd(), '..', '..', 'supabase', 'migrations');
const THIS_MIGRATION = '20260911000000_booking_payment_method_credits.sql';

function raw(): string {
  return readFileSync(join(MIGRATIONS_DIR, THIS_MIGRATION), 'utf8');
}

function stripped(): string {
  return raw()
    .replace(/\r?\n/g, '\n')
    .split('\n')
    .filter(l => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('B-847 migration — legacy \'card\' rows are relabelled bravo_credits', () => {
  it('the file exists and carries executable SQL once the comments are gone', () => {
    expect(() => raw()).not.toThrow();
    expect(stripped().length).toBeGreaterThan(0);
  });

  it('the backfill carries exactly that predicate', () => {
    // The predicate is the whole safety argument: it touches ONLY the mislabelled
    // rows. A bare `SET payment_method = 'bravo_credits'` with no WHERE would also
    // rewrite a future 'corporate' row.
    expect(stripped()).toContain(
      "UPDATE public.lite_bookings SET payment_method = 'bravo_credits' WHERE payment_method = 'card';",
    );
  });

  it('re-points the COLUMN DEFAULT — the third producer of a \'card\' row', () => {
    // `20260423113000_booking_module.sql:62` declared `DEFAULT 'card'`. The two
    // code fixes (the wizard draft, and create()'s normalisation) only cover the
    // INSERTs that name the column; anything that omits it would re-mint the bug.
    expect(stripped()).toContain(
      "ALTER TABLE public.lite_bookings ALTER COLUMN payment_method SET DEFAULT 'bravo_credits';",
    );
  });

  it('the default flips AFTER the backfill (order is not cosmetic)', () => {
    // Flipping the default first would leave the UPDATE's `WHERE payment_method
    // = 'card'` racing rows inserted in between — harmless here, but the reading
    // order is the argument the operator checks.
    const s = stripped();
    const updateAt = s.indexOf('UPDATE public.lite_bookings');
    const alterAt = s.indexOf('ALTER TABLE public.lite_bookings');
    expect(updateAt).toBeGreaterThan(-1);
    expect(alterAt).toBeGreaterThan(updateAt);
  });

  it('touches nothing but that column — no money, no state, no escrow', () => {
    const s = stripped();
    expect(s).not.toMatch(/DELETE FROM/i);
    expect(s).not.toMatch(/\bstatus\b/i);
    expect(s).not.toMatch(/payment_captured/i);
    expect(s).not.toMatch(/escrow/i);
    expect(s).not.toMatch(/wallet/i);
  });

  it('documents WHY for the operator reading it in psql', () => {
    // The raw file (comments included) must say that nothing branches on the
    // column — that is the sentence that makes this UPDATE safe to run.
    const r = raw();
    expect(r).toMatch(/B-847/);
    expect(r).toMatch(/branches on th(is|e) column|display-only/i);
  });
});
