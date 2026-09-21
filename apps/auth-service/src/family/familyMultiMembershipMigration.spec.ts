/**
 * B-843 — one person, many root accounts.
 *
 * The one-root rule lived in FOUR places; the DB one is the only one that can
 * refuse a second membership no matter what the server says, so it is the one
 * that has to move first. The invariant that REPLACES it is narrower and is
 * what every money path already depends on: exactly ONE OPEN row per
 * (root, member). That pair is the key the escrow charge re-resolves on
 * (`dispatch.service.ts`, B-384), the key the spent bump and the refund
 * reversal use, and the key `resolvePayer(user, holder)` reads.
 *
 * No database runs in unit tests, so the migration is pinned by reading the
 * file. Comments are stripped first — this migration's own header prose names
 * both indexes, which is the single most common source of a false green here.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

// jest runs with cwd = apps/auth-service
const MIGRATIONS_DIR = join(process.cwd(), '..', '..', 'supabase', 'migrations');
const THIS_MIGRATION = '20260910230000_family_multi_membership.sql';

function stripped(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(l => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ');
}

describe('B-843 migration — the one-active-per-member index is replaced by (holder, member)', () => {
  const sql = (): string => stripped(THIS_MIGRATION);

  it('DROPs the old one-active-per-member unique index', () => {
    expect(sql()).toMatch(
      /DROP INDEX IF EXISTS public\.family_members_one_active_per_member;/i,
    );
  });

  it('creates the (holder_id, member_id) partial unique with BOTH predicates', () => {
    const s = sql();
    expect(s).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS family_members_holder_member_open\s+ON public\.family_members\(holder_id, member_id\)/i,
    );
    // Both halves of the predicate are load-bearing. Without `member_id IS NOT
    // NULL` the pending-by-phone rows (member_id NULL) would collapse onto one
    // row per holder; without the status filter a revoked row would block a
    // re-invite forever.
    expect(s).toMatch(/WHERE member_id IS NOT NULL AND status IN \('pending','active'\)/i);
  });

  it('documents the new doctrine on the index itself', () => {
    // The raw file (comments included) must carry the COMMENT ON INDEX — an
    // operator reading \\d+ in psql is the audience.
    const raw = readFileSync(join(MIGRATIONS_DIR, THIS_MIGRATION), 'utf8');
    expect(raw).toMatch(/COMMENT ON INDEX public\.family_members_holder_member_open IS/i);
  });

  it('does not resurrect a member-only unique anywhere in the file', () => {
    // A "one active membership" index in ANY spelling re-imposes the rule the
    // whole batch removes.
    expect(sql()).not.toMatch(/UNIQUE INDEX[^;]*ON public\.family_members\(member_id\)/i);
  });
});

/**
 * F1 — the new unique can ABORT on existing data.
 *
 * Nothing has ever enforced uniqueness on (holder_id, member_id) for PENDING
 * rows: the old index covered `status = 'active'` only, the holder+phone index
 * needs a non-null `invite_phone` (and `invite()` stopped writing those in
 * 2026-08), and `invite()`'s bare `ON CONFLICT DO NOTHING` has no conflict
 * target to match either. So an app invite racing a console-batch invite could
 * already have left TWO pending rows for one pair — and `CREATE UNIQUE INDEX`
 * would then fail and roll the whole migration back.
 */
describe('B-843 migration — existing duplicate open rows are revoked BEFORE the unique is built', () => {
  const sql = (): string => stripped(THIS_MIGRATION);

  it('revokes the losers instead of DELETING them (the row id is referenced by the ledger)', () => {
    const s = sql();
    // `wallet_transactions.metadata->>'family_row_id'` pins refund reversal to
    // the CHARGE-TIME membership row; deleting one orphans that reversal.
    expect(s).toMatch(/UPDATE public\.family_members[\s\S]{0,200}SET status = 'revoked'/i);
    expect(s).not.toMatch(/DELETE FROM public\.family_members/i);
  });

  it('keeps exactly ONE row per (holder_id, member_id), ranked active-first then oldest', () => {
    const s = sql();
    expect(s).toMatch(/PARTITION BY holder_id, member_id/i);
    // Active beats pending; among equals the oldest membership survives, and the
    // id is the final tie-break so the choice is deterministic.
    expect(s).toMatch(/ORDER BY \(status = 'active'\) DESC, accepted_at ASC NULLS LAST, invited_at ASC, id ASC/i);
    expect(s).toMatch(/rn > 1/i);
    // Scoped to exactly the rows the new index covers — a dedupe that also
    // walked revoked rows would revoke history.
    expect(s).toMatch(/WHERE member_id IS NOT NULL AND status IN \('pending','active'\)/i);
  });

  it('the dedupe runs BEFORE the CREATE UNIQUE INDEX (order is the whole point)', () => {
    const s = sql();
    const dedupeAt = s.search(/PARTITION BY holder_id, member_id/i);
    const createAt = s.search(/CREATE UNIQUE INDEX IF NOT EXISTS family_members_holder_member_open/i);
    expect(dedupeAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(-1);
    expect(dedupeAt).toBeLessThan(createAt);
  });

  it('tells the operator to build the index CONCURRENTLY on production', () => {
    // A non-concurrent build takes a SHARE lock on family_members, which blocks
    // every member INSERT/UPDATE — including a live escrow charge's spent bump.
    const raw = readFileSync(join(MIGRATIONS_DIR, THIS_MIGRATION), 'utf8');
    expect(raw).toMatch(/CONCURRENTLY/);
  });
});
