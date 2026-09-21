/**
 * Referral deep links (2026-09-05) — the ONE place the link shapes live, so the
 * ops detail page, the public landing and the app agree on them.
 *
 *   web:  https://<console>/r/<CODE>      (public landing; works with no app)
 *   app:  bravosecure://r/<CODE>          (custom scheme the app registers)
 *
 * The mobile parser (src/modules/referral/referralLinks.ts) accepts BOTH.
 */
import {routes} from './routes';

export const REFERRAL_APP_SCHEME = 'bravosecure';
export const ANDROID_PACKAGE = 'com.bravosecure.app';

export function normaliseReferralCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

export function referralAppLink(code: string): string {
  return `${REFERRAL_APP_SCHEME}://r/${encodeURIComponent(normaliseReferralCode(code))}`;
}

export function referralWebLink(origin: string, code: string): string {
  return `${origin.replace(/\/$/, '')}${routes.referralLanding(normaliseReferralCode(code))}`;
}

export function playStoreLink(): string {
  return `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`;
}
