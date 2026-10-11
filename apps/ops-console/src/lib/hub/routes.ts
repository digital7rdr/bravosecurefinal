/**
 * Paths of the Bravo Secure home site as the BROWSER sees them on
 * bravosecure.cloud (the middleware maps them onto app/hub/*).
 */
export const hubRoutes = {
  home: '/',
  login: '/login',
  register: '/register',
  forgot: '/forgot',
  security: '/security',
} as const;
