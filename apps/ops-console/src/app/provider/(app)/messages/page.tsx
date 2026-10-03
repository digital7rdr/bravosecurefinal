'use client';

/**
 * Messages (provider console, 2026-10-03) — the ops console's encrypted 1:1
 * chat, pointed at this agency's own roster. Same Signal sessions, Sealed
 * Sender and relay as the Bravo app, so an officer reads it in the app's
 * Messenger like any other chat. History stays in this browser's vault.
 */

import {useMemo} from 'react';
import {NotGranted, useProvider} from '@/components/provider/ProviderShell';
import {PvPage} from '@/components/provider/ui';
import {ChatWorkspace, type ChatDirectory, type ChatPerson} from '@/features/messenger/ChatWorkspace';
import {pvApi, type RosterMember} from '@/lib/provider/api';

const ROLE: Record<RosterMember['member_role'], string> = {cpo: 'Officer', manager: 'Manager', employee: 'Employee'};

function toPerson(m: RosterMember): ChatPerson {
  const bits = [ROLE[m.member_role] ?? m.member_role, m.call_sign, m.status === 'suspended' ? 'suspended' : null].filter(Boolean);
  return {id: m.member_user_id, name: m.display_name ?? m.call_sign ?? 'Officer', subtitle: bits.join(' · ')};
}

export default function ProviderMessages() {
  const {orgId, can, context} = useProvider();
  const allowed = can('msg', 'roster');
  const selfId = context.user.id;

  const directory = useMemo<ChatDirectory>(() => {
    let cache: {at: number; rows: RosterMember[]} | null = null;
    const roster = async () => {
      if (!cache || Date.now() - cache.at > 60_000) {
        cache = {at: Date.now(), rows: (await pvApi.roster()).filter(m => m.status !== 'removed' && m.member_user_id !== selfId)};
      }
      return cache.rows;
    };
    return {
      search: async q => {
        const n = q.toLowerCase();
        return (await roster())
          .filter(m => `${m.display_name ?? ''} ${m.call_sign ?? ''} ${m.email ?? ''}`.toLowerCase().includes(n))
          .slice(0, 12).map(toPerson);
      },
      get: async id => {
        const m = (await roster()).find(r => r.member_user_id === id);
        return m ? toPerson(m) : null;
      },
      searchPlaceholder: 'New chat — search your officers by name or call sign',
      searchError: () => 'Could not load your roster.',
      // Per agency: switching agency must not mark the other one's chats read.
      seenKey: `bravo_pv_chat_seen_v1:${orgId}`,
      title: 'Chats with your team',
    };
  }, [orgId, selfId]);

  if (!allowed) return <PvPage title="Messages"><NotGranted what="Messenger"/></PvPage>;

  return (
    <PvPage title="Messages"
      subtitle="End-to-end encrypted chat with your officers and managers. They read and reply in the Bravo Secure app's Messenger.">
      <ChatWorkspace directory={directory}/>
    </PvPage>
  );
}
