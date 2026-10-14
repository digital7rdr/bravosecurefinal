'use client';

/**
 * Enterprise structure editor (2026-10-15).
 *
 * Founder request: "enterprise department channels — parent company,
 * departments, child entities and sub-entities and departments under it …
 * configurable from the backend." This page builds an organisation's channel
 * tree from the console:
 *   - NODES — the organisation, then up to three levels below it (country ›
 *     province › area). Each node is itself a chat.
 *   - CHANNELS of a node (laterals) — created from the level's TEMPLATE when
 *     the node is added (e.g. an area gets Area Broadcast, Operations,
 *     Administration, Logistics, HR & Training), then renamed, re-moded or
 *     archived like any channel.
 *   - PLACEMENT — where each member sits. A member sees their node and
 *     everything below it, the levels above read-only, and those levels'
 *     announcement / read-only channels. Unplaced = the whole organisation.
 *
 * End-to-end encryption is unchanged: a channel made here is "waiting for
 * encryption" until an organisation admin opens Channels in the app, and
 * membership changes are applied by that admin's phone.
 */

import {use, useMemo, useState, type ReactNode} from 'react';
import {
  enterpriseStructureApi, useEnterpriseStructure, useOpsMe,
  type EnterpriseStructure, type StructureChannel, type StructurePostMode, type StructureTemplates, type TemplateRun,
} from '@/lib/api';
import {PageHeader} from '@/components/PageHeader';
import {useToast} from '@/components/Toast';
import {routes} from '@/lib/routes';
import {hasRole} from '@/lib/rbac';
import {nameForTier} from '@/lib/orgGraph';
import {
  POST_MODE_OPTIONS, buildStructureRows, canAddChildNode, placementPath, placementStateLabel, postModeLabel,
  templateLevelLabel, templateProblems, templatesForNewChild, type StructureRow,
} from '@/lib/enterpriseStructure';

const LEVEL_KEYS = ['0', '1', '2', '3'] as const;

function errText(e: unknown): string {
  const m = (e as {message?: unknown})?.message;
  const s = Array.isArray(m) ? m.join(', ') : typeof m === 'string' ? m : 'Request failed';
  return s.replace(/_/g, ' ');
}

export default function StructurePage({params}: {params: Promise<{id: string}>}) {
  const {id} = use(params);
  const {data, error, isLoading, mutate} = useEnterpriseStructure(id);
  const {data: me} = useOpsMe();
  const canWrite = hasRole(me?.admin.role, 'SUPERVISOR');
  const orgName = data?.org.workspace_name ?? data?.org.display_name ?? 'Organisation';

  return (
    <>
      <PageHeader
        crumbs={['Enterprise', 'Departments', data?.org.display_name ?? '…', 'Structure']}
        back={{href: routes.enterprise.org(id), label: data?.org.display_name ?? 'Organisation'}}
        title="Channel structure"
        subtitle={<>Levels, channels and who sits where for <b>{orgName}</b>.</>}
      />
      {error && (
        <div className="card" style={{padding: 24, color: 'var(--err)'}}>
          Could not load this organisation&apos;s structure. It may not exist, or it may be outside your region scope.
        </div>
      )}
      {!canWrite && data && (
        <div className="card" style={{padding: '12px 16px', marginBottom: 12, fontSize: 12.5, color: 'var(--tx-3)'}}>
          Read-only: changing the structure needs a supervisor or admin role.
        </div>
      )}
      <div className="card" style={{padding: '12px 16px', marginBottom: 12, fontSize: 12.5, color: 'var(--tx-2)', lineHeight: 1.6}}>
        New channels appear in the Bravo app straight away and switch to <b>end-to-end encrypted</b> the next time an
        organisation admin opens <b>Channels</b> on their phone. Members placed at a node see that node and everything
        below it; the levels above appear read-only together with their announcement and read-only channels.
      </div>
      {isLoading && !data && <div className="card"><div className="skel-row" /><div className="skel-row" /></div>}
      {data && (
        <div className="org-grid">
          <div>
            <TreeCard orgId={id} data={data} canWrite={canWrite} reload={() => void mutate()} />
          </div>
          <div>
            <PlacementCard orgId={id} data={data} canWrite={canWrite} reload={() => void mutate()} />
            <TemplatesCard orgId={id} data={data} canWrite={canWrite} reload={() => void mutate()} />
            <LevelNamesCard orgId={id} data={data} canWrite={canWrite} reload={() => void mutate()} />
          </div>
        </div>
      )}
    </>
  );
}

