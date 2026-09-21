import {IsUUID, Matches, IsString, MinLength, MaxLength, IsIn} from 'class-validator';
import {DeviceIdentityDto} from './device-identity.dto';

// B-794 — extends DeviceIdentityDto so an OTP login can report what phone it
// is, for the ops console's Devices card. Every added field is optional; an
// older build simply sends none.
export class VerifyDto extends DeviceIdentityDto {
  @IsUUID()                                userId!:   string;
  @Matches(/^\d{4,8}$/)                    code!:     string;
  @IsString() @MinLength(1) @MaxLength(128) deviceId!: string;
  @IsIn(['ios','android','web'])            platform!: string;
}
