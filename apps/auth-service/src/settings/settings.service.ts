import {Injectable, Logger, type OnModuleInit} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {RedisService} from '../redis/redis.service';
import {bumpConfigVersion, readConfigVersion} from '../common/services/config-version';
import {SettingsCrypto} from './settings-crypto';
import {CATALOG_BY_KEY, SETTINGS_CATALOG, type SettingDef} from './settings-catalog';

interface Row {
  key: string;
  category: string;
  value_plain: string | null;
  value_enc: string | null;
  is_secret: boolean;
  updated_by: string | null;
  updated_at: string;
}

/** What the admin surface sees — never a secret in clear. */
export interface SettingStatus {
  key: string;
  category: string;
  label: string;
  help?: string;
  secret: boolean;
  placeholder?: string;
  configured: boolean;
  source: 'db' | 'env' | 'unset';
  preview: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

const CACHE_TTL_MS = 15_000;

/**
 * Runtime resolver + admin write path for third-party integration settings.
 *
 * Consumers read with the SYNCHRONOUS getSync(): a warm in-memory snapshot
 * (loaded on module init, refreshed on a TTL and after every write) lets the
 * existing sync call sites — StripeClient.enabled, verifyWebhook, the Twilio and
 * Mapbox reads — switch source without becoming async. A DB override wins; with
 * none, the catalog's envFallback reproduces the pre-existing env behaviour, so
 * an empty table is a no-op.
 */
@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly log = new Logger(SettingsService.name);
  private readonly crypto = new SettingsCrypto(process.env['SETTINGS_ENCRYPTION_KEY']);

