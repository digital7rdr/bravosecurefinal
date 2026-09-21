import {BadRequestException, ConflictException, Injectable, Logger, NotFoundException} from '@nestjs/common';
import {DatabaseService, type Tx} from '../database/database.service';
import {resolveAccountKind} from '../auth/account-kind';
import {escapeLike} from '../common/sql-like';
import {GeocodeService} from '../vbg/geocode.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';
import {OpsAuditService, type AuditActorRole} from '../ops/ops-audit.service';
import {FamilyQuotaService} from './family-quota.service';
import {effectiveSpendable, remainingQuota} from './family-quota.util';

export interface FamilyMemberLocation {
  lat:        number;
  lng:        number;
  /** Reverse-geocoded area name ("Benoni") — falls back to rounded coords. */
  label:      string | null;
  accuracyM:  number | null;
  recordedAt: string;
}

export interface FamilyMemberDto {
  id:           string;
  memberId:     string | null;
  name:         string;        // display name or the invited phone
  avatarUrl:    string | null;
  status:       'pending' | 'active' | 'revoked' | 'declined';
  /** Console roster only — NULL unless the caller passes `includeEmail` (see ListMembersOpts). */
  email:        string | null;
  /** The linked account's number, or the number they were invited on. */
  phone:        string | null;
  /** ISO — while in the future the member is ON HOLD (no owner credits / no Pro plan). */
  heldUntil:    string | null;
  spendLimit:   number | null;
  spent:        number;
  invitedAt:    string;
  acceptedAt:   string | null;
  /** Last device fix — ACTIVE, non-held members only; null until they report. */
  lastLocation: FamilyMemberLocation | null;
  /** B-854 — this member's OWN members may spend this allowance (root-approved). */
  fundsSubMembers:  boolean;
  /** B-854 — how many ACTIVE members this member holds themselves. 0 for most. */
  holdsMembersCount: number;
  /**
   * B-854 — the slice of `spent` this member's OWN members are responsible for,
   * so the root's row can say "of which N BC by their members" instead of
   * reading as the member's own spend. 0 while the chain is off.
   */
  spentByMembers:   number;
  /**
   * B-854 — the LATEST funding ask on this row, whatever state it is in.
   *
   * Not "the open one": a DECLINED ask has to be representable, or a decline is
   * indistinguishable from never having asked and the UI offers a button that
   * files a duplicate the root already refused. `fundsSubMembers` is the
   * authority on whether the chain is ON; this is the history behind it.
   */
  fundingRequest:   FundingRequestSummary | null;
}

/** B-854 — the compact form both rosters carry. Ids, an enum and a timestamp. */
export interface FundingRequestSummary {
  id:        string;
  status:    FundingRequestStatus;
  createdAt: string;
}

export interface FamilyMemberSpendDto {
  member: {id: string; name: string; spent: number; spendLimit: number | null};
  byFeature: Array<{feature: string; spent: number; refunded: number; count: number}>;
  transactions: Array<{
    id: string;
    type: 'payment' | 'refund';
    feature: string | null;
    description: string;
    /** Signed credits — negative = spent from the owner's wallet, positive = refunded back. */
    amount: number;
    bookingId: string | null;
    at: string;
    /**
     * B-854 (A6) — WHO actually spent it, and through whom. On a chained charge
     * the actor is the sub-member (C) and `viaUserId` is the intermediary (B),
     * so the holder's sheet reads "C via B" rather than crediting it to B.
     */
    actorUserId: string | null;
    actorName:   string | null;
    viaUserId:   string | null;
  }>;
}

export interface FamilyInviteDto {
  id:           string;
  holderId:     string;
  holderName:   string;
  invitedAt:    string;
}

export type FundingRequestStatus = 'pending' | 'approved' | 'declined' | 'cancelled' | 'expired';

/** B-854 (A11) — one "may my members spend your allowance?" ask, either side. */
export interface FundingRequestDto {
  id:             string;
  familyRowId:    string;
  holderId:       string;
  holderName:     string | null;
  memberId:       string;
  memberName:     string | null;
  status:         FundingRequestStatus;
  reason:         string | null;
  decisionReason: string | null;
  createdAt:      string;
  decidedAt:      string | null;
  expiresAt:      string;
}

/**
 * B-854 — WHO is flipping the switch.
 *
 * `actorRole` is carried rather than assumed because the SAME service methods
 * serve the holder's app and the ops console, and the B-832 trap is exactly a
 * console act filed against the ops feed as `CLIENT`. `force` is ops-only: it
 * is the override for A10's in-flight refusal, and no app route passes it.
 */
export interface FundingActor {
  actorId:    string;
  /** Typed against the audit union so an ops flip cannot be filed as a CLIENT. */
  actorRole:  AuditActorRole;
  actorCall?: string | null;
  force?:     boolean;
}

/** One root this user is an active member of — the member's own view of it. */
export interface FamilyMembershipDto {
  /** A14 — the membership ROW id, so `family-quota-changed {familyRowId}` is mappable. */
  id:                 string;
  holderId:           string;
  holderName:         string;
  heldUntil:          string | null;
  spendLimit:         number | null;
  spent:              number;
  /** Spec §41 — `spendLimit - spent`, or null when the quota is unlimited. */
  remaining:          number | null;
  /**
   * Spec §3/§10/§41 — `min(remaining quota, root available credit)`: what this
   * member can ACTUALLY spend right now.
   *
   * The root's raw balance is deliberately NOT returned. §41 asks for it only
   * "if appropriate for the product", and a member is not entitled to read the
   * holder's finances — but they do need to understand why a booking inside
   * their quota can still be refused, and this number says exactly that
   * without disclosing how much the holder actually has.
   */
  effectiveSpendable: number;
  /** Spec §21 — the root account is suspended, so nothing is spendable. */
  rootSuspended:      boolean;
  /** Spec §42 — so the UI shows "View Request", never a duplicate-creating button. */
  pendingRequest:     {id: string; requestedCredits: number; createdAt: string} | null;
  /**
   * B-854 (A11/A12) — the chain, from the MEMBER's side.
   *
   * `fundsSubMembers` is the switch on THIS row: the root has agreed that this
   * member's own members may spend this allowance. `spentByMembers` is the slice
   * of `spent` that those members are responsible for, so the member's card can
   * say "includes N BC spent by your members" instead of reading as their own
   * spend. `holdsMembersCount` is why the toggle is offered at all.
   */
  fundsSubMembers:    boolean;
  spentByMembers:     number;
  holdsMembersCount:  number;
  /**
   * The LATEST ask on this row, whatever state it is in — the same shape and
   * the same rule the holder's roster reports. "Declined — ask again" is a real
   * state of this card, and a pending-only field cannot express it.
   */
  fundingRequest:     FundingRequestSummary | null;
}

/**
 * B-843 (A11) — one payable root, as offered to the member on a refusal or in
 * the "Pay from" selector. Quota figures only; never the root's balance (LM-B7).
 */
export interface PayerOption {
  holderId:      string;
  holderName:    string;
  spendLimit:    number | null;
  spent:         number;
  remaining:     number | null;
  /** Inside its hold window — listed so the member sees it, rendered disabled. */
  held:          boolean;
  rootSuspended: boolean;
  /**
   * B-854 (A12) — what this root can ACTUALLY pay for right now, server-computed
   * and CHAIN-AWARE: `min(this member's remaining, the funding row's remaining,
   * the paying wallet's balance)`. Quota figures are already published; this is
   * the same derived min `FamilyMembershipDto.effectiveSpendable` publishes, so
   * it discloses no balance (LM-B7) while explaining why a booking inside the
   * quota can still be refused.
   */
  effectiveSpendable: number;
}

/**
 * F4 — a connection to read on: the pool by default, or the CALLER'S OPEN
 * TRANSACTION. `payWithCredits` holds the member row `FOR UPDATE` while it
 * decorates a refusal, and a pooled read there is a second connection taken
 * while locks are held.
 */
type Reader = Pick<Tx, 'q'>;

/** The one membership row shape every payer decision is made from. */
type PayerRow = {
  id: string; holder_id: string; holder_name: string | null; status: string;
  held_until: Date | null; spend_limit_credits: number | null;
  spent_credits: number; holder_suspended_at: Date | null;
  /**
   * B-854 — the chain columns, all optional so a test double (or a caller on an
   * older read) simply resolves to the un-chained answer, which is today.
   * `root_credits` is the SHOWN root's wallet; `funding_wallet_credits` is the
   * higher root's. They are never published raw — only the derived min is.
   */
  root_credits?:                number | null;
  funding_row_id?:              string | null;
  funding_holder_id?:           string | null;
  funding_spend_limit_credits?: number | null;
  funding_spent_credits?:       number | null;
  funding_holder_suspended_at?: Date | null;
  funding_wallet_credits?:      number | null;
};

/**
 * B-854 — the ONE chain read, shared by `resolvePayer`, `payerOptions` and
 * `myMemberships` so the three surfaces can never disagree about whether a
 * booking is chained.
 *
 * Given an outer `fm` (the member's row under the SHOWN root) and `h` (that
 * root's user row), it resolves the row that FUNDS it: the shown root's own
 * membership under a higher root, flagged `funds_sub_members`.
 *
 * What filters the chain OUT (→ a plain hop to the shown root's own wallet,
 * i.e. exactly today's behaviour): the flag off, the funding row not active,
 * inside its hold window, the intermediary suspended or erased, or the higher
 * root erased. What does NOT filter it out is the higher root being SUSPENDED —
 * §21 wants the charge site to answer ROOT_ACCOUNT_SUSPENDED, and dropping the
 * chain there would silently hop to the intermediary's wallet instead (B-843
 * A21 inverted). Its `suspended_at` is projected and decided in JS.
 *
 * `LIMIT 1` is belt-and-braces: `family_members_one_funding_root` already makes
 * at most one active flagged row per member, and `ORDER BY f.id` makes the
 * degenerate case deterministic rather than arbitrary.
 */
const FUNDING_LATERAL = `
         LEFT JOIN LATERAL (
           SELECT f.id, f.holder_id, f.spend_limit_credits, f.spent_credits,
                  fh.suspended_at   AS funding_holder_suspended_at,
                  fwb.bravo_credits AS funding_wallet_credits
             FROM public.family_members f
             JOIN public.users fh ON fh.id = f.holder_id
             LEFT JOIN public.wallet_balances fwb ON fwb.user_id = f.holder_id
            WHERE f.member_id = fm.holder_id
              AND f.funds_sub_members
              AND f.status = 'active'
              AND (f.held_until IS NULL OR f.held_until <= NOW())
              AND fh.deleted_at IS NULL
              AND h.suspended_at IS NULL
              AND h.deleted_at IS NULL
            ORDER BY f.id
            LIMIT 1
         ) fu ON TRUE`;

/** The chain columns, in the order `PayerRow` declares them. */
const FUNDING_COLS = `
              fu.id AS funding_row_id, fu.holder_id AS funding_holder_id,
              fu.spend_limit_credits AS funding_spend_limit_credits,
              fu.spent_credits AS funding_spent_credits,
              fu.funding_holder_suspended_at, fu.funding_wallet_credits`;

/**
 * The membership projection + join shape every payer decision reads, chain
 * included. Split in two so a caller that needs EXTRA columns (`myMemberships`)
 * can slot them between the list and the FROM rather than re-declaring the
 * chain join — `resolvePayer`, `payerOptions` and `myMemberships` must not be
 * able to drift apart about what a chain is.
 */
