'use client';

import Link from 'next/link';
import {useState} from 'react';
import {useSWRConfig} from 'swr';
import {useProvider} from '@/components/provider/ProviderShell';
import {Empty, PvCard, PvPage} from '@/components/provider/ui';
import {useToast} from '@/components/Toast';
import {pvApi, usePvManagers, type ModuleKey} from '@/lib/provider/api';
import {CONSOLE_MODULES, MODULE_LABEL, errorText} from '@/lib/provider/labels';
import {pvRoutes} from '@/lib/provider/routes';

const APP_ONLY: ModuleKey[] = ['compliance', 'orgChart', 'dept', 'msg', 'intel', 'region'];

const HELP: Partial<Record<ModuleKey, string>> = {
  jobs: 'Crew, dispatch, track and complete jobs; answer offers',
  portal: 'Answer offers and claim open jobs',
  roster: 'Add, invite and suspend officers',
  earn: 'See job values, fees and payouts',
};

export default function ProviderManagers() {
  const {orgId, isOwner} = useProvider();
  const {data, error} = usePvManagers(orgId, isOwner);
  const {mutate} = useSWRConfig();
  const {push} = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  if (!isOwner) {
    return (
      <PvPage title="Managers">
        <PvCard><p className="text-sm text-t3" style={{margin: 0}}>Only the agency owner can change what managers can open.</p></PvCard>
      </PvPage>
    );
  }

  async function toggle(userId: string, current: string[], key: ModuleKey) {
    const next = current.includes(key) ? current.filter(k => k !== key) : [...current, key];
    setBusy(`${userId}:${key}`);
    try {
      await pvApi.setPermissions(userId, next);
      await mutate(['pv', orgId, 'managers']);
    } catch (e) { push({kind: 'err', text: errorText(e)}); }
    finally { setBusy(null); }
  }

  return (
    <PvPage title="Managers" subtitle="Choose what each manager can open. The same settings apply in the app and in this console, and Bravo Secure enforces them on every action.">
      <PvCard pad={false}>
        {error ? <Empty>Could not load managers.</Empty>
          : !data ? <Empty>Loading…</Empty>
          : data.length === 0 ? <Empty>No managers yet. Make an officer a manager on the <Link href={pvRoutes.crew}>Officers</Link> page.</Empty>
          : (
            <div className="pv-table-wrap">
              <table className="pv-table pv-perm">
                <thead>
                  <tr>
                    <th>Manager</th>
                    {CONSOLE_MODULES.map(k => <th key={k} title={HELP[k]}>{MODULE_LABEL[k]}</th>)}
                    <th>In the app only</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map(m => (
                    <tr key={m.user_id}>
                      <td>
                        <div>{m.display_name ?? 'Unnamed'} {m.call_sign && <span className="pv-mono pv-cell-sub">· {m.call_sign}</span>}</div>
                        <div className="pv-cell-sub">{m.email ?? ''}{m.status !== 'active' ? ` · ${m.status}` : ''}</div>
                      </td>
                      {CONSOLE_MODULES.map(k => {
                        const on = m.permitted_modules.includes(k);
                        return (
                          <td key={k}>
                            <button role="switch" aria-checked={on} aria-label={`${MODULE_LABEL[k]} for ${m.display_name ?? 'manager'}`}
                              className={`pv-switch ${on ? 'on' : ''}`} disabled={busy === `${m.user_id}:${k}`}
                              onClick={() => toggle(m.user_id, m.permitted_modules, k)}>
                              <span/>
                            </button>
                          </td>
                        );
                      })}
                      <td className="pv-cell-sub">
                        {APP_ONLY.filter(k => m.permitted_modules.includes(k)).map(k => MODULE_LABEL[k]).join(', ') || 'None'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </PvCard>
      <p className="pv-hint" style={{marginTop: 12}}>
        Org chart, departmental, messenger, Bravo Feed, compliance and region are set in the app under Manager Permissions.
      </p>
    </PvPage>
  );
}
