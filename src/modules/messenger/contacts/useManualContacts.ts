/**
 * React view of the contacts added by hand (2026-10-23): loads the list for
 * the signed-in account and re-renders on every change (this phone or a
 * linked browser).
 */
import {useEffect, useState} from 'react';
import {getActiveOwnerKey} from '../runtime/runtime';
import {useMessengerStore} from '../store/messengerStore';
import {loadManualContacts, manualContacts, onManualContactsChange, type ManualContact} from './manualContacts';
import type {DiscoveredRow} from './useDiscoveredContacts';

export function useManualContacts(): ManualContact[] {
  const [rows, setRows] = useState<ManualContact[]>(manualContacts());
  useEffect(() => {
    const off = onManualContactsChange(() => setRows(manualContacts()));
    const owner = getActiveOwnerKey() ?? useMessengerStore.getState()._ownUserId ?? null;
    void loadManualContacts(owner).then(() => setRows(manualContacts())).catch(() => undefined);
    return off;
  }, []);
  return rows;
}

/**
 * Address-book matches plus the hand-added contacts who are on Bravo, as one
 * picker list (new chat, new group, add to group). The name you typed wins.
 */
export function withManualContacts(matches: DiscoveredRow[], manual: ManualContact[]): DiscoveredRow[] {
  const byUser = new Map(matches.map(m => [m.userId, m]));
  for (const c of manual) {
    if (!c.userId) {continue;}
    const prev = byUser.get(c.userId);
    byUser.set(c.userId, {
      userId: c.userId, displayName: prev?.displayName ?? c.name, avatarUrl: prev?.avatarUrl ?? null,
      phoneE164: c.phoneE164, localName: c.name,
    });
  }
  return [...byUser.values()].sort((a, b) => a.localName.localeCompare(b.localName));
}
