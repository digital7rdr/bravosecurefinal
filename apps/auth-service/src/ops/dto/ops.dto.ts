import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsISO8601,
  IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, IsUUID, Length, Matches,
  MaxLength, Min, Max, MinLength, ValidateNested,
} from 'class-validator';
import {Type} from 'class-transformer';

// Audit fix 1.4 — Cap on every free-form text field so an attacker
// can't push GB of "notes" into the audit log. 1024 covers ops's
// realistic verbosity for reasons / notes / resolutions; longer
// dress briefs allowed up to 2048.
const NOTES_MAX  = 1024;
const REASON_MAX = 1024;
const TEXT_MAX   = 2048;

/**
 * Audit fix 4.2 — click-to-reveal PII audit event. The ops console
 * masks customer phone/email/address by default; clicking to unmask
 * sends one of these so every reveal lands in `ops_audit` with the
 * admin's user_id + call_sign + which kind of field on which subject.
 */
export class PiiRevealDto {
  @IsIn(['phone', 'email', 'address'])
  kind!: 'phone' | 'email' | 'address';
  // The booking / agent / mission id the PII belongs to. UUID kept loose
  // (no @IsUUID) because audit rows accept any subject id shape.
  @IsString() @MaxLength(128) subject!: string;
}

export class ApproveBookingDto {
  @IsOptional() @IsString() @MaxLength(NOTES_MAX) notes?: string;
  // Dress brief is mandatory at publish — agents need it on the apply
  // sheet so they can pledge what they'll wear. Min 8 chars to block
  // empty / placeholder submissions.
  @IsString() @MinLength(8) @MaxLength(TEXT_MAX) dress_instructions!: string;
  /**
   * E2E-04 — deliberate override for a `booking_insufficient_lead_time` refusal:
   * the start is still in the future but inside the service's configured lead,
   * and the operator is accepting the shortened dispatch runway. It does NOT
   * override `booking_start_time_passed` — a block that already began is a
   * reject-and-refund, never an approve.
   */
  @IsOptional() @IsBoolean() approve_late?: boolean;
}

export class RejectBookingDto {
  @IsString() @MaxLength(REASON_MAX) reason!: string;
  @IsOptional() @IsString() @MaxLength(NOTES_MAX) notes?: string;
}

export class AssignCrewDto {
  @IsUUID()   job_id!: string;
  @IsArray()  @ArrayMinSize(1) @ArrayMaxSize(20)
  @IsUUID('all', {each: true}) agent_ids!: string[];
}

export class ShortlistApplicationDto {
  @IsUUID() application_id!: string;
}

export class AgentDecisionDto {
  @IsIn(['APPROVED', 'REJECTED'] as const)
  decision!: 'APPROVED' | 'REJECTED';
  @IsOptional() @IsString() @MaxLength(NOTES_MAX) notes?: string;
}

export class MissionTelemetryDto {
  @IsNumber() @IsLatitude()  lat!: number;
  @IsNumber() @IsLongitude() lng!: number;
  @IsOptional() @IsNumber() @Min(0) @Max(360) heading_deg?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(400) speed_kph?: number;
}

export class AbortMissionDto {
  @IsString() @MaxLength(REASON_MAX) reason!: string;
  @IsOptional() @IsString() @MaxLength(NOTES_MAX) notes?: string;
}

export class TriggerSosDto {
  @IsString() @MaxLength(REASON_MAX) reason!: string;
  @IsOptional() @IsNumber() @IsLatitude()  lat?: number;
  @IsOptional() @IsNumber() @IsLongitude() lng?: number;
}

export class AckSosDto {
  @IsOptional() @IsString() @MaxLength(NOTES_MAX) notes?: string;
}

export class EscalateSosDto {
  @IsIn(['POLICE', 'EMBASSY', 'CLIENT_FAMILY', 'OTHER'] as const)
  escalated_to!: 'POLICE' | 'EMBASSY' | 'CLIENT_FAMILY' | 'OTHER';
  @IsOptional() @IsString() @MaxLength(NOTES_MAX) notes?: string;
}

export class ResolveSosDto {
  @IsString() @MaxLength(TEXT_MAX) resolution!: string;
}

