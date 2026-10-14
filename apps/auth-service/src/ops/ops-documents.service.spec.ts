import {BadRequestException, ConflictException} from '@nestjs/common';
import {createHash} from 'node:crypto';
import {OpsDocumentsService} from './ops-documents.service';

/**
 * Bravo controlled-document library (ISO 9001:2015 naming, 2026-10-15).
 * Numbering, file names and refusals. The SQL itself was exercised against a
 * real Postgres when this landed; here the fake records what was written.
 */
function setup(opts: {maxSeq?: number; current?: {status: string; current_version: number; sha?: string}} = {}) {
  const writes: Array<{sql: string; params: unknown[]}> = [];
  const tx = {
    q: jest.fn(async (sql: string, params: unknown[] = []) => { writes.push({sql, params}); return []; }),
    qOne: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (/MAX\(seq\)/.test(sql)) {return {seq: (opts.maxSeq ?? 0) + 1};}
      if (/INSERT INTO public\.controlled_documents/.test(sql)) {writes.push({sql, params}); return {id: 'doc-1'};}
      if (/FOR UPDATE/.test(sql)) {
        return opts.current ? {department_code: 'FN', category: 100, seq: 7, title: 'Expense Tracking Procedure', ...opts.current} : null;
      }
      if (/sha256 = \$3/.test(sql)) {return opts.current?.sha === params[2] ? {version: 1} : null;}
      return null;
    }),
  };
  const db = {q: jest.fn(), qOne: jest.fn(), withTransaction: jest.fn(async (cb: (t: typeof tx) => unknown) => cb(tx))};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {svc: new OpsDocumentsService(db as any), writes, tx};
}
const pdf = (name = 'Expense Policy FINAL.pdf', bytes = 'hello') =>
  ({buffer: Buffer.from(bytes), originalname: name, size: bytes.length});

describe('OpsDocumentsService', () => {
  it('a new document takes the next number in its folder and a convention file name', async () => {
    const {svc, writes} = setup({maxSeq: 6});
    const out = await svc.create('admin-1', {department_code: 'FN', category: '100', title: 'Expense Tracking Procedure'}, pdf());
    expect(out).toEqual({id: 'doc-1', number: 'BRV-FN 100-007', version: 1,
      file_name: 'BRV-FN-100-007_ExpenseTrackingProcedure_v1.pdf'});
    expect(writes[0].sql).toMatch(/pg_advisory_xact_lock/);
    const v = writes.find(w => /controlled_document_versions/.test(w.sql))!;
    expect(v.params[2]).toBe('Expense Policy FINAL.pdf'); // the uploader's name, kept as a label
    expect(v.params[3]).toBe('application/pdf');           // derived from the extension
  });

  it('refuses unknown folders, bad titles, disallowed types and a full folder', async () => {
    const {svc} = setup({maxSeq: 999});
    await expect(svc.create('a', {department_code: 'XX', category: 100, title: 'T'}, pdf())).rejects.toThrow('unknown_department');
    await expect(svc.create('a', {department_code: 'FN', category: 500, title: 'T'}, pdf())).rejects.toThrow('unknown_category');
    await expect(svc.create('a', {department_code: 'FN', category: 100, title: '  '}, pdf())).rejects.toThrow('title_1_to_120_chars');
    await expect(svc.create('a', {department_code: 'FN', category: 100, title: 'T'}, pdf('run.exe'))).rejects.toThrow('file_type_not_allowed');
    await expect(svc.create('a', {department_code: 'FN', category: 100, title: 'T'}, undefined)).rejects.toThrow(BadRequestException);
    await expect(svc.create('a', {department_code: 'FN', category: 100, title: 'T'}, pdf())).rejects.toThrow('folder_is_full');
  });

  it('a new version bumps the number and keeps the document number', async () => {
    const {svc, writes} = setup({current: {status: 'active', current_version: 2}});
    const out = await svc.addVersion('admin-1', 'doc-1', {change_note: 'Annual review'}, pdf('v3.docx'));
    expect(out).toEqual({id: 'doc-1', number: 'BRV-FN 100-007', version: 3,
      file_name: 'BRV-FN-100-007_ExpenseTrackingProcedure_v3.docx'});
    expect(writes.some(w => /SET current_version = \$2/.test(w.sql) && w.params[1] === 3)).toBe(true);
  });

  it('refuses a new version of an obsolete document, or the same file again', async () => {
    await expect(setup({current: {status: 'obsolete', current_version: 1}}).svc.addVersion('a', 'doc-1', {}, pdf()))
      .rejects.toThrow(ConflictException);
    const sha = createHash('sha256').update(Buffer.from('hello')).digest('hex');
    await expect(setup({current: {status: 'active', current_version: 1, sha}}).svc.addVersion('a', 'doc-1', {}, pdf()))
      .rejects.toThrow('same_as_current_version');
  });
});
