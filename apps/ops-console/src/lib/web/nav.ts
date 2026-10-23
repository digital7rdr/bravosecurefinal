/**
 * The web app's rail. Data only (icons are keyed, drawn by the shell) so tests
 * can import it without the React tree.
 */
import {webRoutes} from './routes';

export type WebNavIcon = 'chat' | 'contacts' | 'group' | 'user';

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

export function webNavActive(href: string, path: string): boolean {
  if (href === '/') return path === '/' || path === '';
  return path === href || path.startsWith(`${href}/`);
}
