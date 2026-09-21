/**
 * B-797 (client 2026-09-04, relayed by the founder) — "why did you remove the
 * function where news can be shared outside of Bravo, like over WhatsApp or any
 * other platform? I only asked you to make it possible to share news internally
 * to Bravo contacts and channels, not remove the external sharing."
 *
 * The share sheet now offers BOTH doors: the internal contacts / channels
 * (B-623) and the phone's own share sheet. Pinned as a source scan, like its
 * siblings in this folder, because the sheet imports ChatScreen's native deps
 * and cannot be mounted here. Comments stripped, CRLF normalised.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function code(rel: string): string {
  const src = readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

const SHEET = code('src/modules/news/ShareNewsSheet.tsx');

describe('B-797 — the news share sheet offers the OS share sheet beside the internal doors', () => {
  it('opens the native share sheet with the SAME text the internal send uses', () => {
    expect(SHEET.match(/\bShare\.share\(/g)).toHaveLength(1);
    expect(SHEET).toMatch(/const message = buildShareText\(item\);/);
    expect(SHEET).toMatch(/\{message, url: item\.url, title: item\.title\}/);
    expect(SHEET).toMatch(/\{dialogTitle: item\.title, subject: item\.title\}/);
  });

  it('is a visible row above the workspaces, labelled for the platforms the client named', () => {
    expect(SHEET).toMatch(/accessibilityLabel="Share outside Bravo"/);
    expect(SHEET).toMatch(/<Text style=\{s\.outsideTitle\}>Share outside Bravo<\/Text>/);
    expect(SHEET).toMatch(/WhatsApp, Messages, email/);
    const row = SHEET.indexOf('accessibilityLabel="Share outside Bravo"');
    const workspaces = SHEET.indexOf('<ShareWorkspaceList');
    expect(row).toBeGreaterThan(0);
    expect(workspaces).toBeGreaterThan(row);
  });

  it('is single-flight (a ref, reset in finally) and closes the sheet once the OS sheet returns', () => {
    expect(SHEET).toMatch(/const externalRef = useRef\(false\);/);
    expect(SHEET).toMatch(/if \(!item \|\| externalRef\.current\) \{return;\}\s*\n\s*externalRef\.current = true;/);
    expect(SHEET).toMatch(/await Share\.share\([\s\S]{0,260}\);\s*\n\s*onClose\(\);/);
    expect(SHEET).toMatch(/finally \{\s*\n\s*externalRef\.current = false;/);
  });

  it('the internal doors are untouched — workspaces, channels and the contacts picker still render', () => {
    expect(SHEET).toMatch(/<ShareWorkspaceList/);
    expect(SHEET).toMatch(/<ShareChannelList/);
    expect(SHEET).toMatch(/<ForwardList currentConvId="" onPick=/);
    expect(SHEET).toMatch(/sendToChannel/);
  });
});
