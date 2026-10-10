import {IsEmail, IsString, MinLength, Matches, IsOptional, ValidateIf, IsIn, MaxLength} from 'class-validator';
import {DeviceIdentityDto} from './device-identity.dto';

// 2026-10-10 — extends DeviceIdentityDto: when MOBILE_SECOND_FACTOR=none the
// password step IS the session-creating step for ios/android, so the login
// body carries the same device fields /auth/verify does. All optional: the
// ops console / web app send none and always get the second-factor step.
export class LoginDto extends DeviceIdentityDto {
  @IsOptional() @IsEmail()                           email?:     string;
  @IsOptional() @Matches(/^\+\d{7,15}$/)             phoneE164?: string;
  @IsOptional() @IsIn(['ios','android','web'])       platform?:  string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) deviceId?: string;
  @IsString()   @MinLength(1)                        password!:  string;
}
