import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional,
} from '@nestjs/common';
import {DatabaseService, type Tx} from '../database/database.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';

/**
 * Referral / discount campaigns (founder, 2026-09-05).
 *
 * Ops mints a code, UNIVERSAL or bound to one REGION, with a percent or a
 * fixed Bravo-Credit discount, optional service filter, caps and a validity
 * window. A client types it on a booking (or arrives through a deep link that
 * pre-fills it) and the quote and the charge both drop by the discount.
 *
 * ── THE ONE RULE ─────────────────────────────────────────────────────────
 * A campaign moves the client's TOTAL and nothing else. It is never read by
 * the dispatch ranker, the offer cascade, availability, licensing or operator
 * approval (the same boundary Issue 28 draws for partner codes, which stay a
 * separate, attribution-only table). The discount is applied to the EUR total
 * BEFORE it is stored, so every charge path that reads total_eur — pay with
 * credits, offer accept, the B-795 committed-sum check — is discount-correct
 * without knowing a discount exists.
 *
 * Reads are two shapes: `quote` NEVER throws (the estimate shows the client why
 * a code did not apply), `resolveForBooking` throws (a create with a code that
 * does not apply is refused up front rather than silently charged full price).
 * Both go through ONE `evaluate` so the preview and the charge cannot disagree.
 */

export type CampaignScope = 'universal' | 'region';
export type CampaignDiscountType = 'percent' | 'fixed_bc';

export interface ReferralCampaignRow {
  id: string;
  code: string;
  name: string;
  scope: CampaignScope;
  region_code: string | null;
  discount_type: CampaignDiscountType;
  discount_value: string | number;
  max_discount_bc: number | null;
  services: string[] | null;
  max_redemptions: number | null;
  per_user_limit: number;
  starts_at: string | Date | null;
  expires_at: string | Date | null;
  active: boolean;
  notes: string | null;
  created_by: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  /** Eligible-client push fan-out: last run + how many it reached. */
  notified_at?: string | Date | null;
  notified_count?: number;
}

export type CampaignRefusal =
  | 'referral_campaign_inactive'
  | 'referral_campaign_not_started'
  | 'referral_campaign_expired'
  | 'referral_campaign_region_mismatch'
  | 'referral_campaign_service_mismatch'
  | 'referral_campaign_exhausted'
  | 'referral_campaign_limit_reached';

export interface CampaignQuoteInput {
  code: string;
  /** The booking's dispatch zone (lite_bookings.region_code). */
  regionCode: string | null | undefined;
  service: string | null | undefined;
  grossEur: number;
  eurPerBc: number;
  /** Optional on an estimate (a preview may run before the caller is known). */
  userId?: string | null;
}

export interface CampaignQuote {
  campaign: ReferralCampaignRow;
  applied: boolean;
  reason: CampaignRefusal | null;
  discountEur: number;
  discountBc: number;
  /** What the client sees: "20% off", "150 BC off". */
  label: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

@Injectable()
export class ReferralCampaignsService {
  private readonly log = new Logger(ReferralCampaignsService.name);

  constructor(
    private readonly db: DatabaseService,
    // Optional so the direct-construction specs keep working; without it the
    // fan-out is a no-op that reports zero, never a throw.
    @Optional() private readonly push?: BookingPushBridge,
  ) {}

  // ─── Pure discount arithmetic (unit-pinned) ───────────────────────────────

  /** The discount in EUR for a gross EUR total. Never exceeds the gross. */
  static discountFor(
    c: Pick<ReferralCampaignRow, 'discount_type' | 'discount_value' | 'max_discount_bc'>,
    grossEur: number, eurPerBc: number,
  ): number {
    const gross = Math.max(0, grossEur);
    const value = Number(c.discount_value);
    if (!(gross > 0) || !(value > 0) || !(eurPerBc > 0)) return 0;
    let eur: number;
    if (c.discount_type === 'percent') {
      eur = gross * Math.min(value, 100) / 100;
      if (c.max_discount_bc !== null && c.max_discount_bc !== undefined) {
        eur = Math.min(eur, c.max_discount_bc * eurPerBc);
      }
    } else {
      eur = value * eurPerBc;
    }
    return round2(Math.min(gross, eur));
  }

  static labelFor(c: Pick<ReferralCampaignRow, 'discount_type' | 'discount_value'>): string {
    const value = Number(c.discount_value);
    return c.discount_type === 'percent'
      ? `${Number.isInteger(value) ? value : value.toFixed(1)}% off`
      : `${Math.round(value)} BC off`;
  }

