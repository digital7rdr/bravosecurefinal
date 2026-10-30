/**
 * Every path of the Bravo Web App as the BROWSER sees it on the web host (the
 * middleware maps them onto app/web/*). One list, so a moved page cannot leave
 * dead links.
 *
 * Owner 2026-10-23 — the rail is the messenger (Chats, Contacts, Groups,
 * Account). Owner 2026-10-30 — Secure Services (Book, My bookings, Secure Pro)
 * is back for Pro and Enterprise clients, opened from the home site's Secure
 * Services tile, kept OUT of the messenger rail.
 */
export const webRoutes = {
  home: '/',
  login: '/login',
  chats: '/',
  contacts: '/contacts',
  groups: '/groups',
  account: '/account',
  /** Secure Services (2026-10-30): the home site tile opens /book. */
  book: '/book',
  bookings: '/bookings',
  booking: (id: string) => `/bookings/${encodeURIComponent(id)}`,
  pro: '/pro',
  /** 2026-10-27 — members, roles and channels of a workspace you run. */
  workspace: '/workspace',
} as const;
