'use client';

/**
 * Public referral-link landing (2026-09-05): what a shared code opens on a
 * phone that has no ops session and usually no app yet.
 *
 * Outside the (console) route group on purpose — no Shell, no rail, no
 * session gate (lib/publicRoutes.ts lists /r). Shows only what the public
 * resolve reveals: the campaign's name, discount and region. Then two doors:
 * open the app with the code (custom scheme) or install it; and the code
 * itself, to type on the booking's Team & Add-ons step.
 */

import {use, useEffect, useState} from 'react';
import {opsApi, type PublicReferral} from '@/lib/api';
import {normaliseReferralCode, playStoreLink, referralAppLink} from '@/lib/referralLinks';

export default function ReferralLanding({params}: {params: Promise<{code: string}>}) {
  const {code: raw} = use(params);
  const code = normaliseReferralCode(decodeURIComponent(raw));
  const [state, setState] = useState<{loading: boolean; data: PublicReferral | null; error: boolean}>({loading: true, data: null, error: false});
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    setState({loading: true, data: null, error: false});
    opsApi.publicReferral(code)
      .then(d => { if (alive) setState({loading: false, data: d, error: false}); })
      .catch(() => { if (alive) setState({loading: false, data: null, error: true}); });
    return () => { alive = false; };
  }, [code]);

  async function copy() {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard denied — the code is on screen */ }
  }

  const valid = state.data?.valid === true ? state.data : null;

  return (
    <main style={{
      minHeight: '100dvh', background: 'var(--surf-3, #122747)', color: 'var(--tx-1, #FFFFFF)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      fontFamily: 'var(--font-sans)',
    }}>
      <section style={{
        width: '100%', maxWidth: 420, background: 'var(--surf-2, #162F54)', border: '1px solid var(--bd-2, #1C3B66)',
        borderRadius: 16, padding: 24, display: 'grid', gap: 16,
      }}>
        <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
          <span aria-hidden="true" style={{width: 10, height: 10, borderRadius: 3, background: 'var(--act, #1E88FF)', boxShadow: '0 0 8px var(--act, #1E88FF)'}} />
          <span style={{fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: 1.6, textTransform: 'uppercase', color: 'var(--tx-3, #7E8AA6)'}}>
            Bravo Secure · Referral
          </span>
        </div>

        {state.loading && <p style={{color: 'var(--tx-3, #7E8AA6)', margin: 0}}>Checking your code…</p>}

        {!state.loading && !valid && (
          <>
            <h1 style={{margin: 0, fontSize: 20}}>This link is not active</h1>
            <p style={{margin: 0, color: 'var(--tx-3, #7E8AA6)', lineHeight: 1.5}}>
              {state.error
                ? 'We could not check the code right now. Try again in a moment.'
                : 'The referral code has expired, was withdrawn, or never existed. You can still book at the standard rate.'}
            </p>
          </>
        )}

        {valid && (
          <>
            <h1 style={{margin: 0, fontSize: 22, lineHeight: 1.25}}>{valid.label} your next booking</h1>
            <p style={{margin: 0, color: 'var(--tx-2, #B8C7E0)', lineHeight: 1.5}}>
              {valid.name}. {valid.scope === 'region' && valid.region_code ? `Valid for bookings in ${valid.region_code}.` : 'Valid in every region.'}
              {valid.expires_at ? ` Until ${new Date(valid.expires_at).toLocaleDateString('en-GB', {day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC'})}.` : ''}
            </p>

            <div style={{
              border: '1px dashed var(--bd-1, #244C82)', borderRadius: 12, padding: '14px 16px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            }}>
              <div>
                <div style={{fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 1.4, color: 'var(--tx-3, #7E8AA6)', textTransform: 'uppercase'}}>Your code</div>
                <div style={{fontFamily: 'var(--font-mono)', fontSize: 24, fontWeight: 700, letterSpacing: 2}}>{valid.code}</div>
              </div>
              <button type="button" onClick={() => void copy()} style={btnGhost} aria-label="Copy code">
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>

            <a href={referralAppLink(valid.code)} style={btnPrimary}>Open in Bravo Secure</a>
            <a href={playStoreLink()} style={btnGhost} rel="noreferrer">Get the app</a>

            <p style={{margin: 0, fontSize: 12, color: 'var(--tx-3, #7E8AA6)', lineHeight: 1.5}}>
              No app on this phone? Install it, then enter the code on the Team &amp; Add-ons step when you book.
              The discount is shown before you confirm.
            </p>
          </>
        )}
      </section>
    </main>
  );
}

const btnPrimary: React.CSSProperties = {
  display: 'block', textAlign: 'center', textDecoration: 'none', padding: '12px 16px', borderRadius: 10,
  background: 'var(--act, #1E88FF)', color: '#fff', fontWeight: 700, fontSize: 14,
};
const btnGhost: React.CSSProperties = {
  display: 'block', textAlign: 'center', textDecoration: 'none', padding: '10px 14px', borderRadius: 10,
  border: '1px solid var(--bd-1, #244C82)', background: 'transparent', color: 'var(--tx-1, #FFFFFF)',
  fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
};
