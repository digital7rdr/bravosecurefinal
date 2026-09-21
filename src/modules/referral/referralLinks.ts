/**
 * Referral deep links (2026-09-05) — the ONE parser for the two link shapes
 * ops shares:
 *
 *   bravosecure://r/<CODE>                     (custom scheme the app registers)
 *   https://<console-host>/r/<CODE>            (public landing; opens the app when
 *                                               Android has verified the host,
 *                                               otherwise the page's button does)
 *
 * Mirrors apps/ops-console/src/lib/referralLinks.ts. Kept free of RN / Expo
 * imports so the node `booking` Jest project can pin it.
 */

export const REFERRAL_SCHEME = 'bravosecure';

/** Same charset + cap as the booking-side field and the server DTO. */
export function normaliseReferralCode(raw: string | null | undefined): string {
  return (raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/^-+/, '')
    .slice(0, 32);
}

/**
 * The code carried by a referral URL, or null when the URL is not one.
 *
 * Only OUR link shapes qualify: the custom scheme, or an http(s) URL whose
 * path is exactly /r/<code>. A code shorter than two characters is treated as
 * noise, matching the server's minimum.
 */
export function parseReferralUrl(url: string | null | undefined): string | null {
  if (!url) {return null;}
  const s = url.trim();
  const m = /^(bravosecure:\/{0,3}|https?:\/\/[^/?#]+\/)r\/([^/?#]+)(?:[/?#].*)?$/i.exec(s);
  if (!m) {return null;}
  let raw = m[2];
  try { raw = decodeURIComponent(raw); } catch { /* keep as-is */ }
  const code = normaliseReferralCode(raw);
  return code.length >= 2 ? code : null;
}
