'use client';

import {useMemo, useState} from 'react';
import {useSWRConfig} from 'swr';
import {NotGranted, useProvider} from '@/components/provider/ProviderShell';
import {Empty, PvCard, PvPage} from '@/components/provider/ui';
import {
  FEED_CATEGORIES, FEED_COUNTRIES, SEVERITY_LABEL, SEVERITY_TONE, regionLabel, safeLink,
  severityOf, timeAgo, usePvFeed, type FeedCategory,
} from '@/lib/provider/api-intel';
import {errorText} from '@/lib/provider/labels';
import {pillClass} from '@/lib/status';

/**
 * Bravo Feed — the web version of the app's Messenger "News" tab → Bravo Feed.
 *
 * Data: the Bravo Secure news feed (GET /news/feed): headlines from news
 * outlets, no older than 72 hours, filtered by category and country. The
 * level is the app's headline estimate. The app's "My Feed" is not here: it
 * is shaped by filter choices saved on the phone only, so the console cannot
 * show the same thing.
 */

export default function ProviderFeed() {
  const {orgId, can} = useProvider();
  const allowed = can('intel');
  const [category, setCategory] = useState<FeedCategory>('top');
  const [country, setCountry] = useState('GLOBAL');
  const [q, setQ] = useState('');
  const {data, error, isLoading} = usePvFeed(orgId, category, country, allowed);
  const {mutate} = useSWRConfig();

  const countries = useMemo(() => {
    const rest = FEED_COUNTRIES.filter(c => c !== 'GLOBAL')
      .map(c => ({code: c, label: regionLabel(c)}))
      .sort((a, b) => a.label.localeCompare(b.label));
    return [{code: 'GLOBAL', label: 'Global'}, ...rest];
  }, []);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.articles ?? [])
      .filter(a => a.title && safeLink(a.url))
      .filter(a => !needle || `${a.title} ${a.summary} ${a.source}`.toLowerCase().includes(needle))
      .map(a => ({...a, severity: severityOf(a.title, a.category)}));
  }, [data, q]);

  if (!allowed) return <PvPage title="Bravo Feed"><NotGranted what="Bravo Feed"/></PvPage>;

  return (
    <PvPage title="Bravo Feed"
      subtitle="Risk intelligence and news from the last 72 hours, the same feed as the app."
      right={<button className="btn btn-ghost btn-sm" onClick={() => mutate(['pv', orgId, `feed:${category}:${country}`])}>Refresh</button>}>
      <PvCard pad={false}>
        <div className="pv-toolbar">
          <div className="pv-tabs" role="tablist" aria-label="Category" style={{flexWrap: 'wrap'}}>
            {FEED_CATEGORIES.map(c => (
              <button key={c.id} role="tab" aria-selected={category === c.id}
                className={`pv-tab ${category === c.id ? 'on' : ''}`} onClick={() => setCategory(c.id)}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
        <div className="pv-toolbar">
          <label className="pv-field" style={{flexDirection: 'row', alignItems: 'center', gap: 8}}>
            <span className="pv-label">Country</span>
            <select className="pv-input" value={country} onChange={e => setCountry(e.target.value)}>
              {countries.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
          </label>
          <input className="pv-search" type="search" placeholder="Search headlines" aria-label="Search headlines"
            value={q} onChange={e => setQ(e.target.value)}/>
        </div>

        {error ? <Empty>{errorText(error)}</Empty>
          : !data ? <Empty>{isLoading ? 'Loading the feed…' : 'Nothing to show.'}</Empty>
          : rows.length === 0 ? <Empty>{q ? 'No headlines match your search.' : 'No news in the last 72 hours for this choice. Try another category or country.'}</Empty>
          : (
            <ul className="pv-list">
              {rows.map(a => {
                const href = safeLink(a.url) as string;
                const ago = timeAgo(a.published_at);
                return (
                  <li key={a.id || href}>
                    <a className="pv-list-row" href={href} target="_blank" rel="noopener noreferrer"
                      style={{alignItems: 'flex-start'}}>
                      <span className={pillClass(SEVERITY_TONE[a.severity])} style={{minWidth: 64, justifyContent: 'center'}}>
                        {SEVERITY_LABEL[a.severity]}
                      </span>
                      <span className="pv-list-main">
                        <span style={{fontWeight: 600}}>{a.title}</span>
                        {a.summary && a.summary !== a.title && (
                          <span className="pv-cell-sub" style={{whiteSpace: 'normal'}}>{a.summary}</span>
                        )}
                        <span className="pv-list-sub">
                          {[a.source, regionLabel(a.region), a.category, ago].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      <span className="pv-hint" aria-hidden style={{flex: '0 0 auto'}}>Open ↗</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        <div className="pv-legend">
          <span>Levels are estimated from the headline wording.</span>
          <span>Articles open on the publisher&apos;s site in a new tab.</span>
        </div>
      </PvCard>
    </PvPage>
  );
}
