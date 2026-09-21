'use client';

/**
 * IA-07 — App Configuration status: the founder's "api calls to app".
 *
 * Everything the mobile apps fetch that ops can change used to be scattered
 * across a page titled "Console Settings" (whose first card was read-only
 * console trivia), a card on a user's detail page, and the dispatch monitor.
 * Nothing anywhere said what the apps actually read, how long a change takes to
 * land, or which values ops cannot change at all — so "I changed the price, why
 * is the app still showing the old one?" had no answer in the product.
 *
 * This page is that answer. The freshness half comes from the server; the
 * read-path and delay half from `propagation.ts`, which is sourced from the
 * 2026-09-02 propagation audit rather than from optimism.
 */

import Link from 'next/link';
import {useConfigStatus} from '@/lib/api';
import {PageHeader} from '@/components/PageHeader';
import {CONFIG_DESCRIPTORS} from '@/features/config/propagation';
import {routes} from '@/lib/routes';
import {formatDateTimeUtc} from '@/lib/datetime';

export default function ConfigStatusPage() {
  const {data, error, isLoading} = useConfigStatus();
  const byKey = new Map((data?.configs ?? []).map(c => [c.key, c]));

  return (
    <>
      <PageHeader
        title="App Configuration"
        subtitle="Every value the mobile apps fetch that ops can change — what the apps read, how long a change takes to reach a device, and which values need a deploy or a store release instead."
        badges={error ? <span className="pill pill-err">STATUS UNAVAILABLE</span> : undefined}
      />

      <div className="card">
        <div className="cfg-grid" style={{borderBottom: '1px solid var(--bd-1)'}}>
          <div className="exec-cap">Configuration</div>
          <div className="exec-cap">What the apps read</div>
          <div className="exec-cap">When it lands</div>
          <div className="exec-cap">Last change</div>
        </div>

        {CONFIG_DESCRIPTORS.map(d => {
          const status = byKey.get(d.key);
          const locked = d.href === null;
          return (
            <div key={d.key} className={`cfg-grid ${locked ? 'cfg-locked' : ''}`}>
              <div>
                <div className="cfg-name">
                  {d.href
                    ? <Link href={d.href}>{d.label} →</Link>
                    : d.label}
                </div>
                {locked && (
                  <div style={{marginTop: 5}}>
                    <span className="pill pill-warn">
                      {d.locked === 'deploy' ? 'NEEDS DEPLOY' : 'NEEDS APP RELEASE'}
                    </span>
                  </div>
                )}
              </div>

              <div className="cfg-meta">{d.appReads}</div>

              <div className="cfg-meta">
                {d.lands}
                {d.caveat && (
                  <div style={{marginTop: 6, color: 'var(--warn)'}}>⚠ {d.caveat}</div>
                )}
              </div>

              <div className="cfg-meta">
                {locked
                  ? '—'
                  : isLoading && !status
                    ? 'loading…'
                    : status?.last_changed_at
                      ? <>
                          {formatDateTimeUtc(status.last_changed_at)}
                          <br />
                          {status.last_changed_by ?? 'actor not recorded'}
                          {typeof status.rows === 'number' && <> · {status.rows} row{status.rows === 1 ? '' : 's'}</>}
                        </>
                      : 'never edited — running on code defaults'}
              </div>
            </div>
          );
        })}
      </div>

      <div className="card" style={{marginTop: 16, padding: '14px 16px'}}>
        <div className="cfg-meta" style={{lineHeight: 1.7}}>
          EVERY EDIT ON THESE PAGES IS AUDITED. Open the audit log to see the from→to of any
          pricing, catalog, region or tier change — <Link href={routes.internal.audit}>Internal · Audit Log →</Link>
        </div>
      </div>
    </>
  );
}