const PAYER_ROW_COLS = `fm.id, fm.holder_id, h.display_name AS holder_name, fm.status, fm.held_until,
             fm.spend_limit_credits, fm.spent_credits,
             h.suspended_at AS holder_suspended_at,
             wb.bravo_credits AS root_credits,
${FUNDING_COLS}`;

const PAYER_ROW_FROM = `
        FROM public.family_members fm
        JOIN public.users h ON h.id = fm.holder_id
        LEFT JOIN public.wallet_balances wb ON wb.user_id = fm.holder_id
${FUNDING_LATERAL}`;

const PAYER_ROW_SELECT = `      SELECT ${PAYER_ROW_COLS}${PAYER_ROW_FROM}`;

/** What `resolvePayer` answers: WHO the debit lands on, plus the row that caps it. */
export interface ResolvedPayer {
  payerId:         string;
  familyRowId:     string | null;
  spendLimit:      number | null;
  spent:           number;
  /**
   * Spec §21 — the ROOT account is suspended, so every member draw on it must
   * stop even though the member's own quota may be untouched. Additive field:
   * the charge sites turn it into ROOT_ACCOUNT_SUSPENDED, and a caller (or a
   * test double) that predates it reads `undefined`, i.e. not suspended,
   * which is exactly the previous behaviour.
   */
  holderSuspended: boolean;
  /** B-843 (A11) — WHICH root, so a money refusal can name it. Null = self-paid. */
  holderId:        string | null;
  holderName:      string | null;
  /**
   * B-854 (A4) — the CHAIN, and the one place its split is stated.
   *
   *   payerId          the WALLET the debit lands on. A once chained.
   *   holderId/Name    the SHOWN root. ALWAYS B — every refusal, push and
   *                    throttle key names this one, never `payerId`, or the
   *                    member learns an account they are not a member of.
   *   familyRowId      (B, C) — the member's own row; C's cap lives on it.
   *   fundingRowId     (A, B) — B's row under A; B's cap lives on it, and a
   *                    chained charge bumps BOTH.
   *   fundingHolderId  A. Equals `payerId` when chained; null otherwise.
   *   viaUserId        B, stamped as `lite_bookings.payer_via_user_id`.
   *
   * All optional: a caller or test double that predates the chain reads
   * `undefined` everywhere, i.e. "not chained", which is exactly today.
   */
  fundingRowId?:      string | null;
  fundingHolderId?:   string | null;
  viaUserId?:         string | null;
  /** A5 — B's cap on A's plan. The SECOND ceiling a chained charge obeys. */
  fundingSpendLimit?: number | null;
  fundingSpent?:      number;
}

export interface ListMembersOpts {
  q?:      string;
  status?: 'active' | 'pending' | 'held' | 'all';
  limit?:  number;
  offset?: number;
  /**
   * PRIVACY — off by default. A holder invites by PHONE and has never been
   * shown a member's email address; only the ops console roster needs it, so
   * it is opted into per call rather than disclosed to every caller.
   */
  includeEmail?: boolean;
}

export interface ListMembersResult {
  members: FamilyMemberDto[];
  /** Rows matching the caller's {q, status} — drives "Show more". */
  total:   number;
  /** UNFILTERED per-status totals for the holder — drives the header chips. */
  counts:  {active: number; pending: number; held: number};
}

const MEMBER_PAGE_DEFAULT = 100;
const MEMBER_PAGE_MAX     = 200;

/**
 * Member hierarchy + shared credits.
 *
 * A holder adds members (by phone). Accepted members' bookings are charged to
 * the HOLDER's wallet — `resolvePayer()` is the single hook the booking flow
 * uses to redirect the debit. A per-member `spend_limit` caps how much of the
 * holder's credits a member may consume. B-832: the member count is UNLIMITED;
 * the per-member credit allocation is the control, not a seat count.
 */
@Injectable()
export class FamilyService {
  private readonly log = new Logger(FamilyService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly geocode: GeocodeService,
    private readonly push: BookingPushBridge,
    private readonly opsAudit: OpsAuditService,
    private readonly quota: FamilyQuotaService,
  ) {}

  /**
   * Holder invites a phone. Founder rule (2026-08-03): the invitee MUST
   * already hold an individual Bravo account (Lite or Pro) — pending-by-phone
   * rows are no longer created; the client picks from registered contacts.
   */
  async invite(
    holderId: string, phoneE164: string, spendLimit?: number | null,
  ): Promise<{id: string; status: string}> {
    const phone = phoneE164.trim();
    if (!/^\+\d{6,15}$/.test(phone)) {throw new BadRequestException('invalid_phone');}

    const target = await this.db.qOne<{id: string; phone_e164: string | null}>(
      `SELECT id, phone_e164 FROM public.users WHERE phone_e164 = $1`,
      [phone],
    );
    if (!target) {throw new BadRequestException('not_a_bravo_user');}
    if (target.id === holderId) {throw new BadRequestException('cannot_invite_self');}
    const {account_kind} = await resolveAccountKind(this.db, target.id);
    if (account_kind !== 'individual') {throw new BadRequestException('not_an_individual_account');}

    // B-843 — a member under ANOTHER root is no longer a refusal: one person may
    // belong to any number of roots. Only a second OPEN row under THIS holder is
    // refused, and the (holder_id, member_id) partial unique is what actually
    // enforces it; this read exists to name the outcome, not to be the gate.
    const dupe = await this.db.qOne<{id: string}>(
      `SELECT id FROM public.family_members
        WHERE holder_id = $1 AND member_id = $2 AND status IN ('pending','active')`,
      [holderId, target.id],
    );
    if (dupe) {throw new BadRequestException('invite_already_pending');}

    // Why: B-833 — `relationship` stays as a nullable column (no migration) but
    // is never written again; old APKs still send one and it dies at the DTO.
    const row = await this.db.qOne<{id: string}>(
      `INSERT INTO public.family_members
         (holder_id, member_id, invite_phone, status, spend_limit_credits, relationship)
       VALUES ($1, $2, NULL, 'pending', $3, NULL)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [holderId, target.id, normalizeLimit(spendLimit)],
    );
    if (!row) {
      throw new BadRequestException('invite_already_pending');
    }
    // R-3 — the invitee only discovered the invite if they happened to open
    // Profile. Fire-and-forget; polling remains the fallback.
    void this.push.familyInvite(target.id, row.id).catch(() => undefined);
    return {id: row.id, status: 'pending'};
  }

  /**
   * B-832 legacy shim (plan D1 + A19). The seat cap is gone, so nothing here
   * grants anything — but a ≤1.0.304 APK computes `atCap` client-side at four
   * active members and from then on shows ONLY this CTA. It keeps answering
   * {ok:true} and files an INFO ops-feed row so support can advise an update.
   */
  async requestSeats(holderId: string): Promise<{ok: true}> {
    const active = await this.db.qOne<{n: number}>(
      `SELECT COUNT(*)::int AS n FROM public.family_members WHERE holder_id = $1 AND status = 'active'`,
      [holderId],
    );
    // `emit` is best-effort and swallows its own errors, so awaiting it cannot
    // throw — the holder always gets {ok:true}.
    await this.opsAudit.emit({
      kind: 'family', severity: 'info', subject: holderId,
      message: 'Legacy client (≤1.0.304) requested seats — cap removed; advise update',
      metadata: {holderId, activeCount: active?.n ?? null, legacy: true},
    });
    return {ok: true};
  }

  /**
   * A2/A8 — may ops manage THIS user's roster? The holder must be an ordinary
   * individual account and must not be an ops admin: an admin's own account
   * derives as `individual`, so without the `admin_users` arm a console operator
   * could make themselves a payer on a customer's plan.
   */
  async isOpsManageableHolder(holderId: string): Promise<boolean> {
    // Why: `resolveAccountKind` fails CLOSED to 'individual' for an unknown id,
    // so existence has to be established here or a typo'd path param reads as a
    // manageable holder and the add dies on the foreign key instead of a 400.
    const holder = await this.db.qOne<{is_admin: boolean}>(
      `SELECT (au.user_id IS NOT NULL) AS is_admin
         FROM public.users u
         LEFT JOIN admin_users au ON au.user_id = u.id
        WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [holderId],
    );
    if (!holder || holder.is_admin) {return false;}
    const {account_kind} = await resolveAccountKind(this.db, holderId);
    return account_kind === 'individual';
  }

  /** The holder half of the ops gate — a property of the REQUEST, not of a row. */
  async assertOpsManageableHolder(holderId: string): Promise<void> {
    if (!(await this.isOpsManageableHolder(holderId))) {
      throw new BadRequestException('holder_not_eligible');
    }
  }

  /**
   * CONSOLE entry point for `invite` (B-836). Everything the app path gets for
   * free — the holder is the authenticated user, so it can only ever be an
   * individual and can never be the actor — has to be checked here, because the
   * holder id arrives from a path parameter chosen by an admin.
   */
  async inviteAsOps(
    adminUserId: string, holderId: string, phoneE164: string, spendLimit?: number | null,
  ): Promise<{id: string; status: string}> {
    await this.assertOpsManageableHolder(holderId);
    return this.inviteAsOpsForCheckedHolder(adminUserId, holderId, phoneE164, spendLimit);
  }

  /**
   * The PER-ROW half, for a caller that has already asserted the holder (the
   * batch route). Only the actor check is row-scoped: the phone is what varies,
   * and an admin must not resolve to their own account on any of them.
   */
  async inviteAsOpsForCheckedHolder(
    adminUserId: string, holderId: string, phoneE164: string, spendLimit?: number | null,
  ): Promise<{id: string; status: string}> {
    const target = await this.db.qOne<{id: string; phone_e164: string | null}>(
      `SELECT id, phone_e164 FROM public.users WHERE phone_e164 = $1`,
      [phoneE164.trim()],
    );
    if (target && target.id === adminUserId) {throw new BadRequestException('cannot_invite_self');}
    return this.invite(holderId, phoneE164, spendLimit ?? null);
  }

