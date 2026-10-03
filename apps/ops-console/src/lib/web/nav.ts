/**
 * The web app's rail. Data only (icons are keyed, drawn by the shell) so tests
 * can import it without the React tree.
 */
import {webRoutes} from './routes';

export type WebNavIcon = 'chat' | 'plus' | 'list' | 'star' | 'user';

export interface WebNavItem {
  href: string;
  label: string;
  icon: WebNavIcon;
  /** Booking pages are for client accounts only (see canBook). */
  clientsOnly?: boolean;
}

export const WEB_NAV: WebNavItem[] = [
  {href: webRoutes.chats, label: 'Chats', icon: 'chat'},
  {href: webRoutes.book, label: 'Book', icon: 'plus', clientsOnly: true},
  {href: webRoutes.bookings, label: 'Bookings', icon: 'list', clientsOnly: true},
  {href: webRoutes.pro, label: 'Secure Pro', icon: 'star', clientsOnly: true},
  {href: webRoutes.account, label: 'Account', icon: 'user'},
];

export function webNavActive(href: string, path: string): boolean {
  if (href === '/') return path === '/' || path === '';
  return path === href || path.startsWith(`${href}/`);
}
