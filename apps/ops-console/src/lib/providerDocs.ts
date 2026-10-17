/**
 * Provider onboarding documents (2026-10-17 — "Ops console can't verify
 * service provider docs"). Shared by the Compliance Review queue and the
 * agency page, so both stamp a file reviewed the same way the agent review
 * page always has (POST /ops/agents/:id/docs|kyc/:key/review).
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
 * Stamp a provider document reviewed when the reviewer may decide (SUPERVISOR+,
 * enforced server-side too). The file itself is shown in the console's
 * document viewer modal by the caller. Returns whether the stamp was written.
 */
export async function markProviderDocReviewed(
  providerUserId: string, source: 'doc' | 'kyc', key: string, canStamp: boolean,
): Promise<boolean> {
  if (!canStamp) {return false;}
  if (source === 'doc') {await opsApi.reviewDoc(providerUserId, key);}
  else {await opsApi.reviewKyc(providerUserId, key);}
  return true;
}