  /**
   * B-835 — the roster is paged and searchable: a Pro root may hold thousands
   * of members, and the console adds them in batches.
   *
   * `total` counts the caller's {q, status} slice (it drives "Show more");
   * `counts` is deliberately UNFILTERED, because the header chips must not move
   * while the operator types. `held` is the subset of `active` still inside its
   * hold window, so `status:'active'` keeps returning held rows — the row's HOLD
   * pill is rendered from `heldUntil`.
   */
  async listMembers(holderId: string, opts: ListMembersOpts = {}): Promise<ListMembersResult> {
    const needle  = opts.q?.trim().slice(0, 64);
    const like    = needle ? `%${escapeLike(needle)}%` : null;
    const limit   = Math.max(1, Math.min(MEMBER_PAGE_MAX, Math.floor(Number(opts.limit)) || MEMBER_PAGE_DEFAULT));
    const offset  = Math.max(0, Math.floor(Number(opts.offset)) || 0);
    const status  = opts.status ?? 'all';
    const statusWhere =
      status === 'pending' ? `fm.status = 'pending'`
      : status === 'active' ? `fm.status = 'active'`
      : status === 'held'   ? `fm.status = 'active' AND fm.held_until > NOW()`
      : `fm.status IN ('pending','active')`;
    // Why: the needle is matched against three columns, so it is bound ONCE and
    // referenced three times — a per-column param would shift $n on every edit.
    const search = `($2::text IS NULL OR u.display_name ILIKE $2 ESCAPE '\\'
                    OR u.phone_e164 ILIKE $2 ESCAPE '\\' OR fm.invite_phone ILIKE $2 ESCAPE '\\')`;
    // Why: the column is not projected at all unless asked for. The mapper
    // re-applies the gate because no unit test executes SQL — without it the
    // pin would pass on a mocked row that still carries an address.
    const emailCol = opts.includeEmail ? 'u.email' : 'NULL::text AS email';

    const [rows, total, counts] = await Promise.all([
      this.db.q<{
        id: string; member_id: string | null; invite_phone: string | null;
        status: string; held_until: Date | null;
        spend_limit_credits: number | null; spent_credits: number;
        invited_at: Date; accepted_at: Date | null; display_name: string | null;
        email: string | null; phone_e164: string | null; avatar_url: string | null;
        loc_lat: number | null; loc_lng: number | null; loc_label: string | null;
        loc_accuracy_m: number | null; loc_recorded_at: Date | null;
        funds_sub_members: boolean; holds_members_count: number; spent_by_members: number | null;
        funding_request_id: string | null; funding_request_status: string | null;
        funding_request_created_at: Date | null; funding_request_expires_at: Date | null;
      }>(
        // The location join is gated in SQL: a pending or held member never
        // exposes a fix to the owner, even if a stale row exists.
        //
        // B-854 — `holds_members_count` is what makes the chain offer legible on
        // the roster ("also holds N members"); the holder must be able to see
        // WHY a member is asking before they approve. Correlated per row rather
        // than a second round trip, and bounded by the page LIMIT below.
        `SELECT fm.id, fm.member_id, fm.invite_phone, fm.status,
                fm.held_until, fm.spend_limit_credits, fm.spent_credits,
                fm.invited_at, fm.accepted_at, u.display_name, u.avatar_url,
                ${emailCol}, u.phone_e164,
                fm.funds_sub_members,
                (SELECT COUNT(*)::int FROM public.family_members hm
                  WHERE hm.holder_id = fm.member_id AND hm.status = 'active') AS holds_members_count,
                COALESCE((
                  SELECT SUM(CASE
                               WHEN wt.type = 'payment' AND wt.amount_credits < 0 THEN -wt.amount_credits
                               WHEN wt.type = 'refund'  AND wt.amount_credits > 0 THEN -wt.amount_credits
                               ELSE 0 END)
                    FROM public.wallet_transactions wt
                   WHERE wt.metadata->>'family_row_id' = fm.id::text
                     AND wt.metadata ? 'via_family_row_id'
                ), 0)::int AS spent_by_members,
                fq.id AS funding_request_id, fq.status AS funding_request_status,
                fq.created_at AS funding_request_created_at,
                fq.expires_at AS funding_request_expires_at,
                loc.lat AS loc_lat, loc.lng AS loc_lng, loc.label AS loc_label,
                loc.accuracy_m AS loc_accuracy_m, loc.recorded_at AS loc_recorded_at
           FROM public.family_members fm
           LEFT JOIN LATERAL (
             SELECT r.id, r.status, r.created_at, r.expires_at
               FROM public.family_funding_requests r
              WHERE r.family_row_id = fm.id
              ORDER BY r.created_at DESC, r.id DESC
              LIMIT 1
           ) fq ON TRUE
           LEFT JOIN public.users u ON u.id = fm.member_id
           LEFT JOIN public.family_member_locations loc
                  ON loc.user_id = fm.member_id
                 AND fm.status = 'active'
                 AND (fm.held_until IS NULL OR fm.held_until <= NOW())
          WHERE fm.holder_id = $1 AND ${statusWhere} AND ${search}
          ORDER BY fm.invited_at DESC, fm.id DESC
          LIMIT $3 OFFSET $4`,
        [holderId, like, limit, offset],
      ),
      this.db.qOne<{n: number}>(
        `SELECT COUNT(*)::int AS n
           FROM public.family_members fm
           LEFT JOIN public.users u ON u.id = fm.member_id
          WHERE fm.holder_id = $1 AND ${statusWhere} AND ${search}`,
        [holderId, like],
      ),
      this.db.qOne<{active: number; pending: number; held: number}>(
        `SELECT COUNT(*) FILTER (WHERE status = 'active')::int  AS active,
                COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
                COUNT(*) FILTER (WHERE status = 'active' AND held_until > NOW())::int AS held
           FROM public.family_members WHERE holder_id = $1`,
        [holderId],
      ),
    ]);

    return {
      members: rows.map(r => ({
        id: r.id,
        memberId: r.member_id,
        name: r.display_name ?? r.invite_phone ?? 'Invited member',
        avatarUrl: r.avatar_url,
        status: r.status as FamilyMemberDto['status'],
        email: opts.includeEmail ? (r.email ?? null) : null,
        phone: r.phone_e164 ?? r.invite_phone ?? null,
        heldUntil: r.held_until?.toISOString() ?? null,
        spendLimit: r.spend_limit_credits,
        spent: r.spent_credits,
        invitedAt: r.invited_at.toISOString(),
        acceptedAt: r.accepted_at?.toISOString() ?? null,
        fundsSubMembers: !!r.funds_sub_members,
        holdsMembersCount: Number(r.holds_members_count ?? 0),
        spentByMembers: Math.max(0, Number(r.spent_by_members ?? 0)),
        fundingRequest: toFundingSummary(r),
        lastLocation: r.loc_lat !== null && r.loc_lng !== null && r.loc_recorded_at ? {
          lat: Number(r.loc_lat),
          lng: Number(r.loc_lng),
          label: r.loc_label,
          accuracyM: r.loc_accuracy_m !== null ? Number(r.loc_accuracy_m) : null,
          recordedAt: r.loc_recorded_at.toISOString(),
        } : null,
      })),
      total: total?.n ?? 0,
      counts: {
        active:  counts?.active  ?? 0,
        pending: counts?.pending ?? 0,
        held:    counts?.held    ?? 0,
      },
    };
  }

  /** Invites awaiting THIS user's accept (by member_id or by their phone). */
  async invitesFor(userId: string): Promise<FamilyInviteDto[]> {
    const rows = await this.db.q<{id: string; holder_id: string; invited_at: Date; holder_name: string | null}>(
      `SELECT fm.id, fm.holder_id, fm.invited_at, h.display_name AS holder_name
         FROM public.family_members fm
         JOIN public.users h ON h.id = fm.holder_id
        WHERE fm.status = 'pending'
          AND (fm.member_id = $1
               OR fm.invite_phone = (SELECT phone_e164 FROM public.users WHERE id = $1))
        ORDER BY fm.invited_at DESC`,
      [userId],
    );
    return rows.map(r => ({
      id: r.id, holderId: r.holder_id, holderName: r.holder_name ?? 'A Bravo user',
      invitedAt: r.invited_at.toISOString(),
    }));
  }

  async accept(userId: string, inviteId: string): Promise<{ok: true}> {
    // B-843 — accepting under a SECOND root is legitimate. What is refused is a
    // second OPEN row under the SAME root: the holder this invite belongs to is
    // read from the invite itself, never from the caller.
    const sameHolder = await this.db.qOne<{id: string}>(
      `SELECT id FROM public.family_members
        WHERE member_id = $1
          AND holder_id = (SELECT holder_id FROM public.family_members WHERE id = $2)
          AND status IN ('pending','active')
          AND id <> $2`,
      [userId, inviteId],
    );
    if (sameHolder) {throw new BadRequestException('already_in_this_family');}

    let updated: {id: string; holder_id: string} | null;
    try {
      updated = await this.db.qOne<{id: string; holder_id: string}>(
        `UPDATE public.family_members
            SET status = 'active', member_id = $1, accepted_at = NOW(), invite_phone = NULL
          WHERE id = $2 AND status = 'pending'
            AND (member_id = $1 OR invite_phone = (SELECT phone_e164 FROM public.users WHERE id = $1))
          RETURNING id, holder_id`,
        [userId, inviteId],
      );
    } catch (e) {
      // Why: a legacy pending-by-phone row carries member_id NULL, so the read
      // above cannot see the collision it is about to cause — binding this user
      // is what puts the row inside the partial unique's predicate. The index is
      // the real gate; without this map the member gets a raw 500.
      if ((e as {code?: string}).code === '23505') {
        throw new BadRequestException('already_in_this_family');
      }
      throw e;
    }
    if (!updated) {throw new NotFoundException('invite_not_found');}
    // R-3 — tell the holder their member is now active (was poll-only).
    void this.push.familyInviteAccepted(updated.holder_id, updated.id).catch(() => undefined);
    return {ok: true};
  }

  async decline(userId: string, inviteId: string): Promise<{ok: true}> {
    await this.db.q(
      `UPDATE public.family_members SET status = 'declined'
        WHERE id = $1 AND status = 'pending'
          AND (member_id = $2 OR invite_phone = (SELECT phone_e164 FROM public.users WHERE id = $2))`,
      [inviteId, userId],
    );
    return {ok: true};
  }

  async revoke(holderId: string, memberRowId: string): Promise<{ok: true}> {
    // B-724 — the bare UPDATE always answered {ok:true}, so a wrong id /
    // someone else's row was indistinguishable from success (and the client
    // toasts "removed" optimistically). Re-revoking stays idempotent-ok; a
    // row that isn't the holder's (or doesn't exist) is now an honest 404.
    // B-854 (A9) — the funding switch is cleared in the SAME UPDATE. A revoked
    // row is dead to the resolver either way (it filters `status = 'active'`),
    // but leaving the flag set would keep the row inside the one-funding-root
    // index's predicate in spirit and, more practically, make a re-invite read
    // as "already funded" on a row nobody ever approved.
    const updated = await this.db.q<{id: string}>(
      `UPDATE public.family_members SET status = 'revoked', funds_sub_members = false
        WHERE id = $1 AND holder_id = $2 AND status <> 'revoked'
        RETURNING id`,
      [memberRowId, holderId],
    );
    if (updated.length === 0) {
      const existing = await this.db.qOne<{status: string}>(
        `SELECT status FROM public.family_members WHERE id = $1 AND holder_id = $2`,
        [memberRowId, holderId],
      );
      if (!existing) {throw new NotFoundException({code: 'MEMBER_NOT_FOUND', message: 'member_not_found'});}
    }
    // Privacy hygiene: a removed member's last fix must not linger. Gated on
    // accepted_at so cancelling a merely-PENDING invite can never delete a fix
    // the member is sharing with a DIFFERENT family they actually joined. (A
    // report racing this delete can strand one row — it stays invisible to this
    // holder via the listMembers active-join and is overwritten on next report.)
    //
    // B-843 (A4) — the location row is keyed by USER, so it is now SHARED with
    // every other root this member belongs to. Deleting it on one root's revoke
    // would blank the map for roots that are still entitled to it, so the delete
    // only fires when no OTHER active membership remains.
    await this.db.q(
      `DELETE FROM public.family_member_locations
        WHERE user_id = (SELECT member_id FROM public.family_members
                          WHERE id = $1 AND holder_id = $2 AND accepted_at IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM public.family_members fm2
                           WHERE fm2.member_id = family_member_locations.user_id
                             AND fm2.status = 'active' AND fm2.id <> $1)`,
      [memberRowId, holderId],
    );
    // §20 — financial history stays: the ledger, the quota audit trail and the
    // membership row itself are all untouched (status flips to 'revoked', it is
    // never deleted). Only the OPEN credit request is closed, because a request
    // against a revoked membership can never legitimately be approved.
    await this.quota.cancelPendingOnRevoke(memberRowId, holderId);
    return {ok: true};
  }

