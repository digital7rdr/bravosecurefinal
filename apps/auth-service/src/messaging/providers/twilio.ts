/**
 * Twilio — kept as a selectable provider. The SDK is imported lazily, as the
 * original OtpService / SmsService did, so a deployment that never selects
 * Twilio never loads it.
 *
 * Errors are rethrown unchanged: AuthService.register maps Twilio's own error
 * codes (60203 max attempts, 60410 blocked, 21608 unverified trial number).
 */
export interface TwilioConfig {
  accountSid: string;
  authToken: string;
}

async function client(cfg: TwilioConfig) {
  const {Twilio} = await import('twilio');
  return new Twilio(cfg.accountSid, cfg.authToken);
}

export async function sendTwilioSms(cfg: TwilioConfig & {from: string}, to: string, body: string): Promise<{messageId?: string}> {
  const c = await client(cfg);
  const msg = await c.messages.create({to, from: cfg.from, body});
  return {messageId: (msg as {sid?: string} | undefined)?.sid};
}

export async function startTwilioVerify(cfg: TwilioConfig & {verifySid: string}, to: string): Promise<void> {
  const c = await client(cfg);
  await c.verify.v2.services(cfg.verifySid).verifications.create({to, channel: 'sms'});
}

export async function checkTwilioVerify(cfg: TwilioConfig & {verifySid: string}, to: string, code: string): Promise<boolean> {
  const c = await client(cfg);
  try {
    const res = await c.verify.v2.services(cfg.verifySid).verificationChecks.create({to, code});
    return res.status === 'approved';
  } catch (e: unknown) {
    // 404 = the verification expired or was already consumed → a failed check,
    // not a server error.
    if ((e as {status?: number})?.status === 404) {return false;}
    throw e;
  }
}
