import {Type} from 'class-transformer';
import {IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, Max} from 'class-validator';

export class InviteMemberDto {
  // E.164 — same shape the messenger contact lookup normalises to.
  @Matches(/^\+\d{6,15}$/, {message: 'phoneE164 must be E.164'}) phoneE164!: string;
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) spendLimitCredits?: number | null;
  // Why: B-833 — accepted-and-ignored. APKs ≤1.0.304 still send a relationship
  // and `whitelist: true` would 400 the whole invite if the field vanished.
  @IsOptional() @IsString() @MaxLength(40) relationship?: string | null;
}

/** B-835 — the holder roster is paged + searchable (a root may hold thousands). */
export class ListMembersQueryDto {
  @IsOptional() @IsString() @MaxLength(64) q?: string;
  @IsOptional() @IsIn(['active', 'pending', 'held', 'all'] as const)
  status?: 'active' | 'pending' | 'held' | 'all';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class SetSpendLimitDto {
  // null clears the cap (unlimited within the holder's balance).
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) spendLimitCredits?: number | null;
  /** Optional note recorded on the quota-audit row (spec §37). */
  @IsOptional() @IsString() @MaxLength(280) reason?: string | null;
}

/**
 * Spec §11 — a member asks the holder for more spending credit.
 *
 * Note what is NOT here: memberId, quota, remaining or used. Every one of those
 * is derived server-side from the authenticated user (§38), so there is nothing
 * in this body a malicious member could rewrite to grant themselves a limit.
 *
 * `holderId` (B-843) is the ONE exception, and it is not an escape from §38: it
 * is a CHOICE AMONG YOUR OWN MEMBERSHIPS, and the service resolves it as
 * `(member_id = you, holder_id = this)` — a root the caller is not under is a
 * 404, never a request filed against another family. It is required only when
 * the member belongs to two or more roots, because then "my holder" has no
 * answer.
 *
 * `@IsInt` + `@Min(1)` is the §30 gate at the edge: 0, negatives, decimals,
 * NaN and Infinity are all rejected before a service method sees them. The
 * service re-validates with `normalizeCredits` regardless — the DTO is a
 * convenience, not the authority.
 */
export class RequestCreditDto {
  @IsInt() @Min(1) @Max(1_000_000) requestedCredits!: number;
  @IsOptional() @IsString() @MaxLength(280) reason?: string | null;
  @IsOptional() @IsUUID() holderId?: string | null;
}

/** Spec §14 — omit `approvedCredits` to approve in full; supply less for a partial. */
export class ApproveCreditDto {
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000) approvedCredits?: number | null;
  @IsOptional() @IsString() @MaxLength(280) reason?: string | null;
}

/** Spec §15 — the holder may attach a reason the member sees. */
export class RejectCreditDto {
  @IsOptional() @IsString() @MaxLength(280) reason?: string | null;
}

/**
 * B-854 (A11) — the member's ask, and the root's decision.
 *
 * Note what is NOT here on either side: no member id, no holder id, no row id,
 * no amount. The membership row is a PATH parameter scoped to the caller's own
 * side of the pair inside the service, so there is nothing in these bodies a
 * caller could rewrite to widen anybody's access to anybody's money.
 */
export class FundMembersRequestDto {
  @IsOptional() @IsString() @MaxLength(280) reason?: string | null;
}

export class FundMembersDecisionDto {
  @IsOptional() @IsString() @MaxLength(280) reason?: string | null;
}

/**
 * A10 — only `false` is accepted from the app. Turning the switch ON is the
 * approve route, which re-runs every eligibility check under the row lock; a
 * PATCH that could also set `true` would be a second, weaker door to the same
 * grant.
 */
export class SetFundMembersDto {
  @IsIn([false] as const) enabled!: false;
}

export class SetHoldDto {
  // ISO instant the hold lasts until; omit/null lifts the hold.
  @IsOptional() @IsDateString() heldUntilIso?: string | null;
}

export class InviteActionDto {
  @IsString() inviteId!: string;
}

export class ReportLocationDto {
  @IsNumber() @Min(-90) @Max(90) lat!: number;
  @IsNumber() @Min(-180) @Max(180) lng!: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100_000) accuracyM?: number | null;
}