  /**
   * Set a member's spending quota.
   *
   * Delegates to FamilyQuotaService, which does this under a row lock, refuses
   * a reduction below the member's already-spent amount (spec §19 — the bare
   * UPDATE this replaced could drive `remaining` negative), and writes the
   * `family_quota_audit` row. The signature keeps its old shape plus an
   * optional actor/reason so the existing controller route and its callers did
   * not have to change.
   */
  async setSpendLimit(
    holderId: string, memberRowId: string, limit: number | null,
    actorId?: string, reason?: string | null,
  ): Promise<{ok: true; previousLimit: number | null; newLimit: number | null; spent: number; remaining: number | null}> {
    return this.quota.setQuota(holderId, memberRowId, limit, actorId ?? holderId, reason);
  }

  /**
   * Owner-imposed hold: until the given instant the member cannot spend the
   * owner's credits (resolvePayer falls back to their own wallet) or use the
   * owner's Pro plan. `null` lifts the hold.
   */
  async setHold(holderId: string, memberRowId: string, heldUntilIso: string | null): Promise<{ok: true}> {
    if (heldUntilIso !== null) {
      const t = new Date(heldUntilIso).getTime();
      if (!Number.isFinite(t)) {throw new BadRequestException('invalid_hold_date');}
      if (t <= Date.now()) {throw new BadRequestException('hold_must_be_in_future');}
      if (t > Date.now() + 366 * 86400_000) {throw new BadRequestException('hold_too_long');}
    }
    const row = await this.db.qOne<{id: string}>(
      `UPDATE public.family_members SET held_until = $3
        WHERE id = $1 AND holder_id = $2 AND status = 'active'
        RETURNING id`,
      [memberRowId, holderId, heldUntilIso],
    );
    if (!row) {throw new NotFoundException('member_not_found');}
    return {ok: true};
  }

  // ── B-854 (A11) — chained credit: the member asks, the ROOT decides ───────
  //
  // Q1 of the plan was "who may flip the switch". Every money-widening act in
  // this product is the PAYER's — `invite()`, `approveRequest` — and the payer
  // here is the root whose wallet the sub-members would reach. So B REQUESTS
  // and A APPROVES; the switch is off until A commits, A may switch it off at
  // any time, and B may ask again.

  /**
   * Every check that must hold before a membership row may fund its member's
   * OWN members. Run at REQUEST time (so B is told early) and again at APPROVE
   * time under the row lock (so a change between the two cannot slip through).
   *
   * `row` is the (holder = root, member = B) row.
   */
  private async assertChainEligible(
    on: Reader, row: {id: string; holder_id: string; member_id: string | null; status: string},
  ): Promise<void> {
    if (row.status !== 'active') {
      throw new BadRequestException({code: 'MEMBER_NOT_ACTIVE', message: 'member_not_active'});
    }
    if (!row.member_id) {
      throw new BadRequestException({code: 'MEMBER_NOT_ACTIVE', message: 'member_not_active'});
    }
    const checks = await on.q<{holds: number; cycle: number; other: number}>(
      `SELECT
         (SELECT COUNT(*)::int FROM public.family_members hm
           WHERE hm.holder_id = $2 AND hm.status = 'active') AS holds,
         (SELECT COUNT(*)::int FROM public.family_members cy
           WHERE cy.member_id = $1 AND cy.holder_id = $2
             AND cy.funds_sub_members AND cy.status = 'active') AS cycle,
         (SELECT COUNT(*)::int FROM public.family_members ot
           WHERE ot.member_id = $2 AND ot.funds_sub_members
             AND ot.status = 'active' AND ot.id <> $3) AS other`,
      [row.holder_id, row.member_id, row.id],
    );
    const c = checks[0] ?? {holds: 0, cycle: 0, other: 0};
    // Nothing to fund. The client hides the control on the same figure, but the
    // gate has to exist here too — a client-only rule is not a rule (§7 1b).
    if (Number(c.holds) === 0) {
      throw new BadRequestException({code: 'NO_SUB_MEMBERS', message: 'no_sub_members'});
    }
    // A2 — A funds B's members AND B funds A's members is a 2-cycle. One hop
    // means it can never recurse, but it makes "whose allowance was that?"
    // unanswerable on both sides, so it is refused at the door.
    if (Number(c.cycle) > 0) {
      throw new ConflictException({code: 'FUNDING_CYCLE', message: 'funding_cycle'});
    }
    // D1 — a member funds their own members from AT MOST ONE root, even though
    // B-843 lets them belong to several. The partial unique is the real gate;
    // this read exists to NAME the outcome rather than surface a raw 23505.
    if (Number(c.other) > 0) {
      throw new ConflictException({code: 'FUNDING_SOURCE_ALREADY_SET', message: 'funding_source_already_set'});
    }
  }

  /** The (holder, member) row a funding action is about, scoped to one side. */
  private async loadFundingRow(
    rowId: string, scope: {holderId?: string; memberId?: string},
  ): Promise<{
    id: string; holder_id: string; member_id: string | null; status: string;
    funds_sub_members: boolean; spent_credits: number;
  }> {
    const row = await this.db.qOne<{
      id: string; holder_id: string; member_id: string | null; status: string;
      funds_sub_members: boolean; spent_credits: number;
    }>(
      `SELECT id, holder_id, member_id, status, funds_sub_members, spent_credits
         FROM public.family_members
        WHERE id = $1
          AND ($2::uuid IS NULL OR holder_id = $2)
          AND ($3::uuid IS NULL OR member_id = $3)`,
      [rowId, scope.holderId ?? null, scope.memberId ?? null],
    );
    // Scoped in the WHERE, so a foreign row is a 404 and never leaks that it
    // exists to the other family (§38/§40).
    if (!row) {throw new NotFoundException({code: 'MEMBER_NOT_FOUND', message: 'member_not_found'});}
    return row;
  }

  /**
   * MEMBER side — B asks root A to let A's allowance fund B's own members.
   *
   * `membershipRowId` is B's own membership row, so the route reads it from the
   * caller's side of the pair and a foreign row is a 404. A second ask while one
   * is open is refused with the open request's id, which is what lets the UI
   * show "Requested" instead of a duplicate-creating button.
   */
  async requestFundMembers(
    memberUserId: string, membershipRowId: string, reason?: string | null,
  ): Promise<FundingRequestDto> {
    const row = await this.loadFundingRow(membershipRowId, {memberId: memberUserId});
    if (row.funds_sub_members) {
      throw new ConflictException({code: 'FUNDING_SOURCE_ALREADY_SET', message: 'funding_source_already_set'});
    }
    await this.assertChainEligible(this.db, row);
    // Lazy expiry, no cron — a forgotten PENDING row must not block the member
    // from ever asking again (the same rule family_credit_requests uses).
    await this.db.q(
      `UPDATE public.family_funding_requests SET status = 'expired'
        WHERE family_row_id = $1 AND status = 'pending' AND expires_at <= NOW()`,
      [membershipRowId],
    ).catch(() => undefined);
    // The duplicate gate is the PARTIAL UNIQUE INDEX, not a preceding SELECT:
    // two simultaneous taps both pass a check-then-insert, only one wins an
    // index. The predicate is repeated so Postgres can infer the partial index.
    const inserted = await this.db.qOne<{id: string}>(
      `INSERT INTO public.family_funding_requests (family_row_id, holder_id, member_id, reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (family_row_id) WHERE status = 'pending' DO NOTHING
       RETURNING id`,
      [membershipRowId, row.holder_id, memberUserId, trimText(reason)],
    );
    if (!inserted) {
      const open = await this.db.qOne<{id: string}>(
        `SELECT id FROM public.family_funding_requests
          WHERE family_row_id = $1 AND status = 'pending'`,
        [membershipRowId],
      );
      throw new ConflictException({
        code: 'FUNDING_REQUEST_PENDING', message: 'funding_request_pending',
        requestId: open?.id ?? null,
      });
    }
    await this.quota.recordFundingAudit({
      familyRowId: membershipRowId, holderId: row.holder_id, memberId: memberUserId,
      actorId: memberUserId, action: 'FUND_MEMBERS_REQUESTED',
      spent: Number(row.spent_credits ?? 0), reason: trimText(reason), requestId: inserted.id,
      // B-854 staging — the id rides as `funding_request_id` (added by
      // `recordFundingAudit`), never `request_id`: that spelling is the name of
      // the FK COLUMN, which points at a different table entirely.
      metadata: {actor_role: 'CLIENT', actor_call: null},
    });
    this.fire(() => this.push.familyFundingRequested(row.holder_id, membershipRowId, inserted.id));
    this.fire(() => this.opsAudit.record({
      actor_id: memberUserId, actor_role: 'CLIENT', action: 'FUND_MEMBERS_REQUESTED',
      subject_type: 'user', subject_id: row.holder_id,
      // `ops_audit.metadata` is free-form JSONB with no FK, so this one could
      // not 500 — but `request_id` is the NAME of the constrained column on the
      // other table, and an operator who follows it looks the id up in
      // `family_credit_requests` and finds nothing. One spelling everywhere.
      metadata: {family_row_id: membershipRowId, funding_request_id: inserted.id},
    }));
    const dto = await this.getFundingRequest(inserted.id);
    if (!dto) {throw new NotFoundException({code: 'REQUEST_NOT_FOUND', message: 'request_not_found'});}
    return dto;
  }

  /**
   * ROOT side — approve: the switch goes ON. Everything is re-checked under the
   * member row's lock, because the request may be days old and the eligibility
   * it was filed against (B still holds members, no second funding root, no
   * reciprocal row) is all mutable.
   */
  async approveFundMembers(
    holderId: string, memberRowId: string, actor: FundingActor, reason?: string | null,
  ): Promise<{ok: true; fundsSubMembers: true; requestId: string | null}> {
    const out = await this.db.withTransaction(async tx => {
      const row = await tx.qOne<{
        id: string; holder_id: string; member_id: string | null; status: string;
        funds_sub_members: boolean; spent_credits: number;
      }>(
        `SELECT id, holder_id, member_id, status, funds_sub_members, spent_credits
           FROM public.family_members WHERE id = $1 AND holder_id = $2 FOR UPDATE`,
        [memberRowId, holderId],
      );
      if (!row) {throw new NotFoundException({code: 'MEMBER_NOT_FOUND', message: 'member_not_found'});}
      await this.assertChainEligible(tx, row);
      // The decision row is claimed BEFORE the switch moves, so the consent gate
      // below runs before any write to `family_members`. Ordering it the other
      // way would leave the flip to be undone by the rollback — correct, but it
      // makes "was the grant ever made?" a question about transaction semantics
      // rather than about this function.
      const decided = await tx.qOne<{id: string}>(
        `UPDATE public.family_funding_requests
            SET status = 'approved', decided_by = $2, decided_at = NOW(), decision_reason = $3
          WHERE family_row_id = $1 AND status = 'pending'
        RETURNING id`,
        [memberRowId, actor.actorId, trimText(reason)],
      );
      // B-854 (P1-2) — A11's consent model: the root APPROVES AN ASK. A holder
      // route that flips the switch with nothing on file is a second, weaker
      // door to the same grant — drivable by a stale client, and leaving the
      // member no record that they ever asked.
      //
      // Ops keeps the requestless path on purpose: a support desk acts for a
      // root who asked by phone, and that act is audited against an operator
      // (`actor_role` + `actor_call`), which is the accountability the client
      // route gets from the request row itself.
      if (!decided && actor.actorRole === 'CLIENT') {
        throw new ConflictException({code: 'NO_FUNDING_REQUEST', message: 'no_funding_request'});
      }
      await tx.q(
        `UPDATE public.family_members SET funds_sub_members = true
          WHERE id = $1 AND holder_id = $2 AND status = 'active'`,
        [memberRowId, holderId],
      );
      await this.quota.recordFundingAudit({
        familyRowId: memberRowId, holderId, memberId: row.member_id, actorId: actor.actorId,
        action: 'FUND_MEMBERS_APPROVED', spent: Number(row.spent_credits ?? 0),
        reason: trimText(reason), requestId: decided?.id ?? null,
        metadata: {actor_role: actor.actorRole, actor_call: actor.actorCall ?? null},
        on: tx,
      });
      return {memberId: row.member_id, requestId: decided?.id ?? null};
    });
    this.announceFunding(holderId, out.memberId, memberRowId, true, actor, out.requestId, 'approved');
    return {ok: true, fundsSubMembers: true, requestId: out.requestId};
  }

