import {BadRequestException, ForbiddenException, Injectable, NotFoundException} from '@nestjs/common';
import {createHash, randomBytes} from 'node:crypto';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {TotpChallengeService} from '../common/services/totp-challenge.service';
import {resolveAccountKind, resolveIsOrgManager} from '../auth/account-kind';
import type {UserRow} from '../auth/auth.service';

/**
 * Bravo Secure home (bravosecure.cloud, 2026-10-10): the app launcher and the
 * single sign-on hand-off.
 *
 * Every app keeps its OWN session (bravo_ops_*, bravo_pv_*, bravo_web_*), so a
 * leaked launcher cookie never doubles as an ops session. Opening an app from
 * the launcher is an OAuth-style code exchange:
 *
 *   1. POST /hub/launch {app}       (launcher session) → checks access, mints a
 *      one-time code bound to (user, app, the app's exact origin), 60 s TTL,
 *      returns https://<app origin>/sso#code=…
 *   2. The app's /sso page POSTs /auth/sso/exchange {code} from its own origin
 *      → the code is consumed atomically, the origin must match, access is
 *      re-checked, and a fresh session is issued with THAT app's cookies.
 *
 * The code rides in the URL fragment, so it never reaches a server log or a
 * Referer header; only a sha256 of it is stored.
 */

export const AUDIENCES = ['client', 'officer', 'agency', 'ops'] as const;
export type Audience = typeof AUDIENCES[number];

export const APP_ICONS = ['shield', 'chat', 'team', 'globe', 'chart', 'calendar', 'vault', 'video'] as const;

export interface PlatformAppRow {
  key: string;
  name: string;
  tagline: string;
  icon: string;
  sort: number;
  active: boolean;
  url: string | null;
  agency_url: string | null;
  allowed_audiences: string[];
  requires_totp: boolean;
  updated_at: string;
  updated_by: string | null;
}

export type TileState = 'open' | 'inactive' | 'not_allowed' | 'needs_totp';

export interface AppTile {
  key: string;
  name: string;
  tagline: string;
  icon: string;
  state: TileState;
}

const CODE_TTL_SEC = 60;
const CODE_PREFIX = 'sso-code:';

interface CodeRecord {u: string; app: string; origin: string}

/** "https://web.bravosecure.cloud/book" → origin + path; null if not http(s). */
export function splitAppUrl(raw: string): {origin: string; path: string} | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  const path = `${u.pathname || '/'}${u.search}`;
  return {origin: u.origin.toLowerCase(), path: path.startsWith('/') ? path : `/${path}`};
}

/**
 * An address a Super Admin may save: https always; plain http only for a
 * localhost name outside production (local testing).
 */
export function isAllowedAppUrl(raw: string, production = process.env.NODE_ENV === 'production'): boolean {
  if (raw.length > 300) return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.username || u.password || u.hash) return false;
  if (u.protocol === 'https:') return true;
  const local = u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || u.hostname === '127.0.0.1';
  return !production && u.protocol === 'http:' && local;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

