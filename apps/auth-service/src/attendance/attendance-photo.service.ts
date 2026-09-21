import {
  BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException,
  OnModuleDestroy, OnModuleInit,
} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {OrgAuditService} from '../org/org-audit.service';
import {acquireRedisLock, releaseRedisLock} from '../common/redis-lock';
import {derivePhotoKey, openPhoto, sealPhoto, sniffImageMime} from './attendancePhotoCrypto';

/**
 * The check-in face photo (founder, 2026-09-05).
 *
 * Until now the frame never left the device (architecture-signed 2026-07-02
 * stop-condition in faceCheck.ts). The founder's instruction changes that
 * with explicit bounds, and this service IS those bounds:
 *
 *  - STORE: the member uploads the frame once, right after their own clock-in
 *    (owner-checked, session still open, inside the upload window, one per
 *    session). Bytes are sealed with a purpose-derived key and the session id
 *    as AAD (attendancePhotoCrypto.ts); mime is sniffed, never trusted.
 *  - READ: only an org manager whose branch covers the member, and every read
 *    lands in org_audit_log ('attendance.photo.view') with a view counter on
 *    the row. Never in any list, export or bell payload.
 *  - PURGE: the bytes are wiped (sealed = NULL, deleted_at) when the review is
 *    no longer pending AND the shift has ended — "when approved and shift
 *    done, image will delete" — and unconditionally after HARD_TTL_DAYS. The
 *    row survives as the audit trail of how often it was viewed.
 */

const UPLOAD_WINDOW_MS = 20 * 60_000;
const MAX_BYTES = 2 * 1024 * 1024;
const HARD_TTL_DAYS = 30;
const SWEEP_INTERVAL_MS = 10 * 60_000;
const LOCK_KEY = 'lock:attendance-photo-purge';
const LOCK_TTL_MS = 9 * 60_000;

export interface PhotoRead {
  mime: 'image/jpeg' | 'image/png';
  bytes: Buffer;
  created_at: string;
}

/** The ONE purge rule, as SQL, shared by the sweep and the post-review hook. */
export const PURGE_DUE_PREDICATE = `
  p.deleted_at IS NULL
  AND (
    p.created_at < NOW() - INTERVAL '${HARD_TTL_DAYS} days'
    OR EXISTS (
      SELECT 1 FROM public.cpo_shift_sessions ses
      LEFT JOIN public.cpo_shifts sh ON sh.id = ses.shift_id
      WHERE ses.id = p.session_id
        AND ses.review_status <> 'pending'
        AND ((sh.end_at IS NOT NULL AND sh.end_at < NOW())
             OR (sh.id IS NULL AND ses.status <> 'open'))
    )
  )`;

