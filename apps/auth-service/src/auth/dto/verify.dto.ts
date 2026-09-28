import {IsOptional, IsUUID, Matches, IsString, MinLength, MaxLength, IsIn} from 'class-validator';
import {DeviceIdentityDto} from './device-identity.dto';

// B-794 — extends DeviceIdentityDto so an OTP login can report what phone it
// is, for the ops console's Devices card. Every added field is optional; an
// older build simply sends none.
export class VerifyDto extends DeviceIdentityDto {
  @IsUUID()                                userId!:   string;
  // 4–8 digit SMS/TOTP code, or an 8-char alphanumeric TOTP backup code.
  @Matches(/^[A-Za-z0-9]{4,10}$/)          code!:     string;
  // TOTP mode: the opaque id /auth/login returned. Binds this verify to a
  // password step that happened within the last OTP_TTL_MINUTES, so a leaked
  // user UUID plus a live code is not a login. Required when
  // AUTH_SECOND_FACTOR=totp; ignored in SMS mode.
  @IsOptional() @IsUUID()                  challengeId?: string;
  @IsString() @MinLength(1) @MaxLength(128) deviceId!: string;
  @IsIn(['ios','android','web'])            platform!: string;
}
