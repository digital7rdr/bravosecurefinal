'use client';

/**
 * App Configuration — Regions (IA-07). Extracted verbatim from the old
 * "Console Settings" page; the editor is unchanged, only its address is.
 */

import {useState} from 'react';
import useSWR from 'swr';
import {ApiError, opsDataApi} from '@/lib/api';

/**
 * Client 2026-09-01 - "we need to be able to add regions as we get service
 * providers."
 *
 * Regions were a compiled TypeScript array, so a provider in a new country meant
 * a code change and a deploy. They are rows now.
 *
 * The BOUNDING BOX is not decoration. A booking's pricing region is derived from
 * its pickup coordinates, because `region` on the booking request comes from the
 * client and pricing on it would let a customer name the cheapest region. A
 * region with no box simply never resolves - it prices at global, which is the
 * safe direction.
 */
export function RegionsCard() {
  const {data, mutate, error} = useSWR('ops-regions', () => opsDataApi.regions());
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    code: '', name: '', currency: '', utc_offset_hours: '0',
    min_lat: '', max_lat: '', min_lng: '', max_lng: '',
  });

  const num = (v: string) => (v.trim() === '' ? undefined : Number(v));

  async function create() {
    const code = form.code.trim().toUpperCase();
    const currency = form.currency.trim().toUpperCase();
    if (!/^[A-Z]{2,8}$/.test(code)) { setErr('Code must be 2-8 uppercase letters.'); return; }
    if (!form.name.trim()) { setErr('Name is required.'); return; }
    if (!/^[A-Z]{3}$/.test(currency)) { setErr('Currency must be a 3-letter code, e.g. EUR.'); return; }
    const box = [form.min_lat, form.max_lat, form.min_lng, form.max_lng].map(v => v.trim());
    const given = box.filter(v => v !== '').length;
    if (given !== 0 && given !== 4) {
      setErr('Give all four bounding-box values, or none. A half box would mis-resolve pricing.');
      return;
    }
    setBusy('__new__'); setErr(null);
    try {
      await opsDataApi.createRegion({
        code, name: form.name.trim(), currency,
        utc_offset_hours: num(form.utc_offset_hours) ?? 0,
        // Deliberately NOT launched: adding a region is preparation, opening it
        // to client bookings is a separate, visible act.
        launched: false,
        min_lat: num(form.min_lat), max_lat: num(form.max_lat),
        min_lng: num(form.min_lng), max_lng: num(form.max_lng),
      });
      setForm({code:'', name:'', currency:'', utc_offset_hours:'0', min_lat:'', max_lat:'', min_lng:'', max_lng:''});
      setAdding(false);
      await mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not add region');
    } finally { setBusy(null); }
  }

  async function toggleLaunched(r: {code: string; name: string; launched: boolean}) {
    const opening = !r.launched;
    // eslint-disable-next-line no-alert
    if (!window.confirm(opening
      ? `Open ${r.name} to client bookings?`
      : `Close ${r.name} to NEW bookings? Existing bookings and history are untouched.`)) return;
    setBusy(r.code); setErr(null);
    try {
      if (opening) { await opsDataApi.updateRegion(r.code, {launched: true}); }
      else { await opsDataApi.closeRegion(r.code); }
      await mutate();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not update region');
    } finally { setBusy(null); }
  }

  const rows = data?.regions ?? [];
  const seeded = rows.some(r => r.seeded);

  return (
    <div className="card" style={{padding:24, marginTop:16, overflow:'auto'}}>
      <div style={{fontFamily:'var(--font-sans)',fontSize:15,fontWeight:700,marginBottom:4}}>
        Regions
      </div>
      <div style={{fontFamily:'var(--font-mono)',fontSize:10,color:'var(--tx-3)',marginBottom:18,letterSpacing:0.5}}>
        Where Bravo Secure dispatches. Add one as providers come on board - no deploy needed.
        A region is created CLOSED; open it when you have supply. SUPERVISOR/ADMIN only.
      </div>

      {seeded && (
        <div style={{fontSize:11,color:'#FBBF24',marginBottom:12,fontFamily:'var(--font-mono)'}}>
          Showing built-in defaults - the regions migration has not run on this environment yet.
          Adding a region here will create the table rows.
        </div>
      )}
      {error && <div style={{fontSize:12,color:'#FF3B3B',marginBottom:12}}>Could not load regions.</div>}
      {err && <div style={{fontSize:12,color:'#FF3B3B',marginBottom:12}}>{err}</div>}

      {rows.map(r => (
        <div key={r.code} style={{
          display:'grid', gridTemplateColumns:'70px minmax(200px,1fr) 70px 70px 1fr 110px',
          gap:14, padding:'11px 0', borderBottom:'1px solid var(--bd-2)', alignItems:'center',
        }}>
          <div style={{fontFamily:'var(--font-mono)',fontSize:12,fontWeight:700,color:'var(--tx-1)'}}>{r.code}</div>
          <div style={{fontSize:12,color:'var(--tx-1)',fontFamily:'var(--font-sans)'}}>{r.name}</div>
          <div style={{fontFamily:'var(--font-mono)',fontSize:11,color:'var(--tx-3)'}}>{r.currency}</div>
          <div style={{fontFamily:'var(--font-mono)',fontSize:11,color:'var(--tx-3)'}}>
            UTC{Number(r.utc_offset_hours) >= 0 ? '+' : ''}{r.utc_offset_hours}
          </div>
          <div style={{fontFamily:'var(--font-mono)',fontSize:9.5,color: r.min_lat === null ? '#FBBF24' : 'var(--tx-3)'}}>
            {r.min_lat === null
              ? 'no box - prices at global'
              : `box ${r.min_lat},${r.min_lng} to ${r.max_lat},${r.max_lng}`}
          </div>
          <button
            onClick={() => { void toggleLaunched(r); }}
            disabled={busy === r.code}
            style={{
              border:`1px solid ${r.launched ? 'rgba(52,211,153,0.4)' : 'var(--bd-2)'}`,
              color: r.launched ? '#34d399' : 'var(--tx-3)',
              background:'transparent', borderRadius:6, padding:'6px 10px',
              fontSize:10, fontWeight:700, cursor:'pointer', letterSpacing:0.5,
            }}>
            {busy === r.code ? '...' : r.launched ? 'LIVE - CLOSE' : 'CLOSED - OPEN'}
          </button>
        </div>
      ))}

      {!adding ? (
        <button
          onClick={() => { setAdding(true); setErr(null); }}
          style={{
            marginTop:16, border:'1px solid rgba(91,141,239,0.4)', color:'#00A3FF',
            background:'transparent', borderRadius:6, padding:'8px 16px',
            fontSize:11, fontWeight:700, cursor:'pointer', letterSpacing:0.5,
          }}>
          + ADD REGION
        </button>
      ) : (
        <div style={{marginTop:18, padding:16, border:'1px solid var(--bd-2)', borderRadius:8}}>
          <div style={{display:'grid',gridTemplateColumns:'repeat(4, minmax(120px,1fr))',gap:12}}>
            {([
              ['code', 'CODE (e.g. FR)'], ['name', 'NAME'], ['currency', 'CURRENCY (EUR)'],
              ['utc_offset_hours', 'UTC OFFSET'],
              ['min_lat', 'MIN LAT'], ['max_lat', 'MAX LAT'],
              ['min_lng', 'MIN LNG'], ['max_lng', 'MAX LNG'],
            ] as Array<[keyof typeof form, string]>).map(([field, label]) => (
              <label key={field} style={{display:'flex',flexDirection:'column',gap:4}}>
                <span style={{fontFamily:'var(--font-mono)',fontSize:9,color:'var(--tx-3)',letterSpacing:0.8}}>
                  {label}
                </span>
                <input
                  value={form[field]}
                  onChange={e => setForm(f => ({...f, [field]: e.target.value}))}
                  style={{
                    background:'transparent', border:'1px solid var(--bd-2)', borderRadius:6,
                    padding:'6px 10px', fontSize:12, color:'var(--tx-1)', fontFamily:'var(--font-mono)',
                  }}
                />
              </label>
            ))}
          </div>
          <div style={{fontFamily:'var(--font-mono)',fontSize:9.5,color:'var(--tx-3)',marginTop:12,lineHeight:1.6}}>
            The bounding box decides which bookings PRICE in this region, from their pickup
            coordinates. Leave all four blank and the region still dispatches - it just prices at
            the global rate. All four or none.
          </div>
          <div style={{display:'flex',gap:10,marginTop:14}}>
            <button
              onClick={() => { void create(); }}
              disabled={busy === '__new__'}
              style={{
                border:'1px solid rgba(91,141,239,0.4)', color:'#00A3FF', background:'transparent',
                borderRadius:6, padding:'7px 16px', fontSize:11, fontWeight:700, cursor:'pointer',
              }}>
              {busy === '__new__' ? 'ADDING...' : 'ADD'}
            </button>
            <button
              onClick={() => { setAdding(false); setErr(null); }}
              style={{
                border:'1px solid var(--bd-2)', color:'var(--tx-3)', background:'transparent',
                borderRadius:6, padding:'7px 16px', fontSize:11, fontWeight:700, cursor:'pointer',
              }}>
              CANCEL
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
