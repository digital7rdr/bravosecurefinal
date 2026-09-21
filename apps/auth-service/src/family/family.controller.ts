import {Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards} from '@nestjs/common';
import {JwtAuthGuard}       from '../common/guards/jwt-auth.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {CurrentUser}        from '../common/decorators/current-user.decorator';
import type {AccessClaims}  from '../auth/jwt.service';
import {FamilyService}      from './family.service';
import {FamilyQuotaService} from './family-quota.service';
import {
  ApproveCreditDto, FundMembersDecisionDto, FundMembersRequestDto, InviteMemberDto,
  ListMembersQueryDto, RejectCreditDto, ReportLocationDto, RequestCreditDto,
  SetFundMembersDto, SetHoldDto, SetSpendLimitDto,
} from './dto/family.dto';

/**
 * Member hierarchy endpoints. JWT-guarded + per-user throttled. Holder ops
 * are scoped to the caller as holder; member ops to the caller as member —
 * no endpoint accepts a foreign user id.
 */
@Controller('family')
@UseGuards(JwtAuthGuard, UserThrottlerGuard)
export class FamilyController {
  constructor(
    private readonly family: FamilyService,
    private readonly quota: FamilyQuotaService,
  ) {}

  // ── Holder side ──
  // B-833 — `dto.relationship` is deliberately NOT forwarded: old APKs still
  // send it, the server stops storing it.
  @Post('invite')
  invite(@Body() dto: InviteMemberDto, @CurrentUser() user: AccessClaims) {
    return this.family.invite(user.sub, dto.phoneE164, dto.spendLimitCredits ?? null);
  }

  /**
   * B-832 legacy shim — there is no seat cap any more. A ≤1.0.304 APK still
   * shows this CTA once it counts four active members; the service answers ok
   * and files an ops-feed nudge to advise an update.
   */
  @Post('request-seats')
  requestSeats(@CurrentUser() user: AccessClaims) {
    return this.family.requestSeats(user.sub);
  }

  /**
   * B-835 — paged + searchable roster. The response keeps its `members` key
   * (old-APK compatible) and adds `total` + `counts`.
   */
  @Get('members')
  members(@Query() query: ListMembersQueryDto, @CurrentUser() user: AccessClaims) {
    return this.family.listMembers(user.sub, query);
  }

  /** Credit-usage breakdown (Claude-token-style): total + per-member + recent. */
  @Get('usage')
  usage(@CurrentUser() user: AccessClaims) {
    return this.family.usage(user.sub);
  }

  /** Itemised per-member spend from the owner's wallet (actor-stamped ledger). */
  @Get('members/:id/spend')
  memberSpend(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessClaims) {
    return this.family.memberSpend(user.sub, id);
  }

  /**
   * Set / clear a member's spending quota (spec §18, §19).
   *
   * `user.sub` is BOTH the holder scope and the audited actor — the route never
   * reads a holder id from the body or the path, so a caller can only ever
   * change a quota inside their own family.
   *
   * Refuses a reduction below the member's already-spent amount with
   * `QUOTA_BELOW_SPENT` + the minimum, which is what §44's confirmation dialog
   * renders.
   */
  @Patch('members/:id/limit')
  setLimit(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetSpendLimitDto, @CurrentUser() user: AccessClaims) {
    return this.family.setSpendLimit(user.sub, id, dto.spendLimitCredits ?? null, user.sub, dto.reason ?? null);
  }

  /** Append-only quota-change history for one member (spec §37). Holder-scoped. */
  @Get('members/:id/quota-history')
  quotaHistory(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessClaims) {
    return this.quota.quotaHistory(user.sub, id).then(history => ({history}));
  }

  // ── Credit requests · holder side (spec §13-§16) ──
  //
  // Every one of these is scoped by `holder_id = user.sub` inside the service,
  // so a holder cannot see or decide another family's requests, and a MEMBER
  // calling them finds nothing to act on (§39: approving your own request is
  // not a permission that exists).

  /** Every credit request across the holder's family, newest first (§43). */
  @Get('credit-requests')
  listRequests(@CurrentUser() user: AccessClaims) {
    return this.quota.listRequests(user.sub).then(requests => ({requests}));
  }

