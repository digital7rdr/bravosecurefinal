/**
 * Email over SMTP (2026-10-10) — verification codes for sign-up on the home
 * site and the sign-in code fallback. nodemailer is imported lazily, like the
 * Twilio SDK, so a deployment that never configures email never loads it.
 */
export interface SmtpConfig {
  host: string;
  port: number;
  /** true = TLS from the first byte (465); false = STARTTLS upgrade (587). */
  secure: boolean;
  user: string;
  password: string;
  from: string;
}

export async function sendSmtpMail(
  cfg: SmtpConfig,
  msg: {to: string; subject: string; text: string; html?: string},
): Promise<{messageId?: string}> {
  const nodemailer = await import('nodemailer');
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    // STARTTLS must actually upgrade: never fall back to plain text.
    requireTLS: !cfg.secure,
    auth: {user: cfg.user, pass: cfg.password},
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  try {
    const info = await transport.sendMail({from: cfg.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html});
    return {messageId: info.messageId};
  } finally {
    transport.close();
  }
}