  /**
   * ONE decision for both the preview and the charge. Returns null when the
   * code is not a campaign at all (the caller then tries the partner table).
   */
  private async evaluate(input: CampaignQuoteInput): Promise<CampaignQuote | null> {
    const code = (input.code ?? '').trim().toUpperCase();
    if (!code) return null;
    const campaign = await this.db.qOne<ReferralCampaignRow>(
      `SELECT * FROM public.referral_campaigns WHERE code = $1`, [code],
    );
    if (!campaign) return null;

    const label = ReferralCampaignsService.labelFor(campaign);
    const refuse = (reason: CampaignRefusal): CampaignQuote =>
      ({campaign, applied: false, reason, discountEur: 0, discountBc: 0, label});

    if (!campaign.active) return refuse('referral_campaign_inactive');
    const now = Date.now();
    if (campaign.starts_at && new Date(campaign.starts_at).getTime() > now) {
      return refuse('referral_campaign_not_started');
    }
    if (campaign.expires_at && new Date(campaign.expires_at).getTime() <= now) {
      return refuse('referral_campaign_expired');
    }
    const region = (input.regionCode ?? '').trim().toUpperCase();
    if (campaign.scope === 'region' && campaign.region_code &&
        campaign.region_code.toUpperCase() !== region) {
      return refuse('referral_campaign_region_mismatch');
    }
    if (campaign.services && campaign.services.length > 0) {
      const svc = (input.service ?? 'secure_transfer').trim();
      if (!campaign.services.includes(svc)) return refuse('referral_campaign_service_mismatch');
    }
    if (campaign.max_redemptions !== null || input.userId) {
      // Counted live from the ledger rather than a counter column: the ledger
      // row is written per discounted booking and is the source ops reads, so
      // the cap and the report can never disagree. (A concurrent pair of
      // creates can overshoot the cap by one — acceptable for a discount.)
      const counts = await this.db.qOne<{total: string; mine: string}>(
        `SELECT COUNT(*)::text AS total,
                COUNT(*) FILTER (WHERE user_id = $2)::text AS mine
           FROM public.referral_redemptions
          WHERE campaign_id = $1`,
        [campaign.id, input.userId ?? null],
      );
      if (campaign.max_redemptions !== null && Number(counts?.total ?? 0) >= campaign.max_redemptions) {
        return refuse('referral_campaign_exhausted');
      }
      if (input.userId && Number(counts?.mine ?? 0) >= campaign.per_user_limit) {
        return refuse('referral_campaign_limit_reached');
      }
    }
    const discountEur = ReferralCampaignsService.discountFor(campaign, input.grossEur, input.eurPerBc);
    return {
      campaign, applied: discountEur > 0, reason: null,
      discountEur, discountBc: Math.round(discountEur / input.eurPerBc), label,
    };
  }

  /** Estimate-side: never throws; `null` = not a campaign code. */
  quote(input: CampaignQuoteInput): Promise<CampaignQuote | null> {
    return this.evaluate(input);
  }

  /** Create-side: a campaign code that does not apply is REFUSED, never ignored. */
  async resolveForBooking(input: CampaignQuoteInput): Promise<CampaignQuote | null> {
    const q = await this.evaluate(input);
    if (!q) return null;
    if (!q.applied) {
      throw new BadRequestException({
        code: q.reason ?? 'referral_campaign_inactive',
        message: ReferralCampaignsService.refusalMessage(q.reason ?? 'referral_campaign_inactive', q.campaign),
      });
    }
    return q;
  }

  static refusalMessage(reason: CampaignRefusal, c?: Pick<ReferralCampaignRow, 'region_code'>): string {
    switch (reason) {
      case 'referral_campaign_not_started': return 'That referral code is not active yet.';
      case 'referral_campaign_expired': return 'That referral code has expired.';
      case 'referral_campaign_region_mismatch':
        return `That referral code is only valid in ${c?.region_code ?? 'another region'}.`;
      case 'referral_campaign_service_mismatch': return 'That referral code does not apply to this service.';
      case 'referral_campaign_exhausted': return 'That referral code has been fully used.';
      case 'referral_campaign_limit_reached': return 'You have already used that referral code.';
      default: return 'That referral code is no longer active.';
    }
  }

