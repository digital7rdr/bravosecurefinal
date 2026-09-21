'use client';

/**
 * B-819 — the console's horizontal filter tabs, as a primitive.
 *
 * `RouteTabs` covers tabs that are URLs (IA-12). Tabs that are LOCAL state —
 * a status bucket inside one page — had no primitive, so four surfaces reached
 * for `.filter-ch` instead. That class belongs to the vertical filter RAIL
 * (`BookingsList`), where `button.filter-ch { width: 100% }` is correct; laid
 * out in a horizontal wrap row it stretched every chip to the full width, so
 * the Pro applications queue rendered its nine status buckets as nine
 * full-width stacked blocks that filled the viewport and pushed the actual
 * work below the fold (founder screenshot, 2026-09-07). Same defect in Pro
 * Management's assignments and the proposal builder's service picker.
 *
 * This renders the same visual language as `RouteTabs` (`.rtabs` / `.rtab`),
 * so a bucket tab and a route tab look identical wherever an operator meets
 * them.
 *
 * A11y: a `role="group"` of `aria-pressed` toggle buttons, NOT `role="tablist"`
 * — a real tablist owes arrow-key roving focus and a linked `tabpanel`, and a
 * half-implemented one is worse for a screen-reader user than plain buttons.
 */

import {Fragment} from 'react';

export interface StatusTab {
  key: string;
  label: string;
  /** Live count. `0` renders muted rather than hidden — "none" and "not loaded"
   *  must not look the same on a work queue. */
  count?: number;
  /** Highlights a NON-EMPTY count as work waiting on the operator. */
  attention?: boolean;
  /** Draws a divider before this tab (groups: actionable · pipeline · closed). */
  startsGroup?: boolean;
  /** Tooltip — the status registry's own hint, where there is one. */
  hint?: string;
}

export function StatusTabs({
  tabs, value, onChange, ariaLabel,
}: {
  tabs: StatusTab[];
  value: string;
  onChange: (key: string) => void;
  ariaLabel: string;
}) {
  return (
    <div className="rtabs" role="group" aria-label={ariaLabel}>
      {tabs.map((t, i) => {
        const active = t.key === value;
        const badge = typeof t.count === 'number' ? (
          <span className={`rtab-cnt${t.count === 0 ? ' zero' : t.attention ? ' warn' : ''}`}>
            {t.count > 99 ? '99+' : t.count}
          </span>
        ) : null;
        return (
          // A Fragment, not a wrapper element: every button must be a DIRECT
          // flex child of `.rtabs` or the row's wrap and gap stop working.
          <Fragment key={t.key}>
            {t.startsGroup && i > 0 && <span className="rtab-sep" aria-hidden="true" />}
            <button
              type="button"
              className={`rtab ${active ? 'on' : ''}`}
              aria-pressed={active}
              title={t.hint}
              onClick={() => onChange(t.key)}>
              {t.label}
              {badge}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
