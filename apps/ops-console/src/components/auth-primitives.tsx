'use client';

import {useId, useState, type InputHTMLAttributes, type CSSProperties, type ReactNode} from 'react';

const col = (gap: number) => ({display:'flex' as const,flexDirection:'column' as const,gap});

/**
 * Pre-auth screens (sign-in, authenticator set-up, admin invite).
 *
 * Desktop: a brand panel on the left and the form on the right. Below 960px
 * the brand panel is dropped and the logo sits above the form. Styles live
 * in globals.css under "Sign-in screens" because the layout switch needs a
 * media query.
 *
 * The logo is public/bravo-logo-light.svg, the ORIGINAL artwork from
 * bravo-secure.com (white + #0084FE), in the variant made for dark surfaces.
 * It is on the PUBLIC_ASSETS allowlist so it renders before sign-in, and the
 * Dockerfile copies public/ into the image so the server can serve it.
 */
export interface AuthBrand {
  kicker: string;
  headline: string;
  lede: string;
  points: string[];
  foot: string;
}

/** The HQ ops console's brand panel (the default). */
export const OPS_BRAND: AuthBrand = {
  kicker: 'Ops Console',
  headline: 'Operations Command Center',
  lede: 'Dispatch, protection details and incident response for Bravo Secure, in one console.',
  points: [
    'Live missions, SOS alerts and field teams',
    'Two-step verification on every operator account',
    'Encrypted operator messaging',
  ],
  foot: 'Authorised personnel only. Sign-ins and console activity are logged.',
};

export function AuthLayout({subtitle, description, wide, brand = OPS_BRAND, children}: {
  subtitle: string;
  description?: ReactNode;
  wide?: boolean;
  brand?: AuthBrand;
  children: ReactNode;
}) {
  return (
    <div className="auth-page">
      <aside className="auth-brand" aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element -- static SVG logo; next/image adds nothing */}
        <img src="/bravo-logo-light.svg" alt="" width={132} height={95} className="auth-logo"/>
        <div>
          <div className="auth-kicker">{brand.kicker}</div>
          <h1 className="auth-headline">{brand.headline}</h1>
          <p className="auth-lede">{brand.lede}</p>
          <ul className="auth-points">
            {brand.points.map(p => <li key={p}><CheckIcon/>{p}</li>)}
          </ul>
        </div>
        <div className="auth-legal">© {new Date().getFullYear()} Bravo Secure</div>
      </aside>

      <main className="auth-main">
        <div className={wide ? 'auth-card auth-card-wide' : 'auth-card'}>
          {/* eslint-disable-next-line @next/next/no-img-element -- static SVG logo; next/image adds nothing */}
          <img src="/bravo-logo-light.svg" alt="Bravo Secure" width={132} height={95} className="auth-mobile-logo"/>
          <h2 className="auth-title">{subtitle}</h2>
          {description ? <p className="auth-desc">{description}</p> : <div style={{height:24}}/>}
          {children}
          <div className="auth-foot">
            <ShieldIcon/>
            <span>{brand.foot}</span>
          </div>
        </div>
      </main>
    </div>
  );
}

export function Field({
  label, hint, value, onChange, type, className, ...rest
}: {label: string; hint?: string; value: string; onChange: (v: string) => void}
  & Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'>) {
  const id = useId();
  const [show, setShow] = useState(false);
  const isPassword = type === 'password';
  return (
    <div style={col(7)}>
      <label htmlFor={id} className="auth-label">{label}</label>
      <div className="auth-input-wrap">
        <input
          {...rest}
          id={id}
          type={isPassword && show ? 'text' : type}
          value={value}
          onChange={e => onChange(e.target.value)}
          className={['auth-input', isPassword ? 'auth-input-pw' : '', className ?? ''].filter(Boolean).join(' ')}
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
        {isPassword && (
          <button type="button" className="auth-reveal" onClick={() => setShow(s => !s)}
            aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
            {show ? <EyeOffIcon/> : <EyeIcon/>}
          </button>
        )}
      </div>
      {hint && <span id={`${id}-hint`} className="auth-hint">{hint}</span>}
    </div>
  );
}

export function Select({
  label, value, onChange, options,
}: {label: string; value: string; onChange: (v: string) => void; options: string[]}) {
  const id = useId();
  return (
    <div style={col(7)}>
      <label htmlFor={id} className="auth-label">{label}</label>
      <select id={id} value={value} onChange={e => onChange(e.target.value)} className="auth-input">
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

export function Note({children}: {children: ReactNode}) {
  return <div className="auth-note">{children}</div>;
}

export function Err({msg}: {msg: string}) {
  return (
    <div role="alert" className="auth-err">
      <AlertIcon/>
      <span>{msg}</span>
    </div>
  );
}

export const authCol = col;
export const authHint: CSSProperties = {fontSize:12,color:'var(--tx-3)',textAlign:'center',marginTop:4};

/* ── Icons (inline, stroke = currentColor) ─────────────────────────── */
const ic = {width:16,height:16,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:2,
  strokeLinecap:'round' as const,strokeLinejoin:'round' as const,'aria-hidden':true};
function CheckIcon()   { return <svg {...ic} className="auth-point-ic"><path d="M20 6 9 17l-5-5"/></svg>; }
function ShieldIcon()  { return <svg {...ic} style={{flex:'0 0 auto',marginTop:1}}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>; }
function AlertIcon()   { return <svg {...ic} style={{flex:'0 0 auto',marginTop:1}}><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>; }
function EyeIcon()     { return <svg {...ic}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>; }
function EyeOffIcon()  { return <svg {...ic}><path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-6.5 0-10-7-10-7a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19M1 1l22 22"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/></svg>; }
