/**
 * Is `url` a file THIS user uploaded through POST /agents/me/upload?
 *
 * The upload endpoint stores bytes under <cwd>/uploads/<userId>/<name> and
 * returns `${PUBLIC_BASE_URL}/uploads/<userId>/<name>`. Anything else a client
 * sends as a document URL (another account's upload, an outside link) is not
 * evidence this account provided — and ops reviewers open these links, so an
 * arbitrary URL would be a phishing door into the console (2026-10-17).
 */
export function isOwnUploadUrl(url: string, userId: string, publicBase = process.env.PUBLIC_BASE_URL): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {return false;}
  if (publicBase) {
    let base: URL;
    try { base = new URL(publicBase); } catch { return false; }
    if (u.origin !== base.origin) {return false;}
  }
  if (u.search || u.hash) {return false;}
  const m = /^\/uploads\/([^/]+)\/([A-Za-z0-9._-]+)$/.exec(u.pathname);
  return !!m && m[1] === userId && !m[2].startsWith('.');
}
