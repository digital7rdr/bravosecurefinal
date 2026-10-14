import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {controlledDocFileName, exportFileName, uploadFileName} from '../lib/fileNaming';

/**
 * Bravo naming standard (2026-10-15) — the console and auth-service each carry
 * a copy of the same pure module (separate builds cannot import each other).
 * Two copies of one rule drift; this fails the moment they do.
 */
describe('file naming — one standard, two copies', () => {
  it('the console copy is byte-identical to the auth-service copy', () => {
    const root = process.cwd();
    const a = readFileSync(join(root, 'apps', 'ops-console', 'src', 'lib', 'fileNaming.ts'), 'utf8').replace(/\r\n/g, '\n');
    const b = readFileSync(join(root, 'apps', 'auth-service', 'src', 'common', 'naming', 'file-naming.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(a === b).toBe(true);
  });

  it('produces the deck\'s shapes in the console too', () => {
    const at = new Date(Date.UTC(2026, 9, 15, 9, 30));
    expect(exportFileName({dept: 'QH', subject: 'Audit Log', ext: 'csv', at})).toBe('20261015T0930_BRV-QH_AuditLog.csv');
    expect(uploadFileName('My Form.pdf', at)).toBe('20261015T0930_MyForm_v1.pdf');
    expect(controlledDocFileName({dept: 'FN', category: 200, seq: 1, title: 'Finance Work Instruction', version: 1, ext: 'docx'}))
      .toBe('BRV-FN-200-001_FinanceWorkInstruction_v1.docx');
  });
});