  /** Approve in full, or in part by supplying a smaller `approvedCredits` (§14). */
  @Post('credit-requests/:id/approve')
  approveRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveCreditDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.quota.approveRequest(user.sub, id, dto.approvedCredits ?? null, dto.reason ?? null);
  }

  /** Reject — the member's quota is not touched (§15). */
  @Post('credit-requests/:id/reject')
  rejectRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectCreditDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.quota.rejectRequest(user.sub, id, dto.reason ?? null);
  }

  // ── B-854 (A11) · chained credit · ROOT side ──
  //
  // Every one of these is scoped by `holder_id = user.sub` inside the service:
  // the row id in the path must be a row of the CALLER's own family, or it is a
  // 404. `user.sub` is also the audited actor and the role is stated as CLIENT
  // — the ops console reaches the same methods with its operator's real role.

  /** Approve: this member's own members may spend the caller's allowance. */
  @Post('members/:rowId/fund-members/approve')
  approveFundMembers(
    @Param('rowId', ParseUUIDPipe) rowId: string,
    @Body() dto: FundMembersDecisionDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.family.approveFundMembers(
      user.sub, rowId, {actorId: user.sub, actorRole: 'CLIENT'}, dto.reason ?? null,
    );
  }

  /** Decline: the switch is not touched, the open ask is closed. */
  @Post('members/:rowId/fund-members/decline')
  declineFundMembers(
    @Param('rowId', ParseUUIDPipe) rowId: string,
    @Body() dto: FundMembersDecisionDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.family.declineFundMembers(
      user.sub, rowId, {actorId: user.sub, actorRole: 'CLIENT'}, dto.reason ?? null,
    );
  }

  /**
   * Switch it off. A10 — refused with `chained_bookings_in_flight` + the count
   * while chained bookings are still live, because flipping it under them makes
   * the charge fail closed at accept and cancels the booking hours later. Only
   * ops may force that through, so no `force` is read from this body.
   */
  @Patch('members/:rowId/fund-members')
  setFundMembers(
    @Param('rowId', ParseUUIDPipe) rowId: string,
    @Body() _dto: SetFundMembersDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.family.setFundMembersOff(user.sub, rowId, {actorId: user.sub, actorRole: 'CLIENT'});
  }

  /** Every funding ask across the caller's family, newest first. */
  @Get('funding-requests')
  fundingRequests(@CurrentUser() user: AccessClaims) {
    return this.family.fundingRequestsForHolder(user.sub).then(requests => ({requests}));
  }

  /** Hold / unhold a member (heldUntilIso null lifts the hold). */
  @Patch('members/:id/hold')
  setHold(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetHoldDto, @CurrentUser() user: AccessClaims) {
    return this.family.setHold(user.sub, id, dto.heldUntilIso ?? null);
  }

  @Delete('members/:id')
  revoke(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessClaims) {
    return this.family.revoke(user.sub, id);
  }

  // ── Member side ──

  /**
   * B-843 — EVERY root this user is a member of. `membership` below stays for
   * ≤1.0.306 clients and answers the oldest of exactly this list.
   */
  @Get('memberships')
  memberships(@CurrentUser() user: AccessClaims) {
    return this.family.myMemberships(user.sub).then(memberships => ({memberships}));
  }

  @Get('membership')
  membership(@CurrentUser() user: AccessClaims) {
    return this.family.myMembership(user.sub).then(membership => ({membership}));
  }

  /**
   * Member device reports its last fix (foreground, ~10-min cadence). A
   * non-member / held / opted-out caller gets `{reported:false}` — soft, so
   * the client backs off without error noise.
   */
  @Post('location')
  reportLocation(@Body() dto: ReportLocationDto, @CurrentUser() user: AccessClaims) {
    return this.family.reportLocation(user.sub, {lat: dto.lat, lng: dto.lng, accuracyM: dto.accuracyM ?? null});
  }

  // ── Credit requests · member side (spec §11, §12, §17) ──

  /**
   * Ask the holder for more spending credit.
   *
   * The membership is resolved from `user.sub`, so the body carries only an
   * amount, a reason and — B-843, when the member belongs to several roots —
   * WHICH of their own roots to ask. A second request while one is open is
   * refused with `CREDIT_REQUEST_PENDING` + the open request's id, which is what
   * lets §42's UI show "View Request" instead of a duplicate-creating button.
   */
  @Post('credit-requests')
  requestCredit(@Body() dto: RequestCreditDto, @CurrentUser() user: AccessClaims) {
    return this.quota.requestCredit(user.sub, dto.requestedCredits, dto.reason ?? null, dto.holderId ?? null)
      .then(request => ({request}));
  }

  /** The member's own request history — own rows only (§39). */
  @Get('credit-requests/mine')
  myRequests(@CurrentUser() user: AccessClaims) {
    return this.quota.myRequests(user.sub).then(requests => ({requests}));
  }

  /**
   * Cancel a PENDING request (§16 holder, §17 member).
   *
   * One route for both sides: the service authorises by PARTICIPATION against
   * the stored row (caller must be its holder or its member) and refuses any
   * non-pending status, so an APPROVED / REJECTED / EXPIRED request can never
   * be cancelled and a cancelled one can never later be approved.
   */
  @Post('credit-requests/:id/cancel')
  cancelRequest(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessClaims) {
    return this.quota.cancelRequest(user.sub, id);
  }

  // ── B-854 (A11) · chained credit · MEMBER side ──

  /**
   * Ask a root to let their allowance fund the caller's OWN members.
   *
   * `:id` is the caller's own MEMBERSHIP row, resolved as `(member_id = you,
   * id = this)` — a row the caller is not the member of is a 404, never a
   * request filed against somebody else's family. The switch stays off until
   * the root approves: every money-widening act here is the payer's.
   */
  @Post('memberships/:id/fund-members/request')
  requestFundMembers(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FundMembersRequestDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.family.requestFundMembers(user.sub, id, dto.reason ?? null)
      .then(request => ({request}));
  }

  /**
   * P1-2 — the MEMBER switches their own chain off.
   *
   * The allowance the chain spends is the caller's own, so waiting on the root
   * to withdraw a grant the caller asked for is a one-way door — and the root
   * is the party least likely to notice that the caller's own members have gone
   * rogue. Same in-flight refusal as the root's route; `force` is an ops
   * override and is never read from this body.
   */
  @Post('memberships/:id/fund-members/off')
  fundMembersOff(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessClaims) {
    return this.family.setFundMembersOffAsMember(user.sub, id, {actorId: user.sub, actorRole: 'CLIENT'});
  }

  /** The caller's own funding asks — own rows only. */
  @Get('funding-requests/mine')
  myFundingRequests(@CurrentUser() user: AccessClaims) {
    return this.family.myFundingRequests(user.sub).then(requests => ({requests}));
  }

  @Get('invites')
  invites(@CurrentUser() user: AccessClaims) {
    return this.family.invitesFor(user.sub).then(invites => ({invites}));
  }

  @Post('invites/:id/accept')
  accept(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessClaims) {
    return this.family.accept(user.sub, id);
  }

  @Post('invites/:id/decline')
  decline(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AccessClaims) {
    return this.family.decline(user.sub, id);
  }
}
