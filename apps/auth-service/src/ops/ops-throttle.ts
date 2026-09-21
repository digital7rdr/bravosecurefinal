/**
 * The ops console's per-USER rate limit.
 *
 * Why this exists (booking-lane critic, 2026-09-04): the global HTTP throttler
 * now ENFORCES by default and, because APP_GUARDs run before JwtAuthGuard, its
 * bucket is keyed per IP. No ops controller bound a throttler, so every `/ops/*`
 * route fell into that IP bucket — and the console is a browser SWR client
 * polling at 2 s / 5 s with 5–10 hooks per page. Four seats behind one office
 * NAT share one bucket and 429 each other out of the console.
 *
 * Binding a `ThrottlerGuard` subclass on the controller makes
 * `GlobalHttpThrottlerGuard.shouldSkip` return true for these routes (it scans
 * `__guards__` on the class and the handler), so an ops user is limited per USER
 * and never per shared egress IP. That is the same carve-out telemetry, SOS,
 * dispatch, family and vbg/news already rely on.
 *
 * The number: a console page runs up to ~10 SWR hooks, the fastest at 2 s, so a
 * single tab's worst case is ~300 req/min. An operator legitimately keeps several
 * tabs open (a live mission, the SOS board, a booking). 1200/min = four
 * worst-case tabs with headroom, while still bounding a runaway render loop at
 * 20 rps instead of letting it saturate the 20-connection pg pool.
 *
 * ⚠️ Storage is the in-memory default (see AppModule), so this limit — like every
 * other — is multiplied by the replica count. Redis-backed ThrottlerStorage is
 * required before a second replica.
 */
export const OPS_THROTTLE = {default: {limit: 1200, ttl: 60_000}} as const;
