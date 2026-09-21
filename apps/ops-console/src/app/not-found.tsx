import Link from 'next/link';
import {routes} from '@/lib/routes';

/** OC-05 — branded 404 instead of Next's default screen. */
export default function NotFound() {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24,
      background: 'var(--bg-0, #06142B)',
    }}>
      <div style={{fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: 2, color: 'var(--tx-3, #8A94A8)'}}>
        404 — NOT FOUND
      </div>
      <div style={{fontFamily: 'var(--font-sans)', fontSize: 15, fontWeight: 700, color: 'var(--tx-1, #E8ECF4)'}}>
        This page does not exist.
      </div>
      <Link
        href={routes.dashboard}
        style={{
          marginTop: 8, padding: '8px 18px', borderRadius: 6,
          border: '1px solid var(--bd-2, #2A3242)', color: 'var(--acc, #1E88FF)',
          fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700,
          letterSpacing: 1, textDecoration: 'none',
        }}>
        GO TO DASHBOARD →
      </Link>
    </div>
  );
}
