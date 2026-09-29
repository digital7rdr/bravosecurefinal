/**
 * The production image must serve public/ (logo + favicons).
 *
 * 2026-09-29: the runtime stage copied .next/standalone and .next/static but
 * not public/, so on https://ops.bravosecure.cloud the sign-in logo, the rail
 * mark and every favicon returned 404 even though publicRoutes.ts allowed
 * them. Next's standalone server serves public/ from the directory that holds
 * server.js, i.e. the runtime WORKDIR.
 */
import fs from 'fs';
import path from 'path';

const DOCKERFILE = path.join(__dirname, '..', '..', 'Dockerfile');

function runtimeStage(src: string): string {
  const lines = src.split(/\r?\n/).filter(l => !/^\s*#/.test(l));
  const start = lines.findIndex(l => /^FROM\s+\S+\s+AS\s+runtime\b/i.test(l));
  expect(start).toBeGreaterThanOrEqual(0);
  return lines.slice(start).join('\n');
}

describe('ops-console Dockerfile ships public/', () => {
  const stage = runtimeStage(fs.readFileSync(DOCKERFILE, 'utf8'));

  it('copies public/ from the build stage into the runtime WORKDIR', () => {
    expect(stage).toMatch(/^COPY --from=build \/app\/apps\/ops-console\/public \.\/public\s*$/m);
  });

  it('keeps it next to server.js (same WORKDIR as the standalone copy)', () => {
    expect(stage).toMatch(/^WORKDIR \/app\s*$/m);
    expect(stage).toMatch(/^COPY --from=build \/app\/apps\/ops-console\/\.next\/standalone \.\/\s*$/m);
    expect(stage).toMatch(/^CMD \["node", "server\.js"\]\s*$/m);
  });

  it('the files the sign-in page needs exist in public/', () => {
    const pub = path.join(__dirname, '..', '..', 'public');
    for (const f of ['bravo-logo-light.svg', 'bravo-mark-light.svg', 'favicon-32.png']) {
      expect(fs.existsSync(path.join(pub, f))).toBe(true);
    }
  });
});
