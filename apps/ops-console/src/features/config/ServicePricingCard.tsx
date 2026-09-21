'use client';

/**
 * App Configuration — the booking pricing board (IA-07). Extracted verbatim
 * from "Console Settings"; the confirm dialogs and bounds are unchanged.
 *
 * B-807 — rendered in GROUPS (`lib/pricingBoard.ts`), each with its own
 * "applies when" sentence. The two settlement fees (`platform_fee_pct`,
 * `cancel_fee_pct`) used to render unlabelled at the bottom of a card whose
 * only timing copy was "the next quote uses the new number" — false for both;
 * they are read at escrow release / cancellation, never by a quote.
 */

import {useState} from 'react';
import useSWR from 'swr';
import {ApiError, opsDataApi} from '@/lib/api';
import {
  PRICING_GROUPS, PRICING_HELP, PRICING_LABELS, pricingSaveConfirmText, ungroupedKeys,
} from '@/lib/pricingBoard';

type PriceRow = {
  key: string; value: number; default_value: number; global_value: number;
  inherited: boolean; updated_at: string | null; min: number; max: number;
};

/**
 * Founder 2026-08-26 — the booking price engine's numbers ("prices for 1x
 * CPO, vehicle, female, price per hour — everywhere the price applicable").
 * Read at CHARGE TIME (60 s server cache): an edit prices the next quote;
 * existing bookings keep their stored totals. eur_per_bc is the conversion
 * ROOT for booking charges; the wallet top-up peg (1 fiat = 1 BC) is a
 * separate, deliberately locked rule.
 */
