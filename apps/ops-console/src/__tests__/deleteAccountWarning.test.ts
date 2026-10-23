import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Owner, 2026-10-23: before an account is deleted the console must say that
 * all its roles and responsibilities will be deleted and cannot be restored.
 */
const SRC = join(process.cwd(), 'apps', 'ops-console', 'src');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');

describe('Delete account warning', () => {
  const modal = read('components', 'DeleteAccountModal.tsx');

  it('loads what the server will remove and says it cannot be restored', () => {
    expect(modal).toMatch(/opsDataApi\.deletionPreview\(userId\)/);
    expect(modal).toMatch(/Every role and responsibility below will be deleted with the account\. This cannot be restored\./);
    for (const section of ['Roles that will be deleted', 'Responsibilities that will be removed', 'Personal data that will be deleted', 'Kept, without the name (business records)']) {
      expect(modal).toContain(section);
    }
  });

  it('needs a reason and DELETE typed, and is disabled while something blocks it', () => {
    expect(modal).toMatch(/const valid = !!preview && !blocked && reason\.trim\(\)\.length >= 3 && typed\.trim\(\) === 'DELETE';/);
    expect(modal).toMatch(/disabled=\{busy \|\| !valid\}/);
  });

  it('both delete buttons (user page, admins page) use it', () => {
    for (const p of [['features', 'people', 'UserDetail.tsx'], ['app', '(console)', 'internal', 'admins', 'page.tsx']]) {
      const src = read(...p);
      expect(src).toMatch(/<DeleteAccountModal/);
      expect(src).not.toMatch(/Delete .*account permanently now\?/);
    }
  });
});