  /**
   * The ledger row. Called AFTER the booking insert (a discount is real only
   * once the booking is). Runs on the given transaction when the caller has
   * one, else on the pool.
   */
  async recordRedemption(
    input: {
      campaignId: string; bookingId: string; userId: string;
      regionCode: string | null; service: string | null;
      grossEur: number; discountEur: number;
    },
    tx?: Pick<Tx, 'q'>,
  ): Promise<void> {
    const runner: Pick<Tx, 'q'> = tx ?? this.db;
    await runner.q(
      `INSERT INTO public.referral_redemptions
         (campaign_id, booking_id, user_id, region_code, service, gross_eur, discount_eur, net_eur)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (booking_id) DO NOTHING`,
      [input.campaignId, input.bookingId, input.userId, input.regionCode, input.service,
       round2(input.grossEur), round2(input.discountEur), round2(Math.max(0, input.grossEur - input.discountEur))],
    );
  }

  // ─── Public (unauthenticated) landing resolve ─────────────────────────────

  /**
   * What a deep-link landing page may show BEFORE the person has an account:
   * the campaign's name, discount and region. No usage figures, no notes.
   * Invalid / inactive / expired codes all collapse to `{valid:false}`.
   */
  async publicResolve(rawCode: string): Promise<
    {valid: false} |
    {valid: true; code: string; name: string; label: string; scope: CampaignScope;
     region_code: string | null; expires_at: string | null}
  > {
    const code = (rawCode ?? '').trim().toUpperCase();
    if (!code || code.length > 32) return {valid: false};
    const c = await this.db.qOne<ReferralCampaignRow>(
      `SELECT * FROM public.referral_campaigns
        WHERE code = $1 AND active = TRUE
          AND (starts_at IS NULL OR starts_at <= NOW())
          AND (expires_at IS NULL OR expires_at > NOW())`,
      [code],
    );
    if (!c) return {valid: false};
    return {
      valid: true, code: c.code, name: c.name, label: ReferralCampaignsService.labelFor(c),
      scope: c.scope, region_code: c.region_code,
      expires_at: c.expires_at ? new Date(c.expires_at).toISOString() : null,
    };
  }

  // ─── Ops: manage + report ─────────────────────────────────────────────────

  /** Every campaign with its usage and money figures, newest first. */
  async list(): Promise<Array<ReferralCampaignRow & {
    redemptions: number; unique_users: number; gross_eur: string; discount_eur: string;
    net_eur: string; paid_bookings: number; paid_net_eur: string; status: 'active' | 'scheduled' | 'expired' | 'inactive' | 'exhausted';
  }>> {
    const rows = await this.db.q<ReferralCampaignRow & {
      redemptions: number; unique_users: number; gross_eur: string; discount_eur: string;
      net_eur: string; paid_bookings: number; paid_net_eur: string;
    }>(
      `SELECT c.*,
              COALESCE(r.n, 0)::int AS redemptions,
              COALESCE(r.users, 0)::int AS unique_users,
              COALESCE(r.gross, 0)::text AS gross_eur,
              COALESCE(r.discount, 0)::text AS discount_eur,
              COALESCE(r.net, 0)::text AS net_eur,
              COALESCE(r.paid, 0)::int AS paid_bookings,
              COALESCE(r.paid_net, 0)::text AS paid_net_eur
         FROM public.referral_campaigns c
         LEFT JOIN (
           SELECT rd.campaign_id,
                  COUNT(*) AS n,
                  COUNT(DISTINCT rd.user_id) AS users,
                  SUM(rd.gross_eur) AS gross,
                  SUM(rd.discount_eur) AS discount,
                  SUM(rd.net_eur) AS net,
                  COUNT(*) FILTER (WHERE b.status IN ('CONFIRMED','LIVE','COMPLETED')) AS paid,
                  COALESCE(SUM(rd.net_eur) FILTER (WHERE b.status IN ('CONFIRMED','LIVE','COMPLETED')), 0) AS paid_net
             FROM public.referral_redemptions rd
             LEFT JOIN public.lite_bookings b ON b.id = rd.booking_id
            GROUP BY rd.campaign_id
         ) r ON r.campaign_id = c.id
        ORDER BY c.created_at DESC
        LIMIT 500`,
    );
    return rows.map(r => ({...r, status: ReferralCampaignsService.statusOf(r)}));
  }

