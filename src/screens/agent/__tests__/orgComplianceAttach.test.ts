import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * 2026-10-17 — "Ops console can't verify service provider docs": the agency's
 * Compliance screen submitted licence / insurance as metadata only, so the
 * console's Compliance Review had no file to look at. The screen mounts RN
 * views, so the wiring is pinned by source scan.
 */
const src = readFileSync(join(process.cwd(), 'src', 'screens', 'agent', 'OrgComplianceScreen.tsx'), 'utf8');
const api = readFileSync(join(process.cwd(), 'src', 'services', 'api.ts'), 'utf8');

describe('provider Compliance screen sends the document itself', () => {
  it('lets the agency attach a photo or PDF', () => {
    expect(src).toMatch(/DocumentPicker\.getDocumentAsync\(\{type: PICK_TYPES/);
    expect(src).toMatch(/const PICK_TYPES = \['image\/jpeg', 'image\/png', 'image\/heic', 'image\/heif', 'image\/webp', 'application\/pdf'\];/);
  });

  it('refuses to submit without a file, uploads it, and sends its URL', () => {
    const at = src.indexOf('const submit = async');
    const fn = src.slice(at, src.indexOf('return (', at));
    expect(fn).toMatch(/if \(!attached\) \{/);
    const upload = fn.indexOf('agentApi.uploadFile(attached)');
    const submit = fn.indexOf('complianceApi.submit(');
    expect(upload).toBeGreaterThan(-1);
    expect(submit).toBeGreaterThan(upload);
    expect(fn.slice(submit, submit + 300)).toMatch(/file_url: fileUrl/);
  });

  it('the client type carries file_url', () => {
    const at = api.indexOf('export const complianceApi');
    expect(api.slice(at, at + 600)).toMatch(/file_url\?: string/);
  });
});
