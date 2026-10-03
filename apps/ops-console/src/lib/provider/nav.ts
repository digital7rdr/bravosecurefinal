/**
 * The provider console rail. Data only (icons are keyed, drawn by the shell)
 * so tests can import it without the React tree.
 */
import type {ModuleKey} from './api';
import {pvRoutes} from './routes';

export type NavIcon = 'home' | 'shield' | 'star' | 'people' | 'car' | 'key' | 'chart';

export interface PvNavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /** Shown to a manager granted ANY of these; the owner always sees it. */
  modules?: ModuleKey[];
  ownerOnly?: boolean;
}
export interface PvNavGroup {label: string; items: PvNavItem[]}

export const PROVIDER_NAV: PvNavGroup[] = [
  {label: 'Operations', items: [
    {href: pvRoutes.home, label: 'Overview', icon: 'home'},
    {href: pvRoutes.jobs, label: 'Jobs', icon: 'shield', modules: ['jobs', 'portal']},
    {href: pvRoutes.pro, label: 'Secure Pro', icon: 'star', modules: ['pro']},
  ]},
  {label: 'Crew & fleet', items: [
    {href: pvRoutes.crew, label: 'Officers', icon: 'people', modules: ['roster']},
    {href: pvRoutes.vehicles, label: 'Vehicles', icon: 'car', modules: ['fleet']},
    {href: pvRoutes.managers, label: 'Managers', icon: 'key', ownerOnly: true},
  ]},
  {label: 'Finance', items: [
    {href: pvRoutes.earnings, label: 'Earnings', icon: 'chart', modules: ['earn']},
  ]},
];

export function navActive(href: string, path: string): boolean {
  if (href === '/') return path === '/' || path === '';
  return path === href || path.startsWith(`${href}/`);
}