export function ServicePricingCard() {
  // Client 2026-09-01 — the board is now per region. GLOBAL is the base every
  // region inherits; picking a region shows what it would actually charge.
  const [region, setRegion] = useState('GLOBAL');
  const {data, mutate, error} = useSWR(
    ['ops-service-pricing', region],
    () => opsDataApi.servicePricing(region),
  );
  // OP-15 — same key as RegionsCard, so one fetch serves both editors and a
  // region added there shows up here without its own poll.
  const {data: regionsData} = useSWR('ops-regions', () => opsDataApi.regions());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  /** Stop following GLOBAL's number, or start following it again. */
  async function resetToGlobal(row: {key: string; global_value: number}) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(
      `Stop overriding ${row.key} for ${region}? It will follow the global value `
      + `(${row.global_value}) again, including future changes to it.`)) return;
    setBusyKey(row.key); setErr(null);
    try {
      await opsDataApi.clearServicePrice(row.key, region);
      await mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Reset failed');
    } finally {
      setBusyKey(null);
    }
  }

  async function save(row: {key: string; value: number; min: number; max: number}) {
    const raw = (drafts[row.key] ?? '').trim();
    const parsed = Number(raw);
    if (!raw || !Number.isFinite(parsed) || parsed < row.min || parsed > row.max) {
      setErr(`Value for ${row.key} must be between ${row.min} and ${row.max}.`);
      return;
    }
    // OC-03 — one SAVE click reprices the platform; make the operator read
    // the from→to once before it lands. The root gets its own louder copy,
    // and a settlement fee is described by its real timing (B-807).
    // eslint-disable-next-line no-alert
    if (!window.confirm(pricingSaveConfirmText(row.key, row.value, parsed, region))) return;
    setBusyKey(row.key); setErr(null);
    try {
      await opsDataApi.setServicePrice(row.key, parsed, region);
      setDrafts(d => ({...d, [row.key]: ''}));
      await mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Price update failed');
    } finally {
      setBusyKey(null);
    }
  }

  const rows: PriceRow[] = data?.pricing ?? [];
  const byKey = new Map(rows.map(r => [r.key, r]));
  const groups = [
    ...PRICING_GROUPS.map(g => ({...g, rows: g.keys.map(k => byKey.get(k)).filter((r): r is PriceRow => !!r)})),
    {
      key: 'other' as const, title: 'Other', appliesWhen: 'Applies from the next quote/charge.',
      keys: [] as readonly string[], rows: ungroupedKeys(rows.map(r => r.key)).map(k => byKey.get(k)!),
    },
  ].filter(g => g.rows.length > 0);

  const mono10 = {fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--tx-3)', letterSpacing: 0.5} as const;

  return (
    <div className="card" style={{padding: 24, marginTop: 16, overflow: 'auto'}}>
      <div style={{fontFamily: 'var(--font-sans)', fontSize: 15, fontWeight: 700, marginBottom: 4}}>
        Service pricing — bookings
      </div>
      <div style={{...mono10, marginBottom: 16}}>
        Quote numbers are read at charge time — the next quote uses the new value; existing bookings keep
        their stored totals. Settlement fees are read when escrow settles. SUPERVISOR/ADMIN only.
      </div>

      {/* The pricing region is DERIVED from the booking's pickup coordinates, not
          from anything the client app sends, so a customer cannot select a
          cheaper region. A region only overrides the keys set for it here. */}
      <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, flexWrap: 'wrap'}}>
        <span style={{...mono10, letterSpacing: 0.8}}>REGION</span>
        <select
          value={region}
          onChange={e => { setRegion(e.target.value); setDrafts({}); }}
          aria-label="Pricing region"
          style={{
            background: 'transparent', border: '1px solid var(--bd-2)', borderRadius: 6,
            padding: '6px 10px', fontSize: 12, color: 'var(--tx-1)', fontFamily: 'var(--font-mono)',
          }}>
          <option value="GLOBAL">GLOBAL — base for every region</option>
          {(regionsData?.regions ?? []).map(r => (
            <option key={r.code} value={r.code}>
              {r.code} — {r.name}{r.launched ? '' : ' (not launched)'}
            </option>
          ))}
        </select>
        {region !== 'GLOBAL' && (
          <span style={mono10}>Blank rows follow GLOBAL. Saving one pins it for {region} only.</span>
        )}
      </div>
      {error && <div style={{fontSize: 12, color: 'var(--err)', marginBottom: 12}}>Could not load service pricing.</div>}
      {err && <div role="alert" style={{fontSize: 12, color: 'var(--err)', marginBottom: 12}}>{err}</div>}

      {groups.map(g => (
        <section key={g.key} aria-label={g.title} style={{marginTop: 18}}>
          <div style={{
            display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap',
            padding: '8px 0', borderBottom: '1px solid var(--bd-1)',
          }}>
            <div style={{fontFamily: 'var(--font-sans)', fontSize: 12.5, fontWeight: 800, letterSpacing: 0.4, color: g.key === 'settlement' ? 'var(--warn)' : 'var(--tx-1)'}}>
              {g.title.toUpperCase()}
            </div>
            <div style={{...mono10, letterSpacing: 0.3, flex: '1 1 320px', minWidth: 0}}>{g.appliesWhen}</div>
          </div>

          {g.rows.map(p => {
            const pending = (drafts[p.key] ?? '').trim();
            const isPct = p.key.endsWith('_pct');
            return (
              <div key={p.key} style={{
                display: 'grid', gridTemplateColumns: 'minmax(240px,1fr) 130px 140px 100px 80px', gap: 14,
                padding: '11px 0', borderBottom: '1px solid var(--bd-2)', alignItems: 'center',
                background: p.key === 'eur_per_bc' ? 'rgba(91,141,239,0.05)' : undefined,
              }}>
                <div style={{minWidth: 0}}>
                  <div style={{fontSize: 12, color: 'var(--tx-1)', fontFamily: 'var(--font-sans)', fontWeight: 700}}>
                    {PRICING_LABELS[p.key] ?? p.key}
                  </div>
                  <div style={{fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--tx-3)', letterSpacing: 0.8, marginTop: 2}}>
                    {p.key} · bounds {p.min}–{p.max}{isPct ? ' %' : ''}{p.value !== p.default_value ? ` · default ${p.default_value}` : ''}
                  </div>
                  {PRICING_HELP[p.key] && (
                    <div style={{fontSize: 11, color: 'var(--tx-3)', lineHeight: 1.5, marginTop: 6, maxWidth: 720}}>
                      {PRICING_HELP[p.key]}
                    </div>
                  )}
                </div>
                <div style={{fontSize: 12.5, fontFamily: 'var(--font-mono)', fontWeight: 700,
                             color: p.inherited ? 'var(--tx-3)' : 'var(--glow)'}}>
                  {p.value}{isPct ? '%' : ''}
                  {/* An operator cannot otherwise tell a deliberate match from an
                      un-set key, and "changing" an inherited value looks like a no-op. */}
                  {region !== 'GLOBAL' && (
                    <span style={{display: 'block', fontSize: 9, fontWeight: 500, letterSpacing: 0.6, marginTop: 2}}>
                      {p.inherited ? 'inherits global' : `own · global ${p.global_value}`}
                    </span>
                  )}
                </div>
                <input
                  value={drafts[p.key] ?? ''}
                  onChange={e => setDrafts(d => ({...d, [p.key]: e.target.value}))}
                  placeholder={isPct ? 'new %' : 'new value'}
                  aria-label={`New value for ${p.key}`}
                  inputMode="decimal"
                  style={{
                    background: 'transparent', border: '1px solid var(--bd-2)', borderRadius: 6,
                    padding: '6px 10px', fontSize: 12, color: 'var(--tx-1)', fontFamily: 'var(--font-mono)',
                  }}
                />
                <button
                  onClick={() => { void save(p); }}
                  disabled={busyKey === p.key || !pending}
                  style={{
                    border: '1px solid rgba(91,141,239,0.4)', color: 'var(--glow)', background: 'transparent',
                    borderRadius: 6, padding: '6px 14px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                    opacity: busyKey === p.key || !pending ? 0.4 : 1,
                  }}>
                  {busyKey === p.key ? 'SAVING…' : 'SAVE'}
                </button>
                {region !== 'GLOBAL' && !p.inherited && (
                  <button
                    onClick={() => { void resetToGlobal(p); }}
                    disabled={busyKey === p.key}
                    title={`Follow the global value (${p.global_value}) again`}
                    style={{
                      border: '1px solid var(--bd-2)', color: 'var(--tx-3)', background: 'transparent',
                      borderRadius: 6, padding: '6px 10px', fontSize: 10, fontWeight: 700, cursor: 'pointer',
                    }}>
                    RESET
                  </button>
                )}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
