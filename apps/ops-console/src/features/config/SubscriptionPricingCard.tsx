'use client';

/** App Configuration — messenger subscription prices (IA-07). Extracted verbatim. */

import {useState} from 'react';
import useSWR from 'swr';
import {ApiError, opsDataApi} from '@/lib/api';

/**
 * M1A/S9 — live subscription pricing (SUPERVISOR/ADMIN). Prices are read at
 * CHARGE TIME server-side, so a change applies to every subscribe and every
 * renewal from now on ("from next month" for renewing subscribers) while
 * already-paid periods finish at what they paid.
 */
export function SubscriptionPricingCard() {
  const {data, mutate, error} = useSWR('ops-subscription-prices', () => opsDataApi.subscriptionPrices());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyTier, setBusyTier] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function save(tier: 'pro' | 'enterprise') {
    const raw = drafts[tier];
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000_000) {
      setErr('Price must be a whole number of BC between 1 and 1,000,000.');
      return;
    }
    // OC-03 — confirm with from→to before repricing every future renewal.
    const current = (data?.prices ?? []).find(p => p.tier === tier)?.price_bc;
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Change the ${tier} subscription price from ${current ?? '?'} BC to ${parsed} BC? Applies to every subscribe and renewal from now on.`)) return;
    setBusyTier(tier); setErr(null);
    try {
      await opsDataApi.setSubscriptionPrice(tier, parsed);
      setDrafts(d => ({...d, [tier]: ''}));
      await mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Price update failed');
    } finally {
      setBusyTier(null);
    }
  }

  const label: Record<string, string> = {pro: 'Messenger Pro', enterprise: 'Enterprise'};

  return (
    <div className="card" style={{padding:24, marginTop:16, overflow:'auto'}}>
      <div style={{fontFamily:'var(--font-sans)',fontSize:15,fontWeight:700,marginBottom:4}}>
        Messenger subscription pricing
      </div>
      <div style={{fontFamily:'var(--font-mono)',fontSize:10,color:'var(--tx-3)',marginBottom:20,letterSpacing:0.5}}>
        Charged at charge time — a change applies to every new subscribe and every renewal
        from now on; periods already paid finish at the old price. SUPERVISOR/ADMIN only.
      </div>
      {error && <div style={{fontSize:12,color:'#FF3B3B',marginBottom:12}}>Could not load prices.</div>}
      {(data?.prices ?? []).map(p => (
        <div key={p.tier} style={{
          display:'grid', gridTemplateColumns:'220px 140px 160px 1fr', gap:16,
          padding:'12px 0', borderBottom:'1px solid var(--bd-2)', alignItems:'center',
        }}>
          <div style={{fontFamily:'var(--font-mono)',fontSize:9.5,color:'var(--tx-3)',letterSpacing:1.2,textTransform:'uppercase',fontWeight:700}}>
            {label[p.tier] ?? p.tier} / 30 days
          </div>
          <div style={{fontSize:12.5,color:'var(--tx-1)',fontFamily:'var(--font-sans)',fontWeight:700}}>
            {p.price_bc.toLocaleString()} BC
          </div>
          <input
            value={drafts[p.tier] ?? ''}
            onChange={e => setDrafts(d => ({...d, [p.tier]: e.target.value}))}
            placeholder="new price (BC)"
            style={{
              background:'transparent', border:'1px solid var(--bd-2)', borderRadius:6,
              padding:'6px 10px', fontSize:12, color:'var(--tx-1)', fontFamily:'var(--font-mono)',
            }}
          />
          <div>
            <button
              onClick={() => { void save(p.tier); }}
              disabled={busyTier === p.tier || !(drafts[p.tier] ?? '').trim()}
              style={{
                border:'1px solid rgba(30,136,255,0.4)', color:'#00A3FF', background:'transparent',
                borderRadius:6, padding:'6px 14px', fontSize:11, fontWeight:700, cursor:'pointer',
                opacity: busyTier === p.tier || !(drafts[p.tier] ?? '').trim() ? 0.4 : 1,
              }}>
              {busyTier === p.tier ? 'SAVING…' : 'SAVE'}
            </button>
          </div>
        </div>
      ))}
      {err && <div style={{fontSize:12,color:'#FF3B3B',marginTop:12}}>{err}</div>}
    </div>
  );
}
