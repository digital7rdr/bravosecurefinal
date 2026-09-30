/**
 * 2026-09-30 — the dashboard follows the admin level, like the rail and the
 * server's domain guard: a Risk Admin sees Safety tiles, not operations
 * queues; a Communication Admin sees Enterprise. Source-level pin (the page
 * is a client component with SWR hooks).
 */
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', '(console)', 'dashboard', 'page.tsx'), 'utf8');

describe('dashboard is scoped to the admin level', () => {
  it('uses the shared rbac domain check', () => {
    expect(SRC).toMatch(/import \{canActInDomain, type AdminDomain\} from '@\/lib\/rbac'/);
    expect(SRC).toMatch(/const ops = can\('operations'\), comms = can\('communication'\), risk = can\('risk'\);/);
  });
  it('gates the Lite and Executive strips and the approval queue on operations', () => {
    expect((SRC.match(/\{ops && <SectionStrip/g) ?? []).length).toBe(2);
    expect(SRC).toMatch(/\{ops && <div className="card"/);
  });
  it('shows Enterprise tiles only to communication and SOS only to risk', () => {
    expect(SRC).toMatch(/if \(comms\) \{[\s\S]*?joinRequests[\s\S]*?\}/);
    expect(SRC).toMatch(/if \(risk\) \{[\s\S]*?routes\.safety\.sos[\s\S]*?\}/);
  });
});