export class WaypointProgressDto {
  @IsInt() @Min(1) seq!: number;
  @IsIn(['current', 'done'] as const) state!: 'current' | 'done';
}

export class OpsListQueryDto {
  @IsOptional() @IsString() @MaxLength(64) status?: string;
  @IsOptional() @IsString() @MaxLength(8)  region?: string;
  @IsOptional() @IsString() @MaxLength(32) type?: string;
  /**
   * IA-03 — product scoping for the Lite / Executive split. Comma-separated
   * subset of the booking `service` enum; anything outside it is rejected here
   * rather than silently returning an empty list (a typo in the console would
   * otherwise read as "no bookings today").
   */
  @IsOptional() @IsString() @MaxLength(120)
  @Matches(/^[a-z_]+(,[a-z_]+)*$/, {message: 'service must be a comma-separated list of service keys'})
  service?: string;
  // OP-13 — server-side search. The console used to filter the loaded window.
  @IsOptional() @IsString() @MaxLength(80) q?: string;
  // @Type required: transform:true does NOT implicitly convert query strings.
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
  // OP-14/OP-17 — page-index paging (the console's LOAD MORE used to re-fetch
  // the whole grown window from row 0 every 5 s). Capped so a runaway page
  // index cannot turn into a full-table skip scan.
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000) offset?: number;
}

// Audit fix 1.4 — DTOs for the previously-untyped body params.

export class DispatchBookingDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20)
  @IsUUID('all', {each: true}) applicationIds!: string[];
  // Optional: omitted for driver-only (client vehicle) bookings, where Bravo
  // assigns a security driver but no Bravo vehicle. Required otherwise — the
  // service enforces the booking-type-specific rule.
  @IsOptional() @IsUUID() vehicleId?: string;
  @IsOptional() @IsString() @MaxLength(TEXT_MAX) dressInstructions?: string | null;
  @IsOptional() @IsUUID() leadAgentId?: string | null;
}

export class CompleteBookingPayoutItemDto {
  @IsUUID() user_id!: string;
  @IsInt() @Min(0) credits!: number;
  @IsOptional() @IsString() @MaxLength(NOTES_MAX) deduction_reason?: string | null;
}

export class CompleteBookingDto {
  @IsOptional() @IsArray() @ArrayMaxSize(20)
  @ValidateNested({each: true})
  @Type(() => CompleteBookingPayoutItemDto)
  payouts?: CompleteBookingPayoutItemDto[];
}

/**
 * Step 11 §41 — admin dispute resolution. `to_client` + `to_provider` are the final
 * credit split of the held gross (remainder = platform fee); both clamped server-side.
 * `resolution` is the mandatory decision note (audited).
 */
export class ResolveDisputeDto {
  @IsInt() @Min(0) to_client!: number;
  @IsInt() @Min(0) to_provider!: number;
  @IsString() @MaxLength(TEXT_MAX) resolution!: string;
}

/** POST /ops/bookings/:id/resolve-review — MON-2: release or refund a stranded
 *  (review_required) escrow hold. `release` pays the agency; `refund` repays the client. */
export class ResolveReviewDto {
  @IsIn(['release', 'refund']) action!: 'release' | 'refund';
  @IsString() @MaxLength(REASON_MAX) reason!: string;
}

export class CancelJobDto {
  @IsString() @MaxLength(REASON_MAX) reason!: string;
}

/** POST /ops/wallets/:userId/adjust — manual BC grant (+) or deduction (−). */
export class AdjustWalletDto {
  // Why bounded: a fat-fingered adjustment shouldn't be able to mint an
  // unbounded balance in one call; larger corrections are deliberate
  // multi-step actions.
  @IsInt() @Min(-100_000) @Max(100_000) credits!: number;
  @IsString() @MinLength(3) @MaxLength(REASON_MAX) reason!: string;
}

export class RejectApplicationDto {
  @IsOptional() @IsString() @MaxLength(NOTES_MAX) notes?: string;
}

export class SelectRouteDto {
  // Encoded polyline — a long line for transcontinental jobs can
  // exceed 1k chars; cap at 32k as a sanity ceiling.
  @IsString() @MaxLength(32_768) polyline!: string;
  @IsInt() @Min(0) distance_m!: number;
  @IsInt() @Min(0) duration_s!: number;
}