  /** ROOT side — decline: the flag is NOT touched, the open request is closed. */
  async declineFundMembers(
    holderId: string, memberRowId: string, actor: FundingActor, reason?: string | null,
  ): Promise<{ok: true}> {
    const row = await this.loadFundingRow(memberRowId, {holderId});
    // P3 — a revoked (or pending) row has no live grant to decide about, and
    // deciding one would file an audit row and wake a member about a membership
    // that no longer exists.
    if (row.status !== 'active') {
      throw new BadRequestException({code: 'MEMBER_NOT_ACTIVE', message: 'member_not_active'});
    }
    const decided = await this.db.qOne<{id: string}>(
      `UPDATE public.family_funding_requests
          SET status = 'declined', decided_by = $2, decided_at = NOW(), decision_reason = $3
        WHERE family_row_id = $1 AND status = 'pending'
      RETURNING id`,
      [memberRowId, actor.actorId, trimText(reason)],
    );
    await this.quota.recordFundingAudit({
      familyRowId: memberRowId, holderId, memberId: row.member_id, actorId: actor.actorId,
      action: 'FUND_MEMBERS_DECLINED', spent: Number(row.spent_credits ?? 0),
      reason: trimText(reason), requestId: decided?.id ?? null,
      metadata: {actor_role: actor.actorRole, actor_call: actor.actorCall ?? null},
    });
    if (row.member_id) {
      this.fire(() => this.push.familyFundingDecided(row.member_id as string, memberRowId, decided?.id ?? null, 'declined'));
    }
    this.fire(() => this.opsAudit.record({
      actor_id: actor.actorId, actor_role: actor.actorRole, action: 'FUND_MEMBERS_DECLINED',
      subject_type: 'user', subject_id: row.member_id ?? holderId,
      metadata: {family_row_id: memberRowId, funding_request_id: decided?.id ?? null},
    }));
    return {ok: true};
  }

  /**
   * ROOT side — switch it OFF (A10).
   *
   * A chained booking already in flight was priced and consented against THIS
   * allowance; flipping the switch under it makes the charge fail closed at
   * accept, which cancels the booking hours later. So an OFF with live chained
   * bookings is REFUSED with the count, and only ops may force it through.
   */
  async setFundMembersOff(
    holderId: string, memberRowId: string, actor: FundingActor,
  ): Promise<{ok: true; fundsSubMembers: false}> {
    return this.turnFundingOff(memberRowId, {holderId}, actor);
  }

  /**
   * MEMBER side — switch it off (P1-2).
   *
   * The allowance the chain spends is the member's OWN. A grant they asked for,
   * that only the root may withdraw, is a one-way door — and the root is the
   * party LEAST likely to notice that the member's own members have gone rogue.
   * Same in-flight refusal as the root's route; `force` is an ops override and
   * is deliberately dropped here rather than read from the caller.
   */
  async setFundMembersOffAsMember(
    memberUserId: string, membershipRowId: string, actor: FundingActor,
  ): Promise<{ok: true; fundsSubMembers: false}> {
    return this.turnFundingOff(
      membershipRowId, {memberId: memberUserId}, {...actor, force: false},
    );
  }

  /**
   * The one OFF. P2-3 — the in-flight COUNT and the flip run in ONE transaction
   * with the membership row held `FOR UPDATE`.
   *
   * Split across two connections, the check is a TOCTOU against the charge
   * lanes: the count reads 0, an accept charges the chain, the flip commits,
   * and the booking is cancelled hours later with the switch already off — the
   * exact outcome A10's refusal exists to prevent. The lock is on
   * `family_members` only and takes no wallet lock, so it cannot cycle against
   * MON-4's family → wallet order.
   */
  private async turnFundingOff(
    rowId: string, scope: {holderId?: string; memberId?: string}, actor: FundingActor,
  ): Promise<{ok: true; fundsSubMembers: false}> {
    const out = await this.db.withTransaction(async tx => {
      const row = await tx.qOne<{
        id: string; holder_id: string; member_id: string | null; status: string;
        funds_sub_members: boolean; spent_credits: number;
      }>(
        `SELECT id, holder_id, member_id, status, funds_sub_members, spent_credits
           FROM public.family_members
          WHERE id = $1
            AND ($2::uuid IS NULL OR holder_id = $2)
            AND ($3::uuid IS NULL OR member_id = $3)
          FOR UPDATE`,
        [rowId, scope.holderId ?? null, scope.memberId ?? null],
      );
      // Scoped in the WHERE, so the other side's row is a 404 and never leaks
      // that it exists (§38/§40).
      if (!row) {throw new NotFoundException({code: 'MEMBER_NOT_FOUND', message: 'member_not_found'});}
      // P3 — nothing to switch off on a dead row, and an audit row + a push
      // about a membership that no longer exists is noise at best.
      if (row.status !== 'active') {
        throw new BadRequestException({code: 'MEMBER_NOT_ACTIVE', message: 'member_not_active'});
      }
      if (row.member_id) {
        const inflight = await tx.qOne<{n: number}>(
          `SELECT COUNT(*)::int AS n FROM public.lite_bookings
            WHERE payer_via_user_id = $1 AND payer_user_id = $2
              AND status IN ('PENDING_OPS','OPS_APPROVED','PAYMENT_PENDING','DISPATCHING')`,
          [row.member_id, row.holder_id],
        ).catch(() => null);
        const n = Number(inflight?.n ?? 0);
        if (n > 0 && !actor.force) {
          throw new ConflictException({
            code: 'CHAINED_BOOKINGS_IN_FLIGHT', message: 'chained_bookings_in_flight', count: n,
          });
        }
      }
      await tx.q(
        `UPDATE public.family_members SET funds_sub_members = false WHERE id = $1`,
        [rowId],
      );
      await this.quota.recordFundingAudit({
        familyRowId: rowId, holderId: row.holder_id, memberId: row.member_id, actorId: actor.actorId,
        action: 'FUND_MEMBERS_OFF', spent: Number(row.spent_credits ?? 0),
        metadata: {actor_role: actor.actorRole, actor_call: actor.actorCall ?? null, forced: !!actor.force},
        on: tx,
      });
      return {holderId: row.holder_id, memberId: row.member_id};
    });
    this.announceFunding(out.holderId, out.memberId, rowId, false, actor, null, null);
    return {ok: true, fundsSubMembers: false};
  }

  /** Open + decided funding asks across this root's family, newest first. */
  async fundingRequestsForHolder(holderId: string, limit = 50): Promise<FundingRequestDto[]> {
    return this.queryFundingRequests('r.holder_id = $1', [holderId], limit);
  }

  /** The member's own funding asks — own rows only. */
  async myFundingRequests(memberUserId: string, limit = 20): Promise<FundingRequestDto[]> {
    return this.queryFundingRequests('r.member_id = $1', [memberUserId], limit);
  }

  /** BOTH parties hear about a flip — A because they own the money, B because
   *  the answer decides whether their own members can book at all. */
  private announceFunding(
    holderId: string, memberId: string | null, familyRowId: string, enabled: boolean,
    actor: FundingActor, requestId: string | null, decision: 'approved' | null,
  ): void {
    if (memberId) {
      if (decision) {
        this.fire(() => this.push.familyFundingDecided(memberId, familyRowId, requestId, decision));
      }
      this.fire(() => this.push.familyFundingChanged(memberId, familyRowId, enabled));
    }
    this.fire(() => this.push.familyFundingChanged(holderId, familyRowId, enabled));
    // B-832 trap — the ops feed row carries the REAL role. A console flip filed
    // as a CLIENT act is an audit defect, not a cosmetic one.
    this.fire(() => this.opsAudit.record({
      actor_id: actor.actorId, actor_role: actor.actorRole,
      action: enabled ? 'FUND_MEMBERS_APPROVED' : 'FUND_MEMBERS_OFF',
      subject_type: 'user', subject_id: memberId ?? holderId,
      metadata: {family_row_id: familyRowId, enabled, forced: !!actor.force},
    }));
  }

  private async getFundingRequest(id: string): Promise<FundingRequestDto | null> {
    const rows = await this.queryFundingRequests('r.id = $1', [id], 1);
    return rows[0] ?? null;
  }

  private async queryFundingRequests(
    where: string, params: unknown[], limit: number,
  ): Promise<FundingRequestDto[]> {
    const rows = await this.db.q<{
      id: string; family_row_id: string; holder_id: string; member_id: string;
      holder_name: string | null; member_name: string | null;
      status: FundingRequestStatus; reason: string | null; decision_reason: string | null;
      created_at: Date; decided_at: Date | null; expires_at: Date;
    }>(
      // `limit` is BOUND, not interpolated — the same rule the credit-request
      // reader follows, for the same reason.
      `SELECT r.id, r.family_row_id, r.holder_id, r.member_id,
              h.display_name AS holder_name, u.display_name AS member_name,
              r.status, r.reason, r.decision_reason, r.created_at, r.decided_at, r.expires_at
         FROM public.family_funding_requests r
         LEFT JOIN public.users h ON h.id = r.holder_id
         LEFT JOIN public.users u ON u.id = r.member_id
        WHERE ${where}
        ORDER BY r.created_at DESC
        LIMIT $${params.length + 1}`,
      [...params, Math.min(Math.max(1, Math.floor(limit) || 20), 100)],
    ).catch((e: unknown) => {
      this.log.warn(`funding request read failed: ${(e as Error).message}`);
      return [];
    });
    return rows.map(r => ({
      id: r.id, familyRowId: r.family_row_id, holderId: r.holder_id, memberId: r.member_id,
      holderName: r.holder_name, memberName: r.member_name, status: r.status,
      reason: r.reason, decisionReason: r.decision_reason,
      createdAt: r.created_at.toISOString(),
      decidedAt: r.decided_at?.toISOString() ?? null,
      expiresAt: r.expires_at.toISOString(),
    }));
  }

  /**
   * Fire-and-forget for the notification + ops-feed side effects of a funding
   * flip. try/catch AND .catch(): several specs build this service with partial
   * doubles, and a MISSING method throws SYNCHRONOUSLY — which `.catch()` alone
   * cannot see. The money write is already committed by the time these run.
   */
  private fire(fn: () => Promise<unknown> | undefined): void {
    try {
      void Promise.resolve(fn()).catch(() => undefined);
    } catch { /* a notification may never undo a committed decision */ }
  }

