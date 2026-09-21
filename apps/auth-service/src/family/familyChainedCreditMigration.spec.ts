/**
 * B-854 — chained family credit: the migration.
 *
 * No database runs in unit tests, so the migration is pinned by reading the
 * file. Comments are stripped FIRST — this migration's header prose names every
 * column and index it adds, which is the single most common source of a false
 * green here (CLAUDE.md source-scan rule). `\r?\n` because the working tree is
 * Windows for some of these files and LF for others.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

// jest runs with cwd = apps/auth-service
const MIGRATIONS_DIR = join(process.cwd(), '..', '..', 'supabase', 'migrations');
const THIS_MIGRATION = '20260912000000_family_chained_credit.sql';

function stripped(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    .replace(/\r?\n/g, '\n')
    .split('\n')
    .filter(l => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ');
}

describe('B-854 migration — the funding switch', () => {
  const sql = (): string => stripped(THIS_MIGRATION);

  it('adds funds_sub_members as NOT NULL DEFAULT false (today, unchanged, is the default)', () => {
    expect(sql()).toMatch(
      /ALTER TABLE public\.family_members ADD COLUMN IF NOT EXISTS funds_sub_members BOOLEAN NOT NULL DEFAULT false;/i,
    );
  });

  it('A9 — one funding root per member, and the predicate is ACTIVE-only', () => {
    const s = sql();
    expect(s).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS family_members_one_funding_root ON public\.family_members\(member_id\)/i,
    );
    // A PENDING row must not be able to squat the one funding slot (§7 round 1a).
    expect(s).toMatch(/WHERE funds_sub_members AND status = 'active';/i);
    expect(s).not.toMatch(/WHERE funds_sub_members AND status IN \('pending','active'\)/i);
  });

  it('tells the operator to build the unique CONCURRENTLY on production', () => {
    // A non-concurrent build takes a SHARE lock on family_members, which blocks
    // every member INSERT/UPDATE — including a live escrow charge's spent bump.
    const raw = readFileSync(join(MIGRATIONS_DIR, THIS_MIGRATION), 'utf8');
    expect(raw).toMatch(/CONCURRENTLY/);
  });
});

describe('B-854 migration — the chain stamp on the booking', () => {
  const sql = (): string => stripped(THIS_MIGRATION);

  it('A16 — exactly ONE new booking column, nullable, FK to users', () => {
    expect(sql()).toMatch(
      /ALTER TABLE public\.lite_bookings ADD COLUMN IF NOT EXISTS payer_via_user_id UUID NULL REFERENCES public\.users\(id\);/i,
    );
    // via_family_row_id lives in ledger metadata ONLY — a second booking column
    // would be a second thing to keep in sync with the ledger.
    expect(sql()).not.toMatch(/lite_bookings ADD COLUMN IF NOT EXISTS via_family_row_id/i);
  });

  it('indexes the stamp partially — the column is NULL on almost every row', () => {
    expect(sql()).toMatch(
      /CREATE INDEX IF NOT EXISTS lite_bookings_payer_via_idx ON public\.lite_bookings\(payer_via_user_id\) WHERE payer_via_user_id IS NOT NULL;/i,
    );
  });
});

describe('B-854 migration — A6 ledger-row-id readers', () => {
  const sql = (): string => stripped(THIS_MIGRATION);

  it('indexes BOTH metadata keys the readers now filter on', () => {
    const s = sql();
    expect(s).toMatch(
      /CREATE INDEX IF NOT EXISTS wallet_tx_family_row_idx ON public\.wallet_transactions \(\(metadata->>'family_row_id'\)\) WHERE metadata \? 'family_row_id';/i,
    );
    expect(s).toMatch(
      /CREATE INDEX IF NOT EXISTS wallet_tx_via_family_row_idx ON public\.wallet_transactions \(\(metadata->>'via_family_row_id'\)\) WHERE metadata \? 'via_family_row_id';/i,
    );
  });
});

describe('B-854 migration — the audit verbs are UPPERCASE like their siblings', () => {
  const sql = (): string => stripped(THIS_MIGRATION);

  it('re-states the action CHECK with the four FUND_MEMBERS_* verbs', () => {
    const s = sql();
    // A CHECK has no ALTER form, so it is dropped (IF EXISTS, re-runnable) and
    // re-added — and the re-add must carry the ORIGINAL five verbs too, or every
    // existing quota write starts failing.
    expect(s).toMatch(/ALTER TABLE public\.family_quota_audit DROP CONSTRAINT IF EXISTS family_quota_audit_action_check;/i);
    for (const verb of [
      'QUOTA_CREATED', 'QUOTA_INCREASED', 'QUOTA_DECREASED', 'QUOTA_CLEARED', 'CREDIT_APPROVED',
      'FUND_MEMBERS_REQUESTED', 'FUND_MEMBERS_APPROVED', 'FUND_MEMBERS_DECLINED', 'FUND_MEMBERS_OFF',
    ]) {
      expect(s).toContain(`'${verb}'`);
    }
    // Lowercase would pass the service and be rejected by the constraint at
    // runtime — the exact shape §7 round 1a flagged.
    expect(s).not.toMatch(/'fund_members_(on|off)'/);
  });
});

describe('B-854 migration — A11 the approval loop', () => {
  const sql = (): string => stripped(THIS_MIGRATION);

  it('creates family_funding_requests with the full lifecycle', () => {
    const s = sql();
    expect(s).toMatch(/CREATE TABLE IF NOT EXISTS public\.family_funding_requests \(/i);
    for (const col of [
      'family_row_id', 'holder_id', 'member_id', 'status',
      'decided_by', 'decided_at', 'decision_reason', 'created_at', 'expires_at',
    ]) {
      expect(s).toContain(col);
    }
    expect(s).toMatch(/CHECK \(status IN \('pending','approved','declined','cancelled','expired'\)\)/i);
  });

  it('one PENDING request per membership row, by INDEX not by check-then-insert', () => {
    expect(sql()).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS family_funding_requests_one_pending ON public\.family_funding_requests\(family_row_id\) WHERE status = 'pending';/i,
    );
  });

  it('the request row follows the membership ROW (ON DELETE CASCADE from family_members)', () => {
    expect(sql()).toMatch(
      /family_row_id UUID NOT NULL REFERENCES public\.family_members\(id\) ON DELETE CASCADE/i,
    );
  });

  it('deny-by-default RLS, like its family_credit_requests sibling', () => {
    const s = sql();
    expect(s).toMatch(/ALTER TABLE public\.family_funding_requests ENABLE ROW LEVEL SECURITY;/i);
    expect(s).toMatch(/ALTER TABLE public\.family_funding_requests FORCE ROW LEVEL SECURITY;/i);
    expect(s).toMatch(/REVOKE ALL ON public\.family_funding_requests FROM anon, authenticated;/i);
  });
});