export class SignoffMissionDeploymentDto {
  @IsUUID() agent_id!: string;
  @IsIn(['dress', 'vehicle', 'equip', 'briefing'] as const)
  check_key!: 'dress' | 'vehicle' | 'equip' | 'briefing';
  @IsIn(['passed', 'failed'] as const) state!: 'passed' | 'failed';
  @IsOptional() @IsString() @MaxLength(NOTES_MAX) notes?: string;
}

export class SendMissionMessageDto {
  @IsString() @MinLength(1) @MaxLength(TEXT_MAX) text!: string;
}

export class TerminateAgentDto {
  @IsOptional() @IsString() @MaxLength(NOTES_MAX) notes?: string;
}

// ─── 2026-07-07 data-coverage audit read surfaces (ops-data.controller) ──

export class OpsDisputesQueryDto {
  @IsOptional() @IsString() @MaxLength(32) status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

export class OpsTxQueryDto {
  @IsOptional() @IsUUID() user_id?: string;
  @IsOptional() @IsString() @MaxLength(32) type?: string;
  @IsOptional() @IsString() @MaxLength(32) status?: string;
  /** Keyset cursor — created_at of the last row of the previous page. */
  @IsOptional() @IsISO8601() before?: string;
  /** OP-14 review — id tie-break for rows sharing `before`'s timestamp (one
   *  escrow release writes three ledger rows at the same now()). */
  @IsOptional() @IsUUID() before_id?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

export class OpsEscrowQueryDto {
  @IsOptional() @IsString() @MaxLength(32) status?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
  /** IA-06 — narrow to one booking (the booking detail's Money panel). */
  @IsOptional() @IsUUID() booking?: string;
}

export class OpsUsersQueryDto {
  @IsOptional() @IsString() @MaxLength(64) q?: string;
  @IsOptional() @IsString() @MaxLength(32) role?: string;
  @IsOptional() @IsString() @MaxLength(32) kyc?: string;
  @IsOptional() @IsString() @MaxLength(32) tier?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000) offset?: number;
}

export class OpsSosQueryDto {
  @IsOptional() @IsIn(['active', 'resolved', 'all'] as const)
  status?: 'active' | 'resolved' | 'all';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

export class OpsAuditBrowseQueryDto {
  @IsOptional() @IsUUID() actor_id?: string;
  @IsOptional() @IsString() @MaxLength(64) action?: string;
  @IsOptional() @IsString() @MaxLength(32) subject_type?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  /** Keyset cursor — created_at of the last row of the previous page. */
  @IsOptional() @IsISO8601() before?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

// ─── B-836 — console management of a Pro root's linked members ──────────

/** Same knobs as the holder's own roster (B-835); the holder id is the path param. */
export class OpsFamilyQueryDto {
  @IsOptional() @IsString() @MaxLength(64) q?: string;
  @IsOptional() @IsIn(['active', 'pending', 'held', 'all'] as const)
  status?: 'active' | 'pending' | 'held' | 'all';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class OpsFamilyInviteDto {
  @Matches(/^\+\d{6,15}$/, {message: 'phoneE164 must be E.164'}) phoneE164!: string;
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) spendLimitCredits?: number | null;
}

/**
 * B-854 (A10) — the console's OFF switch for chained credit.
 *
 * `enabled` accepts only `false` for the same reason the app DTO does: turning
 * it ON is the approve route, which re-runs every eligibility check under the
 * row lock. `force` is the ops-ONLY override for the in-flight refusal, and it
 * exists here and nowhere else — forcing it cancels those bookings at accept,
 * so it must be a deliberate operator act with an audit row behind it.
 */
export class OpsSetFundMembersDto {
  @IsIn([false] as const) enabled!: false;
  @IsOptional() @IsBoolean() force?: boolean;
}

export class OpsFamilyBatchInviteDto {
  // A14 — 50, not 200: each row is several serial queries plus a push fan-out.
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50)
  @IsString({each: true}) @MaxLength(20, {each: true})
  phones!: string[];
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) spendLimitCredits?: number | null;
}

export class RejectArmedDto {
  @IsString() @MinLength(3) @MaxLength(REASON_MAX) reason!: string;
}

export class SuspendUserDto {
  @IsString() @MinLength(3) @MaxLength(REASON_MAX) reason!: string;
}

// ─── Issue 28 — partner / referral code mint + (de)activation ────────────

export class CreateReferralCodeDto {
  // Same charset + length as the booking-side field (create-booking.dto.ts),
  // so every mintable code is submittable by the client.
  @IsString() @MinLength(2) @MaxLength(32)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9-]*$/, {message: 'referral_code_invalid_format'})
  code!: string;
  /** Provider account the attribution belongs to. Exactly one of these two. */
  @IsOptional() @IsUUID() owner_user_id?: string;
  /** External partner with no Bravo account (e.g. a travel agency). */
  @IsOptional() @IsString() @MaxLength(120) partner_name?: string;
  @IsOptional() @IsString() @MaxLength(NOTES_MAX) purpose?: string;
  // Why strict: without it isISO8601 is regex-only, so a calendar-invalid date
  // ("2026-02-30") slips through, parses to NaN past the service's expiry
  // guard, and dies 500 at the timestamptz bind.
  @IsOptional() @IsISO8601({strict: true}) expires_at?: string;
}

