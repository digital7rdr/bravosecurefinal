'use client';

/**
 * IA-12 — ONE page header for the whole console.
 *
 * The console had two dialects: `.page-head > h2` with `.page-crumbs` on the
 * booking/pro/settings pages, and a bare `h1.text-xl.font-bold.text-t1` on the
 * Tailwind-era pages (finance, users, analytics, dispatch, admins, audit,
 * referral-codes) — different sizes, different colours, breadcrumbs on some
 * pages only. Every page renders this instead.
 *
 * Crumbs are DERIVED from the nav tree (lib/nav.tsx), so a page can never
 * disagree with the rail about which section it lives in.
 */

import type {ReactNode} from 'react';
import {usePathname} from 'next/navigation';
import Link from 'next/link';
import {NAV_GROUPS, isNavItemActive} from '@/lib/nav';

export function useSectionCrumbs(): string[] {
  const path = usePathname() ?? '';
  for (const g of NAV_GROUPS) {
    // Longest href first so `/lite/dispatch/requests` prefers "Auto-Dispatch"
    // over the section landing.
    const items = [...g.items].sort((a, b) => b.href.length - a.href.length);
    const hit = items.find(i => isNavItemActive(i, path));
    if (hit) return hit.exact ? [g.label] : [g.label, hit.label];
  }
  return [];
}

export interface PageHeaderProps {
  title: ReactNode;
  /** Overrides the derived section crumbs. Use only for detail pages that want
   *  a back-link crumb ("Lite · Bookings · BL-1234"). */
  crumbs?: string[];
  /** One sentence. What this page is for, in the operator's words. */
  subtitle?: ReactNode;
  /** Chips/pills rendered inline after the title (SOS counts, live counters). */
  badges?: ReactNode;
  /** Right-hand actions. ONE primary action per page (DESIGN_REVIEW_LOOP G8). */
  actions?: ReactNode;
  /** Renders a "← <label>" link above the title on detail pages. */
  back?: {href: string; label: string};
}

export function PageHeader({title, crumbs, subtitle, badges, actions, back}: PageHeaderProps) {
  const derived = useSectionCrumbs();
  const trail = crumbs ?? derived;

  return (
    <div className="page-head">
      <div style={{minWidth: 0}}>
        {back && (
          <Link href={back.href} className="page-back">← {back.label}</Link>
        )}
        {trail.length > 0 && (
          <div className="page-crumbs">{trail.join('  ·  ')}</div>
        )}
        <h2>
          <span style={{minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis'}}>{title}</span>
          {badges}
        </h2>
        {subtitle && <div className="page-sub">{subtitle}</div>}
      </div>
      {actions && <div className="page-head-right">{actions}</div>}
    </div>
  );
}
