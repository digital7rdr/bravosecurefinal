import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString,
  Matches, Max, MaxLength, Min, MinLength,
} from 'class-validator';

/** Ops mints a campaign. Same code charset as the booking-side field, so every
 *  mintable code is submittable by the client (and typeable off a poster). */
export class CreateReferralCampaignDto {
  @IsString() @MinLength(2) @MaxLength(32)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9-]*$/, {message: 'referral_code_invalid_format'})
  code!: string;

  @IsString() @MinLength(2) @MaxLength(120)
  name!: string;

  @IsIn(['universal', 'region'])
  scope!: 'universal' | 'region';

  @IsOptional() @IsString() @MaxLength(8)
  region_code?: string;

  @IsIn(['percent', 'fixed_bc'])
  discount_type!: 'percent' | 'fixed_bc';

  @IsNumber() @Min(0.01) @Max(100000)
  discount_value!: number;

  @IsOptional() @IsInt() @Min(1) @Max(1000000)
  max_discount_bc?: number;

  @IsOptional() @IsArray() @ArrayMaxSize(8) @IsString({each: true})
  services?: string[];

  @IsOptional() @IsInt() @Min(1) @Max(10000000)
  max_redemptions?: number;

  @IsOptional() @IsInt() @Min(1) @Max(1000)
  per_user_limit?: number;

  // strict: a calendar-invalid date would otherwise parse to NaN past the
  // service guard and die at the timestamptz bind (same trap as CreateReferralCodeDto).
  @IsOptional() @IsISO8601({strict: true})
  starts_at?: string;

  @IsOptional() @IsISO8601({strict: true})
  expires_at?: string;

  @IsOptional() @IsString() @MaxLength(500)
  notes?: string;
}

export class UpdateReferralCampaignDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120)
  name?: string;

  @IsOptional() @IsBoolean()
  active?: boolean;

  // `null` clears the bound; undefined leaves it alone (three-valued on purpose).
  @IsOptional() @IsISO8601({strict: true})
  expires_at?: string | null;

  @IsOptional() @IsISO8601({strict: true})
  starts_at?: string | null;

  @IsOptional() @IsInt() @Min(1) @Max(10000000)
  max_redemptions?: number | null;

  @IsOptional() @IsInt() @Min(1) @Max(1000)
  per_user_limit?: number;

  @IsOptional() @IsString() @MaxLength(500)
  notes?: string | null;
}
