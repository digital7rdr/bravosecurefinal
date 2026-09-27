import {Injectable} from '@nestjs/common';
import {SettingsService} from '../settings/settings.service';
import {OTP_MODES, type OtpMode} from './messaging.types';
import {
  checkTwilioVerify, sendTwilioSms, startTwilioVerify, type TwilioConfig,
} from './providers/twilio';

/**
 * Twilio credentials and OTP mode, resolved from the Integrations settings
 * (console value → env fallback, via SettingsService.getSync), so a key change
 * in the console reaches every replica without a redeploy.
 */
@Injectable()
export class MessagingService {
  constructor(private readonly settings: SettingsService) {}

  private s(key: string): string {
    return (this.settings.getSync(key) ?? '').trim();
  }

  private twilioConfig(): TwilioConfig | null {
    const accountSid = this.s('twilio.accountSid');
    const authToken = this.s('twilio.authToken');
    return accountSid && authToken ? {accountSid, authToken} : null;
  }

  private twilioVerifyConfig(): (TwilioConfig & {verifySid: string}) | null {
    const base = this.twilioConfig();
    const verifySid = this.s('twilio.verifySid');
    return base && verifySid ? {...base, verifySid} : null;
  }

  private twilioSmsConfig(): (TwilioConfig & {from: string}) | null {
    const base = this.twilioConfig();
    const from = this.s('twilio.fromNumber');
    return base && from ? {...base, from} : null;
  }

  isVerifyReady(): boolean {
    return this.twilioVerifyConfig() !== null;
  }

  isSmsReady(): boolean {
    return this.twilioSmsConfig() !== null;
  }

  /**
   * The OTP mode to use, or null when neither mode has credentials. An explicit
   * choice wins; unset → the original inference (Verify first, then SMS).
   */
  otpMode(): OtpMode | null {
    const v = this.s('twilio.otpMode');
    if ((OTP_MODES as readonly string[]).includes(v)) {return v as OtpMode;}
    if (this.isVerifyReady()) {return 'verify';}
    if (this.isSmsReady()) {return 'sms';}
    return null;
  }

  async sendSms(to: string, body: string): Promise<{messageId?: string}> {
    const cfg = this.twilioSmsConfig();
    if (!cfg) {throw new Error('Twilio SMS not configured (account SID, auth token and From number are required)');}
    return sendTwilioSms(cfg, to, body);
  }

  async startVerify(to: string): Promise<void> {
    const cfg = this.twilioVerifyConfig();
    if (!cfg) {throw new Error('Twilio Verify not configured (account SID, auth token and Verify service SID are required)');}
    await startTwilioVerify(cfg, to);
  }

  /** false when Verify is not configured — there is then no Twilio-held code to check. */
  async checkVerify(to: string, code: string): Promise<boolean> {
    const cfg = this.twilioVerifyConfig();
    if (!cfg) {return false;}
    return checkTwilioVerify(cfg, to, code);
  }
}
