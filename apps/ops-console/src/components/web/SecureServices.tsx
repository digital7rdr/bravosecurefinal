'use client';

/**
 * Secure Services on the Bravo Web App (owner 2026-10-30: "when i click
 * secure services it lands on messenger" → "this should be in upgrade option
 * for lite user, pro and enterprise should have option 1").
 *
 * Book, My bookings and Secure Pro are back for Bravo Messenger Pro and
 * Enterprise clients. They are opened from the home site's Secure Services
 * tile and are NOT in the messenger rail (Chats, Contacts, Groups, Account);
 * these tabs move between them.
 *
 * On the free plan, the pages that START something (Book, Secure Pro) show
 * the upgrade instead; My bookings stays open so earlier bookings can still be
 * followed and paid. The server is the gate either way (403 tier_insufficient).
 */
import Link from 'next/link';
import {usePathname} from 'next/navigation';
import type {ReactNode} from 'react';
import {useWeb} from '@/components/web/WebShell';
import {PvPage} from '@/components/provider/ui';
import {secureServicesAccess} from '@/lib/web/access';
import {webNavActive} from '@/lib/web/nav';
import {webRoutes} from '@/lib/web/routes';

/** Same words as the home site's Upgrade tile. */
export const SECURE_SERVICES_UPGRADE_TEXT =
  'Secure Services is included with Bravo Messenger Pro and Enterprise. Upgrade in the Bravo Secure app: Profile → Messenger Plans.';

const TABS: Array<{href: string; label: string}> = [
  {href: webRoutes.book, label: 'Book'},
  {href: webRoutes.bookings, label: 'My bookings'},
  {href: webRoutes.pro, label: 'Secure Pro'},
];

export function SecureServicesTabs() {
  const path = usePathname() ?? '';
  // The internal /web prefix never shows in the browser, but be safe in dev.
  const here = path.replace(/^\/web(?=\/|$)/, '') || '/';
  return (
    <nav className="web-ss-tabs" aria-label="Secure Services">
      {TABS.map(t => (
        <Link key={t.href} href={t.href} className={`pv-tab${webNavActive(t.href, here) ? ' on' : ''}`}>{t.label}</Link>
      ))}
    </nav>
  );
}

/** A Secure Services page opened by an officer, a provider or an agency manager. */
export function ClientsOnly() {
  return (
    <div className="card" style={{padding: 28, maxWidth: 560}}>
      <h2 style={{margin: '0 0 8px', fontSize: 18}}>Secure Services is for client accounts</h2>
      <p className="text-sm text-t3" style={{margin: 0, lineHeight: 1.6}}>
        This account belongs to an officer or a service provider, so it uses Bravo Secure for
        messaging only. Book protection with a personal client account.
      </p>
    </div>
  );
}

/** A free-plan client on a page that starts a booking or a Secure Pro plan. */
export function SecureServicesUpgrade() {
  return (
    <div className="card" style={{padding: 28, maxWidth: 620}}>
      <h2 style={{margin: '0 0 8px', fontSize: 18}}>Upgrade to use Secure Services</h2>
      <p className="text-sm text-t3" style={{margin: '0 0 16px', lineHeight: 1.6}}>{SECURE_SERVICES_UPGRADE_TEXT}</p>
      <p className="text-sm text-t3" style={{margin: '0 0 16px', lineHeight: 1.6}}>
        Once your plan is upgraded, come back here (or tap Secure Services on the home site) to book.
        Bookings you already made are under My bookings.
      </p>
      <Link className="btn btn-ghost" href={webRoutes.bookings}>My bookings</Link>
    </div>
  );
}

/**
 * Wraps a Secure Services page: the tabs, then the page, or the reason it is
 * not available. `startsService` — the page starts something new.
 */
export function SecureServicesGate({title, startsService, children}: {
  title: string; startsService: boolean; children: ReactNode;
}) {
  const {me} = useWeb();
  const access = secureServicesAccess(me, startsService);
  if (access === 'not_client') return <PvPage title={title}><ClientsOnly/></PvPage>;
  return (
    <>
      <SecureServicesTabs/>
      {access === 'upgrade' ? <PvPage title={title}><SecureServicesUpgrade/></PvPage> : children}
    </>
  );
}