  static statusOf(c: Pick<ReferralCampaignRow, 'active' | 'starts_at' | 'expires_at' | 'max_redemptions'> & {redemptions?: number}):
    'active' | 'scheduled' | 'expired' | 'inactive' | 'exhausted' {
    if (!c.active) return 'inactive';
    const now = Date.now();
    if (c.expires_at && new Date(c.expires_at).getTime() <= now) return 'expired';
    if (c.starts_at && new Date(c.starts_at).getTime() > now) return 'scheduled';
    if (c.max_redemptions !== null && (c.redemptions ?? 0) >= c.max_redemptions) return 'exhausted';
    return 'active';
  }

  /** One campaign: the row, its figures, a by-status split and the redemption history. */
  async detail(id: string) {
    const rows = await this.list();
    const campaign = rows.find(r => r.id === id);
    if (!campaign) throw new NotFoundException('referral_campaign_not_found');
    const [history, byStatus, byDay] = await Promise.all([
      this.db.q(
        `SELECT rd.id, rd.booking_id, rd.user_id, u.display_name AS user_name,
                rd.region_code, rd.service, rd.gross_eur, rd.discount_eur, rd.net_eur, rd.created_at,
                b.status AS booking_status, b.region_label, b.pickup_time, b.total_eur
           FROM public.referral_redemptions rd
           LEFT JOIN public.users u ON u.id = rd.user_id
           LEFT JOIN public.lite_bookings b ON b.id = rd.booking_id
          WHERE rd.campaign_id = $1
          ORDER BY rd.created_at DESC
          LIMIT 300`, [id]),
      this.db.q<{status: string | null; n: string; net: string}>(
        `SELECT b.status, COUNT(*)::text AS n, COALESCE(SUM(rd.net_eur), 0)::text AS net
           FROM public.referral_redemptions rd
           LEFT JOIN public.lite_bookings b ON b.id = rd.booking_id
          WHERE rd.campaign_id = $1
          GROUP BY b.status
          ORDER BY n DESC`, [id]),
      this.db.q<{day: string; n: string; discount: string; net: string}>(
        `SELECT to_char(date_trunc('day', rd.created_at), 'YYYY-MM-DD') AS day,
                COUNT(*)::text AS n,
                COALESCE(SUM(rd.discount_eur), 0)::text AS discount,
                COALESCE(SUM(rd.net_eur), 0)::text AS net
           FROM public.referral_redemptions rd
          WHERE rd.campaign_id = $1 AND rd.created_at >= NOW() - interval '30 days'
          GROUP BY 1
          ORDER BY 1 ASC`, [id]),
    ]);
    return {campaign, history, by_status: byStatus, by_day: byDay};
  }

  async create(
    adminUserId: string,
    dto: {
      code: string; name: string; scope: CampaignScope; region_code?: string;
      discount_type: CampaignDiscountType; discount_value: number; max_discount_bc?: number;
      services?: string[]; max_redemptions?: number; per_user_limit?: number;
      starts_at?: string; expires_at?: string; notes?: string;
    },
  ): Promise<ReferralCampaignRow> {
    const code = dto.code.trim().toUpperCase();
    const region = dto.scope === 'region' ? (dto.region_code ?? '').trim().toUpperCase() : null;
    if (dto.scope === 'region' && !region) throw new BadRequestException('region_code_required');
    if (dto.discount_type === 'percent' && dto.discount_value > 100) {
      throw new BadRequestException('percent_over_100');
    }
    if (dto.expires_at) {
      const t = new Date(dto.expires_at).getTime();
      if (!(t > Date.now())) throw new BadRequestException('expires_at_in_past');
      if (dto.starts_at && !(new Date(dto.starts_at).getTime() < t)) {
        throw new BadRequestException('starts_after_expiry');
      }
    }
    const services = dto.services?.map(s => s.trim()).filter(Boolean) ?? null;
    try {
      const row = await this.db.qOne<ReferralCampaignRow>(
        `INSERT INTO public.referral_campaigns
           (code, name, scope, region_code, discount_type, discount_value, max_discount_bc,
            services, max_redemptions, per_user_limit, starts_at, expires_at, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [code, dto.name.trim(), dto.scope, region, dto.discount_type, dto.discount_value,
         dto.max_discount_bc ?? null, services && services.length ? services : null,
         dto.max_redemptions ?? null, dto.per_user_limit ?? 1,
         dto.starts_at ?? null, dto.expires_at ?? null, dto.notes?.trim() || null, adminUserId],
      );
      if (!row) throw new BadRequestException('referral_campaign_create_failed');
      return row;
    } catch (e) {
      if ((e as {code?: string}).code === '23505') throw new ConflictException('code_already_exists');
      throw e;
    }
  }

  /** Ops edits: the human-facing fields and the switches. Never the code or the discount
   *  (a changed discount would make the ledger's history lie about what was offered). */
  async update(
    id: string,
    patch: {
      name?: string; active?: boolean; expires_at?: string | null; starts_at?: string | null;
      max_redemptions?: number | null; per_user_limit?: number; notes?: string | null;
    },
  ): Promise<ReferralCampaignRow> {
    const row = await this.db.qOne<ReferralCampaignRow>(
      `UPDATE public.referral_campaigns
          SET name = COALESCE($2, name),
              active = COALESCE($3, active),
              expires_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE expires_at END,
              starts_at = CASE WHEN $6::boolean THEN $7::timestamptz ELSE starts_at END,
              max_redemptions = CASE WHEN $8::boolean THEN $9::int ELSE max_redemptions END,
              per_user_limit = COALESCE($10, per_user_limit),
              notes = CASE WHEN $11::boolean THEN $12::text ELSE notes END,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, patch.name?.trim() || null, patch.active ?? null,
       patch.expires_at !== undefined, patch.expires_at ?? null,
       patch.starts_at !== undefined, patch.starts_at ?? null,
       patch.max_redemptions !== undefined, patch.max_redemptions ?? null,
       patch.per_user_limit ?? null,
       patch.notes !== undefined, patch.notes ?? null],
    );
    if (!row) throw new NotFoundException('referral_campaign_not_found');
    return row;
  }

