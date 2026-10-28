/**
 * Every path of the Bravo Web App as the BROWSER sees it on the web host (the
 * middleware maps them onto app/web/*). One list, so a moved page cannot leave
 * dead links.
 *
 * Owner 2026-10-23 — the web app is a messenger only: Book, Bookings and
 * Secure Pro were removed (their old paths redirect to Chats).
 */
export const webRoutes = {
  home: '/',
  login: '/login',
  chats: '/',
  contacts: '/contacts',
  groups: '/groups',
  account: '/account',
  /** 2026-10-27 — members, roles and channels of a workspace you run. */
  workspace: '/workspace',
} as const;
