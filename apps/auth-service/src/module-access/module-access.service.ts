import {BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {resolveAccountKind, type AccountKindResult} from '../auth/account-kind';
import {bumpConfigVersion, readConfigVersion} from '../common/services/config-version';
import {
  ACCOUNT_GROUPS, ALWAYS_ON, GROUP_IDS, MODULES, MODULE_BY_KEY, NOT_YET,
  type AccountGroup, type ModuleKey,
} from './module-catalog';

export interface EffectiveModules {
  group: AccountGroup;
  /** Applicable modules that are switched OFF for this user. Everything else is on. */
  disabled: ModuleKey[];
}

interface Cell {enabled: boolean; updated_at: string}

const USER_TTL_S = 30;
const MATRIX_TTL_MS = 15_000;
const userKey = (ver: number, sub: string) => `modacc:${ver}:${sub}`;

/**
 * Resolves and administers per-account-group module access.
 *
 * effective(user) = override(user, module) ?? matrix(group, module) ?? ENABLED,
 * evaluated only for modules APPLICABLE to the user's group — a client-side
 * module toggle can never block an agency or CPO endpoint.
 *
 * Caching mirrors account-gate-cache: the per-user result sits in Redis for 30s
 * under a key that embeds the matrix version, so a matrix edit invalidates every
 * user at once (one INCR) and an override edit DELs one key. Any Redis or DB
 * failure FAILS OPEN — these are product modules, not the authentication
 * boundary (JwtAuthGuard still runs first), and an outage must not lock
 * everyone out of the app.
 */
@Injectable()
export class ModuleAccessService {
  private readonly log = new Logger(ModuleAccessService.name);
  private matrix: Map<string, Cell> | null = null;
  private matrixAt = 0;
  private matrixVersion: number | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  /** Account group from the same facts /auth/me routes on. */
  static groupFrom(kind: Pick<AccountKindResult, 'account_kind' | 'owns_workspace' | 'workspaces'>): AccountGroup {
    if (kind.account_kind === 'cpo') {return 'cpo';}
    if (kind.account_kind === 'agency') {return 'agency';}
    if (kind.owns_workspace || (kind.workspaces?.length ?? 0) > 0) {return 'enterprise';}
    return 'individual';
  }

  private async version(): Promise<number> {
    return (await readConfigVersion(this.redis, 'module_access').catch(() => null)) ?? 0;
  }

  private async loadMatrix(): Promise<Map<string, Cell>> {
    const now = Date.now();
    if (this.matrix && now - this.matrixAt < MATRIX_TTL_MS) {
      const v = await readConfigVersion(this.redis, 'module_access').catch(() => null);
      if (v === null || v === this.matrixVersion) {return this.matrix;}
    }
    const rows = await this.db.q<{account_group: string; module_key: string; enabled: boolean; updated_at: string}>(
      `select account_group, module_key, enabled, updated_at::text as updated_at from public.module_access`,
    );
    this.matrix = new Map(rows.map(r => [`${r.account_group}:${r.module_key}`, {enabled: r.enabled, updated_at: r.updated_at}]));
    this.matrixAt = now;
    this.matrixVersion = await readConfigVersion(this.redis, 'module_access').catch(() => null);
    return this.matrix;
  }

  private async overrides(userId: string): Promise<Map<string, boolean>> {
    const rows = await this.db.q<{module_key: string; enabled: boolean}>(
      `select module_key, enabled from public.user_module_overrides where user_id = $1`, [userId],
    );
    return new Map(rows.map(r => [r.module_key, r.enabled]));
  }

  private static compute(group: AccountGroup, matrix: Map<string, Cell>, ov: Map<string, boolean>): ModuleKey[] {
    return MODULES
      .filter(m => m.groups.includes(group))
      .filter(m => {
        const o = ov.get(m.key);
        if (o !== undefined) {return !o;}
        const cell = matrix.get(`${group}:${m.key}`);
        return cell ? !cell.enabled : false;
      })
      .map(m => m.key);
  }

  // ── hot path ────────────────────────────────────────────────────────────────

  async effective(userId: string): Promise<EffectiveModules> {
    const ver = await this.version();
    const key = userKey(ver, userId);
    if (this.redis?.client) {
      try {
        const raw = await this.redis.client.get(key);
        if (raw) {return JSON.parse(raw) as EffectiveModules;}
      } catch {/* fall through to the DB */}
    }
    const kind = await resolveAccountKind(this.db, userId);
    const group = ModuleAccessService.groupFrom(kind);
    const [matrix, ov] = await Promise.all([this.loadMatrix(), this.overrides(userId)]);
    const result: EffectiveModules = {group, disabled: ModuleAccessService.compute(group, matrix, ov)};
    if (this.redis?.client) {
      try {await this.redis.client.set(key, JSON.stringify(result), 'EX', USER_TTL_S);} catch {/* fail-open */}
    }
    return result;
  }

  /** For /auth/me: never throws — the app is presentation, the guard is the gate. */
  async effectiveOrNull(userId: string): Promise<EffectiveModules | null> {
    try {
      return await this.effective(userId);
    } catch (e) {
      this.log.warn(`module access unavailable for /auth/me: ${(e as Error).message}`);
      return null;
    }
  }

  async isEnabled(userId: string, key: ModuleKey): Promise<boolean> {
    try {
      return !(await this.effective(userId)).disabled.includes(key);
    } catch (e) {
      this.log.warn(`module check for ${key} failed OPEN: ${(e as Error).message}`);
      return true;
    }
  }

  async assertEnabled(userId: string, key: ModuleKey): Promise<void> {
    if (await this.isEnabled(userId, key)) {return;}
    const label = MODULE_BY_KEY.get(key)?.label ?? 'This feature';
    throw new ForbiddenException({
      error: 'module_disabled', module: key,
      message: `${label} is not available on your account.`,
    });
  }

  // ── admin surface ─────────────────────────────────────────────────────────

  async matrixView() {
    this.matrix = null; // admin reads are always fresh
    const matrix = await this.loadMatrix();
    return {
      groups: ACCOUNT_GROUPS,
      modules: MODULES,
      alwaysOn: ALWAYS_ON,
      notYet: NOT_YET,
      cells: ACCOUNT_GROUPS.flatMap(g => MODULES.map(m => {
        const applicable = m.groups.includes(g.id);
        const cell = matrix.get(`${g.id}:${m.key}`);
        return {
          group: g.id, module: m.key, applicable,
          enabled: applicable ? (cell?.enabled ?? true) : null,
          updatedAt: cell?.updated_at ?? null,
        };
      })),
    };
  }

  async setGroupModule(group: string, key: string, enabled: boolean, adminId: string | null): Promise<void> {
    if (!GROUP_IDS.has(group)) {throw new BadRequestException('unknown_group');}
    const def = MODULE_BY_KEY.get(key);
    if (!def) {throw new BadRequestException('unknown_module');}
    if (!def.groups.includes(group as AccountGroup)) {throw new BadRequestException('module_not_applicable');}
    await this.db.q(
      `insert into public.module_access (account_group, module_key, enabled, updated_by, updated_at)
         values ($1, $2, $3, $4, now())
       on conflict (account_group, module_key) do update
         set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now()`,
      [group, key, enabled, adminId],
    );
    this.matrix = null;
    await bumpConfigVersion(this.redis, 'module_access'); // invalidates every user's cached result
  }

  async userView(userId: string) {
    const exists = await this.db.qOne<{id: string}>(
      `select id from public.users where id = $1 and deleted_at is null`, [userId],
    );
    if (!exists) {throw new NotFoundException('user_not_found');}
    const group = ModuleAccessService.groupFrom(await resolveAccountKind(this.db, userId));
    this.matrix = null;
    const [matrix, ov] = await Promise.all([this.loadMatrix(), this.overrides(userId)]);
    return {
      group,
      modules: MODULES.map(m => {
        const applicable = m.groups.includes(group);
        const groupEnabled = matrix.get(`${group}:${m.key}`)?.enabled ?? true;
        const override = ov.has(m.key) ? ov.get(m.key)! : null;
        return {
          key: m.key, label: m.label, applicable,
          groupEnabled: applicable ? groupEnabled : null,
          override: applicable ? override : null,
          enabled: applicable ? (override ?? groupEnabled) : null,
        };
      }),
    };
  }

  /** `enabled: null` removes the override (the user follows their group again). */
  async setUserOverride(userId: string, key: string, enabled: boolean | null, adminId: string | null): Promise<AccountGroup> {
    const def = MODULE_BY_KEY.get(key);
    if (!def) {throw new BadRequestException('unknown_module');}
    const exists = await this.db.qOne<{id: string}>(
      `select id from public.users where id = $1 and deleted_at is null`, [userId],
    );
    if (!exists) {throw new NotFoundException('user_not_found');}
    const group = ModuleAccessService.groupFrom(await resolveAccountKind(this.db, userId));
    if (!def.groups.includes(group)) {throw new BadRequestException('module_not_applicable');}
    if (enabled === null) {
      await this.db.q(`delete from public.user_module_overrides where user_id = $1 and module_key = $2`, [userId, key]);
    } else {
      await this.db.q(
        `insert into public.user_module_overrides (user_id, module_key, enabled, updated_by, updated_at)
           values ($1, $2, $3, $4, now())
         on conflict (user_id, module_key) do update
           set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now()`,
        [userId, key, enabled, adminId],
      );
    }
    await this.bustUser(userId);
    return group;
  }

  async bustUser(userId: string): Promise<void> {
    if (!this.redis?.client) {return;}
    try {await this.redis.client.del(userKey(await this.version(), userId));} catch {/* TTL backstop */}
  }
}
