/**
 * The provider console rail. Data only (icons are keyed, drawn by the shell)
 * so tests can import it without the React tree.
 */
import type {ModuleKey} from './api';
import {pvRoutes} from './routes';

export type NavIcon = 'home' | 'shield' | 'star' | 'chat' | 'people' | 'car' | 'key' | 'chart' | 'tree'
  | 'briefcase' | 'check' | 'sitemap' | 'globe' | 'clock' | 'alert' | 'inbox' | 'news';

export interface PvNavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /** Shown to a manager granted ANY of these; the owner always sees it. */
  modules?: ModuleKey[];
  ownerOnly?: boolean;
}
export interface PvNavGroup {label: string; items: PvNavItem[]}

/**
 * 2026-10-31 (owner) — the same functions as the app's agency dashboard:
 * Missions, Job Portal, Compliance, CPO Roster, Org Chart, Departmental
 * (attendance review, incidents, join approvals, channels), Messenger, Bravo
 * Feed, Region, Earnings, Manager Permissions — gated by the same modules.
 */
export const PROVIDER_NAV: PvNavGroup[] = [
  {label: 'Operations', items: [
    {href: pvRoutes.home, label: 'Overview', icon: 'home'},
    {href: pvRoutes.jobs, label: 'Missions', icon: 'shield', modules: ['jobs', 'portal']},
    {href: pvRoutes.portal, label: 'Job Portal', icon: 'briefcase', modules: ['portal']},
    {href: pvRoutes.pro, label: 'Secure Pro', icon: 'star', modules: ['pro']},
    {href: pvRoutes.messages, label: 'Messages', icon: 'chat', modules: ['msg', 'roster']},
    {href: pvRoutes.feed, label: 'Bravo Feed', icon: 'news', modules: ['intel']},
  ]},
  {label: 'Crew & fleet', items: [
    {href: pvRoutes.crew, label: 'CPO Roster', icon: 'people', modules: ['roster']},
    {href: pvRoutes.orgChart, label: 'Org Chart', icon: 'sitemap', modules: ['orgChart']},
    {href: pvRoutes.compliance, label: 'Compliance', icon: 'check', modules: ['compliance']},
    {href: pvRoutes.vehicles, label: 'Vehicles', icon: 'car', modules: ['fleet']},
    {href: pvRoutes.region, label: 'Region', icon: 'globe', modules: ['region']},
    {href: pvRoutes.managers, label: 'Managers', icon: 'key', ownerOnly: true},
  ]},
  {label: 'Departmental', items: [
    {href: pvRoutes.attendance, label: 'Attendance', icon: 'clock', modules: ['dept']},
    {href: pvRoutes.incidents, label: 'Incidents', icon: 'alert', modules: ['dept']},
    {href: pvRoutes.approvals, label: 'Join requests', icon: 'inbox', modules: ['dept']},
    {href: pvRoutes.departments, label: 'Workspace', icon: 'tree', modules: ['dept']},
  ]},
  {label: 'Finance', items: [
    {href: pvRoutes.earnings, label: 'Earnings', icon: 'chart', modules: ['earn']},
  ]},
];

export function navActive(href: string, path: string): boolean {
  if (href === '/') return path === '/' || path === '';
  return path === href || path.startsWith(`${href}/`);
}
