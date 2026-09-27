/**
 * OTP delivery modes (2026-09-28 — Twilio only).
 *
 *   verify  Twilio Verify generates, delivers and checks the code (original).
 *   sms     The auth-service generates the code, keeps only an HMAC of it in
 *           Redis, and sends it with Twilio Programmable SMS. Before this, the
 *           SMS path sent the message with an EMPTY code (callers pass '').
 *
 * Chosen under Integrations → Twilio → "OTP delivery"; unset = Verify when its
 * SID is set, otherwise SMS (the original inference).
 */
export const OTP_MODES = ['verify', 'sms'] as const;
export type OtpMode = typeof OTP_MODES[number];

/** Never log a full phone number. */
export function maskPhone(p: string): string {
  return p.length > 4 ? `${p.slice(0, 3)}***${p.slice(-2)}` : '***';
}
