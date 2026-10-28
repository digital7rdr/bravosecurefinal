/**
 * The web app's rail. Data only (icons are keyed, drawn by the shell) so tests
 * can import it without the React tree.
 */
import {webRoutes} from './routes';
import {managedWorkspaces, type WebMe} from './access';

export type WebNavIcon = 'chat' | 'contacts' | 'group' | 'user' | 'workspace';

export interface WebNavItem {
  href: string;
  label: string;
  icon: WebNavIcon;
}

/**
 * Owner 2026-10-23: "remove book, bookings, secure pro. keep chats and
 * contacts … groups". The web app is the messenger: the same for every
 * account (clients, officers, providers).
 */
export const WEB_NAV: WebNavItem[] = [
  {href: webRoutes.chats, label: 'Chats', icon: 'chat'},
  {href: webRoutes.contacts, label: 'Contacts', icon: 'contacts'},
  {href: webRoutes.groups, label: 'Groups', icon: 'group'},
  {href: webRoutes.account, label: 'Account', icon: 'user'},
];

/**
 * 2026-10-27 (owner) — the rail for THIS account: the messenger items for
 * everyone, plus Workspace for the owner, Admins and Managers of a workspace.
 */
export function webNavFor(me: WebMe | undefined | null): WebNavItem[] {
  if (managedWorkspaces(me).length === 0) return WEB_NAV;
  const at = WEB_NAV.findIndex(i => i.href === webRoutes.account);
  return [...WEB_NAV.slice(0, at), {href: webRoutes.workspace, label: 'Workspace', icon: 'workspace'}, ...WEB_NAV.slice(at)];
}

export function webNavActive(href: string, path: string): boolean {
  if (href === '/') return path === '/' || path === '';
  return path === href || path.startsWith(`${href}/`);
}
