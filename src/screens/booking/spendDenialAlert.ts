import {Alert} from '@utils/alert';
import {navigateOnce, type NavigateCapableNavigation} from '@navigation/tapGuard';
import {spendDenialKind, quotaFiguresFrom, holderFrom} from './creditErrors';

/**
 * B-724 — the family-limit refusal must carry its own door.
 *
 * B-709 built `spendDenialKind`/`quotaFiguresFrom` precisely so the refusal
 * alert could offer "Request More Credit", but every surface rendered the
 * dead-end `humanCreditMessage` string instead ("ask your plan holder…"),
 * and the working request card (FamilyQuotaCard on IndividualProfile) was
 * only findable by browsing there on your own — which the client never did.
 *
 * Returns true when the error WAS a family-quota refusal and the alert (with
 * the CTA) was shown; the caller then skips its generic error alert. Any
 * other error returns false and is handled by the caller as before.
 */
export function showSpendDenialAlert(
  e: unknown,
  navigation: (NavigateCapableNavigation & object) | null | undefined,
): boolean {
  if (spendDenialKind(e) !== 'SPENDING_QUOTA_EXCEEDED') {return false;}
  const f = quotaFiguresFrom(e);
  // §48 — numbers only from the server's own refusal body, never guessed.
  const figures = f
    ? `\n\nLimit ${f.allocated} cr · used ${f.used} cr · remaining ${f.remaining} cr. This booking needs ${f.required} cr.`
    : '';
  // B-843/A11 — WHICH root refused. With several roots "your plan holder"
  // names nobody, and the profile shows a card per root, so the id rides the
  // navigation to highlight the one this refusal is about. Both halves come
  // from the server's own body: a guessed name on a money refusal is worse
  // than the neutral wording.
  const holder = holderFrom(e);
  const named = holder?.holderName ?? null;
  Alert.alert(
    named ? `Spending limit reached on ${named}’s plan` : 'Spending limit reached',
    `You’ve reached your member spending limit${named ? ` on ${named}’s plan` : ''} — nothing was charged.` +
      `${figures}\n\nYou can send ${named ? named : 'your plan holder'} a request for more credit.`,
    [
      {text: 'Not now', style: 'cancel'},
      {
        text: 'Request More Credit',
        onPress: () => {
          if (holder?.holderId) {
            navigateOnce(navigation, 'IndividualProfile', {focusHolderId: holder.holderId});
          } else {
            navigateOnce(navigation, 'IndividualProfile');
          }
        },
      },
    ],
  );
  return true;
}
