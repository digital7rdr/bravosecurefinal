import {BadRequestException, ConflictException, Injectable, NotFoundException} from '@nestjs/common';
import {createHash} from 'node:crypto';
import {DatabaseService} from '../database/database.service';
import {
  DEPARTMENTS, DOC_CATEGORIES, controlledDocFileName, controlledDocNumber, isDepartmentCode, isDocCategory,
  splitName, type DepartmentCode, type DocCategoryCode,
} from '../common/naming/file-naming';

/**
 * Bravo controlled-document library (ISO 9001:2015 deck, 2026-10-15).
 *
 * Department folders × category sub-folders × numbered documents, every
 * version kept. Numbers and file names come from common/naming/file-naming.ts
 * — the one place the convention is written down. Bytes are stored in
 * Postgres (see the migration for why) and never selected by list reads.
 */

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** Extension → the Content-Type we serve. Derived here, never trusted from the client. */
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  vsdx: 'application/vnd.ms-visio.drawing',
  dwg: 'application/acad',
  csv: 'text/csv',
  txt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};
export const ALLOWED_DOCUMENT_EXTENSIONS = Object.keys(MIME_BY_EXT);

export interface UploadedDoc {
  buffer: Buffer;
  originalname: string;
  size: number;
}

export interface DocumentRow {
  id: string;
  department_code: DepartmentCode;
  category: DocCategoryCode;
  seq: number;
  number: string;
  title: string;
  status: 'active' | 'obsolete';
  current_version: number;
  file_name: string | null;
  size_bytes: number | null;
  updated_at: string;
  updated_by_name: string | null;
}

@Injectable()
export class OpsDocumentsService {
  constructor(private readonly db: DatabaseService) {}

  /** The folder skeleton, so the console shows empty folders too. */
  folders() {
    return {
      departments: DEPARTMENTS,
      categories: DOC_CATEGORIES,
      allowed_extensions: ALLOWED_DOCUMENT_EXTENSIONS,
      max_bytes: MAX_DOCUMENT_BYTES,
    };
  }

  async list(): Promise<{documents: DocumentRow[]} & ReturnType<OpsDocumentsService['folders']>> {
    const rows = await this.db.q<Omit<DocumentRow, 'number'>>(
      `SELECT d.id, d.department_code, d.category, d.seq, d.title, d.status, d.current_version,
              v.stored_name AS file_name, v.size_bytes, d.updated_at, u.display_name AS updated_by_name
         FROM public.controlled_documents d
         LEFT JOIN public.controlled_document_versions v
           ON v.document_id = d.id AND v.version = d.current_version
         LEFT JOIN public.users u ON u.id = d.updated_by
        ORDER BY d.department_code, d.category, d.seq
        LIMIT 5000`,
    );
    return {
      ...this.folders(),
      documents: rows.map(r => ({...r, category: Number(r.category) as DocCategoryCode,
        number: controlledDocNumber(r.department_code, Number(r.category) as DocCategoryCode, r.seq)})),
    };
  }

  async get(id: string) {
    const doc = await this.db.qOne<Omit<DocumentRow, 'number' | 'file_name' | 'size_bytes'> & {created_at: string; created_by_name: string | null}>(
      `SELECT d.id, d.department_code, d.category, d.seq, d.title, d.status, d.current_version,
              d.created_at, d.updated_at, cu.display_name AS created_by_name, uu.display_name AS updated_by_name
         FROM public.controlled_documents d
         LEFT JOIN public.users cu ON cu.id = d.created_by
         LEFT JOIN public.users uu ON uu.id = d.updated_by
        WHERE d.id = $1`,
      [id],
    );
    if (!doc) {throw new NotFoundException('document_not_found');}
    const versions = await this.db.q<{
      version: number; stored_name: string; original_name: string; size_bytes: number; sha256: string;
      change_note: string | null; uploaded_at: string; uploaded_by_name: string | null;
    }>(
      `SELECT v.version, v.stored_name, v.original_name, v.size_bytes, v.sha256, v.change_note, v.uploaded_at,
              u.display_name AS uploaded_by_name
         FROM public.controlled_document_versions v
         LEFT JOIN public.users u ON u.id = v.uploaded_by
        WHERE v.document_id = $1
        ORDER BY v.version DESC`,
      [id],
    );
    const category = Number(doc.category) as DocCategoryCode;
    return {document: {...doc, category, number: controlledDocNumber(doc.department_code, category, doc.seq)}, versions};
  }

  /** Validate a file and work out what it is stored and served as. */
  private checkFile(file: UploadedDoc | undefined): {ext: string; mime: string; sha256: string} {
    if (!file || !file.buffer?.length) {throw new BadRequestException('no_file');}
    if (file.size > MAX_DOCUMENT_BYTES || file.buffer.length > MAX_DOCUMENT_BYTES) {
      throw new BadRequestException('file_too_large');
    }
    const {ext} = splitName(file.originalname);
    const mime = MIME_BY_EXT[ext];
    if (!mime) {throw new BadRequestException('file_type_not_allowed');}
    return {ext, mime, sha256: createHash('sha256').update(file.buffer).digest('hex')};
  }

  private static cleanTitle(raw: unknown): string {
    const t = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
    if (!t || t.length > 120) {throw new BadRequestException('title_1_to_120_chars');}
    return t;
  }

  private static cleanNote(raw: unknown): string | null {
    const n = typeof raw === 'string' ? raw.trim() : '';
    if (n.length > 500) {throw new BadRequestException('change_note_too_long');}
    return n || null;
  }