  /** The Promos landing figures across every campaign. */
  async overview(): Promise<{
    campaigns: number; active: number; redemptions: number; unique_users: number;
    discount_eur: string; net_eur: string; redemptions_7d: number;
  }> {
    const row = await this.db.qOne<{
      campaigns: string; active: string; redemptions: string; unique_users: string;
      discount_eur: string; net_eur: string; redemptions_7d: string;
    }>(
      `SELECT (SELECT COUNT(*)::text FROM public.referral_campaigns) AS campaigns,
              (SELECT COUNT(*)::text FROM public.referral_campaigns
                WHERE active AND (expires_at IS NULL OR expires_at > NOW())
                  AND (starts_at IS NULL OR starts_at <= NOW())) AS active,
              COUNT(*)::text AS redemptions,
              COUNT(DISTINCT user_id)::text AS unique_users,
              COALESCE(SUM(discount_eur), 0)::text AS discount_eur,
              COALESCE(SUM(net_eur), 0)::text AS net_eur,
              COUNT(*) FILTER (WHERE created_at >= NOW() - interval '7 days')::text AS redemptions_7d
         FROM public.referral_redemptions`,
    );
    return {
      campaigns: Number(row?.campaigns ?? 0), active: Number(row?.active ?? 0),
      redemptions: Number(row?.redemptions ?? 0), unique_users: Number(row?.unique_users ?? 0),
      discount_eur: row?.discount_eur ?? '0', net_eur: row?.net_eur ?? '0',
      redemptions_7d: Number(row?.redemptions_7d ?? 0),
    };
  }

  // ─── Eligible-client push fan-out (founder, 2026-09-05) ───────────────────
  //
  // "If any referral comes it will go to all user notification". EVERY client
  // is told, wherever they live: a client in Dhaka may be in Cape Town next
  // week, and the region is enforced where it matters — at the booking, by
  // `evaluate` — not at the announcement. So eligible = a CLIENT account
  // (role individual), not deleted, not suspended, not opted out of offers
  // (notif_prefs.offers). The message carries the details instead: the
  // discount, the code, WHERE it works (region name) and until when.
  //
  // The wake is the content-free {userId, eventClass:'referral', eventId}
  // frame every other push uses (P0-N8); the blob carries only public promo
  // facts. One durable inbox row per client rides along (the bell), so a
  // phone that missed the push still sees the offer.

  static readonly NOTIFY_PAGE = 500;
  static readonly NOTIFY_COOLDOWN_MS = 24 * 3600_000;

  private static eligibilityWhere(): string {
    return `u.role = 'individual'
        AND u.deleted_at IS NULL
        AND u.suspended_at IS NULL
        AND COALESCE(u.notif_prefs->>'offers', 'true') <> 'false'`;
  }

