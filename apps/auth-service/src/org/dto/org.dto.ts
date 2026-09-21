import {
  ArrayMaxSize, ArrayNotEmpty, IsArray, IsEmail, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, MinLength,
} from 'class-validator';
import {TEAM_UNIT_MAX} from '../../booking/dto/create-booking.dto';

export const ORG_MEMBER_ROLES = ['cpo', 'manager'] as const;
export type OrgMemberRole = (typeof ORG_MEMBER_ROLES)[number];

// Q7 — roles a ROSTER row can be SET to. 'employee' (the workspace staff
// role) is a valid demote target for workspace tenants; it is deliberately
// NOT in ORG_MEMBER_ROLES, which also gates minting managed sub-accounts —
// an employee is an enrolled EXISTING user, never a minted sub-account.
export const SETTABLE_MEMBER_ROLES = ['cpo', 'manager', 'employee'] as const;

/**
 * B-812 — mint a single-use roster invitation code (agency app and ops console
 * share this shape). Every field is optional: the defaults are a CPO invite
 * with no pre-assigned call sign that expires in 7 days.
 */
export class MintInviteDto {
  @IsOptional() @IsIn(ORG_MEMBER_ROLES as unknown as string[])
  member_role?: OrgMemberRole;

  @IsOptional() @IsString() @MaxLength(24)
  call_sign?: string;

  @IsOptional() @IsInt() @Min(1) @Max(30)
  expires_in_days?: number;
}
export type SettableMemberRole = (typeof SETTABLE_MEMBER_ROLES)[number];

// ─── Crew assignment (Step 13) — the agency picks guards + a leader ──────
// LM-V3 — UUID-typed ids + the cap aligned to the booking team ceiling, not 16.
// B-876 — that ceiling is TEAM_UNIT_MAX (the DTO's own export, so there is ONE
// literal). It has to track the booking cap exactly: a team the client is
// allowed to BOOK but the agency cannot CREW is a booking that dead-ends after
// the money is held.
export class AssignCrewDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(TEAM_UNIT_MAX) @IsUUID('4', {each: true})
  cpo_user_ids!: string[];

  @IsUUID('4')
  lead_user_id!: string;
}

// ─── Create a managed CPO sub-account ───────────────────────────────
// The provider org supplies the CPO's identity + a temp password. The CPO
// resets it on first login. KYC/docs are seeded (like AgentService.create)
// so the existing ops review console works unchanged.
export class CreateManagedCpoDto {
  @IsString() @MinLength(2)
  display_name!: string;

  @IsEmail()
  email!: string;

  @IsString() @Length(6, 32)
  phone_e164!: string;

  // Temp password the org sets; CPO is forced to reset on first login.
  @IsString() @MinLength(8)
  temp_password!: string;

  @IsOptional() @IsString() @Length(1, 32)
  call_sign?: string;

  @IsOptional() @IsIn(ORG_MEMBER_ROLES)
  member_role?: OrgMemberRole;
}

// ─── Suspend / reinstate a roster member ────────────────────────────
export class SetMemberStatusDto {
  @IsIn(['active', 'suspended', 'removed'] as const)
  status!: 'active' | 'suspended' | 'removed';

  // Suspension window. Omitting `suspended_until` means indefinite. The reason
  // is mandatory for `suspended` — enforced in the service so the rule holds for
  // every caller, not just this DTO. Shown to the CPO on their next login.
  @IsOptional() @IsISO8601()
  suspended_from?: string;

  @IsOptional() @IsISO8601()
  suspended_until?: string | null;

  @IsOptional() @IsString() @MaxLength(280)
  suspend_reason?: string;
}

// ─── M1A rule 16 — enroll an existing user as an org EMPLOYEE ───────
export class AddEmployeeDto {
  @IsString() @MinLength(3) @MaxLength(254)
  email_or_phone!: string;
}

// ─── Promote / demote a roster member (RS-10) ───────────────────────
export class SetMemberRoleDto {
  @IsIn(SETTABLE_MEMBER_ROLES)
  member_role!: SettableMemberRole;
}

// ─── Owner grants/revokes a manager's dashboard modules ──────────────────
export class SetManagerPermissionsDto {
  @IsArray() @IsString({each: true})
  modules!: string[];
}

// ─── Apply to a job as the org, naming a deployed CPO ───────────────
export class OrgApplyToJobDto {
  @IsString()
  cpo_user_id!: string;

  @IsString() @MinLength(4)
  dress_pledge!: string;
}
