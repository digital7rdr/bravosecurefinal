/**
 * B-819 (founder, 2026-09-07, screenshot of /pro/applications) — the status
 * buckets rendered as nine full-width stacked blocks that filled the whole
 * viewport, with the applications themselves below the fold.
 *
 * RED-first, both halves:
 *   • the CSS rule `button.filter-ch { width: 100% }` was UNSCOPED, so it
 *     stretched every chip in a horizontal wrap row, not just the vertical
 *     filter rail it was written for;
 *   • the page hand-rolled its header, its rows and its status text instead of
 *     the console's own primitives, so none of the queue's facts (counts on
 *     empty buckets, how long something has waited) were on screen.
 *
 * The pure queue vocabulary is executed; the wiring is scanned at the decision
 * site with comments stripped (prose naming a token is the classic false pass).
 */
import fs from 'fs';
import path from 'path';
import {
  PRO_ACTIONABLE_STATUSES, PRO_STALE_DAYS,
  isProActionable, isProStale, waitingDays, waitingLabel,
} from '../lib/proapps';
import {PRO_APPLICATION_STATUS} from '../lib/status';

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
/** Strip comments — a rule quoted in prose must not satisfy a scan. */
const code = (rel: string) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const PAGE = 'apps/ops-console/src/app/(console)/pro/applications/page.tsx';
const CSS = 'apps/ops-console/src/app/globals.css';
const TABS = 'apps/ops-console/src/components/StatusTabs.tsx';

describe('the queue vocabulary (pure)', () => {
  const NOW = new Date('2026-09-07T10:00:00.000Z');

  it('the two buckets waiting on OPS are the actionable ones', () => {
    expect(PRO_ACTIONABLE_STATUSES).toEqual(['PENDING_PROPOSAL', 'REVISION_REQUESTED']);
    expect(isProActionable('PENDING_PROPOSAL')).toBe(true);
    expect(isProActionable('REVISION_REQUESTED')).toBe(true);
    // PROPOSAL_CREATED waits on the CLIENT — chasing ops for it is the wrong queue.
    expect(isProActionable('PROPOSAL_CREATED')).toBe(false);
    expect(isProActionable('ACTIVE')).toBe(false);
  });

  it('counts whole UTC days waited, and never reports a negative age', () => {
    expect(waitingDays('2026-09-07T09:00:00.000Z', NOW)).toBe(0);
    expect(waitingDays('2026-09-06T23:59:00.000Z', NOW)).toBe(1);
    expect(waitingDays('2026-08-28T10:00:00.000Z', NOW)).toBe(10);
    // A clock-skewed future timestamp reads "today", never "-1 days".
    expect(waitingDays('2026-09-09T10:00:00.000Z', NOW)).toBe(0);
  });

  it('labels the age in the operator’s words', () => {
    expect(waitingLabel(0)).toBe('today');
    expect(waitingLabel(1)).toBe('1 day');
    expect(waitingLabel(9)).toBe('9 days');
  });

  it('only an ACTIONABLE row can go stale — an old ACTIVE plan is not "late"', () => {
    const old = '2026-08-20T10:00:00.000Z';   // 18 days
    expect(isProStale({status: 'PENDING_PROPOSAL', submitted_at: old}, NOW)).toBe(true);
    expect(isProStale({status: 'REVISION_REQUESTED', submitted_at: old}, NOW)).toBe(true);
    expect(isProStale({status: 'ACTIVE', submitted_at: old}, NOW)).toBe(false);
    expect(isProStale({status: 'CANCELLED', submitted_at: old}, NOW)).toBe(false);
  });

  it('the stale threshold is a boundary, not a "more than"', () => {
    const at = new Date(NOW.getTime() - PRO_STALE_DAYS * 86_400_000).toISOString();
    const under = new Date(NOW.getTime() - (PRO_STALE_DAYS - 1) * 86_400_000).toISOString();
    expect(isProStale({status: 'PENDING_PROPOSAL', submitted_at: at}, NOW)).toBe(true);
    expect(isProStale({status: 'PENDING_PROPOSAL', submitted_at: under}, NOW)).toBe(false);
  });
});