  /** How many clients a notify reaches right now (every eligible client, any region). */
  async countEligible(): Promise<number> {
    const row = await this.db.qOne<{n: string}>(
      `SELECT COUNT(*)::text AS n FROM public.users u WHERE ${ReferralCampaignsService.eligibilityWhere()}`,
    );
    return Number(row?.n ?? 0);
  }

  /** The human name of a region for the message ("Cape Town", not "ZA"); code as fallback. */
  private async regionName(code: string | null): Promise<string | null> {
    if (!code) return null;
    const row = await this.db.qOne<{name: string}>(
      `SELECT name FROM public.regions WHERE upper(code) = $1`, [code.toUpperCase()],
    ).catch(() => null);
    return row?.name?.trim() || code.toUpperCase();
  }

  /**
   * Fan the offer out to every eligible client, in id-keyset pages, one wake
   * each. Refuses (without sending) when the campaign is not live or was
   * notified inside the cooldown, so an edit or a reactivation can never blast
   * everyone twice. Runs to completion in-process; the caller fires it and
   * moves on (a 50k-client fan-out is minutes, not a request).
   */
  async get(id: string): Promise<ReferralCampaignRow> {
    const c = await this.db.qOne<ReferralCampaignRow>(
      `SELECT * FROM public.referral_campaigns WHERE id = $1`, [id],
    );
    if (!c) throw new NotFoundException('referral_campaign_not_found');
    return c;
  }

  /**
   * The precheck answers NOW (live? cooled down? a push lane at all?) and the
   * fan-out itself runs DETACHED — the HTTP caller must never wait on a 50k
   * client loop. `notified_at` is stamped before the loop starts so a second
   * press during it is a cooldown, never a second blast; `notified_count`
   * lands when the loop finishes and the campaign page polls it in.
   */
  async notifyEligible(
    campaignId: string,
    opts: {force?: boolean} = {},
  ): Promise<{queued: boolean; skipped: 'not_live' | 'cooldown' | 'no_push' | null}> {
    const c = await this.get(campaignId);
    if (ReferralCampaignsService.statusOf(c) !== 'active') return {queued: false, skipped: 'not_live'};
    if (!opts.force && c.notified_at
        && Date.now() - new Date(c.notified_at).getTime() < ReferralCampaignsService.NOTIFY_COOLDOWN_MS) {
      return {queued: false, skipped: 'cooldown'};
    }
    if (!this.push) return {queued: false, skipped: 'no_push'};
    await this.db.q(`UPDATE public.referral_campaigns SET notified_at = NOW() WHERE id = $1`, [campaignId]);
    void this.runFanOut(c).catch(e =>
      this.log.error(`referral campaign ${c.code} fan-out failed: ${(e as Error).message}`));
    return {queued: true, skipped: null};
  }

  /** The loop. Exposed for the spec; production reaches it through notifyEligible. */
  async runFanOut(c: ReferralCampaignRow): Promise<number> {
    if (!this.push) return 0;
    const offer = {
      campaignId: c.id, code: c.code, label: ReferralCampaignsService.labelFor(c),
      regionCode: c.region_code, regionName: await this.regionName(c.region_code),
      expiresAt: c.expires_at ? new Date(c.expires_at).toISOString() : null,
    };
    let after = '00000000-0000-0000-0000-000000000000';
    let sent = 0;
    for (;;) {
      const page = await this.db.q<{id: string}>(
        `SELECT u.id FROM public.users u
          WHERE ${ReferralCampaignsService.eligibilityWhere()}
            AND u.id > $1::uuid
          ORDER BY u.id
          LIMIT $2`,
        [after, ReferralCampaignsService.NOTIFY_PAGE],
      );
      if (page.length === 0) break;
      for (const u of page) {
        // publish() never throws; the .catch is belt-and-braces for the loop.
        await this.push.referralOffer(u.id, offer).catch(() => undefined);
        sent += 1;
      }
      after = page[page.length - 1].id;
      if (page.length < ReferralCampaignsService.NOTIFY_PAGE) break;
    }
    await this.db.q(
      `UPDATE public.referral_campaigns SET notified_count = $2 WHERE id = $1`, [c.id, sent],
    );
    this.log.log(`referral campaign ${c.code} notified ${sent} client(s)`);
    return sent;
  }

  /** Logged, never thrown: a ledger miss must not fail a booking that was already made. */
  warnLedgerMiss(bookingId: string, e: unknown): void {
    this.log.error(`referral redemption ledger write failed for booking ${bookingId}: ${(e as Error).message}`);
  }
}
