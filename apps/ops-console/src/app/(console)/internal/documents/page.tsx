'use client';

/**
 * Controlled documents (ISO 9001:2015 file naming deck, adopted 2026-10-15).
 *
 *   main folder  "012. FINANCE"            — 13 departments, EX … QH
 *   sub-folder   "100. Policy / Procedures" — 100 / 200 / 300 / 400
 *   document     "BRV-FN 100-001 Expense Tracking Procedure"
 *   file         "BRV-FN-100-001_ExpenseTrackingProcedure_v2.pdf"
 *
 * Numbers are assigned by the server and never reused; every version is kept
 * and downloadable; a withdrawn document is marked obsolete, not deleted.
 */

import {useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {PageHeader} from '@/components/PageHeader';
import {useToast} from '@/components/Toast';
import {
  documentsApi, useControlledDocuments, useOpsMe,
  type ControlledDocument, type ControlledDocumentLibrary, type ControlledDocumentVersion,
} from '@/lib/api';
import {hasRole} from '@/lib/rbac';
import {formatDateTimeShortUtc} from '@/lib/datetime';
import {
  categoryFolderLabel, controlledDocFileName, departmentFolderLabel, isDepartmentCode,
  type DepartmentCode, type DocCategoryCode,
} from '@/lib/fileNaming';

type Folder = {dept: string; category: DocCategoryCode | null};

function errText(e: unknown): string {
  const m = (e as {message?: unknown})?.message;
  const s = Array.isArray(m) ? m.join(', ') : typeof m === 'string' ? m : 'Request failed';
  return s.replace(/_/g, ' ');
}

function sizeLabel(n: number | null | undefined): string {
  if (!n) {return '—';}
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

async function save(id: string, name: string, version?: number) {
  const blob = await documentsApi.download(id, version);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function DocumentsPage() {
  const {data, error, isLoading, mutate} = useControlledDocuments();
  const {data: me} = useOpsMe();
  const canWrite = hasRole(me?.admin.role, 'SUPERVISOR');
  const [folder, setFolder] = useState<Folder>({dept: 'EX', category: 100});
  const [openDept, setOpenDept] = useState<string | null>('EX');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [showObsolete, setShowObsolete] = useState(false);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of data?.documents ?? []) {
      if (d.status !== 'active') {continue;}
      m.set(d.department_code, (m.get(d.department_code) ?? 0) + 1);
      m.set(`${d.department_code}:${d.category}`, (m.get(`${d.department_code}:${d.category}`) ?? 0) + 1);
    }
    return m;
  }, [data]);

  const needle = q.trim().toLowerCase();
  const shown = (data?.documents ?? []).filter(d => {
    if (!showObsolete && d.status !== 'active') {return false;}
    if (needle) {return `${d.number} ${d.title} ${d.file_name ?? ''}`.toLowerCase().includes(needle);}
    return d.department_code === folder.dept && (folder.category === null || d.category === folder.category);
  });

  const folderTitle = needle
    ? `Search · ${shown.length} result${shown.length === 1 ? '' : 's'}`
    : isDepartmentCode(folder.dept)
      ? `${departmentFolderLabel(folder.dept)}${folder.category ? ` › ${categoryFolderLabel(folder.category)}` : ''}`
      : folder.dept;

  return (
    <>
      <PageHeader title="Documents"
        subtitle="Bravo's controlled documents, filed and named to the ISO 9001:2015 standard. Every version is kept." />
      {error && <div className="card" style={{padding: 20, color: 'var(--err)'}}>Could not load the document library.</div>}
      <div className="docs-grid">
        <div>
          <Card title="Folders">
            <div style={{padding: '10px 14px'}}>
              <input className="modal-input" placeholder="Search number, title or file name" value={q}
                onChange={e => setQ(e.target.value)} />
            </div>
            {isLoading && !data && <div className="skel-row" />}
            {(data?.departments ?? []).map(d => {
              const open = openDept === d.code;
              return (
                <div key={d.code}>
                  <button type="button" className="docs-folder"
                    aria-expanded={open}
                    data-active={!needle && folder.dept === d.code && folder.category === null ? 'true' : undefined}
                    onClick={() => { setOpenDept(open ? null : d.code); setFolder({dept: d.code, category: null}); setSelected(null); setQ(''); }}>
                    <span aria-hidden="true">{open ? '▾' : '▸'}</span>
                    <span className="docs-folder-name">{d.folder}. {d.name.toUpperCase()}</span>
                    <span className="docs-code">{d.code}</span>
                    {(counts.get(d.code) ?? 0) > 0 && <span className="pill">{counts.get(d.code)}</span>}
                  </button>
                  {open && (data?.categories ?? []).map(c => (
                    <button type="button" key={c.code} className="docs-folder docs-sub"
                      data-active={!needle && folder.dept === d.code && folder.category === c.code ? 'true' : undefined}
                      onClick={() => { setFolder({dept: d.code, category: c.code}); setSelected(null); setQ(''); }}>
                      <span className="docs-folder-name">{c.code}. {c.name}</span>
                      {(counts.get(`${d.code}:${c.code}`) ?? 0) > 0 && <span className="pill">{counts.get(`${d.code}:${c.code}`)}</span>}
                    </button>
                  ))}
                </div>
              );
            })}
          </Card>
          <StandardCard />
        </div>
        <div>
          <Card title={folderTitle} action={(
            <label style={{fontSize: 11.5, color: 'var(--tx-3)', display: 'flex', gap: 6, alignItems: 'center'}}>
              <input type="checkbox" checked={showObsolete} onChange={e => setShowObsolete(e.target.checked)} /> obsolete
            </label>
          )}>
            {data && shown.length === 0 && (
              <div className="q-empty">{needle ? 'No document matches.' : 'This folder is empty.'}</div>
            )}
            {shown.map(d => (
              <div key={d.id}>
                <button type="button" className="q-row docs-row" aria-expanded={selected === d.id}
                  onClick={() => setSelected(selected === d.id ? null : d.id)}>
                  <div style={{minWidth: 0, textAlign: 'left'}}>
                    <div className="q-primary"><span className="docs-number">{d.number}</span> {d.title}</div>
                    <div className="q-secondary" style={{whiteSpace: 'normal', overflowWrap: 'anywhere'}}>
                      {d.file_name ?? '—'} · {sizeLabel(d.size_bytes)} · updated {formatDateTimeShortUtc(d.updated_at)}
                      {d.updated_by_name ? ` by ${d.updated_by_name}` : ''}
                    </div>
                  </div>
                  <div className="q-right">
                    <span className="pill">v{d.current_version}</span>
                    {d.status === 'obsolete' && <span className="pill pill-warn">OBSOLETE</span>}
                  </div>
                </button>
                {selected === d.id && <DocumentPanel doc={d} canWrite={canWrite} reload={() => void mutate()} />}
              </div>
            ))}
          </Card>
          {canWrite && !needle && folder.category !== null && data && isDepartmentCode(folder.dept) && (
            <NewDocumentCard lib={data} dept={folder.dept} category={folder.category} reload={() => void mutate()} />
          )}
          {canWrite && !needle && folder.category === null && (
            <div className="card" style={{padding: '12px 16px', fontSize: 12.5, color: 'var(--tx-3)'}}>
              Open a sub-folder (100–400) to add a document to it.
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function NewDocumentCard({lib, dept, category, reload}: {lib: ControlledDocumentLibrary; dept: DepartmentCode; category: DocCategoryCode; reload: () => void}) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const next = Math.max(0, ...lib.documents.filter(d => d.department_code === dept && d.category === category).map(d => d.seq)) + 1;
  const ext = (file?.name.split('.').pop() ?? '').toLowerCase();
  const tooBig = !!file && file.size > lib.max_bytes;
  const badType = !!file && !lib.allowed_extensions.includes(ext);
  const preview = title.trim() && file && !badType
    ? controlledDocFileName({dept, category, seq: next, title, version: 1, ext}) : null;

  const submit = async () => {
    if (!file || !title.trim() || tooBig || badType) {return;}
    setBusy(true);
    try {
      const out = await documentsApi.create({department_code: dept, category, title: title.trim(), change_note: note.trim() || undefined, file});
      toast.push({kind: 'ok', text: `Filed as ${out.number} — ${out.file_name}`});
      setTitle(''); setNote(''); setFile(null);
      if (input.current) {input.current.value = '';}
      reload();
    } catch (e) {
      toast.push({kind: 'err', text: errText(e)});
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Add a document to this folder">
      <div style={{padding: '12px 14px', display: 'grid', gap: 10}}>
        <label>
          <span className="modal-label">Title</span>
          <input className="modal-input" value={title} maxLength={120} placeholder="e.g. Expense Tracking Procedure"
            onChange={e => setTitle(e.target.value)} />
        </label>
        <label>
          <span className="modal-label">File ({lib.allowed_extensions.join(', ')} · up to {Math.round(lib.max_bytes / 1024 / 1024)} MB)</span>
          <input ref={input} type="file" style={{fontSize: 12}} accept={lib.allowed_extensions.map(e => `.${e}`).join(',')}
            onChange={e => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <label>
          <span className="modal-label">Note (optional)</span>
          <input className="modal-input" value={note} maxLength={500} placeholder="e.g. First issue, approved by the CFO"
            onChange={e => setNote(e.target.value)} />
        </label>
        {tooBig && <div className="modal-err">That file is larger than {Math.round(lib.max_bytes / 1024 / 1024)} MB.</div>}
        {badType && <div className="modal-err">.{ext || '?'} files are not accepted here.</div>}
        {preview && (
          <div style={{fontSize: 12, color: 'var(--tx-2)'}}>
            Will be filed as <b>BRV-{dept} {category}-{String(next).padStart(3, '0')} {title.trim()}</b> and stored as{' '}
            <code style={{overflowWrap: 'anywhere'}}>{preview}</code>
          </div>
        )}
        <div style={{display: 'flex', justifyContent: 'flex-end'}}>
          <button className="btn btn-sm btn-pri" disabled={busy || !file || !title.trim() || tooBig || badType} onClick={() => void submit()}>
            {busy ? <span className="spinner" /> : null}File document
          </button>
        </div>
      </div>
    </Card>
  );
}

function DocumentPanel({doc, canWrite, reload}: {doc: ControlledDocument; canWrite: boolean; reload: () => void}) {
  const toast = useToast();
  const [versions, setVersions] = useState<ControlledDocumentVersion[] | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [title, setTitle] = useState(doc.title);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    documentsApi.get(doc.id)
      .then(r => { if (live) {setVersions(r.versions);} })
      .catch(e => { if (live) {toast.push({kind: 'err', text: errText(e)});} });
    return () => { live = false; };
    // Load once per opened document; a version upload refreshes it in act().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id]);

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast.push({kind: 'ok', text: ok});
      reload();
      const r = await documentsApi.get(doc.id);
      setVersions(r.versions);
      return true;
    } catch (e) {
      toast.push({kind: 'err', text: errText(e)});
      return false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="docs-panel">
      <div className="exec-cap" style={{marginBottom: 6}}>Versions</div>
      {!versions && <div className="skel-row" />}
      {(versions ?? []).map(v => (
        <div key={v.version} className="docs-version">
          <div style={{minWidth: 0}}>
            <div style={{fontSize: 12.5, color: 'var(--tx-1)', overflowWrap: 'anywhere'}}>
              <b>v{v.version}</b> · {v.stored_name}{v.version === doc.current_version ? ' · current' : ''}
            </div>
            <div className="q-secondary" style={{whiteSpace: 'normal'}}>
              {formatDateTimeShortUtc(v.uploaded_at)}{v.uploaded_by_name ? ` · ${v.uploaded_by_name}` : ''} · {sizeLabel(v.size_bytes)}
              {' · uploaded as '}“{v.original_name}”{v.change_note ? ` · ${v.change_note}` : ''}
            </div>
          </div>
          <button className="btn btn-sm btn-ghost" disabled={busy === `dl:${v.version}`}
            onClick={() => { setBusy(`dl:${v.version}`); save(doc.id, v.stored_name, v.version)
              .catch(e => toast.push({kind: 'err', text: errText(e)})).finally(() => setBusy(null)); }}>
            Download
          </button>
        </div>
      ))}
      {canWrite && doc.status === 'active' && (
        <div className="docs-actions">
          <div className="exec-cap">New version</div>
          <input type="file" style={{fontSize: 12}} onChange={e => setFile(e.target.files?.[0] ?? null)} />
          <input className="modal-input" value={note} maxLength={500} placeholder="What changed (optional)" onChange={e => setNote(e.target.value)} />
          <div>
            <button className="btn btn-sm btn-pri" disabled={!file || busy === 'ver'}
              onClick={() => file && void act('ver', () => documentsApi.addVersion(doc.id, {file, change_note: note.trim() || undefined}),
                `${doc.number} v${doc.current_version + 1} filed`).then(ok => { if (ok) {setFile(null); setNote('');} })}>
              {busy === 'ver' ? <span className="spinner" /> : null}Upload v{doc.current_version + 1}
            </button>
          </div>
        </div>
      )}
      {canWrite && (
        <div className="docs-actions">
          <div className="exec-cap">Title (the number {doc.number} never changes)</div>
          <div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
            <input className="modal-input" style={{flex: '1 1 200px', width: 'auto'}} value={title} maxLength={120}
              onChange={e => setTitle(e.target.value)} />
            <button className="btn btn-sm btn-ghost" disabled={!title.trim() || title.trim() === doc.title || busy === 'title'}
              onClick={() => void act('title', () => documentsApi.update(doc.id, {title: title.trim()}), 'Title updated — later versions use the new name')}>
              Save title
            </button>
            {doc.status === 'active'
              ? <button className="btn btn-sm btn-danger" disabled={busy === 'status'}
                  onClick={() => void act('status', () => documentsApi.update(doc.id, {status: 'obsolete'}), `${doc.number} marked obsolete`)}>
                  Mark obsolete
                </button>
              : <button className="btn btn-sm btn-ghost" disabled={busy === 'status'}
                  onClick={() => void act('status', () => documentsApi.update(doc.id, {status: 'active'}), `${doc.number} reinstated`)}>
                  Reinstate
                </button>}
          </div>
        </div>
      )}
    </div>
  );
}

function StandardCard() {
  return (
    <Card title="Naming standard">
      <div style={{padding: '10px 14px 14px', fontSize: 12, color: 'var(--tx-2)', lineHeight: 1.7}}>
        <div><b>Documents</b> — <code>BRV-FN 100-001 Expense Tracking Procedure</code>, stored as <code>BRV-FN-100-001_ExpenseTrackingProcedure_v2.pdf</code>.</div>
        <div><b>Exports</b> — date first: <code>20261015T0930_BRV-FN_WalletLedger.csv</code>.</div>
        <div><b>Uploads</b> — <code>20261015T0930_PassportScanFront_v1.jpg</code>; the original name is kept as a label.</div>
        <div style={{color: 'var(--tx-3)', marginTop: 6}}>
          Dates are ISO 8601 (YYYYMMDD, times YYYYMMDDThhmm, 24-hour, UTC). No spaces or special characters;
          words in CamelCase, parts joined with “_”; versions as _v2, _v3. Sub-folders: 100 Policy / Procedures ·
          200 Work Instructions · 300 Forms · 400 Organizational Charts and Drawings.
        </div>
      </div>
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