  /**
   * EVERY root this user is an active member of (B-843 — there may be several).
   *
   * Ordered oldest-membership-first (`accepted_at ASC NULLS LAST, id ASC`) so
   * the list, the one-row `myMembership()` shim below and the Pro ride-along all
   * agree on which root is "first" — an unordered read would let a refetch
   * silently reorder the member's own cards.
   */
  async myMemberships(userId: string): Promise<FamilyMembershipDto[]> {
    // B-854 (A12) — the SAME chain read the payer resolution uses, plus the two
    // figures only this surface needs: how much of this allowance the member's
    // OWN members are responsible for, and whether they hold any at all.
    const rows = await this.db.q<PayerRow & {
      funds_sub_members: boolean; spent_by_members: number; holds_members_count: number;
    }>(
      `      SELECT ${PAYER_ROW_COLS},
             fm.funds_sub_members,
             (SELECT COUNT(*)::int FROM public.family_members hm
               WHERE hm.holder_id = $1 AND hm.status = 'active') AS holds_members_count,
             COALESCE((
               SELECT SUM(CASE
                            WHEN wt.type = 'payment' AND wt.amount_credits < 0 THEN -wt.amount_credits
                            WHEN wt.type = 'refund'  AND wt.amount_credits > 0 THEN -wt.amount_credits
                            ELSE 0 END)
                 FROM public.wallet_transactions wt
                WHERE wt.metadata->>'family_row_id' = fm.id::text
                  AND wt.metadata ? 'via_family_row_id'
             ), 0)::int AS spent_by_members${PAYER_ROW_FROM}
        WHERE fm.member_id = $1 AND fm.status = 'active'
        ORDER BY fm.accepted_at ASC NULLS LAST, fm.id ASC`,
      [userId],
    );
    if (rows.length === 0) {return [];}

    const ids = rows.map(r => r.id);
    // Two reads for every row's open asks rather than two per membership.
    const [pending, funding] = await Promise.all([
      this.db.q<{id: string; family_row_id: string; requested_credits: number; created_at: Date}>(
        `SELECT id, family_row_id, requested_credits, created_at
           FROM public.family_credit_requests
          WHERE family_row_id = ANY($1::uuid[]) AND status = 'pending' AND expires_at > NOW()`,
        [ids],
      ).catch(() => []),
      // B-854 — the LATEST ask per row, whatever state it is in, not the open
      // one. A declined ask must reach the member's card or "Declined — ask
      // again" is indistinguishable from never having asked, and the button
      // files a duplicate the root already refused. `DISTINCT ON` + the same
      // ORDER BY is what makes "latest" deterministic rather than whichever row
      // the planner happened to emit first.
      this.db.q<{id: string; family_row_id: string; status: string; created_at: Date; expires_at: Date}>(
        `SELECT DISTINCT ON (family_row_id) id, family_row_id, status, created_at, expires_at
           FROM public.family_funding_requests
          WHERE family_row_id = ANY($1::uuid[])
          ORDER BY family_row_id, created_at DESC, id DESC`,
        [ids],
      ).catch(() => []),
    ]);
    const pendingByRow = new Map(pending.map(p => [p.family_row_id, p]));
    const fundingByRow = new Map(funding.map(f => [f.family_row_id, f]));

    return rows.map(row => {
      const spent = Number(row.spent_credits ?? 0);
      const limit = row.spend_limit_credits;
      const rootSuspended = row.holder_suspended_at !== null;
      const p = pendingByRow.get(row.id) ?? null;
      const f = fundingByRow.get(row.id) ?? null;
      return {
        id: row.id,
        holderId: row.holder_id, holderName: row.holder_name ?? 'Plan holder',
        heldUntil: row.held_until?.toISOString() ?? null,
        spendLimit: limit, spent,
        remaining: remainingQuota(spent, limit),
        // A12 — chain-aware: `min(my remaining, the funding row's remaining, the
        // paying wallet's balance)`, and 0 while EITHER root is suspended (§21).
        // The number the member sees must agree with what the spend path will
        // do, or the UI is lying to them — and it still discloses no balance.
        effectiveSpendable: chainCeiling(row, userId),
        // …while the NAME and the suspension flag stay the member's own root's
        // (LM-B7): a member's root is the one they joined, never the one above it.
        rootSuspended,
        fundsSubMembers: !!row.funds_sub_members,
        spentByMembers: Math.max(0, Number(row.spent_by_members ?? 0)),
        holdsMembersCount: Number(row.holds_members_count ?? 0),
        // Same rule as the holder's roster, through the same helper.
        fundingRequest: toFundingSummary({
          funding_request_id: f?.id ?? null,
          funding_request_status: f?.status ?? null,
          funding_request_created_at: f?.created_at ?? null,
          funding_request_expires_at: f?.expires_at ?? null,
        }),
        pendingRequest: p
          ? {id: p.id, requestedCredits: p.requested_credits, createdAt: p.created_at.toISOString()}
          : null,
      };
    });
  }

  /**
   * The single membership an OLD client (≤1.0.306) knows how to render — the
   * FIRST of `myMemberships()`, i.e. the oldest. Deterministic on purpose: an
   * arbitrary pick would make a member's quota card change root between two
   * refreshes.
   */
  async myMembership(userId: string): Promise<FamilyMembershipDto | null> {
    const all = await this.myMemberships(userId);
    return all[0] ?? null;
  }

  /**
   * A11/A16 — the option list a money refusal carries so the client can say
   * WHICH root, and offer the others. EVERY active membership is listed, held
   * ones included but FLAGGED, because a selector that silently omits a root the
   * member knows they belong to reads as a bug; the client renders it disabled.
   *
   * Quota figures only. The root's raw balance is never returned (LM-B7) — a
   * member must not be able to read a root's finances through a cheap booking.
   */
  async payerOptions(userId: string, on?: Reader): Promise<PayerOption[]> {
    const rows = await (on ?? this.db).q<PayerRow>(
      `${PAYER_ROW_SELECT}
        WHERE fm.member_id = $1 AND fm.status = 'active'
        ORDER BY fm.accepted_at ASC NULLS LAST, fm.id ASC`,
      [userId],
    ).catch((e: unknown) => {
      // F2 — this degrades to "no options offered", which on a money refusal is
      // a real loss of information, so it must never be SILENT. (The
      // PAYER_CHOICE_REQUIRED path no longer comes through here at all: it
      // builds its options from the rows `resolvePayer` already read.)
      this.log.warn(`payerOptions read failed member=${userId}: ${(e as Error).message}`);
      return [] as PayerRow[];
    });
    const now = Date.now();
    return rows.map(r => toPayerOption(r, now, userId));
  }

  /**
   * BILLING HOOK — who pays for `userId`'s booking.
   *
   * B-843: a member may belong to SEVERAL roots, so "the member's holder" is no
   * longer a well-defined question. The answer is now:
   *
   *   `chosenHolderId === userId`  → themselves (never touches the family branch)
   *   `chosenHolderId` set         → that root, or PAYER_NOT_ELIGIBLE
   *   `chosenHolderId` absent      → 0 spendable memberships → themselves
   *                                  exactly 1 → that one (the pre-B-843 rule)
   *                                  ≥ 2      → PAYER_CHOICE_REQUIRED + options
   *
   * The ≥2 case FAILS CLOSED on purpose. Picking one silently would charge a
   * root the member did not name, and a surprise charge is a far worse failure
   * than a refusal the client can render as a choice.
   *
   * Also returns the member row so the caller can enforce the cap + bump `spent`.
   *
   * B-854 — ONE extra hop, decided in the same read. Once the chosen root is
   * itself an active, flagged member of a HIGHER root, the debit lands on that
   * higher root's wallet and the charge obeys BOTH caps. What the member is
   * SHOWN never changes: `holderId`/`holderName` stay the root they joined. The
   * hop is exactly one deep — if the higher root is itself funded, this booking
   * does not climb again (the lateral reads the chosen root's funding row and
   * stops), which is what makes cycles impossible rather than merely unlikely.
   */
  async resolvePayer(
    userId: string, chosenHolderId?: string | null, on?: Reader,
  ): Promise<ResolvedPayer> {
    const self: ResolvedPayer = {
      payerId: userId, familyRowId: null, spendLimit: null, spent: 0,
      holderSuspended: false, holderId: null, holderName: null,
    };
    // "Pay from my own wallet" is always available, even to a member with roots
    // (§11 of the plan's edge cases) — and it must not read the family tables at
    // all, or a held membership could refuse a purchase the member is paying for.
    if (chosenHolderId && chosenHolderId === userId) {return self;}

    // ONE read answers every question this method asks (F2). The hold used to be
    // a SQL predicate and the refusal's `options` a SECOND round-trip through
    // `payerOptions()` — which swallows a DB error into `[]`, so
    // PAYER_CHOICE_REQUIRED could ship an EMPTY option list and the client would
    // render "Choose which account pays" with nothing to choose. The rows are
    // already here; eligibility is decided in JS.
    //
    // With a chosen root the status filter is dropped too, so a revoked/pending
    // row can still supply the holder's NAME for the refusal body (F3).
    const rows = await (on ?? this.db).q<PayerRow>(
      `${PAYER_ROW_SELECT}
        WHERE fm.member_id = $1
          ${chosenHolderId ? 'AND fm.holder_id = $2' : `AND fm.status = 'active'`}
        ORDER BY fm.accepted_at ASC NULLS LAST, fm.id ASC`,
      chosenHolderId ? [userId, chosenHolderId] : [userId],
    );

    const now = Date.now();
    // A held member (held_until in the future) pays from their OWN wallet —
    // the owner's credits are frozen for them for the hold window. That is a
    // deliberate PRODUCT rule and differs from spec §22's "member suspended =
    // cannot spend at all"; it is preserved as-is rather than rewritten.
    //
    // A SUSPENDED root is deliberately still SPENDABLE here: §21 wants the
    // charge site to answer ROOT_ACCOUNT_SUSPENDED, and folding suspension into
    // eligibility would turn a member's single suspended root into a SILENT
    // charge to their own wallet — the opposite of telling them the real reason.
    const spendable = rows.filter(r => r.status === 'active' && !isHeldRow(r, now));

    if (chosenHolderId) {
      const picked = spendable[0];
      if (!picked) {
        // Foreign root, revoked membership, or a hold — one refusal for all
        // three, because distinguishing them would tell the member things about
        // a root they are not (or no longer) part of. It still NAMES the account
        // they chose: the same code thrown at the charge site carries these, and
        // one code must render one way (F3).
        throw new BadRequestException({
          code: 'PAYER_NOT_ELIGIBLE',
          message: "That account can't pay for this booking right now.",
          holder_id: chosenHolderId,
          holder_name: rows[0]?.holder_name ?? null,
        });
      }
      return toResolvedPayer(picked, userId);
    }

    if (spendable.length === 0) {return self;}
    if (spendable.length === 1) {return toResolvedPayer(spendable[0], userId);}
    throw new BadRequestException({
      code: 'PAYER_CHOICE_REQUIRED',
      message: 'Choose which account pays for this booking.',
      // EVERY active root, held/suspended ones flagged so the client can render
      // them disabled — built from the rows above, never from a second read.
      options: rows.filter(r => r.status === 'active').map(r => toPayerOption(r, now, userId)),
    });
  }

  /**
   * Post-charge hook for the two spend sites (spec §33/§34): warn the holder if
   * this member just crossed 80 / 90 / 100% of their quota.
   *
   * A passthrough so `BookingService` and `DispatchService` — which already
   * inject `FamilyService` — do not each have to take a second dependency.
   * MUST be called AFTER the charge transaction commits: it reads the
   * post-bump `spent_credits`, and running it inside the txn would both read a
   * value that may still roll back and hold the member row's lock across a
   * Redis publish, lengthening the critical section MON-4 keeps short.
   */
  async notifyUsageThreshold(familyRowId: string | null): Promise<void> {
    if (!familyRowId) {return;}
    await this.quota.notifyUsageThreshold(familyRowId);
  }

