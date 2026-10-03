import {
  BadRequestException, ConflictException, Injectable, NotFoundException,
} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {MISSION_OPEN_STATES} from '../ops/mission-state-machine.service';

/**
 * Agency-owned vehicles (provider console Phase 2, 2026-10-03).
 *
 * Tenant rule, everywhere: the org id comes from OrgManagerGuard
 * (req.orgManager.org_user_id), never from the request, and every query filters
 * on it — a vehicle or mission of another agency reads as "not found".
 *
 * Review rule: an agency adds and edits its vehicles; HQ verifies them. Only a
 * verified, active vehicle can go on a job. Editing anything that identifies the
 * vehicle (plate, make/model, armour) puts it back into review.
 */

export const VEHICLE_COLS = `
  v.id, v.call_sign, v.make_model, v.plate, v.colour, v.armored, v.armor_grade,
  v.capacity, v.region_code, v.review_status, v.review_note, v.reviewed_at,
  v.active, v.created_at, v.updated_at
`;

const OPEN_STATES_SQL = `ARRAY[${MISSION_OPEN_STATES.map(s => `'${s}'`).join(',')}]::text[]`;

/** The open mission a vehicle is on right now, if any. */
const BUSY_SQL = `
  (SELECT m.short_code FROM mission_org_vehicles mv
     JOIN missions m ON m.id = mv.mission_id
    WHERE mv.vehicle_id = v.id AND mv.released_at IS NULL
      AND m.status::text = ANY(${OPEN_STATES_SQL})
    LIMIT 1)
`;

export interface VehicleInput {
  call_sign?: string;
  make_model?: string;
  plate?: string;
  colour?: string | null;
  armored?: boolean;
  armor_grade?: string | null;
  capacity?: number;
  region_code?: string | null;
  active?: boolean;
}

/** Fields whose change means HQ has to look at the vehicle again. */
const IDENTITY_FIELDS: Array<keyof VehicleInput> = ['make_model', 'plate', 'armored', 'armor_grade'];

const clean = (s: string | null | undefined) => (s === undefined ? undefined : s === null ? null : s.trim() || null);

@Injectable()
export class OrgFleetService {
  constructor(private readonly db: DatabaseService) {}

  async list(orgUserId: string): Promise<{vehicles: Array<Record<string, unknown>>}> {
    const vehicles = await this.db.q(
      `SELECT ${VEHICLE_COLS}, ${BUSY_SQL} AS on_mission
         FROM org_vehicles v
        WHERE v.org_user_id = $1
        ORDER BY v.active DESC, v.call_sign ASC
        LIMIT 500`,
      [orgUserId],
    );
    return {vehicles};
  }

  async create(orgUserId: string, actorId: string, dto: VehicleInput): Promise<{vehicle: Record<string, unknown>}> {
    if (!dto.call_sign?.trim() || !dto.make_model?.trim() || !dto.plate?.trim()) {
      throw new BadRequestException('call_sign_make_model_plate_required');
    }
    try {
      const vehicle = await this.db.qOne(
        `INSERT INTO org_vehicles AS v
           (org_user_id, call_sign, make_model, plate, colour, armored, armor_grade,
            capacity, region_code, created_by)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6,false),$7,COALESCE($8,4),$9,$10)
         RETURNING ${VEHICLE_COLS}, NULL::text AS on_mission`,
        [
          orgUserId, dto.call_sign.trim(), dto.make_model.trim(), dto.plate.trim(),
          clean(dto.colour) ?? null, dto.armored ?? null, clean(dto.armor_grade) ?? null,
          dto.capacity ?? null, clean(dto.region_code) ?? null, actorId,
        ],
      );
      return {vehicle: vehicle!};
    } catch (e) {
      throw this.uniqueError(e);
    }
  }

