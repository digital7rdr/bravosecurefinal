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
  managers: '/managers',
  earnings: '/earnings',
} as const;