  // B-843 (A9) — the member-keyed variant is GONE. With several roots per member
  // "the member's active row" is ambiguous, and the escrow accept already knows
  // exactly which row it charged: `settleWonOffer` now carries that id out and
  // every caller uses the row-keyed hook above.

  /**
   * Post-refund hook: a refund lowered `spent_credits`, so re-arm the usage
   * bands the member has dropped back below (§26). Never notifies.
   */
  async rearmUsageThreshold(familyRowId: string | null): Promise<void> {
    if (!familyRowId) {return;}
    await this.quota.rearmUsageThreshold(familyRowId);
  }

  /**
   * MEMBER side — report the device's current fix. Silently a no-op (`reported:
   * false`) unless the caller is an ACTIVE, non-held family member whose
   * `users.location_scope` is not 'never' — the report path is the consent
   * gate, so an ineligible client learns nothing and stores nothing.
   */
  async reportLocation(
    userId: string,
    fix: {lat: number; lng: number; accuracyM?: number | null},
  ): Promise<{ok: true; reported: boolean}> {
    const lat = Number(fix.lat);
    const lng = Number(fix.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)
        || Math.abs(lat) > 90 || Math.abs(lng) > 180
        || (lat === 0 && lng === 0)) {
      throw new BadRequestException('invalid_coordinates');
    }
    // Consent: only the permissive default scope shares continuously with the
    // family owner. Both narrower choices the user can make in Settings →
    // Location ('during_mission', 'never') exclude family sharing — a user who
    // deliberately narrowed their location use must not stream 24/7.
    const eligible = await this.db.qOne<{id: string}>(
      `SELECT fm.id
         FROM public.family_members fm
         JOIN public.users u ON u.id = fm.member_id
        WHERE fm.member_id = $1 AND fm.status = 'active'
          AND (fm.held_until IS NULL OR fm.held_until <= NOW())
          AND u.location_scope = 'while_on_duty'`,
      [userId],
    );
    if (!eligible) {return {ok: true, reported: false};}

    // Number(null) === 0 — a missing accuracy must store NULL, never "perfect".
    const accRaw = fix.accuracyM == null ? NaN : Number(fix.accuracyM);
    const accuracyM = Number.isFinite(accRaw) && accRaw >= 0 ? accRaw : null;
    // Reverse-geocode server-side (cached ~1km/1h) so the label is trusted and
    // consistent; GeocodeService degrades to a coords label, never throws.
    const region = await this.geocode.reverse(lat, lng);
    await this.db.q(
      `INSERT INTO public.family_member_locations (user_id, lat, lng, accuracy_m, label, recorded_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, accuracy_m = EXCLUDED.accuracy_m,
             label = EXCLUDED.label, recorded_at = NOW()`,
      [userId, lat, lng, accuracyM, region.region ?? null],
    );
    return {ok: true, reported: true};
  }

  /**
   * HOLDER side — what a member spent from the owner's wallet, itemised.
   *
   * B-854 (A6) — keyed on the LEDGER ROW ID, not the actor.
   *
   * The actor stamp alone cannot see a chained charge: when C (a member of B)
   * spends the root A's allowance, the ledger row sits on A's wallet with
   * `actor_user_id = C` — and C is not a member of A, so A opening B's line saw
   * nothing while B's `spent_credits` climbed. The three arms below are, in
   * order: the row this charge was CAPPED against (`family_row_id`), the row it
   * passed THROUGH (`via_family_row_id`, so B opening C's line sees it even
   * though the money left A's wallet), and the pre-metadata legacy fallback —
   * which is explicitly gated on the metadata key being ABSENT so it can never
   * double-count a modern row.
   *
   * The via arm deliberately drops the `user_id = holder` predicate: the caller
   * has already been proved the OWNER of `memberRowId` by the read below, and
   * that row id is a narrower authorisation than the wallet it was paid from.
   */
  async memberSpend(holderId: string, memberRowId: string, limit = 50): Promise<FamilyMemberSpendDto> {
    const fm = await this.db.qOne<{
      member_id: string | null; spend_limit_credits: number | null; spent_credits: number;
      display_name: string | null; invite_phone: string | null;
    }>(
      `SELECT fm.member_id, fm.spend_limit_credits, fm.spent_credits, u.display_name, fm.invite_phone
         FROM public.family_members fm
         LEFT JOIN public.users u ON u.id = fm.member_id
        WHERE fm.id = $1 AND fm.holder_id = $2`,
      [memberRowId, holderId],
    );
    if (!fm) {throw new NotFoundException('member_not_found');}
    const member = {
      id: memberRowId,
      name: fm.display_name ?? fm.invite_phone ?? 'Member',
      spent: fm.spent_credits,
      spendLimit: fm.spend_limit_credits,
    };
    if (!fm.member_id) {return {member, byFeature: [], transactions: []};}

    const lim = Math.max(1, Math.min(100, Math.floor(limit) || 50));
    // P2-1 — LOWER-CASED before binding. `ParseUUIDPipe` accepts an UPPERCASE
    // uuid and hands it through verbatim, while Postgres renders `uuid` values
    // canonically lower-cased — so a text comparison against 'FR-AB…' matches
    // nothing and this sheet comes back EMPTY. A silent wrong answer on a money
    // screen is worse than an error, and the `uuid` column compare above (`fm.id
    // = $1`) would have succeeded, so nothing else flags it.
    const rowKey = String(memberRowId).toLowerCase();
    // $1 holder wallet, $2 the membership ROW id (text — the metadata value is
    // text, and comparing as text avoids a ::uuid cast that would 22P02 on any
    // malformed historic value), $3 the member user id for the legacy arm.
    const scope = `wt.type IN ('payment','refund') AND (
                     (wt.user_id = $1 AND (
                        wt.metadata->>'family_row_id' = $2
                        OR (wt.actor_user_id = $3 AND NOT (wt.metadata ? 'family_row_id'))))
                     OR wt.metadata->>'via_family_row_id' = $2)`;
    const txns = await this.db.q<{
      id: string; type: string; amount_credits: number; description: string;
      booking_id: string | null; feature: string | null; created_at: Date;
      actor_user_id: string | null; actor_name: string | null; via_user_id: string | null;
    }>(
      // A6 — the ACTOR and the VIA both ride out, so the holder's sheet can say
      // "C via B" instead of attributing C's spend to B.
      `SELECT wt.id, wt.type, wt.amount_credits, wt.description, wt.booking_id, wt.feature,
              wt.created_at, wt.actor_user_id, au.display_name AS actor_name,
              wt.metadata->>'via_user_id' AS via_user_id
         FROM wallet_transactions wt
         LEFT JOIN public.users au ON au.id = wt.actor_user_id
        WHERE ${scope}
        ORDER BY wt.created_at DESC
        LIMIT $4`,
      [holderId, rowKey, fm.member_id, lim],
    );
    const byFeature = await this.db.q<{feature: string | null; spent: number; refunded: number; n: number}>(
      `SELECT wt.feature,
              COALESCE(SUM(CASE WHEN wt.amount_credits < 0 THEN -wt.amount_credits ELSE 0 END), 0)::int AS spent,
              COALESCE(SUM(CASE WHEN wt.amount_credits > 0 THEN wt.amount_credits ELSE 0 END), 0)::int AS refunded,
              COUNT(*)::int AS n
         FROM wallet_transactions wt
        WHERE ${scope}
        GROUP BY wt.feature
        ORDER BY spent DESC`,
      [holderId, rowKey, fm.member_id],
    );
    return {
      member,
      byFeature: byFeature.map(f => ({
        feature: f.feature ?? 'other',
        spent: f.spent,
        refunded: f.refunded,
        count: f.n,
      })),
      transactions: txns.map(t => ({
        id: t.id,
        type: (t.type === 'refund' ? 'refund' : 'payment') as 'payment' | 'refund',
        feature: t.feature,
        description: t.description,
        amount: t.amount_credits,
        bookingId: t.booking_id,
        at: t.created_at.toISOString(),
        actorUserId: t.actor_user_id ?? null,
        actorName: t.actor_name ?? null,
        viaUserId: t.via_user_id ?? null,
      })),
    };
  }

  /**
   * Credit-usage breakdown for the holder — a Claude-token-style view: total
   * spend, per-member spend (+ cap + share %), and the recent member-charged
   * transactions from the wallet ledger.
   *
   * B-835 (D5/A17): the bar chart takes the top 50 spenders, but `totalSpent`
   * and `memberCount` are a SQL aggregate over EVERY active member, so a member
   * outside the top 50 still counts. `othersSpent` is that tail, which is what
   * lets the shares visibly add up.
   */
  async usage(holderId: string): Promise<{
    totalSpent: number;
    memberCount: number;
    othersSpent: number;
    members: Array<{id: string; name: string; spent: number; spendLimit: number | null; sharePct: number}>;
    recent: Array<{
      name: string; credits: number; at: string; bookingId: string | null;
      /** B-854 (A6) — the spender, and the member they spent THROUGH (null = direct). */
      actorUserId: string | null; viaUserId: string | null;
    }>;
  }> {
    const totals = await this.db.qOne<{total: number; n: number}>(
      `SELECT COALESCE(SUM(fm.spent_credits), 0)::int AS total, COUNT(*)::int AS n
         FROM public.family_members fm
        WHERE fm.holder_id = $1 AND fm.status = 'active'`,
      [holderId],
    );
    const totalSpent  = Number(totals?.total ?? 0);
    const memberCount = Number(totals?.n ?? 0);

    const members = await this.db.q<{
      id: string; member_id: string | null; invite_phone: string | null;
      spent_credits: number; spend_limit_credits: number | null; display_name: string | null;
    }>(
      `SELECT fm.id, fm.member_id, fm.invite_phone, fm.spent_credits, fm.spend_limit_credits, u.display_name
         FROM public.family_members fm
         LEFT JOIN public.users u ON u.id = fm.member_id
        WHERE fm.holder_id = $1 AND fm.status = 'active'
        ORDER BY fm.spent_credits DESC LIMIT 50`,
      [holderId],
    );
    const memberOut = members.map(m => ({
      id: m.id,
      name: m.display_name ?? m.invite_phone ?? 'Member',
      spent: m.spent_credits,
      spendLimit: m.spend_limit_credits,
      sharePct: totalSpent > 0 ? Math.round((m.spent_credits / totalSpent) * 100) : 0,
    }));
    const othersSpent = Math.max(0, totalSpent - memberOut.reduce((n, m) => n + (m.spent || 0), 0));

    // Recent family-charged ledger rows on the holder's wallet.
    //
    // B-854 (A6) — the ACTOR-membership EXISTS is gone. It asked "is the spender
    // one of MY members?", which is false for every chained charge (C is B's
    // member, not the root's), so the line items silently disagreed with the
    // totals above — `spent_credits` had already been bumped on B's row. The
    // predicate is now the charge-time ROW: does this ledger row's cap row
    // belong to me? The old actor form survives ONLY where no metadata exists
    // (pre-stamp history), gated on the key being absent so nothing is counted
    // twice.
    //
    // P1-3 — the INTERMEDIARY's arm. When C spends the root's allowance through
    // B, the ledger row sits on the ROOT's wallet, so `wt.user_id = $1` hid it
    // from B — whose own `(B, C)` row that same charge bumped. The via arm is
    // therefore OUTSIDE the wallet predicate, scoped instead by an EXISTS over
    // the caller's own family rows: the row id it matches is one of $1's rows,
    // which is a narrower authorisation than the wallet it was paid from (the
    // same argument `memberSpend` makes).
    const recent = await this.db.q<{
      amount_credits: number; created_at: Date; booking_id: string | null;
      display_name: string | null; actor_user_id: string | null; via_user_id: string | null;
    }>(
      `SELECT wt.amount_credits, wt.created_at, wt.booking_id, u.display_name,
              wt.actor_user_id, wt.metadata->>'via_user_id' AS via_user_id
         FROM wallet_transactions wt
         LEFT JOIN public.users u ON u.id = wt.actor_user_id
        WHERE wt.type = 'payment' AND wt.amount_credits < 0
          AND wt.actor_user_id IS NOT NULL AND wt.actor_user_id <> $1
          AND ((wt.user_id = $1
                AND (EXISTS (SELECT 1 FROM public.family_members fm
                              WHERE fm.holder_id = $1
                                AND fm.id::text = wt.metadata->>'family_row_id')
                     OR (NOT (wt.metadata ? 'family_row_id')
                         AND EXISTS (SELECT 1 FROM public.family_members fm2
                                      WHERE fm2.holder_id = $1 AND fm2.member_id = wt.actor_user_id))))
               OR EXISTS (SELECT 1 FROM public.family_members fm3
                           WHERE fm3.holder_id = $1
                             AND fm3.id::text = wt.metadata->>'via_family_row_id'))
        ORDER BY wt.created_at DESC LIMIT 20`,
      [holderId],
    );
    return {
      totalSpent,
      memberCount,
      othersSpent,
      members: memberOut,
      recent: recent.map(r => ({
        name: r.display_name ?? 'Member',
        credits: Math.abs(r.amount_credits),
        at: r.created_at.toISOString(),
        bookingId: r.booking_id,
        // A6 — the holder's line item names the SPENDER and the route.
        actorUserId: r.actor_user_id ?? null,
        viaUserId: r.via_user_id ?? null,
      })),
    };
  }

  // MON-4 — the standalone recordSpend() bump was removed: it wrote spent_credits
  // UNLOCKED, and both live charge sites (booking.payWithCredits, dispatch escrow
  // accept) now bump it inline under a FOR UPDATE lock on the member row. A revived
  // unlocked helper would reopen the family-cap TOCTOU, so it is intentionally gone.

  // B-843 (A15) — `linkPendingInvitesByPhone` is DELETED. It had no caller (the
  // founder rule of 2026-08-03 stopped pending-by-phone rows being created at
  // all), and under the new (holder_id, member_id) partial unique a blind
  // member_id backfill across every legacy phone row is exactly the statement
  // that would 23505 with nothing to catch it.
}

