import {Injectable, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {MessagingService} from '../../messaging/messaging.service';
import {maskPhone} from '../../messaging/messaging.types';

/**
 * Thin Twilio SMS sender for arbitrary message bodies — used by the VBG
 * escalation paths (panic, biometric-miss, geofence breach) to text the
 * principal / emergency contacts, and by ops user invites.
 *
 * Credentials come from Integrations → Twilio (env fallback). Honours the OTP
 * dev bypass so local/dev builds never actually hit Twilio. Best-effort: never
 * throws into the caller — a Twilio outage must not block the escalation's
 * other channels (WS, Kafka).
 */
@Injectable()
export class SmsService {
  private readonly log = new Logger(SmsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly messaging: MessagingService,
  ) {}

  async sendSms(to: string, body: string): Promise<{sent: boolean}> {
    if (this.config.get<boolean>('otp.devBypass') || this.config.get<boolean>('otp.devReturnCode')) {
      this.log.log(`SMS (dev bypass) → ${maskPhone(to)}`);
      return {sent: false};
    }
    if (!this.messaging.isSmsReady()) {
      this.log.warn('SMS not sent — Twilio FROM/credentials missing');
      return {sent: false};
    }
    try {
      await this.messaging.sendSms(to, body.slice(0, 480));
      this.log.log(`SMS sent → ${maskPhone(to)}`);
      return {sent: true};
    } catch (e) {
      this.log.error(`SMS send failed → ${maskPhone(to)}: ${(e as Error).message}`);
      return {sent: false};
    }
  }
}
