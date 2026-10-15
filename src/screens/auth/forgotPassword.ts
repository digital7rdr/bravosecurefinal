/**
 * Forgot password (mobile, 2026-10-16) — the pure rules behind
 * ForgotPasswordScreen, kept free of React so they are unit-tested.
 * They mirror the server (apps/auth-service/src/hub: ResetStartDto,
 * ResetCompleteDto, PasswordResetService) so the person sees the problem
 * before a round trip, never a different rule from the server's.
 */

/** ResetCompleteDto: @MinLength(10) @MaxLength(128). */
export const MIN_RESET_PASSWORD = 10;
export const MAX_RESET_PASSWORD = 128;

/** Null when the server will accept the identifier's SHAPE. */
export function resetIdentifierProblem(raw: string): string | null {
  const text = raw.trim();
  if (!text) {return 'Type your mobile number or email.';}
  if (text.includes('@')) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? null : 'Check the email address.';
  }
  const phone = text.replace(/[\s\-().]/g, '').replace(/^00/, '+');
  if (!phone.startsWith('+')) {return 'Type the mobile number with its country code, for example +971 50 123 4567.';}
  return /^\+\d{7,15}$/.test(phone) ? null : 'Check the mobile number, for example +971 50 123 4567.';
}

export function newPasswordProblem(pw: string, repeat: string): string | null {
  if (pw.length < MIN_RESET_PASSWORD) {return `Use at least ${MIN_RESET_PASSWORD} characters.`;}
  if (pw.length > MAX_RESET_PASSWORD) {return `Use at most ${MAX_RESET_PASSWORD} characters.`;}
  if (pw !== repeat) {return 'The two passwords are not the same.';}
  return null;
}

/**
 * The words to show for a failed call. The server already writes a sentence
 * for every reset error ({error, message}); validation errors arrive as a
 * message array; anything else is the network.
 */
export function resetErrorText(e: unknown): string {
  const res = (e as {response?: {status?: number; data?: {message?: unknown; error?: unknown}}})?.response;
  if (!res) {return 'Could not reach Bravo Secure. Check your connection and try again.';}
  const msg = res.data?.message;
  if (typeof msg === 'string' && msg.trim()) {return msg;}
  if (Array.isArray(msg) && msg.length) {
    const first = String(msg[0]);
    if (/newPassword/.test(first)) {return `Use at least ${MIN_RESET_PASSWORD} characters.`;}
    if (/code/.test(first)) {return 'Type the code from the text or email.';}
    return 'Check what you typed and try again.';
  }
  if (res.status === 429) {return 'Too many tries. Wait a few minutes and try again.';}
  return 'Something went wrong. Try again.';
}
