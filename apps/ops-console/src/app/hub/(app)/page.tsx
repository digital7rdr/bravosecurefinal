'use client';

/**
 * Bravo Secure home: one tile per app. An open tile signs the person in to
 * that app (single sign-on); the server decides every tile's state from the
 * apps a Super Admin activated and the kinds of account allowed to use them.
 */
import {useRouter} from 'next/navigation';
import {useState} from 'react';
import {useHub} from '@/components/hub/HubShell';
import {AppIcon} from '@/components/hub/AppIcon';
import {hubApi, ApiError, type AppTile} from '@/lib/hub/api';
import {hubRoutes} from '@/lib/hub/routes';

const BADGE: Record<Exclude<AppTile['state'], 'open'>, string> = {
  inactive: 'Inactive',
  not_allowed: 'No access',
  needs_totp: 'Needs authenticator',
};

export default function HubHome() {
  const {data, reload} = useHub();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function open(t: AppTile) {
    if (busy) return;
    if (t.state === 'needs_totp') { router.push(`${hubRoutes.security}?for=${encodeURIComponent(t.name)}`); return; }
    if (t.state !== 'open') return;
    setBusy(t.key); setErr(null);
    try {
      const {redirect} = await hubApi.launch(t.key);
      window.location.assign(redirect);
    } catch (e) {
      setBusy(null);
      setErr(e instanceof ApiError && e.status === 403
        ? `${t.name} is not available for your account right now.`
        : `${t.name} could not be opened. Try again.`);
      void reload();
    }
  }

  return (
    <div className="hub-home">
      <section className="hub-hero">
        <h1 className="hub-title">Welcome</h1>
        <div className="hub-kicker">YOUR SECURITY ECOSYSTEM</div>
        <div className="hub-pillars">PEOPLE <span>|</span> INFORMATION <span>|</span> OPERATIONS <span>|</span> ANYWHERE</div>
      </section>
      {err && <div className="hub-err" role="alert">{err}</div>}
      <div className="hub-grid">
        {data.apps.map(t => {
          const live = t.state === 'open' || t.state === 'needs_totp';
          return (
            <button key={t.key} type="button"
              className={`hub-tile hub-tile-${t.state} ${busy === t.key ? 'hub-tile-busy' : ''}`}
              disabled={!live || (busy !== null && busy !== t.key)}
              aria-disabled={!live}
              title={t.state === 'open' ? `Open ${t.name}` : `${t.name}: ${BADGE[t.state].toLowerCase()}`}
              onClick={() => void open(t)}>
              <span className="hub-tile-icon"><AppIcon name={t.icon}/></span>
              <span className="hub-tile-name">{t.name}</span>
              <span className="hub-tile-tag">{t.tagline}</span>
              {t.state !== 'open' && <span className="hub-tile-badge">{BADGE[t.state]}</span>}
              {busy === t.key && <span className="hub-tile-badge hub-tile-opening">Opening…</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