export class SetReferralCodeActiveDto {
  @IsBoolean() active!: boolean;
}

export class EraseUserDto {
  @IsString() @MinLength(3) @MaxLength(REASON_MAX) reason!: string;
}

// ─── RS-09 — admin invites + role management ─────────────────────────

// B-818 — the four console levels, plus the legacy ranked three (still valid).
export const ADMIN_ROLES = [
  'SUPER_ADMIN', 'OPERATION_ADMIN', 'COMMUNICATION_ADMIN', 'RISK_ADMIN',
  'OPS', 'SUPERVISOR', 'ADMIN',
] as const;

/**
 * B-818 — a SUPER_ADMIN mints a console account directly: id (phone, the
 * console's login) + password, no invite round-trip. The founder named the
 * Risk Admin as the case, but the door is role-agnostic so an Operation or
 * Communication admin can be provisioned the same way.
 */
export class CreateAdminAccountDto {
  @IsString() @MinLength(2) @MaxLength(80)
  display_name!: string;

  @IsString() @Length(2, 24)
  call_sign!: string;

  @IsIn(ADMIN_ROLES)
  role!: (typeof ADMIN_ROLES)[number];

  // Critic P1 — the console login matches this string EXACTLY (LoginDto:
  // `^\+\d{7,15}$`) and sends the OTP to it; anything else is an account that
  // can never sign in.
  @IsString() @Matches(/^\+\d{7,15}$/, {message: 'phone_e164 must be E.164 (+ and 7–15 digits)'})
  phone_e164!: string;

  @IsString() @MinLength(8) @MaxLength(128)
  password!: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString() @Length(2, 8)
  region?: string;
}

export class CreateAdminInviteDto {
  @IsEmail()
  email!: string;

  @IsString() @MinLength(2) @MaxLength(80)
  display_name!: string;

  @IsString() @Length(2, 24)
  call_sign!: string;

  // Defaults to OPS in the service — least privilege unless explicitly raised.
  @IsOptional() @IsIn(ADMIN_ROLES)
  role?: (typeof ADMIN_ROLES)[number];

  @IsOptional() @IsString() @Length(2, 8)
  region?: string;
}

export class SetAdminRoleDto {
  @IsIn(ADMIN_ROLES)
  role!: (typeof ADMIN_ROLES)[number];
}

// OC-09 — admin offboarding. active=false is the "this operator left" switch:
// AdminGuard already refuses inactive rows, this just makes the column settable.
export class SetAdminActiveDto {
  @IsBoolean()
  active!: boolean;
}

export class AcceptAdminInviteDto {
  @IsString() @Length(20, 128)
  token!: string;

  @IsString() @Matches(/^\+\d{7,15}$/, {message: 'phone_e164 must be E.164 (+ and 7–15 digits)'})
  phone_e164!: string;

  @IsString() @MinLength(8) @MaxLength(128)
  password!: string;

  @IsOptional() @IsString() @MinLength(2) @MaxLength(80)
  display_name?: string;
}