/* ── tree ──────────────────────────────────────────────────────────── */

type Editor =
  | {kind: 'root'}
  | {kind: 'child'; parent: StructureChannel}
  | {kind: 'channel'; parent: StructureChannel}
  | {kind: 'rename'; channel: StructureChannel};

function TreeCard({orgId, data, canWrite, reload}: {orgId: string; data: EnterpriseStructure; canWrite: boolean; reload: () => void}) {
  const toast = useToast();
  const [showArchived, setShowArchived] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);
  // One row at a time shows its actions; the rest stay a readable tree.
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const allRows = useMemo(() => buildStructureRows(data.channels, data.members, {showArchived}),
    [data.channels, data.members, showArchived]);
  const {rows, hasChildren} = useMemo(() => {
    const parentOf = new Map(data.channels.map(c => [c.id, c.parent_id]));
    const withKids = new Set(allRows.map(r => r.channel.parent_id).filter((x): x is string => !!x));
    const hidden = (id: string) => {
      let cur = parentOf.get(id) ?? null;
      for (let hop = 0; hop < 8 && cur; hop++) {
        if (collapsed.has(cur)) {return true;}
        cur = parentOf.get(cur) ?? null;
      }
      return false;
    };
    return {rows: allRows.filter(r => !hidden(r.channel.id)), hasChildren: withKids};
  }, [allRows, collapsed, data.channels]);
  const archivedCount = data.channels.filter(c => c.archived).length;
  const toggle = (id: string) => setCollapsed(prev => {
    const next = new Set(prev);
    if (next.has(id)) {next.delete(id);} else {next.add(id);}
    return next;
  });

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast.push({kind: 'ok', text: ok});
      reload();
      return true;
    } catch (e) {
      toast.push({kind: 'err', text: errText(e)});
      return false;
    } finally {
      setBusy(null);
    }
  };

  const reportTemplate = (run: TemplateRun, where: string) => {
    if (run.failed.length) {
      toast.push({kind: 'warn', ttlMs: null,
        text: `${where}: ${run.created.length} channel(s) created; could not create ${run.failed.map(f => `"${f.name}" (${f.error.replace(/_/g, ' ')})`).join(', ')}.`});
    }
  };

  return (
    <Card title={`Tree · ${allRows.filter(r => r.kind === 'node').length} nodes · ${allRows.filter(r => r.kind === 'lateral').length} channels`}
      action={(
        <div style={{display: 'flex', gap: 8, alignItems: 'center'}}>
          {archivedCount > 0 && (
            <label style={{fontSize: 11.5, color: 'var(--tx-3)', display: 'flex', gap: 6, alignItems: 'center'}}>
              <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
              archived ({archivedCount})
            </label>
          )}
          {canWrite && (
            <button className="btn btn-sm btn-sec" onClick={() => setEditor({kind: 'root'})}>+ ORGANISATION</button>
          )}
        </div>
      )}>
      {editor?.kind === 'root' && (
        <NameForm
          title="New organisation (top level)"
          templates={templatesForNewChild(data.templates, null)}
          withTemplate
          withMode
          busy={busy === 'root'}
          onCancel={() => setEditor(null)}
          onSubmit={async ({name, applyTemplate, mode}) => {
            let result: TemplateRun | null = null;
            const done = await run('root', async () => {
              const r = await enterpriseStructureApi.createNode(orgId, {name, apply_template: applyTemplate, post_mode: mode});
              result = r.laterals;
            }, `Created ${name}`);
            if (result) {reportTemplate(result, name);}
            if (done) {setEditor(null);}
          }}
        />
      )}
      {allRows.length > 0 && (
        <div style={{padding: '8px 14px', fontSize: 11.5, color: 'var(--tx-3)', borderBottom: '1px solid var(--bd-2)'}}>
          {canWrite ? 'Select a row to add levels or channels, rename, change posting or archive.' : 'Select a row to see its details.'}
        </div>
      )}
      {allRows.length === 0 && editor?.kind !== 'root' && (
        <div className="q-empty">
          No channels yet. {canWrite ? 'Start with the organisation itself — use + ORGANISATION.' : ''}
        </div>
      )}
      {rows.map(row => (
        <div key={row.channel.id}>
          <TreeRow
            row={row}
            levelNames={data.level_names}
            canWrite={canWrite}
            busy={busy}
            confirming={confirmArchive === row.channel.id}
            selected={selected === row.channel.id}
            onSelect={() => { setSelected(cur => (cur === row.channel.id ? null : row.channel.id)); setConfirmArchive(null); }}
            expandable={hasChildren.has(row.channel.id)}
            isCollapsed={collapsed.has(row.channel.id)}
            onToggle={() => toggle(row.channel.id)}
            onAddChild={() => setEditor({kind: 'child', parent: row.channel})}
            onAddChannel={() => setEditor({kind: 'channel', parent: row.channel})}
            onRename={() => setEditor({kind: 'rename', channel: row.channel})}
            onMode={mode => void run(`mode:${row.channel.id}`,
              () => enterpriseStructureApi.updateChannel(orgId, row.channel.id, {post_mode: mode}),
              `${row.channel.name}: ${postModeLabel(mode)}`)}
            onApplyTemplate={async () => {
              setBusy(`tpl:${row.channel.id}`);
              try {
                const r = await enterpriseStructureApi.applyTemplate(orgId, row.channel.id);
                toast.push({kind: r.created.length ? 'ok' : 'info',
                  text: r.created.length ? `Added ${r.created.map(c => c.name).join(', ')}` : 'Nothing missing — this level already has its template channels.'});
                reportTemplate(r, row.channel.name);
                reload();
              } catch (e) {
                toast.push({kind: 'err', text: errText(e)});
              } finally {
                setBusy(null);
              }
            }}
            onArchive={() => {
              if (confirmArchive !== row.channel.id) {setConfirmArchive(row.channel.id); return;}
              setConfirmArchive(null);
              void run(`arch:${row.channel.id}`, () => enterpriseStructureApi.archive(orgId, row.channel.id),
                `Archived ${row.channel.name}`);
            }}
            onRestore={() => void run(`arch:${row.channel.id}`, () => enterpriseStructureApi.unarchive(orgId, row.channel.id),
              `Restored ${row.channel.name}`)}
          />
          {editor && editor.kind === 'child' && editor.parent.id === row.channel.id && (
            <NameForm
              indent={row.depth + 1}
              title={`New ${nameForTier((row.tier ?? 1) + 1, data.level_names)} under ${row.channel.name}`}
              templates={templatesForNewChild(data.templates, row.channel.level)}
              withTemplate
              withMode
              busy={busy === 'child'}
              onCancel={() => setEditor(null)}
              onSubmit={async ({name, applyTemplate, mode}) => {
                let result: TemplateRun | null = null;
                const done = await run('child', async () => {
                  const r = await enterpriseStructureApi.createNode(orgId,
                    {name, parent_id: row.channel.id, apply_template: applyTemplate, post_mode: mode});
                  result = r.laterals;
                }, `Created ${name}`);
                if (result) {reportTemplate(result, name);}
                if (done) {setEditor(null);}
              }}
            />
          )}
          {editor && editor.kind === 'channel' && editor.parent.id === row.channel.id && (
            <NameForm
              indent={row.depth + 1}
              title={`New channel in ${row.channel.name}`}
              withMode
              busy={busy === 'channel'}
              onCancel={() => setEditor(null)}
              onSubmit={async ({name, mode}) => {
                const done = await run('channel',
                  () => enterpriseStructureApi.createChannel(orgId, {parent_id: row.channel.id, name, post_mode: mode}),
                  `Created ${name}`);
                if (done) {setEditor(null);}
              }}
            />
          )}
          {editor && editor.kind === 'rename' && editor.channel.id === row.channel.id && (
            <NameForm
              indent={row.depth}
              title={`Rename ${row.channel.name}`}
              initial={row.channel.name}
              busy={busy === 'rename'}
              onCancel={() => setEditor(null)}
              onSubmit={async ({name}) => {
                const done = await run('rename',
                  () => enterpriseStructureApi.updateChannel(orgId, row.channel.id, {name}),
                  `Renamed to ${name}`);
                if (done) {setEditor(null);}
              }}
            />
          )}
        </div>
      ))}
    </Card>
  );
}

