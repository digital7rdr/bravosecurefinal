'use client';

/**
 * Enterprise structure editor (2026-10-15) — Bravo console view of ONE
 * organisation. The editor itself is features/enterpriseStructure; this page
 * binds it to /ops/enterprise/orgs/:id/structure.
 *
 * Founder request: "enterprise department channels — parent company,
 * departments, child entities and sub-entities and departments under it …
 * configurable from the backend." Nodes (organisation › country › province ›
 * area), each node a chat; each level's template channels; member placement.
 * The organisation's own owner has the same editor in the provider console.
 */

import {use, useMemo} from 'react';
import {enterpriseStructureApi, useEnterpriseStructure, useOpsMe} from '@/lib/api';
import {PageHeader} from '@/components/PageHeader';
import {routes} from '@/lib/routes';
import {hasRole} from '@/lib/rbac';
import {StructureEditor, type StructureClient} from '@/features/enterpriseStructure/StructureEditor';

export default function StructurePage({params}: {params: Promise<{id: string}>}) {
  const {id} = use(params);
  const {data, error, isLoading, mutate} = useEnterpriseStructure(id);
  const {data: me} = useOpsMe();
  const canWrite = hasRole(me?.admin.role, 'SUPERVISOR');
  const orgName = data?.org.workspace_name ?? data?.org.display_name ?? 'Organisation';
  const client = useMemo<StructureClient>(() => ({
    createNode: body => enterpriseStructureApi.createNode(id, body),
    createChannel: body => enterpriseStructureApi.createChannel(id, body),
    updateChannel: (c, body) => enterpriseStructureApi.updateChannel(id, c, body),
    archive: c => enterpriseStructureApi.archive(id, c),
    unarchive: c => enterpriseStructureApi.unarchive(id, c),
    applyTemplate: c => enterpriseStructureApi.applyTemplate(id, c),
    setTemplates: body => enterpriseStructureApi.setTemplates(id, body),
    setLevelNames: names => enterpriseStructureApi.setLevelNames(id, names),
    place: (users, c) => enterpriseStructureApi.place(id, users, c),
  }), [id]);

  return (
    <>
      <PageHeader
        crumbs={['Enterprise', 'Workspaces', data?.org.display_name ?? '…', 'Structure']}
        back={{href: routes.enterprise.org(id), label: data?.org.display_name ?? 'Organisation'}}
        title="Channel structure"
        subtitle={<>Levels, channels and who sits where for <b>{orgName}</b>.</>}
      />
      {error && (
        <div className="card" style={{padding: 24, color: 'var(--err)'}}>
          Could not load this organisation&apos;s structure. It may not exist, or it may be outside your region scope.
        </div>
      )}
      {isLoading && !data && <div className="card"><div className="skel-row" /><div className="skel-row" /></div>}
      {data && (
        <StructureEditor data={data} client={client} canWrite={canWrite} reload={() => void mutate()}
          readOnlyNote="Read-only: changing the structure needs a supervisor or admin role." />
      )}
    </>
  );
}
