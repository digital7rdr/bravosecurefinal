'use client';

/**
 * Pick a point: type an address (Mapbox search) or click the map. The chosen
 * point is shown as a pin and its address filled in by reverse lookup. The
 * position never leaves the browser except to Mapbox for the lookup and, once
 * the booking is sent, to Bravo Secure.
 */
import {useEffect, useState} from 'react';
import {BravoMap} from '@/components/BravoMapLazy';
import type {Place} from '@/lib/web/api';

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';

interface Hit {label: string; lng: number; lat: number}

async function forward(q: string, near?: [number, number]): Promise<Hit[]> {
  if (!TOKEN || q.trim().length < 3) return [];
  const prox = near ? `&proximity=${near[0]},${near[1]}` : '';
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q.trim())}.json?access_token=${TOKEN}&limit=5${prox}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const j = (await res.json()) as {features?: Array<{place_name: string; center: [number, number]}>};
  return (j.features ?? []).map(f => ({label: f.place_name, lng: f.center[0], lat: f.center[1]}));
}

async function reverse(lng: number, lat: number): Promise<string | null> {
  if (!TOKEN) return null;
  try {
    const res = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${TOKEN}&limit=1`);
    if (!res.ok) return null;
    const j = (await res.json()) as {features?: Array<{place_name: string}>};
    return j.features?.[0]?.place_name ?? null;
  } catch { return null; }
}

const fmt = (p: Place) => p.address || `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`;

export function PlacePicker({label, value, onChange, pinType = 'pickup', near}: {
  label: string;
  value: Place | null;
  onChange: (p: Place | null) => void;
  pinType?: 'pickup' | 'dropoff';
  /** [lng, lat] to start the map at and bias the search toward. */
  near?: [number, number];
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (q.trim().length < 3) { setHits([]); return; }
    let live = true;
    const t = setTimeout(() => { void forward(q, near).then(h => { if (live) setHits(h); }); }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [q, near]);

  const pick = async (lng: number, lat: number, address?: string) => {
    onChange({latitude: lat, longitude: lng, ...(address ? {address} : {})});
    setOpen(false); setQ('');
    if (!address) {
      const a = await reverse(lng, lat);
      if (a) onChange({latitude: lat, longitude: lng, address: a});
    }
  };

  const center: [number, number] | undefined = value ? [value.longitude, value.latitude] : near;

  return (
    <div className="web-place">
      <label className="pv-field">
        <span className="pv-label">{label}</span>
        <div className="web-place-search">
          <input className="pv-input" value={q} placeholder={value ? fmt(value) : 'Search an address, or click the map'}
            onChange={e => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
            aria-label={`${label}: search an address`}/>
          {open && hits.length > 0 && (
            <div className="web-place-hits" role="listbox">
              {hits.map(h => (
                <button key={`${h.lng},${h.lat}`} type="button" className="web-place-hit" onClick={() => void pick(h.lng, h.lat, h.label)}>
                  {h.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </label>
      {value && <div className="pv-cell-sub web-place-chosen">📍 {fmt(value)}</div>}
      <div className="pv-map web-place-map">
        <BravoMap center={center} zoom={value ? 14 : 11}
          markers={value ? [{id: pinType, lat: value.latitude, lng: value.longitude, type: pinType, label}] : []}
          onPick={(lng, lat) => void pick(lng, lat)}/>
      </div>
    </div>
  );
}
