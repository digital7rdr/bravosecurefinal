import {IsOptional, IsUUID} from 'class-validator';

/**
 * POST /bookings/:id/pay-with-credits — B-843 (A10).
 *
 * The body is entirely optional: with nothing in it the charge uses the payer
 * stamped on the booking at creation, which is the normal path. `payerUserId`
 * is for the two cases where the stamp is not the answer — a booking created
 * before the stamp existed, and a member RE-firing the charge after a
 * `PAYER_CHOICE_REQUIRED` / `PAYER_NOT_ELIGIBLE` refusal, having picked another
 * root or their own wallet.
 *
 * It is a CHOICE, never an instruction: the service re-resolves it through
 * `FamilyService.resolvePayer(clientId, …)`, which refuses any id that is not
 * the caller themselves or one of the caller's own live, non-held memberships.
 *
 * camelCase to match `SetSpendLimitDto` and the other body DTOs — `whitelist:
 * true` silently STRIPS a mis-cased key, and a stripped payer would charge the
 * default one without anyone seeing an error.
 */
export class PayWithCreditsDto {
  @IsOptional() @IsUUID() payerUserId?: string;
}