/**
 * B-854 (A5) — the TIGHTER of the two family caps a charge has to clear, or
 * null when it clears both.
 *
 * A non-chained booking has exactly ONE cap and this collapses, figure for
 * figure, to the check it replaces. A chained one has two — the spender's limit
 * on their own row, and the intermediary's limit on the funding row — and only
 * one of them is the reason the member was refused. Reporting the other's
 * numbers would send them to ask the wrong person for more credit.
 *
 * "Tighter" is measured as the smaller REMAINING, not the smaller limit: a
 * generous-but-exhausted allowance blocks sooner than a small untouched one.
 * An unlimited (null) side simply never enters the comparison.
 *
 * Pure and exported so both charge sites and the create-time soft check share
 * one rule — the shape that drifts is two copies of an inequality.
 */
export function familyCapRefusal(
  payer: Pick<ResolvedPayer,
    'familyRowId' | 'spendLimit' | 'spent' | 'fundingRowId' | 'fundingSpendLimit' | 'fundingSpent'>,
  cost: number,
): {required: number; allocated: number; used: number; remaining: number} | null {
  if (!payer.familyRowId) {return null;}
  const caps: Array<{limit: number; spent: number}> = [];
  if (payer.spendLimit !== null && payer.spendLimit !== undefined) {
    caps.push({limit: Number(payer.spendLimit), spent: Number(payer.spent ?? 0)});
  }
  if (payer.fundingRowId && payer.fundingSpendLimit !== null && payer.fundingSpendLimit !== undefined) {
    caps.push({limit: Number(payer.fundingSpendLimit), spent: Number(payer.fundingSpent ?? 0)});
  }
  let worst: {limit: number; spent: number} | null = null;
  for (const c of caps) {
    if (c.spent + cost <= c.limit) {continue;}
    if (!worst || c.limit - c.spent < worst.limit - worst.spent) {worst = c;}
  }
  if (!worst) {return null;}
  return {
    required:  cost,
    allocated: worst.limit,
    used:      worst.spent,
    remaining: Math.max(0, worst.limit - worst.spent),
  };
}

/**
 * B-854 — the status a funding ask REPORTS, and the one place that rule lives.
 *
 * `family_funding_requests.status` is swept lazily (no cron, exactly like its
 * credit-request sibling), so a row can sit at 'pending' long past its expiry.
 * Trusting the column there makes both rosters offer "View request" for an ask
 * nobody can act on any more. Derived from the expiry instead, identically on
 * the holder's side and the member's — two copies of this comparison is how the
 * two screens start disagreeing about the same row.
 */
export function reportedFundingStatus(
  status: string | null, expiresAt: Date | string | null, now = Date.now(),
): FundingRequestStatus {
  if (status !== 'pending') {return (status ?? 'expired') as FundingRequestStatus;}
  const t = expiresAt ? new Date(expiresAt).getTime() : NaN;
  return Number.isFinite(t) && t <= now ? 'expired' : 'pending';
}

/** The compact roster form, or null when the row has never been asked about. */
function toFundingSummary(row: {
  funding_request_id?: string | null;
  funding_request_status?: string | null;
  funding_request_created_at?: Date | null;
  funding_request_expires_at?: Date | null;
}): FundingRequestSummary | null {
  if (!row.funding_request_id || !row.funding_request_created_at) {return null;}
  return {
    id:        row.funding_request_id,
    status:    reportedFundingStatus(row.funding_request_status ?? null, row.funding_request_expires_at ?? null),
    createdAt: row.funding_request_created_at.toISOString(),
  };
}

function trimText(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t.slice(0, 280) : null;
}

function normalizeLimit(v: number | null | undefined): number | null {
  if (v === null || v === undefined) {return null;}
  if (!Number.isFinite(v) || v < 0) {return null;}
  return Math.floor(v);
}

function isHeldRow(row: {held_until: Date | null}, now: number): boolean {
  return !!row.held_until && new Date(row.held_until).getTime() > now;
}

/**
 * B-854 — read the chain off a `PayerRow`, and REFUSE the degenerate shapes.
 *
 * `clientId` is load-bearing, not decoration: with mutual funding (A funds B's
 * members and B funds A's members) the single hop can land back on the SPENDER
 * — C ≡ A — which would charge C for C's own booking while consuming two caps,
 * and `reverseFamilySpend`'s `memberId === holderId` early return then strands
 * both. That shape is a PLAIN hop, resolved here and refused again at the
 * charge site (A2).
 */
function chainOf(row: PayerRow, clientId: string): {
  chained:                boolean;
  /** The balance of the wallet that would actually pay. Never published raw. */
  walletCredits:          number;
  fundingRowId:           string | null;
  fundingHolderId:        string | null;
  fundingSpendLimit:      number | null;
  fundingSpent:           number;
  fundingHolderSuspended: boolean;
} {
  const own = Math.max(0, Number(row.root_credits ?? 0));
  const fundingHolderId = row.funding_row_id ? (row.funding_holder_id ?? null) : null;
  // P2-5 — `row.holder_id === clientId` is refused too, symmetric with the two
  // charge sites (which reject `via === client` alongside `wallet === client`).
  // A self-membership row cannot exist by construction, so this is depth rather
  // than a live hole — but the charge sites already guard the shape, and a
  // resolver that would happily HAND them one is the asymmetry that gets fixed
  // in the wrong place later.
  if (!row.funding_row_id || !fundingHolderId
      || fundingHolderId === clientId || row.holder_id === clientId) {
    return {
      chained: false, walletCredits: own, fundingRowId: null, fundingHolderId: null,
      fundingSpendLimit: null, fundingSpent: 0, fundingHolderSuspended: false,
    };
  }
  return {
    chained:                true,
    walletCredits:          Math.max(0, Number(row.funding_wallet_credits ?? 0)),
    fundingRowId:           row.funding_row_id,
    fundingHolderId,
    fundingSpendLimit:      row.funding_spend_limit_credits ?? null,
    fundingSpent:           Number(row.funding_spent_credits ?? 0),
    fundingHolderSuspended: (row.funding_holder_suspended_at ?? null) !== null,
  };
}

/**
 * B-854 (A12) — `min(this member's remaining, the funding row's remaining, the
 * paying wallet's balance)`, with a suspended wallet owner worth 0 (§21).
 *
 * Nesting `effectiveSpendable` twice is the same arithmetic written once:
 * `min(min(remC, avail), min(remB, avail)) === min(remC, remB, avail)`, and an
 * unlimited quota on either side drops out of the min exactly as §41 wants.
 */
function chainCeiling(row: PayerRow, clientId: string): number {
  const chain = chainOf(row, clientId);
  const frozen = row.holder_suspended_at !== null || chain.fundingHolderSuspended;
  const available = frozen ? 0 : chain.walletCredits;
  const mine = effectiveSpendable(Number(row.spent_credits ?? 0), row.spend_limit_credits, available);
  return chain.chained
    ? Math.min(mine, effectiveSpendable(chain.fundingSpent, chain.fundingSpendLimit, available))
    : mine;
}

function toPayerOption(row: PayerRow, now: number, clientId: string): PayerOption {
  const spent = Number(row.spent_credits ?? 0);
  return {
    holderId:      row.holder_id,
    holderName:    row.holder_name ?? 'Plan holder',
    spendLimit:    row.spend_limit_credits,
    spent,
    remaining:     remainingQuota(spent, row.spend_limit_credits),
    held:          isHeldRow(row, now),
    // A12 — `rootSuspended` stays the SHOWN root's (B's). The higher root's
    // suspension is folded into `effectiveSpendable` instead, because naming it
    // would tell the member about an account they are not a member of.
    rootSuspended: row.holder_suspended_at !== null,
    effectiveSpendable: chainCeiling(row, clientId),
  };
}

function toResolvedPayer(row: PayerRow, clientId: string): ResolvedPayer {
  const chain = chainOf(row, clientId);
  return {
    // A4 — the WALLET, which is the higher root once chained…
    payerId: chain.chained ? (chain.fundingHolderId as string) : row.holder_id,
    familyRowId: row.id,
    spendLimit: row.spend_limit_credits, spent: Number(row.spent_credits ?? 0),
    // …and once chained this is the WALLET owner's suspension, because that is
    // the account whose money is frozen. A suspended intermediary never gets
    // here at all — the chain read drops it — so the plain hop keeps answering
    // for that case exactly as it did before.
    holderSuspended: chain.chained ? chain.fundingHolderSuspended : row.holder_suspended_at !== null,
    // …but the SHOWN root is always the member's own (LM-B7).
    holderId: row.holder_id, holderName: row.holder_name ?? 'Plan holder',
    fundingRowId: chain.fundingRowId,
    fundingHolderId: chain.fundingHolderId,
    viaUserId: chain.chained ? row.holder_id : null,
    fundingSpendLimit: chain.fundingSpendLimit,
    fundingSpent: chain.fundingSpent,
  };
}
