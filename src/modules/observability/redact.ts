/**
 * Redaction shared by the crash reporter (crashlytics.ts wrapper) and the
 * Sentry transport's beforeSend / beforeBreadcrumb hooks (sentry.ts).
 *
 * Crash reports must NOT contain plaintext message bodies, identity keys,
 * session fingerprints or auth tokens. The patterns match the shapes that have
 * shown up in past incidents (b64 keys, JWTs, PEM blocks, hex fingerprints).
 * Add to this list when you find new ones.
 */
const REDACT_PATTERNS: Array<[RegExp, string]> = [
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<jwt>'],
  [/-----BEGIN [^-]+-----[\s\S]+?-----END [^-]+-----/g, '<pem>'],
  [/[A-Fa-f0-9]{40,}/g, '<hex>'],
  [/[A-Za-z0-9+/]{43}=/g, '<b64-32>'], // base64-encoded 32-byte key
  [/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <token>'],
];

export function redact(input: string): string {
  let out = input;
  for (const [re, sub] of REDACT_PATTERNS) {
    out = out.replace(re, sub);
  }
  // Cap length — stack traces with raw memory dumps can balloon and
  // dominate the report.
  return out.length > 4000 ? out.slice(0, 4000) + '…<truncated>' : out;
}

/** Drop the query string and fragment — ids and tokens ride there. */
export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}
