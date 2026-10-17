/**
 * Provider onboarding documents (2026-10-17 — "Ops console can't verify
 * service provider docs"). Shared by the Compliance Review queue and the
 * agency page, so both open a file and stamp it reviewed the same way the
 * agent review page always has (POST /ops/agents/:id/docs|kyc/:key/review).
 */
import {opsApi} from './api';

export const KYC_LABEL: Record<string, string> = {
  gov_id: 'Gov ID', proof_address: 'Proof of Address',
  sia_licence: 'Protection Licence', police: 'Police / DBS',
};

/** Only http(s) links are opened — anything else is not a file we served. */
export function isViewableUrl(url: string | null | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url);
}

export function providerDocLabel(source: 'doc' | 'kyc', key: string, title: string | null | undefined): string {
  if (source === 'kyc') {return KYC_LABEL[key] ?? title ?? key;}
  return title || key;
}

/**
 * Open the file in a new tab; when the reviewer may decide (SUPERVISOR+,
 * enforced server-side too) also stamp it reviewed. Returns whether the stamp
 * was written.
 */
export async function openAndMarkReviewed(
  providerUserId: string, source: 'doc' | 'kyc', key: string, url: string, canStamp: boolean,
): Promise<boolean> {
  if (isViewableUrl(url)) {window.open(url, '_blank', 'noopener');}
  if (!canStamp) {return false;}
  if (source === 'doc') {await opsApi.reviewDoc(providerUserId, key);}
  else {await opsApi.reviewKyc(providerUserId, key);}
  return true;
}
