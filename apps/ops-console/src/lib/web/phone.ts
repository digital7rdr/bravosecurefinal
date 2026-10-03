/** "+44 7700 900123" / "0044 7700-900123" → "+447700900123"; anything else → null. */
export function toE164(raw: string): string | null {
  let v = raw.trim().replace(/[\s\-().]/g, '');
  if (v.startsWith('00')) v = `+${v.slice(2)}`;
  return /^\+\d{7,15}$/.test(v) ? v : null;
}
