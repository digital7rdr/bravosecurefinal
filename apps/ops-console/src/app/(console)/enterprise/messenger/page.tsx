'use client';

import {useState} from 'react';
import {PageHeader} from '@/components/PageHeader';
import {ChatWorkspace} from '@/features/messenger/ChatWorkspace';
import {BroadcastsLog} from '@/features/messenger/BroadcastsLog';

/**
 * Messenger (2026-09-30): encrypted 1:1 chats with clients, CPO agents and
 * provider agencies — the same protocol as the mobile messenger — plus the
 * read-only system broadcast log it used to be on its own.
 */
export default function MessengerPage() {
  const [tab, setTab] = useState<'chats' | 'broadcasts'>('chats');
  return (
    <div style={{display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0}}>
      <PageHeader
        title="Messenger"
        subtitle="End-to-end encrypted chats with clients, agents and agencies, as in the Bravo app."
      />
      <div style={{display: 'flex', gap: 8, marginBottom: 14}}>
        <button type="button" className={`rtab${tab === 'chats' ? ' on' : ''}`} onClick={() => setTab('chats')}>Chats</button>
        <button type="button" className={`rtab${tab === 'broadcasts' ? ' on' : ''}`} onClick={() => setTab('broadcasts')}>System broadcasts</button>
      </div>
      {tab === 'chats' ? <ChatWorkspace /> : <BroadcastsLog />}
    </div>
  );
}
