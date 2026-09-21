import {BadRequestException, Body, Controller, Delete, Get, Logger, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards} from '@nestjs/common';
import {Throttle} from '@nestjs/throttler';
import type {Request} from 'express';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {AdminGuard, RequireRoles, type AdminContext} from './admin.guard';
import {OpsDataService} from './ops-data.service';
import {OpsAuditService} from './ops-audit.service';
import {IdentityDocumentService} from '../identity/identity-document.service';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {OPS_THROTTLE} from './ops-throttle';
import {
  OpsAuditBrowseQueryDto, OpsDisputesQueryDto, OpsEscrowQueryDto,
  OpsFamilyBatchInviteDto, OpsFamilyInviteDto, OpsFamilyQueryDto,
  OpsSetFundMembersDto, OpsSosQueryDto, OpsTxQueryDto, OpsUsersQueryDto,
  SuspendUserDto, EraseUserDto,
} from './dto/ops.dto';

import {MintInviteDto} from '../org/dto/org.dto';
import {FamilyService, type FamilyMemberDto} from '../family/family.service';
import {FamilyQuotaService} from '../family/family-quota.service';
import {FundMembersDecisionDto, SetHoldDto, SetSpendLimitDto} from '../family/dto/family.dto';

type OpsReq = Request & {admin: AdminContext};

/** The console renders snake_case rows; the app DTO is camelCase. One mapper. */
function toOpsFamilyRow(m: FamilyMemberDto) {
  return {
    id: m.id,
    member_id: m.memberId,
    member_name: m.name,
    member_email: m.email,
    member_phone: m.phone,
    status: m.status,
    held_until: m.heldUntil,
    spend_limit_credits: m.spendLimit,
    spent_credits: m.spent,
    invited_at: m.invitedAt,
    accepted_at: m.acceptedAt,
    // B-854 — the console's "Funds their members" column, the badge that says
    // WHY the ask exists, what the chain has cost so far, and the latest ask in
    // whatever state it is in (a DECLINED one is what makes "ask again" legible,
    // so the console must be able to render it too).
    funds_sub_members: m.fundsSubMembers,
    holds_members_count: m.holdsMembersCount,
    spent_by_members: m.spentByMembers,
    funding_request: m.fundingRequest
      ? {
          id: m.fundingRequest.id,
          status: m.fundingRequest.status,
          created_at: m.fundingRequest.createdAt,
        }
      : null,
  };
}

/**
 * Read surfaces added by the 2026-07-07 data-coverage audit. Same guard
 * chain as OpsController. Money/user/audit reads are SUPERVISOR+ (least
 * privilege — OPS-tier keeps the operational surfaces: SOS, VBG, analytics,
 * broadcasts, telemetry).
 */
@Controller('ops')
// Ops console rate limiting (booking-lane critic 2026-09-04): bind a
// ThrottlerGuard subclass LAST (after JwtAuthGuard, so req.user is set when
// getTracker runs) so this surface is limited per USER. That binding is also
// what makes GlobalHttpThrottlerGuard.shouldSkip skip these routes — without it
// the whole console shares ONE per-IP bucket per office NAT.
@Throttle(OPS_THROTTLE)
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard, UserThrottlerGuard)
export class OpsDataController {
  private readonly log = new Logger(OpsDataController.name);

  constructor(
    private readonly data: OpsDataService,
    private readonly audit: OpsAuditService,
    private readonly family: FamilyService,
    private readonly quota: FamilyQuotaService,
    private readonly identity: IdentityDocumentService,
  ) {}

  // ─── Disputes (DC-02) ─────────────────────────────────────────────
  @Get('disputes')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  listDisputes(@Query() q: OpsDisputesQueryDto, @Req() req: OpsReq) {
    return this.data.listDisputes(req.admin, q.status, q.limit);
  }

  // ─── Finance ledger (DC-01) ───────────────────────────────────────
  @Get('finance/transactions')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  listTransactions(@Query() q: OpsTxQueryDto) {
    return this.data.listWalletTransactions(q);
  }

