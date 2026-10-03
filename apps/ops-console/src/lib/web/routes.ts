/**
 * Every path of the Bravo Web App as the BROWSER sees it on the web host (the
 * middleware maps them onto app/web/*). One list, so a moved page cannot leave
 * dead links.
 */
export const webRoutes = {
  home: '/',
  login: '/login',
  chats: '/',
  book: '/book',
  bookLite: '/book?product=lite',
  bookExecutive: '/book?product=executive',
  bookings: '/bookings',
  booking: (id: string) => `/bookings/${encodeURIComponent(id)}`,
  pro: '/pro',
  account: '/account',
} as const;