  async update(orgUserId: string, id: string, dto: VehicleInput): Promise<{vehicle: Record<string, unknown>}> {
    for (const f of ['call_sign', 'make_model', 'plate'] as const) {
      if (dto[f] !== undefined && !dto[f]!.trim()) throw new BadRequestException(`${f}_required`);
    }
    const next: Record<string, unknown> = {};
    if (dto.call_sign !== undefined) next.call_sign = dto.call_sign.trim();
    if (dto.make_model !== undefined) next.make_model = dto.make_model.trim();
    if (dto.plate !== undefined) next.plate = dto.plate.trim();
    if (dto.colour !== undefined) next.colour = clean(dto.colour);
    if (dto.armored !== undefined) next.armored = dto.armored;
    if (dto.armor_grade !== undefined) next.armor_grade = clean(dto.armor_grade);
    if (dto.capacity !== undefined) next.capacity = dto.capacity;
    if (dto.region_code !== undefined) next.region_code = clean(dto.region_code);
    if (dto.active !== undefined) next.active = dto.active;
    if (Object.keys(next).length === 0) throw new BadRequestException('no_fields');

    try {
      return await this.db.withTransaction(async tx => {
        const cur = await tx.qOne<Record<string, unknown>>(
          `SELECT make_model, plate, armored, armor_grade FROM org_vehicles
            WHERE id = $1 AND org_user_id = $2 FOR UPDATE`,
          [id, orgUserId],
        );
        if (!cur) throw new NotFoundException('vehicle_not_found');
        // Only a REAL change to what identifies the vehicle sends it back to
        // review: re-saving the same plate must not take a verified car off the road.
        const norm = (k: string, v: unknown) => (k === 'plate' && typeof v === 'string' ? v.replace(/\s/g, '').toUpperCase() : v ?? null);
        const reReview = IDENTITY_FIELDS.some(f => f in next && norm(f, next[f]) !== norm(f, cur[f]));

        const sets: string[] = [];
        const params: unknown[] = [];
        for (const [k, v] of Object.entries(next)) { params.push(v); sets.push(`${k} = $${params.length}`); }
        if (reReview) sets.push(`review_status = 'pending'`, 'review_note = NULL', 'reviewed_by = NULL', 'reviewed_at = NULL');
        sets.push('updated_at = now()');
        params.push(id, orgUserId);
        const vehicle = await tx.qOne(
          `UPDATE org_vehicles AS v SET ${sets.join(', ')}
            WHERE v.id = $${params.length - 1} AND v.org_user_id = $${params.length}
            RETURNING ${VEHICLE_COLS}, ${BUSY_SQL} AS on_mission`,
          params,
        );
        if (reReview || next.active === false) {
          // An unverified or retired vehicle comes off any open mission.
          await tx.q(
            `UPDATE mission_org_vehicles SET released_at = now()
              WHERE vehicle_id = $1 AND released_at IS NULL`,
            [id],
          );
        }
        return {vehicle: vehicle!};
      });
    } catch (e) {
      throw this.uniqueError(e);
    }
  }

  /** Vehicles currently on one of this agency's missions. */
  async missionVehicles(orgUserId: string, missionId: string): Promise<{vehicles: Array<Record<string, unknown>>}> {
    await this.ownedMission(this.db, orgUserId, missionId);
    const vehicles = await this.db.q(
      `SELECT ${VEHICLE_COLS}, mv.assigned_at
         FROM mission_org_vehicles mv
         JOIN org_vehicles v ON v.id = mv.vehicle_id
        WHERE mv.mission_id = $1 AND mv.org_user_id = $2 AND mv.released_at IS NULL
        ORDER BY mv.assigned_at`,
      [missionId, orgUserId],
    );
    return {vehicles};
  }

