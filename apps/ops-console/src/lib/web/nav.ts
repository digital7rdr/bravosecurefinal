/**
 * The web app's rail. Data only (icons are keyed, drawn by the shell) so tests
 * can import it without the React tree.
 */
import {webRoutes} from './routes';
import {managedWorkspaces, type WebMe} from './access';

export type WebNavIcon = 'chat' | 'contacts' | 'group' | 'user' | 'workspace' | 'plus' | 'list' | 'star';

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

/**
 * Owner 2026-10-30 — Secure Services has its OWN rail ("when i click secure
 * services … the menu links at the left all shows the menu items of the
 * messenger"). Account is shared (ID document, sign-out).
 */
export const WEB_SERVICES_NAV: WebNavItem[] = [
  {href: webRoutes.book, label: 'Book', icon: 'plus'},
  {href: webRoutes.bookings, label: 'My bookings', icon: 'list'},
  {href: webRoutes.pro, label: 'Secure Pro', icon: 'star'},
  {href: webRoutes.account, label: 'Account', icon: 'user'},
];

/** Which product the web app is showing: Messenger or Secure Services. */
export type WebSection = 'messenger' | 'services';

const SERVICES_PATHS = [webRoutes.book, webRoutes.bookings, webRoutes.pro];

/**
 * The section for a path. Secure Services pages → services; the messenger
 * pages → messenger; a shared page (Account) keeps the section you came from.
 */
export function webSectionFor(path: string, previous: WebSection): WebSection {
  if (SERVICES_PATHS.some(h => webNavActive(h, path))) return 'services';
  if (webNavActive(webRoutes.account, path)) return previous;
  return 'messenger';
}

/** The rail for this account in this section. */
export function webRailFor(me: WebMe | undefined | null, section: WebSection): WebNavItem[] {
  return section === 'services' ? WEB_SERVICES_NAV : webNavFor(me);
}

export function webNavActive(href: string, path: string): boolean {
  if (href === '/') return path === '/' || path === '';
  return path === href || path.startsWith(`${href}/`);
}