describe('B-819 root cause — the full-width chip rule is the RAIL’s alone', () => {
  const css = code(CSS);

  it('scopes width:100% to .filter-rail; the button reset stays global', () => {
    // THE BUG: `button.filter-ch, button.region-chip { width: 100%; … }`.
    expect(css).toMatch(/\.filter-rail button\.filter-ch,\s*\n?\s*\.filter-rail button\.region-chip \{ width: 100%; \}/);
    const reset = css.match(/button\.filter-ch, button\.region-chip \{[^}]*\}/)?.[0] ?? '';
    expect(reset).toContain('font: inherit');
    expect(reset).not.toContain('width: 100%');
  });

  it('a zero count is MUTED, not hidden — "none" and "not loaded" must differ', () => {
    expect(css).toMatch(/\.rtab-cnt\.zero \{[^}]*color: var\(--tx-3\)/);
    expect(css).toMatch(/\.rtab-cnt\.warn \{[^}]*background: var\(--warn\)/);
    const tabs = code(TABS);
    expect(tabs).toMatch(/typeof t\.count === 'number'/);
    expect(tabs).toMatch(/t\.count === 0 \? ' zero' : t\.attention \? ' warn' : ''/);
  });

  it('StatusTabs buttons are DIRECT flex children of .rtabs (a wrapper kills wrap + gap)', () => {
    const tabs = code(TABS);
    expect(tabs).toMatch(/<Fragment key=\{t\.key\}>/);
    expect(tabs).not.toMatch(/display: 'contents'/);
    // Toggle buttons, not a half-built tablist (no roving focus, no tabpanel).
    expect(tabs).toMatch(/role="group"/);
    expect(tabs).toMatch(/aria-pressed=\{active\}/);
    expect(tabs).not.toMatch(/role="tab(list)?"/);
  });
});

describe('the page is built from the house primitives', () => {
  const page = code(PAGE);

  it('no status-bucket row reaches for the rail’s chip class any more', () => {
    expect(page).not.toMatch(/filter-ch/);
    expect(code('apps/ops-console/src/features/pro/ProManagement.tsx')).not.toMatch(/filter-ch/);
  });

  it('uses PageHeader, StatusTabs, DataTable and StatusPill — one dialect', () => {
    expect(page).toMatch(/<PageHeader/);
    expect(page).toMatch(/<StatusTabs/);
    expect(page).toMatch(/<DataTable/);
    expect(page).toMatch(/<StatusPill domain="proApplication"/);
    // IA-17 — never render a raw enum string again.
    expect(page).not.toMatch(/status\.replace\(/);
    // IA-12 — the hand-rolled header (an <h1> the CSS styles as <h2>) is gone.
    expect(page).not.toMatch(/className="page-head"/);
    expect(page).not.toMatch(/<h1>/);
  });

  it('tab labels come from the status registry, so a tab cannot disagree with its pill', () => {
    expect(page).toMatch(/PRO_APPLICATION_STATUS\[t\.key as ProApplicationStatus\]/);
    expect(page).not.toMatch(/label: 'PROPOSAL SENT'/);
    // Every bucket the page offers is a real status (plus the 'all' bucket).
    const keys = [...page.matchAll(/\{key: '([A-Z_]+|all)'/g)].map(m => m[1]);
    expect(keys).toContain('all');
    for (const k of keys.filter(x => x !== 'all')) {
      expect(Object.keys(PRO_APPLICATION_STATUS)).toContain(k);
    }
    expect(keys.filter(x => x !== 'all').sort()).toEqual(Object.keys(PRO_APPLICATION_STATUS).sort());
  });

  it('leads with what is waiting on ops, and says so only when there IS work', () => {
    expect(page).toMatch(/const waiting = PRO_ACTIONABLE_STATUSES\.reduce/);
    expect(page).toMatch(/\{waiting > 0 && \(/);
    expect(page).toMatch(/queue-banner/);
  });

  it('shows the WAITING age, ambered only where an operator can act', () => {
    expect(page).toMatch(/header: 'Waiting'/);
    expect(page).toMatch(/const stale = isProStale\(r\);/);
    expect(page).toMatch(/queue-age-stale/);
  });

  it('the empty bucket points at the buckets that DO hold work (no dead end)', () => {
    expect(page).toMatch(/const elsewhere = TAB_ORDER/);
    expect(page).toMatch(/counts\[t\.key\] \?\? 0\) > 0/);
  });

  it('is honest that counts and filtering only cover the loaded window', () => {
    expect(page).toMatch(/capped \? ' · counts are a floor past the 200-row window' : ''/);
    expect(page).toMatch(/sorting and filtering apply to the loaded rows/);
  });

  it('keeps the polling, the paging window and the row link target', () => {
    expect(page).toMatch(/refreshInterval: POLL_MSN/);
    expect(page).toMatch(/const PAGE = 50;/);
    expect(page).toMatch(/const MAX_LIMIT = 200;/);
    expect(page).toMatch(/rowHref=\{r => routes\.pro\.application\(r\.id\)\}/);
  });
});