  /** DB-derived effective values (decrypted), catalog keys only. */
  private snapshot = new Map<string, string>();
  /** Full rows for the admin status view. */
  private rowsCache = new Map<string, Row>();
  private loadedAt = 0;
  private version: number | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Warm the snapshot before the app serves traffic so a secret that lives
    // only in the DB (e.g. the Stripe webhook secret) is available on the very
    // first request. A failure here is non-fatal — getSync falls back to env.
    await this.refresh().catch(e =>
      this.log.warn(`initial settings load failed: ${(e as Error).message}`));
  }

  get encryptionAvailable(): boolean {
    return this.crypto.available;
  }
  get encryptionUnavailableReason(): string | null {
    return this.crypto.unavailableReason;
  }

  // ── read path ───────────────────────────────────────────────────────────────

  /** Synchronous effective value: DB override → env fallback → undefined. */
  getSync(key: string): string | undefined {
    this.maybeRefresh(); // fire-and-forget; never blocks the caller
    const fromDb = this.snapshot.get(key);
    if (fromDb !== undefined) {return fromDb;}
    const def = CATALOG_BY_KEY.get(key);
    return def ? def.envFallback(this.config) : this.config.get<string>(key);
  }

  /** Async variant that guarantees a fresh snapshot first (used in tests/tools). */
  async get(key: string): Promise<string | undefined> {
    if (this.isStale()) {await this.refresh();}
    return this.getSync(key);
  }

  private isStale(): boolean {
    return Date.now() - this.loadedAt >= CACHE_TTL_MS;
  }

  private maybeRefresh(): void {
    if (this.refreshing || !this.isStale()) {return;}
    // A cross-replica write bumps the version; if unchanged, just extend the TTL
    // window without a DB hit.
    void (async () => {
      try {
        const v = await readConfigVersion(this.redis, 'integrations').catch(() => null);
        if (v !== null && v === this.version) {this.loadedAt = Date.now(); return;}
        await this.refresh();
      } catch {/* TTL will retry */}
    })();
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) {return this.refreshing;}
    this.refreshing = (async () => {
      let res: Row[];
      try {
        res = await this.db.q<Row>(
        `select key, category, value_plain, value_enc, is_secret, updated_by,
                updated_at::text as updated_at
           from platform_settings`,
        );
      } catch (e) {
        // Table missing (migration not applied yet) or a DB blip: keep the last
        // good snapshot, back off for one TTL window instead of re-querying on
        // every request, and let getSync keep serving env fallbacks.
        this.log.warn(`platform_settings unavailable, using env fallback: ${(e as Error).message}`);
        this.loadedAt = Date.now();
        return;
      }
      const rows = new Map<string, Row>();
      const snap = new Map<string, string>();
      for (const r of res) {
        rows.set(r.key, r);
        if (!CATALOG_BY_KEY.has(r.key)) {continue;}
        if (r.is_secret && r.value_enc) {
          try {
            snap.set(r.key, this.crypto.decrypt(r.value_enc));
          } catch (e) {
            this.log.error(`decrypt failed for ${r.key}: ${(e as Error).message} — using env fallback`);
          }
        } else if (!r.is_secret && r.value_plain !== null) {
          snap.set(r.key, r.value_plain);
        }
      }
      this.rowsCache = rows;
      this.snapshot = snap;
      this.loadedAt = Date.now();
      this.version = await readConfigVersion(this.redis, 'integrations').catch(() => null);
    })().finally(() => {this.refreshing = null;});
    return this.refreshing;
  }

  // ── admin surface ─────────────────────────────────────────────────────────

  private static mask(value: string, secret: boolean): string {
    if (!secret) {return value.length > 80 ? `${value.slice(0, 77)}…` : value;}
    return `${'•'.repeat(Math.min(Math.max(value.length - 4, 4), 12))}${value.slice(-4)}`;
  }

  async status(): Promise<SettingStatus[]> {
    if (this.isStale()) {await this.refresh().catch(() => undefined);}
    return SETTINGS_CATALOG.map((def): SettingStatus => {
      const row = this.rowsCache.get(def.key);
      let source: SettingStatus['source'] = 'unset';
      let preview: string | null = null;
      let updatedAt: string | null = null;
      let updatedBy: string | null = null;

      if (row) {
        source = 'db';
        updatedAt = row.updated_at;
        updatedBy = row.updated_by;
        if (def.secret && row.value_enc) {
          try {
            preview = SettingsService.mask(this.crypto.decrypt(row.value_enc), true);
          } catch {
            preview = '⚠ undecryptable';
          }
        } else if (!def.secret && row.value_plain !== null) {
          preview = SettingsService.mask(row.value_plain, false);
        }
      } else {
        const envVal = def.envFallback(this.config);
        if (envVal !== undefined && envVal !== '') {
          source = 'env';
          preview = SettingsService.mask(envVal, def.secret);
        }
      }

      return {
        key: def.key, category: def.category, label: def.label, help: def.help,
        secret: def.secret, placeholder: def.placeholder,
        configured: source !== 'unset', source, preview, updatedAt, updatedBy,
      };
    });
  }

  /** Upsert a value. Encrypts secrets; rejects unknown keys. */
  async set(key: string, rawValue: string, adminId: string | null): Promise<SettingDef> {
    const def = CATALOG_BY_KEY.get(key);
    if (!def) {throw new Error(`unknown setting key: ${key}`);}
    const value = rawValue.trim();
    if (value === '') {throw new Error('value is empty — use clear to remove a setting');}

    if (def.secret) {
      if (!this.crypto.available) {
        throw new Error(this.crypto.unavailableReason ?? 'encryption key unavailable');
      }
      const enc = this.crypto.encrypt(value);
      await this.db.q(
        `insert into platform_settings (key, category, value_enc, value_plain, is_secret, updated_by, updated_at)
           values ($1, $2, $3, null, true, $4, now())
         on conflict (key) do update
           set value_enc = excluded.value_enc, value_plain = null, is_secret = true,
               category = excluded.category, updated_by = excluded.updated_by, updated_at = now()`,
        [key, def.category, enc, adminId],
      );
    } else {
      await this.db.q(
        `insert into platform_settings (key, category, value_plain, value_enc, is_secret, updated_by, updated_at)
           values ($1, $2, $3, null, false, $4, now())
         on conflict (key) do update
           set value_plain = excluded.value_plain, value_enc = null, is_secret = false,
               category = excluded.category, updated_by = excluded.updated_by, updated_at = now()`,
        [key, def.category, value, adminId],
      );
    }
    await this.invalidate();
    return def;
  }

  /** Remove a setting so the resolver falls back to env again. */
  async clear(key: string, _adminId: string | null): Promise<SettingDef> {
    const def = CATALOG_BY_KEY.get(key);
    if (!def) {throw new Error(`unknown setting key: ${key}`);}
    await this.db.q(`delete from platform_settings where key = $1`, [key]);
    await this.invalidate();
    return def;
  }

  private async invalidate(): Promise<void> {
    await bumpConfigVersion(this.redis, 'integrations').catch(() => undefined);
    this.loadedAt = 0; // force this instance to reload on next read
    await this.refresh().catch(() => undefined);
  }
}