  /**
   * A new document: the next number in its folder, version 1.
   * Numbers are never reused — an obsolete document keeps its number.
   */
  async create(actorId: string, input: {department_code?: unknown; category?: unknown; title?: unknown; change_note?: unknown},
    file: UploadedDoc | undefined) {
    const dept = input.department_code;
    const category = typeof input.category === 'string' ? Number(input.category) : input.category;
    if (!isDepartmentCode(dept)) {throw new BadRequestException('unknown_department');}
    if (!isDocCategory(category)) {throw new BadRequestException('unknown_category');}
    const title = OpsDocumentsService.cleanTitle(input.title);
    const note = OpsDocumentsService.cleanNote(input.change_note);
    const f = this.checkFile(file);
    return this.db.withTransaction(async tx => {
      // Serialise numbering per folder: two uploads into FN/100 at the same
      // moment must not both read "next is 007".
      await tx.q(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`controlled_doc:${dept}:${category}`]);
      const next = await tx.qOne<{seq: number}>(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM public.controlled_documents
          WHERE department_code = $1 AND category = $2`,
        [dept, category],
      );
      const seq = next?.seq ?? 1;
      if (seq > 999) {throw new ConflictException('folder_is_full');}
      const doc = await tx.qOne<{id: string}>(
        `INSERT INTO public.controlled_documents
           (department_code, category, seq, title, current_version, created_by, updated_by)
         VALUES ($1, $2, $3, $4, 1, $5, $5) RETURNING id`,
        [dept, category, seq, title, actorId],
      );
      if (!doc) {throw new BadRequestException('document_create_failed');}
      const stored = controlledDocFileName({dept, category, seq, title, version: 1, ext: f.ext});
      await tx.q(
        `INSERT INTO public.controlled_document_versions
           (document_id, version, stored_name, original_name, mime, size_bytes, sha256, content, change_note, uploaded_by)
         VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [doc.id, stored, (file!.originalname || stored).slice(0, 255), f.mime, file!.buffer.length, f.sha256,
         file!.buffer, note, actorId],
      );
      return {id: doc.id, number: controlledDocNumber(dept, category, seq), version: 1, file_name: stored};
    });
  }

  /** A new revision of an existing, active document. */
  async addVersion(actorId: string, id: string, input: {change_note?: unknown}, file: UploadedDoc | undefined) {
    const note = OpsDocumentsService.cleanNote(input.change_note);
    const f = this.checkFile(file);
    return this.db.withTransaction(async tx => {
      const doc = await tx.qOne<{department_code: DepartmentCode; category: number; seq: number; title: string;
        status: string; current_version: number}>(
        `SELECT department_code, category, seq, title, status, current_version
           FROM public.controlled_documents WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!doc) {throw new NotFoundException('document_not_found');}
      if (doc.status !== 'active') {throw new ConflictException('document_is_obsolete');}
      const dup = await tx.qOne<{version: number}>(
        `SELECT version FROM public.controlled_document_versions
          WHERE document_id = $1 AND version = $2 AND sha256 = $3`,
        [id, doc.current_version, f.sha256],
      );
      if (dup) {throw new ConflictException('same_as_current_version');}
      const version = doc.current_version + 1;
      const category = Number(doc.category) as DocCategoryCode;
      const stored = controlledDocFileName({dept: doc.department_code, category, seq: doc.seq, title: doc.title,
        version, ext: f.ext});
      await tx.q(
        `INSERT INTO public.controlled_document_versions
           (document_id, version, stored_name, original_name, mime, size_bytes, sha256, content, change_note, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, version, stored, (file!.originalname || stored).slice(0, 255), f.mime, file!.buffer.length, f.sha256,
         file!.buffer, note, actorId],
      );
      await tx.q(
        `UPDATE public.controlled_documents SET current_version = $2, updated_by = $3, updated_at = now() WHERE id = $1`,
        [id, version, actorId],
      );
      return {id, number: controlledDocNumber(doc.department_code, category, doc.seq), version, file_name: stored};
    });
  }

  /** Rename (the number stays) or withdraw / reinstate. */
  async update(actorId: string, id: string, input: {title?: unknown; status?: unknown}) {
    const title = input.title === undefined ? null : OpsDocumentsService.cleanTitle(input.title);
    const status = input.status === undefined ? null : input.status;
    if (status !== null && status !== 'active' && status !== 'obsolete') {throw new BadRequestException('bad_status');}
    if (title === null && status === null) {throw new BadRequestException('nothing_to_change');}
    const row = await this.db.qOne<{id: string}>(
      `UPDATE public.controlled_documents
          SET title = COALESCE($2, title), status = COALESCE($3, status), updated_by = $4, updated_at = now()
        WHERE id = $1 RETURNING id`,
      [id, title, status, actorId],
    );
    if (!row) {throw new NotFoundException('document_not_found');}
    return this.get(id);
  }

  /** The bytes of one version (the current one when `version` is omitted). */
  async file(id: string, version?: number): Promise<{name: string; mime: string; content: Buffer; number: string; version: number}> {
    const row = await this.db.qOne<{stored_name: string; mime: string; content: Buffer; version: number;
      department_code: DepartmentCode; category: number; seq: number}>(
      `SELECT v.stored_name, v.mime, v.content, v.version, d.department_code, d.category, d.seq
         FROM public.controlled_documents d
         JOIN public.controlled_document_versions v
           ON v.document_id = d.id AND v.version = COALESCE($2::int, d.current_version)
        WHERE d.id = $1`,
      [id, version ?? null],
    );
    if (!row) {throw new NotFoundException('document_version_not_found');}
    return {name: row.stored_name, mime: row.mime, content: row.content, version: row.version,
      number: controlledDocNumber(row.department_code, Number(row.category) as DocCategoryCode, row.seq)};
  }
}
