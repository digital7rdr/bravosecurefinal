/**
 * Every path of the service provider console, as the BROWSER sees it on the
 * provider host (the middleware maps them onto app/provider/*). One list, like
 * lib/routes.ts for the ops console, so a moved page cannot leave dead links.
 */
export const pvRoutes = {
  home: '/',
  login: '/login',
  jobs: '/jobs',
  assign: (bookingId: string) => `/jobs?assign=${encodeURIComponent(bookingId)}`,
  mission: (missionId: string) => `/jobs/${encodeURIComponent(missionId)}`,
  crew: '/crew',
  vehicles: '/vehicles',
  pro: '/pro',
  messages: '/messages',
  managers: '/managers',
  /** The agency's levels, channels and who sits where (2026-10-15). */
  departments: '/departments',
  earnings: '/earnings',
  /* 2026-10-31 (owner: "the Service provider, agent web portal should have
     the same functions as the Mobile app") — the app's agency dashboard rows. */
  portal: '/portal',
  compliance: '/compliance',
  orgChart: '/org-chart',
  region: '/region',
  attendance: '/attendance',
  incidents: '/incidents',
  incident: (id: string) => `/incidents/${encodeURIComponent(id)}`,
  approvals: '/approvals',
  feed: '/feed',
} as const;
