'use client';

/** App Configuration — package card copy (IA-07). Extracted verbatim. */

import {useState} from 'react';
import useSWR from 'swr';
import {ApiError, opsDataApi} from '@/lib/api';

/**
 * Founder 2026-08-26 — the package cards' display copy (name + description),
 * ops-editable per package. The apps ship the same copy compiled-in as a
 * fail-open fallback, so an edit here is cosmetic-safe: it can rename a card,
 * never blank one.
 */
export function PackageCatalogCard() {
  const {data, mutate, error} = useSWR('ops-subscription-catalog', () => opsDataApi.subscriptionCatalog());
  const [drafts, setDrafts] = useState<Record<string, {name?: string; desc?: string}>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function save(key: string) {
    const d = drafts[key] ?? {};
    const display_name = d.name?.trim();
    const description = d.desc?.trim();
    if (!display_name && !description) {return;}
    if (display_name !== undefined && display_name !== '' && display_name.length > 60) {
      setErr('Name must be 1-60 characters.'); return;
    }
    if (description !== undefined && description.length > 500) {
      setErr('Description must be 500 characters or fewer.'); return;
    }
    // OC-03 — customer-facing copy; a stray paste shouldn't ship silently.
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Update the ${key.replace(/_/g, ' ')} card${display_name ? ` name to "${display_name}"` : ''}${display_name && description ? ' and' : ''}${description ? ' description' : ''}? Live on the apps' next catalog fetch.`)) return;
    setBusyKey(key); setErr(null);
    try {
      await opsDataApi.setSubscriptionCatalogEntry({
        key,
        ...(display_name ? {display_name} : {}),
        ...(description ? {description} : {}),
      });
      setDrafts(ds => ({...ds, [key]: {}}));
      await mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Catalog update failed');
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="card" style={{padding:24, marginTop:16, overflow:'auto'}}>
      <div style={{fontFamily:'var(--font-sans)',fontSize:15,fontWeight:700,marginBottom:4}}>
        Package catalog — names &amp; descriptions
      </div>
      <div style={{fontFamily:'var(--font-mono)',fontSize:10,color:'var(--tx-3)',marginBottom:20,letterSpacing:0.5}}>
        Edits apply on the apps&apos; next catalog fetch. Prices are edited in the pricing
        card above (one charge-time source). SUPERVISOR/ADMIN only.
      </div>
      {error && <div style={{fontSize:12,color:'#FF3B3B',marginBottom:12}}>Could not load the catalog.</div>}
      {err && <div style={{fontSize:12,color:'#FF3B3B',marginBottom:12}}>{err}</div>}
      {(data?.catalog ?? []).map(p => {
        const d = drafts[p.key] ?? {};
        const dirty = !!(d.name?.trim() || d.desc?.trim());
        return (
          <div key={p.key} style={{
            display:'grid', gridTemplateColumns:'180px 1fr 120px', gap:16,
            padding:'14px 0', borderBottom:'1px solid var(--bd-2)', alignItems:'start',
          }}>
            <div>
              <div style={{fontFamily:'var(--font-mono)',fontSize:9.5,color:'var(--tx-3)',letterSpacing:1.2,textTransform:'uppercase',fontWeight:700}}>
                {p.key.replace(/_/g, ' ')}
              </div>
              <div style={{fontSize:12.5,color:'var(--tx-1)',fontFamily:'var(--font-sans)',fontWeight:700,marginTop:6}}>
                {p.display_name}
              </div>
              <div style={{fontSize:11,color:'var(--tx-3)',marginTop:4,lineHeight:1.5}}>
                {p.description}
              </div>
            </div>
            <div style={{display:'grid', gap:8}}>
              <input
                value={d.name ?? ''}
                onChange={e => setDrafts(ds => ({...ds, [p.key]: {...ds[p.key], name: e.target.value}}))}
                placeholder="new name"
                maxLength={60}
                style={{
                  background:'transparent', border:'1px solid var(--bd-2)', borderRadius:6,
                  padding:'6px 10px', fontSize:12, color:'var(--tx-1)', fontFamily:'var(--font-sans)',
                }}
              />
              <textarea
                value={d.desc ?? ''}
                onChange={e => setDrafts(ds => ({...ds, [p.key]: {...ds[p.key], desc: e.target.value}}))}
                placeholder="new description"
                maxLength={500}
                rows={2}
                style={{
                  background:'transparent', border:'1px solid var(--bd-2)', borderRadius:6,
                  padding:'6px 10px', fontSize:12, color:'var(--tx-1)', fontFamily:'var(--font-sans)', resize:'vertical',
                }}
              />
            </div>
            <div>
              <button
                onClick={() => { void save(p.key); }}
                disabled={busyKey === p.key || !dirty}
                style={{
                  border:'1px solid rgba(91,141,239,0.4)', color:'#00A3FF', background:'transparent',
                  borderRadius:6, padding:'6px 14px', fontSize:11, fontWeight:700, cursor:'pointer',
                  opacity: busyKey === p.key || !dirty ? 0.4 : 1,
                }}>
                {busyKey === p.key ? 'SAVING…' : 'SAVE'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