@Injectable()
export class AttendancePhotoService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(AttendancePhotoService.name);
  private timer: NodeJS.Timeout | null = null;
  private keyCache: Buffer | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly audit: OrgAuditService,
  ) {}

  private key(): Buffer {
    if (!this.keyCache) {
      // The same root the TOTP lane uses, DERIVED for this purpose (see the
      // crypto helper) — no raw key sharing, no new deployment secret.
      this.keyCache = derivePhotoKey(this.config.get<string>('totp.encryptionKey') ?? '');
    }
    return this.keyCache;
  }

  onModuleInit(): void {
    this.timer = setInterval(() => { void this.sweepOnce().catch(() => undefined); }, SWEEP_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // ─── Member: store ────────────────────────────────────────────────────

  async store(sessionId: string, cpoUserId: string, bytes: Buffer): Promise<{stored: true}> {
    if (!bytes || bytes.length === 0) throw new BadRequestException('photo_empty');
    if (bytes.length > MAX_BYTES) throw new BadRequestException('photo_too_large');
    const mime = sniffImageMime(bytes);
    if (!mime) throw new BadRequestException('photo_not_an_image');

    const ses = await this.db.qOne<{org_user_id: string; cpo_user_id: string; status: string; clock_in_at: string}>(
      `SELECT org_user_id, cpo_user_id, status, clock_in_at FROM public.cpo_shift_sessions WHERE id = $1`,
      [sessionId],
    );
    if (!ses) throw new NotFoundException('session_not_found');
    // Owner-only, and only for the session just opened: a photo is evidence of
    // THIS check-in, not something to attach to history.
    if (ses.cpo_user_id !== cpoUserId) throw new ForbiddenException('not_your_session');
    if (ses.status !== 'open') throw new BadRequestException('session_not_open');
    if (Date.now() - new Date(ses.clock_in_at).getTime() > UPLOAD_WINDOW_MS) {
      throw new BadRequestException('photo_upload_window_closed');
    }
    const sealed = sealPhoto(bytes, this.key(), sessionId);
    const ins = await this.db.q<{session_id: string}>(
      `INSERT INTO public.attendance_checkin_photos
         (session_id, org_user_id, cpo_user_id, mime, bytes_len, sealed)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (session_id) DO NOTHING
       RETURNING session_id`,
      [sessionId, ses.org_user_id, cpoUserId, mime, bytes.length, sealed],
    );
    if (ins.length === 0) throw new BadRequestException('photo_already_stored');
    return {stored: true};
  }

  // ─── Manager: read (audited) ──────────────────────────────────────────

  async read(
    orgUserId: string, managerUserId: string, managerDepartment: string | null, sessionId: string,
  ): Promise<PhotoRead> {
    const row = await this.db.qOne<{
      mime: 'image/jpeg' | 'image/png'; sealed: Buffer | null; created_at: string; deleted_at: string | null;
      cpo_user_id: string; in_branch: boolean;
    }>(
      // Same branch rule as orgShifts / pendingQueue: the member's shift
      // department, else their org_members department, must match a scoped
      // manager's department. An unscoped manager (NULL) sees the whole org.
      `SELECT p.mime, p.sealed, p.created_at, p.deleted_at, p.cpo_user_id,
              ($3::text IS NULL OR COALESCE(sh.department, om.department) = $3) AS in_branch
         FROM public.attendance_checkin_photos p
         JOIN public.cpo_shift_sessions ses ON ses.id = p.session_id
         LEFT JOIN public.cpo_shifts sh ON sh.id = ses.shift_id
         LEFT JOIN public.org_members om ON om.org_user_id = ses.org_user_id AND om.member_user_id = ses.cpo_user_id
        WHERE p.session_id = $1 AND p.org_user_id = $2`,
      [sessionId, orgUserId, managerDepartment ?? null],
    );
    if (!row || !row.in_branch) throw new NotFoundException('photo_not_found');
    if (!row.sealed || row.deleted_at) throw new NotFoundException('photo_purged');
    const bytes = openPhoto(Buffer.from(row.sealed), this.key(), sessionId);
    await this.db.q(
      `UPDATE public.attendance_checkin_photos
          SET view_count = view_count + 1, last_viewed_at = NOW()
        WHERE session_id = $1`, [sessionId],
    );
    // Every look at a face is a recorded act — metadata only, never the bytes.
    await this.audit.log(orgUserId, managerUserId, 'attendance.photo.view', {
      targetKind: 'shift_session', targetId: sessionId, metadata: {member_user_id: row.cpo_user_id},
    }).catch(() => undefined);
    return {mime: row.mime, bytes, created_at: new Date(row.created_at).toISOString()};
  }

  /** Which of these sessions still have a viewable photo (for list badges). */
  async liveFor(sessionIds: string[]): Promise<Set<string>> {
    if (sessionIds.length === 0) return new Set();
    const rows = await this.db.q<{session_id: string}>(
      `SELECT session_id FROM public.attendance_checkin_photos
        WHERE session_id = ANY($1::uuid[]) AND deleted_at IS NULL AND sealed IS NOT NULL`,
      [sessionIds],
    );
    return new Set(rows.map(r => r.session_id));
  }

  // ─── Purge ────────────────────────────────────────────────────────────

  /** Wipe the bytes of every photo whose retention has ended. Returns how many. */
  async purgeDue(limit = 500): Promise<number> {
    const rows = await this.db.q<{session_id: string}>(
      `UPDATE public.attendance_checkin_photos p
          SET sealed = NULL, deleted_at = NOW()
        WHERE p.session_id IN (
          SELECT p.session_id FROM public.attendance_checkin_photos p
           WHERE ${PURGE_DUE_PREDICATE}
           LIMIT $1)
        RETURNING p.session_id`,
      [limit],
    );
    return rows.length;
  }

  /** Called right after a review decision: purge THIS session's photo if due. */
  async purgeIfDue(sessionId: string): Promise<boolean> {
    const rows = await this.db.q<{session_id: string}>(
      `UPDATE public.attendance_checkin_photos p
          SET sealed = NULL, deleted_at = NOW()
        WHERE p.session_id = $1 AND ${PURGE_DUE_PREDICATE}
        RETURNING p.session_id`,
      [sessionId],
    );
    return rows.length > 0;
  }

  /** Public for tests — one purge iteration under the cross-pod lock. */
  async sweepOnce(): Promise<{purged: number; skipped_lock: boolean}> {
    const token = await acquireRedisLock(this.redis.client, LOCK_KEY, LOCK_TTL_MS);
    if (token === null) return {purged: 0, skipped_lock: true};
    try {
      const purged = await this.purgeDue();
      if (purged > 0) this.log.log(`attendance photo purge: ${purged} wiped`);
      return {purged, skipped_lock: false};
    } finally {
      await releaseRedisLock(this.redis.client, LOCK_KEY, token).catch(() => undefined);
    }
  }
}