@Injectable()
export class HubService {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly totp: TotpChallengeService,
  ) {}

  /** The kinds of account this person is, decided on the server every time. */
  async audiences(userId: string): Promise<Set<Audience>> {
    const [kind, manager, staff] = await Promise.all([
      resolveAccountKind(this.db, userId),
      resolveIsOrgManager(this.db, userId),
      this.db.qOne<{n: number}>(`SELECT count(*)::int AS n FROM admin_users WHERE user_id=$1 AND active = TRUE`, [userId]),
    ]);
    const out = new Set<Audience>();
    if ((staff?.n ?? 0) > 0) out.add('ops');
    if (manager || kind.account_kind === 'agency') out.add('agency');
    if (kind.account_kind === 'cpo') out.add('officer');
    if (kind.account_kind === 'individual' && !manager) out.add('client');
    return out;
  }

  async listApps(): Promise<PlatformAppRow[]> {
    return this.db.q<PlatformAppRow>(
      `SELECT key, name, tagline, icon, sort, active, url, agency_url, allowed_audiences, requires_totp,
              updated_at, updated_by
         FROM public.platform_apps ORDER BY sort, key`);
  }

  private static stateFor(app: PlatformAppRow, who: Set<Audience>, totpVerified: boolean): TileState {
    if (!app.active || !app.url) return 'inactive';
    if (!app.allowed_audiences.some(a => who.has(a as Audience))) return 'not_allowed';
    if (app.requires_totp && !totpVerified) return 'needs_totp';
    return 'open';
  }

  async tiles(userId: string): Promise<{apps: AppTile[]; audiences: Audience[]; totp: 'none' | 'pending' | 'verified'}> {
    const [apps, who, totp] = await Promise.all([this.listApps(), this.audiences(userId), this.totp.status(userId)]);
    return {
      apps: apps.map(a => ({key: a.key, name: a.name, tagline: a.tagline, icon: a.icon,
        state: HubService.stateFor(a, who, totp === 'verified')})),
      audiences: [...who],
      totp,
    };
  }

  /** Step 1 of the hand-off. Throws when the person may not open the app. */
  async launch(userId: string, key: string): Promise<{redirect: string}> {
    const app = (await this.listApps()).find(a => a.key === key);
    if (!app) throw new NotFoundException('app_not_found');
    const [who, totp] = await Promise.all([this.audiences(userId), this.totp.status(userId)]);
    const state = HubService.stateFor(app, who, totp === 'verified');
    if (state !== 'open') throw new ForbiddenException(`app_${state}`);
    // Agency owners and managers go to the agency address when there is one
    // (Secure Services → the provider console); everyone else to the main one.
    const target = who.has('agency') && app.agency_url && !who.has('client') ? app.agency_url : app.url!;
    const parts = splitAppUrl(target);
    if (!parts) throw new BadRequestException('app_url_invalid');
    const code = randomBytes(32).toString('base64url');
    const rec: CodeRecord = {u: userId, app: app.key, origin: parts.origin};
    await this.redis.set(`${CODE_PREFIX}${sha(code)}`, JSON.stringify(rec), CODE_TTL_SEC);
    return {redirect: `${parts.origin}/sso#code=${encodeURIComponent(code)}&next=${encodeURIComponent(parts.path)}`};
  }

  /**
   * Step 2. Consumes the code (single use, atomically), checks it was minted
   * for THIS origin, re-checks access, and returns the account to sign in.
   */
  async exchange(code: string, origin: string | null): Promise<{user: UserRow; app: string}> {
    if (!origin) throw new ForbiddenException('sso_origin_required');
    const raw = await this.redis.takeOnce(`${CODE_PREFIX}${sha(code)}`);
    if (!raw) throw new ForbiddenException('sso_code_invalid');
    let rec: CodeRecord;
    try { rec = JSON.parse(raw) as CodeRecord; } catch { throw new ForbiddenException('sso_code_invalid'); }
    if (rec.origin !== origin.trim().replace(/\/+$/, '').toLowerCase()) throw new ForbiddenException('sso_code_invalid');
    const user = await this.db.qOne<UserRow>(
      `SELECT id,email,display_name,role,subscription_tier,phone_e164 FROM public.users
        WHERE id=$1 AND deleted_at IS NULL AND suspended_at IS NULL`, [rec.u]);
    if (!user) throw new ForbiddenException('sso_code_invalid');
    // Access may have been withdrawn in the seconds since launch.
    const app = (await this.listApps()).find(a => a.key === rec.app);
    const [who, totp] = await Promise.all([this.audiences(user.id), this.totp.status(user.id)]);
    if (!app || HubService.stateFor(app, who, totp === 'verified') !== 'open') throw new ForbiddenException('sso_code_invalid');
    return {user, app: rec.app};
  }

  /* ── Super Admin: edit the launcher ─────────────────────────────────── */

  async updateApp(key: string, patch: {
    name?: string; tagline?: string; icon?: string; sort?: number; active?: boolean;
    url?: string | null; agency_url?: string | null; allowed_audiences?: string[]; requires_totp?: boolean;
  }, adminUserId: string): Promise<{before: PlatformAppRow; after: PlatformAppRow}> {
    const before = (await this.listApps()).find(a => a.key === key);
    if (!before) throw new NotFoundException('app_not_found');
    for (const k of ['url', 'agency_url'] as const) {
      const v = patch[k];
      if (typeof v === 'string' && !isAllowedAppUrl(v)) throw new BadRequestException(`${k}_invalid`);
    }
    if (patch.allowed_audiences && patch.allowed_audiences.some(a => !(AUDIENCES as readonly string[]).includes(a))) {
      throw new BadRequestException('audience_invalid');
    }
    if (patch.icon !== undefined && !(APP_ICONS as readonly string[]).includes(patch.icon)) throw new BadRequestException('icon_invalid');
    const next = {...before, ...patch};
    if (next.active && !next.url) throw new BadRequestException('url_required_to_activate');
    const after = await this.db.qOne<PlatformAppRow>(
      `UPDATE public.platform_apps
          SET name=$2, tagline=$3, icon=$4, sort=$5, active=$6, url=$7, agency_url=$8,
              allowed_audiences=$9::text[], requires_totp=$10, updated_at=now(), updated_by=$11
        WHERE key=$1
        RETURNING key, name, tagline, icon, sort, active, url, agency_url, allowed_audiences, requires_totp, updated_at, updated_by`,
      [key, next.name, next.tagline, next.icon, next.sort, next.active, next.url, next.agency_url,
        [...new Set(next.allowed_audiences)], next.requires_totp, adminUserId],
    );
    return {before, after: after!};
  }
}