  async assign(orgUserId: string, actorId: string, missionId: string, vehicleId: string): Promise<{ok: true}> {
    return this.db.withTransaction(async tx => {
      const mission = await this.ownedMission(tx, orgUserId, missionId);
      if (!(MISSION_OPEN_STATES as readonly string[]).includes(mission.status)) {
        throw new ConflictException('mission_not_open');
      }
      // Lock the vehicle row: two managers assigning the same car at once queue here.
      const v = await tx.qOne<{active: boolean; review_status: string}>(
        `SELECT active, review_status FROM org_vehicles
          WHERE id = $1 AND org_user_id = $2 FOR UPDATE`,
        [vehicleId, orgUserId],
      );
      if (!v) throw new NotFoundException('vehicle_not_found');
      if (!v.active) throw new ConflictException('vehicle_inactive');
      if (v.review_status !== 'verified') throw new ConflictException('vehicle_not_verified');
      const busy = await tx.qOne<{mission_id: string}>(
        `SELECT mv.mission_id FROM mission_org_vehicles mv
           JOIN missions m ON m.id = mv.mission_id
          WHERE mv.vehicle_id = $1 AND mv.released_at IS NULL
            AND m.status::text = ANY(${OPEN_STATES_SQL})
          LIMIT 1`,
        [vehicleId],
      );
      if (busy && busy.mission_id !== missionId) throw new ConflictException('vehicle_busy');
      if (busy) return {ok: true as const};
      await tx.q(
        `INSERT INTO mission_org_vehicles (mission_id, vehicle_id, org_user_id, assigned_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (mission_id, vehicle_id)
           DO UPDATE SET released_at = NULL, assigned_by = EXCLUDED.assigned_by, assigned_at = now()`,
        [missionId, vehicleId, orgUserId, actorId],
      );
      return {ok: true as const};
    });
  }

  async release(orgUserId: string, missionId: string, vehicleId: string): Promise<{ok: true}> {
    const row = await this.db.qOne<{mission_id: string}>(
      `UPDATE mission_org_vehicles SET released_at = now()
        WHERE mission_id = $1 AND vehicle_id = $2 AND org_user_id = $3 AND released_at IS NULL
        RETURNING mission_id`,
      [missionId, vehicleId, orgUserId],
    );
    if (!row) throw new NotFoundException('assignment_not_found');
    return {ok: true};
  }

  // ── HQ review (ops console) ──────────────────────────────────────────────

  async listForReview(status: 'pending' | 'verified' | 'rejected' | 'all'): Promise<{vehicles: Array<Record<string, unknown>>}> {
    const where = status === 'all' ? '' : 'AND v.review_status = $1';
    const vehicles = await this.db.q(
      `SELECT ${VEHICLE_COLS}, v.org_user_id, u.display_name AS org_name, ${BUSY_SQL} AS on_mission
         FROM org_vehicles v
         JOIN public.users u ON u.id = v.org_user_id
        WHERE v.active ${where}
        ORDER BY (v.review_status = 'pending') DESC, v.created_at ASC
        LIMIT 500`,
      status === 'all' ? [] : [status],
    );
    return {vehicles};
  }

  async review(adminId: string, id: string, decision: 'verified' | 'rejected', note?: string | null): Promise<{vehicle: Record<string, unknown>}> {
    if (decision === 'rejected' && !(note && note.trim().length >= 3)) {
      throw new BadRequestException('reason_required');
    }
    const vehicle = await this.db.qOne(
      `UPDATE org_vehicles AS v
          SET review_status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now(), updated_at = now()
        WHERE v.id = $1
        RETURNING ${VEHICLE_COLS}, v.org_user_id`,
      [id, decision, note?.trim() || null, adminId],
    );
    if (!vehicle) throw new NotFoundException('vehicle_not_found');
    if (decision === 'rejected') {
      // A rejected vehicle comes off any open mission it was on.
      await this.db.q(
        `UPDATE mission_org_vehicles SET released_at = now()
          WHERE vehicle_id = $1 AND released_at IS NULL`,
        [id],
      );
    }
    return {vehicle};
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async ownedMission(
    db: Pick<DatabaseService, 'qOne'>, orgUserId: string, missionId: string,
  ): Promise<{status: string}> {
    const m = await db.qOne<{status: string}>(
      `SELECT m.status::text AS status FROM missions m
         JOIN lite_bookings b ON b.id = m.booking_id
        WHERE m.id = $1 AND b.assigned_provider_user_id = $2`,
      [missionId, orgUserId],
    );
    if (!m) throw new NotFoundException('mission_not_found');
    return m;
  }

  private uniqueError(e: unknown): unknown {
    const err = e as {code?: string; constraint?: string};
    if (err.code === '23505') {
      return new ConflictException(err.constraint?.includes('plate') ? 'plate_taken' : 'call_sign_taken');
    }
    if (err.code === '23514') return new BadRequestException('invalid_vehicle_field');
    return e;
  }
}

