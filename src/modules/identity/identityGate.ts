/**
 * B-867 — the client half of the identity-document gate ("all individual users
 * have to submit their ID / passport … after submission they can start a
 * Secure booking, if not the system tells them where to go").
 *
 * The SERVER is the boundary (BookingService.create / ProApplicationsService
 * .create refuse with `identity_document_required`); everything here is the
 * courtesy layer that stops the user before the refusal and routes them to
 * the one place that clears it: Profile → Identity verification.
 */
import {Alert} from '@utils/alert';
import type {User} from '@/types';

export const IDENTITY_DOCUMENT_REQUIRED = 'identity_document_required';

export type IdentityFacts = Pick<User, 'identity_document_status' | 'identity_document_required'>;

/**
 * True when THIS account must submit before it may book. Fail-OPEN when the
 * server has not reported (older server, snapshot from before the field
 * existed): the client never invents a wall the server does not hold; the
 * server refusal is still caught by `isIdentityRequiredError`.
 */
export function needsIdentityDocument(u: IdentityFacts | null | undefined): boolean {
  if (!u) {return false;}
  if (u.identity_document_status === 'submitted') {return false;}
  return u.identity_document_required === true;
}

/** Matches the server refusal in every shape it reaches a screen: the raw
 *  axios error, the booking store's normalised re-throw (`code` copied on),
 *  and the Pro store's humanised Error (which carries `code` too). */
export function isIdentityRequiredError(e: unknown): boolean {
  const err = e as {code?: unknown; response?: {data?: {code?: unknown; message?: unknown}}} | null | undefined;
  if (!err || typeof err !== 'object') {return false;}
  if (err.code === IDENTITY_DOCUMENT_REQUIRED) {return true;}
  const body = err.response?.data;
  return body?.code === IDENTITY_DOCUMENT_REQUIRED || body?.message === IDENTITY_DOCUMENT_REQUIRED;
}

export const IDENTITY_REQUIRED_TITLE = 'Identity verification required';
export const IDENTITY_REQUIRED_BODY =
  'Add your ID or passport under Profile → Identity verification before you book. It takes a minute.';

/** The "system tells them where to go" alert. `openIdentity` navigates to the
 *  IdentityDocument screen in whatever stack the caller lives in. */
export function promptIdentityRequired(openIdentity: () => void): void {
  Alert.alert(IDENTITY_REQUIRED_TITLE, IDENTITY_REQUIRED_BODY, [
    {text: 'Later', style: 'cancel'},
    {text: 'Verify now', onPress: openIdentity},
  ]);
}