  @Get('finance/escrows')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  listEscrows(@Query() q: OpsEscrowQueryDto, @Req() req: OpsReq) {
    return this.data.listEscrows(req.admin, q.status, q.limit, q.booking);
  }

  @Get('finance/payouts')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  listPayouts(@Query('limit') limit: string | undefined, @Req() req: OpsReq) {
    return this.data.listPayouts(req.admin, Number(limit) || undefined);
  }

  @Get('finance/invoices')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  listInvoices(@Query('limit') limit: string | undefined, @Req() req: OpsReq) {
    return this.data.listInvoices(req.admin, Number(limit) || undefined);
  }

  @Get('finance/promos')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  listPromos(@Query('limit') limit?: string) {
    return this.data.listPromos(Number(limit) || undefined);
  }

  @Get('finance/wallet/:userId')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  walletOverview(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.data.walletOverview(userId);
  }

  // ─── User directory (DC-04) ───────────────────────────────────────
  @Get('users')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  listUsers(@Query() q: OpsUsersQueryDto) {
    return this.data.listUsers(q);
  }

  @Get('users/:id')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  getUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.data.getUserDetail(id);
  }

  // B-867 — the ID / passport images an individual submitted. The bytes leave
  // the sealed row ONLY here: SUPERVISOR+, and every read lands in ops_audit
  // (subject 'pii', 'identity_document.view') with a view counter on the row —
  // the same trail as a phone/email reveal. Never part of the user detail body.
  @Get('users/:id/identity-document')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  getUserIdentityDocument(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq) {
    return this.identity.readForOps(req.admin, id);
  }

  // ─── B-836 — the linked-members roster, managed from the console ──────────
  //
  // Same service methods the holder's own app calls, with the holder id taken
  // from the path instead of the JWT — so the §19 quota floor, the ONE-OPEN-ROW-
  // PER-(ROOT, MEMBER) index and the invitee's accept step all still apply.
  //
  // B-843 — that index REPLACED the old one-active-membership rule: a person may
  // now be a member under any number of roots, so adding the same phone under two
  // different holders is `ok` on both, and `member_in_another_family` can no
  // longer occur. Which root PAYS is the booking's stamped `payer_user_id`.
  //
  // A16 — the console sends an `Idempotency-Key` header on these POSTs, but it
  // is DECORATIVE here: no IdempotencyInterceptor is bound to this controller.
  // Real idempotence comes from `invite_already_pending` (a repeat add is
  // refused by the row that already exists), and limit / hold / revoke are
  // idempotent by construction.

  // SK-07/IS-03 + B-835 — memberships both directions. `owner_of` is the paged,
  // searchable roster (same source as the app); `member_of` is the plan this
  // user rides. `manageable` is the SERVER's answer to "may ops edit this
  // roster?" so the console card need not re-derive it (A8).
  @Get('users/:id/family')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async getUserFamily(@Param('id', ParseUUIDPipe) id: string, @Query() q: OpsFamilyQueryDto) {
    const [roster, memberOf, manageable] = await Promise.all([
      // `includeEmail` is the console's opt-in: the holder's own app route
      // deliberately never discloses a member's email address.
      this.family.listMembers(id, {...q, includeEmail: true}),
      this.data.getUserFamilyMemberOf(id),
      this.family.isOpsManageableHolder(id),
    ]);
    return {
      owner_of: roster.members.map(toOpsFamilyRow),
      member_of: memberOf,
      total: roster.total,
      counts: roster.counts,
      manageable,
    };
  }

  @Post('users/:id/family/members')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async inviteFamilyMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OpsFamilyInviteDto,
    @Req() req: OpsReq,
  ) {
    const r = await this.family.inviteAsOps(req.admin.user_id, id, dto.phoneE164, dto.spendLimitCredits ?? null);
    await this.audit.recordAdmin(req.admin, 'family.member_invite', 'user', id, {row_id: r.id});
    return r;
  }

  /**
   * D7/A14 — bulk add, capped at 50 phones per call (each row is several serial
   * queries plus a push fan-out). Rows are INDEPENDENT: one refusal never stops
   * the rest, and the caller gets a per-row outcome to chase.
   *
   * The HOLDER is a property of the request, so it is resolved once, up front,
   * and an ineligible one is a 400 — not a 200 carrying fifty identical
   * `holder_not_eligible` rows (and not two extra queries per row).
   */
  @Post('users/:id/family/members/batch')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async inviteFamilyMembersBatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OpsFamilyBatchInviteDto,
    @Req() req: OpsReq,
  ) {
    await this.family.assertOpsManageableHolder(id);
    const results: Array<{phone: string; ok: boolean; id?: string; code?: string}> = [];
    const seen = new Set<string>();
    for (const raw of dto.phones) {
      const phone = String(raw ?? '').trim();
      if (seen.has(phone)) {
        results.push({phone, ok: false, code: 'duplicate_in_batch'});
        continue;
      }
      seen.add(phone);
      try {
        const r = await this.family.inviteAsOpsForCheckedHolder(req.admin.user_id, id, phone, dto.spendLimitCredits ?? null);
        results.push({phone, ok: true, id: r.id});
      } catch (e) {
        if (e instanceof BadRequestException) {
          results.push({phone, ok: false, code: (e as Error).message});
        } else {
          this.log.warn(`family batch add row failed for holder ${id}: ${(e as Error).message}`);
          results.push({phone, ok: false, code: 'error'});
        }
      }
    }
    const ids = results.filter(r => r.ok).map(r => r.id);
    const added = ids.length;
    // D6 — counts and row ids ONLY. A phone list would outlive a revoke.
    await this.audit.recordAdmin(req.admin, 'family.member_invite_batch', 'user', id, {
      added, failed: results.length - added, ids,
    });
    return {results, added, failed: results.length - added};
  }

  /**
   * Same `setQuota` the holder's app calls, so the §19 `QUOTA_BELOW_SPENT`
   * floor applies to an ops-set limit too. A3 — the ops-vs-holder discriminator
   * rides the audit row's metadata JSONB; `family_quota_audit` has no
   * `actor_role` column.
   */
  @Patch('users/:id/family/members/:rowId/limit')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async setFamilyMemberLimit(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rowId', ParseUUIDPipe) rowId: string,
    @Body() dto: SetSpendLimitDto,
    @Req() req: OpsReq,
  ) {
    const r = await this.quota.setQuota(
      id, rowId, dto.spendLimitCredits ?? null, req.admin.user_id, dto.reason ?? null,
      {actor_role: req.admin.role, actor_call: req.admin.call_sign},
    );
    await this.audit.recordAdmin(req.admin, 'family.limit_set', 'user', id, {
      row_id: rowId, previous: r.previousLimit, next: r.newLimit,
    });
    return r;
  }

  @Patch('users/:id/family/members/:rowId/hold')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async setFamilyMemberHold(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rowId', ParseUUIDPipe) rowId: string,
    @Body() dto: SetHoldDto,
    @Req() req: OpsReq,
  ) {
    const r = await this.family.setHold(id, rowId, dto.heldUntilIso ?? null);
    await this.audit.recordAdmin(req.admin, 'family.hold_set', 'user', id, {
      row_id: rowId, held_until: dto.heldUntilIso ?? null,
    });
    return r;
  }

  @Delete('users/:id/family/members/:rowId')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async revokeFamilyMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rowId', ParseUUIDPipe) rowId: string,
    @Req() req: OpsReq,
  ) {
    const r = await this.family.revoke(id, rowId);
    await this.audit.recordAdmin(req.admin, 'family.member_revoke', 'user', id, {row_id: rowId});
    return r;
  }

  @Get('users/:id/family/members/:rowId/spend')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  familyMemberSpend(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rowId', ParseUUIDPipe) rowId: string,
  ) {
    return this.family.memberSpend(id, rowId);
  }

  // ─── B-854 (A11) — chained credit, from the console ───────────────────────
  //
  // Same service methods the root's own app calls, so every eligibility rule
  // (one funding root, no reciprocal row, the member must actually hold
  // members, the row must be ACTIVE) applies identically to an ops flip.
  //
  // What DIFFERS is the actor: B-832's trap is a console act mirrored onto the
  // ops feed hard-coded as `CLIENT`. The operator's REAL role and call sign
  // ride into both the `family_quota_audit` metadata and the feed row.

  @Get('users/:id/family/funding-requests')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  listFamilyFundingRequests(@Param('id', ParseUUIDPipe) id: string) {
    return this.family.fundingRequestsForHolder(id).then(requests => ({requests}));
  }

  @Post('users/:id/family/members/:rowId/fund-members/approve')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async approveFamilyFundMembers(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rowId', ParseUUIDPipe) rowId: string,
    @Body() dto: FundMembersDecisionDto,
    @Req() req: OpsReq,
  ) {
    const r = await this.family.approveFundMembers(
      id, rowId,
      {actorId: req.admin.user_id, actorRole: req.admin.role, actorCall: req.admin.call_sign},
      dto.reason ?? null,
    );
    await this.audit.recordAdmin(req.admin, 'family.fund_members_approve', 'user', id, {
      row_id: rowId, request_id: r.requestId,
    });
    return r;
  }

  @Post('users/:id/family/members/:rowId/fund-members/decline')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async declineFamilyFundMembers(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rowId', ParseUUIDPipe) rowId: string,
    @Body() dto: FundMembersDecisionDto,
    @Req() req: OpsReq,
  ) {
    const r = await this.family.declineFundMembers(
      id, rowId,
      {actorId: req.admin.user_id, actorRole: req.admin.role, actorCall: req.admin.call_sign},
      dto.reason ?? null,
    );
    await this.audit.recordAdmin(req.admin, 'family.fund_members_decline', 'user', id, {row_id: rowId});
    return r;
  }

  /**
   * A10 — ops is the ONLY caller that may force the switch off while chained
   * bookings are still in flight. `force` is opt-in per call and is recorded on
   * the admin audit row, because forcing it cancels those bookings at accept.
   */
  @Patch('users/:id/family/members/:rowId/fund-members')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async setFamilyFundMembers(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rowId', ParseUUIDPipe) rowId: string,
    @Body() dto: OpsSetFundMembersDto,
    @Req() req: OpsReq,
  ) {
    const r = await this.family.setFundMembersOff(id, rowId, {
      actorId: req.admin.user_id, actorRole: req.admin.role, actorCall: req.admin.call_sign,
      force: dto.force === true,
    });
    await this.audit.recordAdmin(req.admin, 'family.fund_members_off', 'user', id, {
      row_id: rowId, forced: dto.force === true,
    });
    return r;
  }

  // ─── B-812 — a provider's roster invitation codes, from the console ───────
  // Ops can issue a code on a provider's behalf (support desk); the provider's
  // own app mints through /org/invites. Both write the same table with the
  // same rules; the console mints are audited against the admin's call sign.
  @Get('users/:id/provider-invites')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  listProviderInvites(@Param('id', ParseUUIDPipe) id: string) {
    return this.data.listProviderInvites(id);
  }

  @Post('users/:id/provider-invites')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async mintProviderInvite(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MintInviteDto, @Req() req: OpsReq) {
    const r = await this.data.mintProviderInvite(req.admin.user_id, id, dto);
    // The code is a live credential: the audit row carries the invite's id and
    // a suffix, never the code itself (it would outlive a revoke in the trail).
    await this.audit.recordAdmin(req.admin, 'provider.invite_mint', 'user', id, {
      invite_id: r.id, code_suffix: r.code.slice(-3), member_role: r.member_role, call_sign: r.call_sign, expires_at: r.expires_at,
    });
    return r;
  }

  @Post('users/:id/provider-invites/:code/revoke')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async revokeProviderInvite(@Param('id', ParseUUIDPipe) id: string, @Param('code') code: string, @Req() req: OpsReq) {
    const r = await this.data.revokeProviderInvite(id, code);
    await this.audit.recordAdmin(req.admin, 'provider.invite_revoke', 'user', id, {invite_id: r.id, code_suffix: r.code.slice(-3)});
    return r;
  }

  @Post('users/:id/devices/:deviceRowId/revoke')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async revokeDevice(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('deviceRowId', ParseUUIDPipe) deviceRowId: string,
    @Req() req: OpsReq,
  ) {
    const r = await this.data.revokeUserDevice(id, deviceRowId);
    await this.audit.recordAdmin(req.admin, 'user.device_revoke', 'user', id, {device_row_id: deviceRowId});
    return r;
  }

  // DC-04 — reversible suspension (locks login + kills live sessions).
  @Post('users/:id/suspend')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async suspendUser(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SuspendUserDto, @Req() req: OpsReq) {
    await this.data.assertConsoleAdminTarget(req.admin, id);
    const r = await this.data.suspendUser(req.admin.user_id, id, dto.reason);
    await this.audit.recordAdmin(req.admin, 'user.suspend', 'user', id, {reason: dto.reason, revoked_sessions: r.revoked_sessions});
    return r;
  }

  @Post('users/:id/restore')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async restoreUser(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq) {
    const r = await this.data.restoreUser(id);
    await this.audit.recordAdmin(req.admin, 'user.restore', 'user', id, {});
    return r;
  }

  // DC-04 — GDPR erasure (irreversible: soft-delete + PII scrub). ADMIN only.
  @Post('users/:id/erase')
  @RequireRoles('ADMIN')
  async eraseUser(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EraseUserDto, @Req() req: OpsReq) {
    await this.data.assertConsoleAdminTarget(req.admin, id);
    const r = await this.data.eraseUser(req.admin.user_id, id, dto.reason);
    await this.audit.recordAdmin(req.admin, 'user.erase', 'user', id, {reason: dto.reason, revoked_sessions: r.revoked_sessions});
    return r;
  }

  // ─── SOS log (DC-06) ──────────────────────────────────────────────
  @Get('sos')
  listSos(@Query() q: OpsSosQueryDto) {
    return this.data.listSos(q.status, q.limit);
  }

  // ─── VBG oversight (DC-07) ────────────────────────────────────────
  @Get('vbg/monitoring')
  listVbgMonitoring(@Query('limit') limit?: string) {
    return this.data.listVbgMonitoring(Number(limit) || undefined);
  }

  // ─── Global audit browser + write-only-trail readers (DC-08) ──────
  @Get('audit')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  browseAudit(@Query() q: OpsAuditBrowseQueryDto) {
    return this.data.browseAudit(q);
  }

  // SK-08 — was `audit/org/:orgUserId`, which OpsController's
  // `audit/:subject_type/:subject_id` (ParseUUIDPipe on the 2nd segment)
  // could shadow depending on registration order. `audit-log/` shares no
  // prefix with that wildcard, so the reader is always reachable.
  @Get('audit-log/org/:orgUserId')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  orgAudit(@Param('orgUserId', ParseUUIDPipe) orgUserId: string, @Query('limit') limit?: string) {
    return this.data.listOrgAudit(orgUserId, Number(limit) || undefined);
  }

  // ─── Telemetry replay (DC-16) ─────────────────────────────────────
  @Get('missions/:id/telemetry')
  missionTelemetry(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq) {
    return this.data.missionTelemetry(id, req.admin);
  }

  // ─── Broadcast log (DC-20) ────────────────────────────────────────
  @Get('broadcasts/recent')
  listRecentBroadcasts(@Query('kind') kind?: string, @Query('limit') limit?: string) {
    return this.data.listRecentBroadcasts(kind || undefined, Number(limit) || undefined);
  }

  // ─── Analytics rollups (DC-10) ────────────────────────────────────
  @Get('analytics')
  analytics(@Query('days') days: string | undefined, @Query('region') region: string | undefined, @Req() req: OpsReq) {
    return this.data.analytics(req.admin, Number(days) || 30, region || undefined);
  }
}
