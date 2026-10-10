import {Injectable} from '@nestjs/common';
import {SettingsService} from '../settings/settings.service';
import {OTP_MODES, type OtpMode} from './messaging.types';
import {
  checkTwilioVerify, sendTwilioSms, startTwilioVerify, type TwilioConfig,
} from './providers/twilio';
import {sendSmtpMail, type SmtpConfig} from './providers/smtp';

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

  /** SMTP settings (Integrations → Email), or null while any required one is missing. */
  private smtpConfig(): SmtpConfig | null {
    const host = this.s('email.smtpHost');
    const user = this.s('email.smtpUser');
    const password = this.s('email.smtpPassword');
    const from = this.s('email.from') || user;
    if (!host || !user || !password || !from) {return null;}
    const security = this.s('email.smtpSecurity');
    const port = Number(this.s('email.smtpPort')) || (security === 'starttls' ? 587 : 465);
    const secure = security ? security === 'tls' : port === 465;
    return {host, port, secure, user, password, from};
  }

  isEmailReady(): boolean {
    return this.smtpConfig() !== null;
  }

  async sendEmail(to: string, subject: string, text: string, html?: string): Promise<{messageId?: string}> {
    const cfg = this.smtpConfig();
    if (!cfg) {throw new Error('Email not configured (SMTP server, username, password and From address are required — Integrations → Email)');}
    return sendSmtpMail(cfg, {to, subject, text, html});
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
