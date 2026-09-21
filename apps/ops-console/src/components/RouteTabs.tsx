'use client';

/**
 * IA-12 — tabs are ROUTES, not local state.
 *
 * /finance and /pro-management kept their tab in `useState`, so an operator
 * could not link a colleague to "the escrow tab", the browser Back button
 * escaped the page instead of the tab, and a refresh always landed on tab one.
 * Every tab surface in the console is a sibling route segment rendered through
 * this component.
 */

import Link from 'next/link';
import {usePathname} from 'next/navigation';

export interface RouteTab {
  href: string;
  label: string;
  /** Small count on the right of the label (pending work). */
  count?: number;
  /** Match this tab for any deeper path (a tab that owns a detail route). */
  prefix?: boolean;
}

export function RouteTabs({tabs, ariaLabel}: {tabs: RouteTab[]; ariaLabel: string}) {
  const path = usePathname() ?? '';
  return (
    <nav className="rtabs" aria-label={ariaLabel}>
      {tabs.map(t => {
        const active = t.prefix
          ? path === t.href || path.startsWith(t.href + '/')
          : path === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`rtab ${active ? 'on' : ''}`}
            aria-current={active ? 'page' : undefined}>
            {t.label}
            {typeof t.count === 'number' && t.count > 0 && (
              <span className="rtab-cnt">{t.count > 99 ? '99+' : t.count}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