function TreeRow({
  row, levelNames, canWrite, busy, confirming, selected, onSelect, expandable, isCollapsed, onToggle,
  onAddChild, onAddChannel, onRename, onMode, onApplyTemplate, onArchive, onRestore,
}: {
  row: StructureRow; levelNames: string[]; canWrite: boolean; busy: string | null; confirming: boolean;
  selected: boolean; onSelect: () => void; expandable: boolean; isCollapsed: boolean; onToggle: () => void;
  onAddChild: () => void; onAddChannel: () => void; onRename: () => void; onMode: (m: StructurePostMode) => void;
  onApplyTemplate: () => void; onArchive: () => void; onRestore: () => void;
}) {
  const c = row.channel;
  const isNode = row.kind === 'node';
  const tint = isNode ? ['var(--act)', 'var(--ok)', 'var(--warn)', 'var(--info)'][((row.tier ?? 1) - 1) % 4] : 'var(--tx-3)';
  const locked = c.is_broadcast; // the server pins a #broadcast's mode and refuses children
  return (
    <div className="org-tree-row" onClick={onSelect} role="button" tabIndex={0} aria-pressed={selected}
      onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {e.preventDefault(); onSelect();} }}
      style={{paddingLeft: 14 + row.depth * 20, opacity: c.archived ? 0.55 : 1, cursor: 'pointer',
        background: selected ? 'var(--surf-3)' : undefined, boxShadow: selected ? `inset 3px 0 0 ${tint}` : undefined}}>
      <div style={{minWidth: 0, display: 'flex', gap: 8, alignItems: 'flex-start'}}>
        {expandable ? (
          <button type="button" className="btn btn-sm btn-ghost" aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${c.name}`}
            onClick={e => { e.stopPropagation(); onToggle(); }}
            style={{height: 20, width: 20, padding: 0, justifyContent: 'center', marginTop: -1}}>{isCollapsed ? '▸' : '▾'}</button>
        ) : <span style={{width: 20, flexShrink: 0}} />}
        <span className="org-tier-dot" aria-hidden="true"
          style={{background: isNode ? tint : 'transparent', borderColor: tint, borderStyle: isNode ? 'solid' : 'dashed'}} />
        <div style={{minWidth: 0}} onClick={e => { if (selected) {e.stopPropagation();} }}>
          <div className="q-primary" style={{display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap'}}>
            <span style={{fontWeight: isNode ? 700 : 600}}>{c.name}</span>
            <span className="org-tier-tag" style={{color: tint}}>
              {isNode ? `L${row.tier} · ${nameForTier(row.tier ?? 1, levelNames)}`.toUpperCase() : 'CHANNEL'}
            </span>
          </div>
          <div className="q-secondary" style={{whiteSpace: 'normal'}}>
            {postModeLabel(c.post_mode)} · {c.member_count} member{c.member_count === 1 ? '' : 's'}
            {row.placed > 0 ? ` · ${row.placed} placed here` : ''}
            {c.access === 'restricted' ? ' · managers only' : ''}
          </div>
          {selected && canWrite && !c.archived && (
            <div style={{display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6}}>
              {isNode && canAddChildNode(c) && (
                <button className="btn btn-sm btn-ghost" onClick={onAddChild}>+ {nameForTier((row.tier ?? 1) + 1, levelNames)}</button>
              )}
              {isNode && <button className="btn btn-sm btn-ghost" onClick={onAddChannel}>+ Channel</button>}
              {isNode && (
                <button className="btn btn-sm btn-ghost" disabled={busy === `tpl:${c.id}`} onClick={onApplyTemplate}
                  title="Create the template channels this level is missing">
                  {busy === `tpl:${c.id}` ? <span className="spinner" /> : null}Template
                </button>
              )}
              <button className="btn btn-sm btn-ghost" onClick={onRename}>Rename</button>
              {!locked && (
                <select aria-label={`Posting in ${c.name}`} value={c.post_mode} disabled={busy === `mode:${c.id}`}
                  onChange={e => onMode(e.target.value as StructurePostMode)}
                  style={{height: 28, fontSize: 11, borderRadius: 8}}>
                  {POST_MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              )}
              {!c.is_broadcast && (
                <button className={`btn btn-sm ${confirming ? 'btn-danger' : 'btn-ghost'}`} disabled={busy === `arch:${c.id}`}
                  onClick={onArchive}>
                  {confirming ? 'Confirm archive' : 'Archive'}
                </button>
              )}
            </div>
          )}
          {selected && canWrite && c.archived && (
            <div style={{marginTop: 6}}>
              <button className="btn btn-sm btn-ghost" disabled={busy === `arch:${c.id}`} onClick={onRestore}>Restore</button>
            </div>
          )}
        </div>
      </div>
      <div className="q-right" style={{flexWrap: 'wrap', justifyContent: 'flex-end'}}>
        {c.archived
          ? <span className="pill">ARCHIVED</span>
          : <span className={`pill ${c.provisioned ? 'pill-ok' : 'pill-warn'}`}
              title={c.provisioned ? 'End-to-end encrypted group is set up' : 'Waiting for an organisation admin to open Channels in the app'}>
              {c.provisioned ? '● E2E' : '○ WAITING'}
            </span>}
      </div>
    </div>
  );
}

function NameForm({
  title, initial = '', templates, withTemplate, withMode, busy, indent = 0, onCancel, onSubmit,
}: {
  title: string; initial?: string; templates?: Array<{name: string; post_mode: StructurePostMode}>;
  withTemplate?: boolean; withMode?: boolean; busy: boolean; indent?: number;
  onCancel: () => void;
  onSubmit: (v: {name: string; applyTemplate: boolean; mode: StructurePostMode}) => void | Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [applyTemplate, setApplyTemplate] = useState(true);
  const [mode, setMode] = useState<StructurePostMode>('open');
  const trimmed = name.trim();
  return (
    <form
      onSubmit={e => { e.preventDefault(); if (trimmed && trimmed.length <= 80 && !busy) {void onSubmit({name: trimmed, applyTemplate, mode});} }}
      style={{margin: `8px 14px 10px ${14 + indent * 20}px`, padding: 12, borderRadius: 10, background: 'var(--surf-3)', border: '1px solid var(--bd-2)'}}>
      <label className="modal-label">{title}</label>
      <div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
        <input className="modal-input" autoFocus value={name} maxLength={80} placeholder="Name"
          onChange={e => setName(e.target.value)} style={{flex: '1 1 200px', width: 'auto'}} />
        {withMode && (
          <select aria-label="Posting" value={mode} onChange={e => setMode(e.target.value as StructurePostMode)}
            style={{borderRadius: 8, fontSize: 12}}>
            {POST_MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label} — {o.hint}</option>)}
          </select>
        )}
      </div>
      {withTemplate && templates && (
        <label style={{display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 10, fontSize: 12, color: 'var(--tx-2)'}}>
          <input type="checkbox" checked={applyTemplate} onChange={e => setApplyTemplate(e.target.checked)} style={{marginTop: 2}} />
          <span>
            Also create this level&apos;s channels{templates.length
              ? <>: {templates.map(t => t.name).join(', ')}</>
              : <> (the template for this level is empty)</>}
          </span>
        </label>
      )}
      <div style={{display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10}}>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-sm btn-pri" disabled={!trimmed || busy}>
          {busy ? <span className="spinner" /> : null}Save
        </button>
      </div>
    </form>
  );
}

/* ── placement ─────────────────────────────────────────────────────── */

function PlacementCard({orgId, data, canWrite, reload}: {orgId: string; data: EnterpriseStructure; canWrite: boolean; reload: () => void}) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<string>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const nodes = useMemo(() => buildStructureRows(data.channels).filter(r => r.kind === 'node'), [data.channels]);

  const shown = data.members.filter(m => {
    if (filter === 'unplaced' && m.placement_channel_id) {return false;}
    if (filter !== 'all' && filter !== 'unplaced' && m.placement_channel_id !== filter) {return false;}
    const needle = q.trim().toLowerCase();
    return !needle || (m.display_name ?? '').toLowerCase().includes(needle) || (m.department ?? '').toLowerCase().includes(needle);
  });
  const allShownSelected = shown.length > 0 && shown.every(m => selected.has(m.user_id));

  const apply = async () => {
    if (!target || selected.size === 0) {return;}
    setBusy(true);
    try {
      const r = await enterpriseStructureApi.place(orgId, [...selected], target === 'org' ? null : target);
      const failed = r.results.filter(x => !x.ok);
      const where = target === 'org' ? 'the whole organisation' : placementPath(data.channels, target);
      toast.push(failed.length
        ? {kind: 'warn', ttlMs: null, text: `${r.results.length - failed.length} placed at ${where}; ${failed.length} failed (${failed[0].error?.replace(/_/g, ' ')}).`}
        : {kind: 'ok', text: `${r.results.length} placed at ${where}. Their phones pick up the change when an admin opens Channels.`});
      setSelected(new Set());
      reload();
    } catch (e) {
      toast.push({kind: 'err', text: errText(e)});
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={`Members · ${data.members.length} active · ${data.members.filter(m => !m.placement_channel_id).length} unplaced`}>
      <div style={{display: 'flex', gap: 8, padding: '10px 14px', flexWrap: 'wrap'}}>
        <input className="modal-input" placeholder="Search name or department" value={q} onChange={e => setQ(e.target.value)}
          style={{flex: '1 1 180px', width: 'auto'}} />
        <select aria-label="Filter by placement" value={filter} onChange={e => setFilter(e.target.value)} style={{borderRadius: 8, fontSize: 12}}>
          <option value="all">Everyone</option>
          <option value="unplaced">Whole organisation (unplaced)</option>
          {nodes.map(n => <option key={n.channel.id} value={n.channel.id}>{'— '.repeat(n.depth)}{n.channel.name}</option>)}
        </select>
      </div>
      {data.members.length === 0 && <div className="q-empty">Nobody has joined this organisation yet.</div>}
      {shown.length > 0 && (
        <label className="q-row" style={{cursor: 'pointer', gap: 10, justifyContent: 'flex-start'}}>
          <input type="checkbox" checked={allShownSelected} disabled={!canWrite}
            onChange={e => setSelected(prev => {
              const next = new Set(prev);
              for (const m of shown) {if (e.target.checked) {next.add(m.user_id);} else {next.delete(m.user_id);}}
              return next;
            })} />
          <span className="q-secondary">Select all {shown.length} shown</span>
        </label>
      )}
      <div style={{maxHeight: 420, overflow: 'auto'}}>
        {shown.map(m => {
          const warn = placementStateLabel(m);
          return (
            <label key={m.user_id} className="q-row" style={{cursor: canWrite ? 'pointer' : 'default', gap: 10, justifyContent: 'flex-start'}}>
              <input type="checkbox" checked={selected.has(m.user_id)} disabled={!canWrite}
                onChange={e => setSelected(prev => {
                  const next = new Set(prev);
                  if (e.target.checked) {next.add(m.user_id);} else {next.delete(m.user_id);}
                  return next;
                })} />
              <div style={{minWidth: 0, flex: 1}}>
                <div className="q-primary">{m.display_name ?? m.user_id.slice(0, 8)}
                  <span className="q-secondary" style={{marginLeft: 8}}>{m.member_role === 'manager' ? 'Manager' : m.member_role === 'cpo' ? 'Officer' : 'Employee'}</span>
                </div>
                <div className="q-secondary" style={{whiteSpace: 'normal', color: warn ? 'var(--warn)' : undefined}}>
                  {warn ?? placementPath(data.channels, m.placement_channel_id)}
                </div>
              </div>
            </label>
          );
        })}
      </div>
      {canWrite && data.members.length > 0 && (
        <div className="q-footer" style={{display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap'}}>
          <span style={{color: 'var(--tx-3)'}}>{selected.size} selected → place at</span>
          <select aria-label="Place at" value={target} onChange={e => setTarget(e.target.value)} style={{borderRadius: 8, fontSize: 12, flex: '1 1 160px'}}>
            <option value="">Choose a level…</option>
            <option value="org">Whole organisation</option>
            {nodes.filter(n => !n.channel.archived).map(n => (
              <option key={n.channel.id} value={n.channel.id}>{'— '.repeat(n.depth)}{n.channel.name}</option>
            ))}
          </select>
          <button className="btn btn-sm btn-pri" disabled={busy || !target || selected.size === 0} onClick={() => void apply()}>
            {busy ? <span className="spinner" /> : null}Place
          </button>
        </div>
      )}
    </Card>
  );
}

/* ── templates ─────────────────────────────────────────────────────── */

function TemplatesCard({orgId, data, canWrite, reload}: {orgId: string; data: EnterpriseStructure; canWrite: boolean; reload: () => void}) {
  const toast = useToast();
  const [draft, setDraft] = useState<StructureTemplates | null>(null);
  const [busy, setBusy] = useState(false);
  const t = draft ?? data.templates;
  const problem = draft ? templateProblems(draft) : null;

  const edit = (level: typeof LEVEL_KEYS[number], fn: (list: StructureTemplates[typeof level]) => StructureTemplates[typeof level]) =>
    setDraft({...t, [level]: fn([...t[level]])});

  const save = async (body: {templates?: StructureTemplates; reset?: boolean}) => {
    setBusy(true);
    try {
      await enterpriseStructureApi.setTemplates(orgId, body);
      toast.push({kind: 'ok', text: body.reset ? 'Templates reset to the Bravo defaults' : 'Templates saved'});
      setDraft(null);
      reload();
    } catch (e) {
      toast.push({kind: 'err', text: errText(e)});
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Level templates" action={data.templates_are_default && !draft ? <span className="pill">DEFAULTS</span> : undefined}>
      <div style={{padding: '10px 14px', fontSize: 12, color: 'var(--tx-3)', lineHeight: 1.6}}>
        The channels created with each new node. Existing nodes are not changed; use <b>Template</b> on a node to add
        the ones it is missing.
      </div>
      {LEVEL_KEYS.map(level => (
        <div key={level} style={{padding: '8px 14px', borderTop: '1px solid var(--bd-2)'}}>
          <div className="exec-cap" style={{marginBottom: 6}}>{templateLevelLabel(Number(level), data.level_names)}</div>
          {t[level].length === 0 && <div className="q-secondary" style={{marginBottom: 6}}>No channels — the node only.</div>}
          {t[level].map((e, i) => (
            <div key={i} style={{display: 'flex', gap: 6, marginBottom: 6}}>
              <input className="modal-input" value={e.name} disabled={!canWrite} maxLength={80} aria-label="Channel name"
                onChange={ev => edit(level, l => l.map((x, j) => (j === i ? {...x, name: ev.target.value} : x)))}
                style={{flex: 1, width: 'auto', padding: '6px 10px'}} />
              <select value={e.post_mode} disabled={!canWrite} aria-label="Posting"
                onChange={ev => edit(level, l => l.map((x, j) => (j === i ? {...x, post_mode: ev.target.value as StructurePostMode} : x)))}
                style={{borderRadius: 8, fontSize: 12}}>
                {POST_MODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {canWrite && (
                <button className="btn btn-sm btn-ghost" aria-label={`Remove ${e.name}`}
                  onClick={() => edit(level, l => l.filter((_, j) => j !== i))}>✕</button>
              )}
            </div>
          ))}
          {canWrite && t[level].length < 12 && (
            <button className="btn btn-sm btn-ghost" onClick={() => edit(level, l => [...l, {name: '', post_mode: 'open'}])}>+ Channel</button>
          )}
        </div>
      ))}
      {canWrite && (
        <div className="q-footer" style={{display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center'}}>
          {problem && <span style={{color: 'var(--err)', marginRight: 'auto'}}>{problem}</span>}
          {!data.templates_are_default && (
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void save({reset: true})}>Reset to defaults</button>
          )}
          {draft && <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setDraft(null)}>Discard</button>}
          <button className="btn btn-sm btn-pri" disabled={busy || !draft || !!problem}
            onClick={() => draft && void save({templates: {
              '0': draft['0'].map(x => ({...x, name: x.name.trim()})),
              '1': draft['1'].map(x => ({...x, name: x.name.trim()})),
              '2': draft['2'].map(x => ({...x, name: x.name.trim()})),
              '3': draft['3'].map(x => ({...x, name: x.name.trim()})),
            }})}>
            {busy ? <span className="spinner" /> : null}Save templates
          </button>
        </div>
      )}
    </Card>
  );
}

/* ── level names ───────────────────────────────────────────────────── */

function LevelNamesCard({orgId, data, canWrite, reload}: {orgId: string; data: EnterpriseStructure; canWrite: boolean; reload: () => void}) {
  const toast = useToast();
  const [draft, setDraft] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const names = draft ?? [0, 1, 2, 3].map(i => data.level_names[i] ?? '');
  return (
    <Card title="Level names">
      <div style={{padding: '10px 14px', fontSize: 12, color: 'var(--tx-3)'}}>
        What each level is called in the app, e.g. Group · Country · Province · Area. Blank keeps the default.
      </div>
      <div style={{display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, padding: '0 14px 12px'}}>
        {names.map((n, i) => (
          <label key={i} style={{minWidth: 0}}>
            <span className="modal-label">L{i + 1}</span>
            <input className="modal-input" value={n} maxLength={24} disabled={!canWrite} placeholder={nameForTier(i + 1, [])}
              onChange={e => setDraft(names.map((x, j) => (j === i ? e.target.value : x)))} />
          </label>
        ))}
      </div>
      {canWrite && (
        <div className="q-footer" style={{display: 'flex', justifyContent: 'flex-end', gap: 8}}>
          {draft && <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setDraft(null)}>Discard</button>}
          <button className="btn btn-sm btn-pri" disabled={busy || !draft} onClick={async () => {
            if (!draft) {return;}
            setBusy(true);
            try {
              await enterpriseStructureApi.setLevelNames(orgId, draft.map(x => x.trim()));
              toast.push({kind: 'ok', text: 'Level names saved'});
              setDraft(null);
              reload();
            } catch (e) {
              toast.push({kind: 'err', text: errText(e)});
            } finally {
              setBusy(false);
            }
          }}>{busy ? <span className="spinner" /> : null}Save names</button>
        </div>
      )}
    </Card>
  );
}

function Card({title, action, children}: {title: string; action?: ReactNode; children: ReactNode}) {
  return (
    <div className="card" style={{marginBottom: 12}}>
      <div className="card-header">
        <div className="card-header-title"><span className="bar" />{title}</div>
        {action}
      </div>
      {children}
    </div>
  );
}
