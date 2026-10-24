/**
 * Lazy doors to the group invite sheets (2026-10-24). The sheets pull in the
 * camera and clipboard native modules, so they load only when one is opened —
 * the Messenger home, Groups and Group info screens stay light (and testable).
 */
import React from 'react';

type JoinProps = {onClose: () => void};
type InviteProps = {groupId: string; groupName: string; onClose: () => void};

export function JoinGroupSheet(props: JoinProps): React.JSX.Element {
  const {JoinGroupModal} = require('./GroupInviteModals') as typeof import('./GroupInviteModals');
  return <JoinGroupModal visible {...props} />;
}

export function GroupInviteSheet(props: InviteProps): React.JSX.Element {
  const {GroupInviteModal} = require('./GroupInviteModals') as typeof import('./GroupInviteModals');
  return <GroupInviteModal visible {...props} />;
}
