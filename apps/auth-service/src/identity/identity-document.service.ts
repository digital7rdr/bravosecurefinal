import {BadRequestException, Injectable, NotFoundException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {OpsAuditService} from '../ops/ops-audit.service';
import type {AdminContext} from '../ops/admin.guard';
import {
  deriveIdentityKey, openIdentityImage, sealIdentityImage, sniffImageMime, type DocSide,
} from './identityDocumentCrypto';
import {resolveIdentityDocument, type IdentityDocumentFacts} from './identityGate';

/**
 * The identity document (B-867) — the founder's "ID / passport on
 * registration; settings page if missed; ops sees the photo".
 *
 *  - SUBMIT: the owner uploads front (+ optional back for a national ID) in
 *    ONE request; the row is upserted whole, so a replace never leaves a
 *    front from one document next to a back from another. Bytes are sealed
 *    with a purpose-derived key, the owner id + side as AAD; mime sniffed.
 *  - STATUS: the owner reads existence + type + date — never the bytes.
 *  - OPS READ: SUPERVISOR+ (route-gated) reads the images as data URLs; each
 *    read bumps the row's view counter and lands in ops_audit as
 *    'identity_document.view' on subject_type 'pii' — the same trail the
 *    phone/email reveal writes.
 */

export type IdentityDocType = 'national_id' | 'passport';
const DOC_TYPES: ReadonlySet<string> = new Set(['national_id', 'passport']);
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export interface IdentityImageOut {
  side: DocSide;
  mime: 'image/jpeg' | 'image/png';
  data_url: string;
}

export interface IdentityDocumentOpsRead {
  doc_type: IdentityDocType;
  submitted_at: string;
  view_count: number;
  images: IdentityImageOut[];
}

interface SealedRow {
  doc_type: IdentityDocType;
  front_mime: 'image/jpeg' | 'image/png';
  front_sealed: Buffer;
  back_mime: 'image/jpeg' | 'image/png' | null;
  back_sealed: Buffer | null;
  submitted_at: Date | string;
  view_count: number;
}

@Injectable()
export class IdentityDocumentService {
  private keyCache: Buffer | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly audit: OpsAuditService,
  ) {}

  private key(): Buffer {
    if (!this.keyCache) {
      // The same at-rest root the TOTP / check-in-photo lanes derive from,
      // DERIVED for this purpose (identityDocumentCrypto.ts) — no raw key
      // sharing, no new deployment secret.
      this.keyCache = deriveIdentityKey(this.config.get<string>('totp.encryptionKey') ?? '');
    }
    return this.keyCache;
  }

  /** Validate one image part: present, bounded, and genuinely a JPEG/PNG. */
  private checkImage(bytes: Buffer | undefined, side: DocSide): {bytes: Buffer; mime: 'image/jpeg' | 'image/png'} {
    if (!bytes || bytes.length === 0) throw new BadRequestException(`${side}_missing`);
    if (bytes.length > MAX_IMAGE_BYTES) throw new BadRequestException(`${side}_too_large`);
    const mime = sniffImageMime(bytes);
    if (!mime) throw new BadRequestException(`${side}_not_an_image`);
    return {bytes, mime};
  }

  // ─── Owner: submit / replace ──────────────────────────────────────────

  async submit(userId: string, docTypeRaw: string, front: Buffer | undefined, back: Buffer | undefined): Promise<IdentityDocumentFacts> {
    const docType = (docTypeRaw ?? '').trim();
    if (!DOC_TYPES.has(docType)) throw new BadRequestException('doc_type_invalid');
    const f = this.checkImage(front, 'front');
    // A passport has no second page to scan; refusing a stray back keeps the
    // row's meaning exact ("back" always means the back of a national ID).
    if (docType === 'passport' && back && back.length > 0) throw new BadRequestException('passport_has_no_back');
    const b = back && back.length > 0 ? this.checkImage(back, 'back') : null;

    const key = this.key();
    const frontSealed = sealIdentityImage(f.bytes, key, userId, 'front');
    const backSealed = b ? sealIdentityImage(b.bytes, key, userId, 'back') : null;
    await this.db.q(
      `INSERT INTO public.identity_documents
         (user_id, doc_type, front_mime, front_bytes_len, front_sealed, back_mime, back_bytes_len, back_sealed, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         doc_type = EXCLUDED.doc_type,
         front_mime = EXCLUDED.front_mime, front_bytes_len = EXCLUDED.front_bytes_len, front_sealed = EXCLUDED.front_sealed,
         back_mime = EXCLUDED.back_mime, back_bytes_len = EXCLUDED.back_bytes_len, back_sealed = EXCLUDED.back_sealed,
         submitted_at = NOW()`,
      [userId, docType, f.mime, f.bytes.length, frontSealed, b?.mime ?? null, b?.bytes.length ?? null, backSealed],
    );
    return resolveIdentityDocument(this.db, userId);
  }

  // ─── Owner: status ───────────────────────────────────────────────────

  status(userId: string): Promise<IdentityDocumentFacts> {
    return resolveIdentityDocument(this.db, userId);
  }

  // ─── Ops: read (audited) ─────────────────────────────────────────────

  async readForOps(admin: AdminContext, userId: string): Promise<IdentityDocumentOpsRead> {
    const row = await this.db.qOne<SealedRow>(
      // An erased account's document is deleted by eraseUser; the join is the
      // belt to that brace, so a stray row can never be opened for a deleted user.
      `SELECT d.doc_type, d.front_mime, d.front_sealed, d.back_mime, d.back_sealed, d.submitted_at, d.view_count
         FROM public.identity_documents d
         JOIN public.users u ON u.id = d.user_id AND u.deleted_at IS NULL
        WHERE d.user_id = $1`,
      [userId],
    );
    if (!row) throw new NotFoundException('identity_document_not_found');
    // FAIL-CLOSED: the audit row lands BEFORE any byte is opened. The action is
    // in OpsAuditService.CRITICAL_ACTIONS, so a failed insert throws here and
    // nothing is disclosed — the dispatch.full_read rule, applied to an ID.
    const sides = row.back_sealed && row.back_mime ? 2 : 1;
    await this.audit.recordAdmin(admin, 'identity_document.view', 'pii', userId, {doc_type: row.doc_type, sides});
    const key = this.key();
    const images: IdentityImageOut[] = [{
      side: 'front', mime: row.front_mime,
      data_url: `data:${row.front_mime};base64,${openIdentityImage(Buffer.from(row.front_sealed), key, userId, 'front').toString('base64')}`,
    }];
    if (row.back_sealed && row.back_mime) {
      images.push({
        side: 'back', mime: row.back_mime,
        data_url: `data:${row.back_mime};base64,${openIdentityImage(Buffer.from(row.back_sealed), key, userId, 'back').toString('base64')}`,
      });
    }
    await this.db.q(
      `UPDATE public.identity_documents SET view_count = view_count + 1, last_viewed_at = NOW() WHERE user_id = $1`,
      [userId],
    );
    return {
      doc_type: row.doc_type,
      submitted_at: new Date(row.submitted_at).toISOString(),
      view_count: row.view_count + 1,
      images,
    };
  }
}
