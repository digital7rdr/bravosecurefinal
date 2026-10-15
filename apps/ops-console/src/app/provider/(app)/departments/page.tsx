'use client';

/**
 * Departments (provider console, 2026-10-15).
 *
 * Owner report: "I don't see the departments in the provider account." The
 * agency's own levels (company › region › branch › team), each level's
 * channels, templates and who sits where — the same editor Bravo ops has,
 * bound to /org/structure for the organisation chosen in this console.
 */

import {useMemo} from 'react';
import {useSWRConfig} from 'swr';
import {NotGranted, useProvider} from '@/components/provider/ProviderShell';
import {PvPage} from '@/components/provider/ui';
import {pvStructureApi, usePvStructure} from '@/lib/provider/api';
import {StructureEditor, type StructureClient} from '@/features/enterpriseStructure/StructureEditor';

export default function ProviderDepartments() {
  const {orgId, can} = useProvider();
  const allowed = can('dept');
  const {data, error} = usePvStructure(orgId, allowed);
  const {mutate} = useSWRConfig();
  const client = useMemo<StructureClient>(() => ({
    createNode: pvStructureApi.createNode,
    createChannel: pvStructureApi.createChannel,
    updateChannel: pvStructureApi.updateChannel,
    archive: pvStructureApi.archive,
    unarchive: pvStructureApi.unarchive,
    applyTemplate: pvStructureApi.applyTemplate,
    setTemplates: pvStructureApi.setTemplates,
    setLevelNames: pvStructureApi.setLevelNames,
    place: pvStructureApi.place,
  }), []);

  if (!allowed) {return <PvPage title="Departments"><NotGranted what="Departments" /></PvPage>;}

  return (
    <PvPage title="Departments" subtitle="Your levels, their channels, and who sits where. Members see their own level and everything below it.">
      {error && <div className="card" style={{padding: 20, color: 'var(--err)'}}>Could not load your departments.</div>}
      {!data && !error && <div className="card"><div className="skel-row" /><div className="skel-row" /></div>}
      {data && (
        <StructureEditor data={data} client={client} canWrite={data.can_edit}
          reload={() => void mutate(['pv', orgId, 'structure'])}
          readOnlyNote="You manage one department, so the structure is read-only for you. The agency owner can change it." />
      )}
    </PvPage>
  );
}
