import {
  Body, Controller, Get, Headers, Param, Post, Query, UseGuards, UseInterceptors,
} from '@nestjs/common';
import {Throttle} from '@nestjs/throttler';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {CurrentUser}  from '../common/decorators/current-user.decorator';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';
import {OptionalIdempotencyInterceptor} from '../common/interceptors/optional-idempotency.interceptor';
import type {AccessClaims} from '../auth/jwt.service';
import {BookingService, type ClientBooking} from './booking.service';
import {BookingHistoryService, type HistoryPage} from './booking-history.service';
import {PricingService} from './pricing.service';
import {regionFromPoint} from '../common/regions';
import {InvoiceService} from './invoice.service';
import {CreateBookingDto, EstimateBookingDto} from './dto/create-booking.dto';
import {CreateDisputeDto} from './dto/dispute.dto';
import {PayWithCreditsDto} from './dto/pay-with-credits.dto';
import {SubmitRatingDto} from './dto/rating.dto';
import {ModuleAccessService} from '../module-access/module-access.service';

@Controller('bookings')
@UseGuards(JwtAuthGuard)
export class BookingController {
  constructor(
    private readonly bookings: BookingService,
    private readonly invoices: InvoiceService,
    private readonly pricing: PricingService,
    // B-786 — appended LAST on purpose. Nest injects by type, but this
    // controller is also constructed positionally in specs, and inserting a
    // parameter mid-list silently shifts every one after it.
    private readonly history: BookingHistoryService,
    // 2026-09-27 — also appended last, for the same reason. Module Access: an
    // admin can switch Secure Transfer / Executive Protection off per group.
    private readonly moduleAccess: ModuleAccessService,
  ) {}

  /**
   * E2E-23 / E2E-36 (2026-09-03) + B-795 (2026-09-04) — the LEGACY create path,
   * brought up to the `/dispatch/request` posture.
   *
   * Three guards, in order of strength:
   *
   *  1. `UserThrottlerGuard` + `@Throttle` 5/min — IDENTICAL to
   *     `/dispatch/request`. Bound at the HANDLER, never the controller: a
   *     controller-level ThrottlerGuard would make `GlobalHttpThrottlerGuard`
   *     skip every OTHER booking route (its `shouldSkip` reads class metadata
   *     too), silently removing the global ceiling from the whole surface.
   *     Per-USER, not per-IP, so a carrier NAT cannot starve a neighbour.
   *  2. `OptionalIdempotencyInterceptor` — full replay collapse when the client
   *     sends `Idempotency-Key` (the updated app mints one per submission body),
   *     pass-through when it does not. A key-less request is an app built before
   *     multi-booking: `create()` keeps the old one-active rule for it verbatim;
   *     a keyed client gets the open-bookings cap instead (several SCHEDULED
   *     bookings may be open at once).
   *  3. The race-proof floor: the partial unique index
   *     `lite_bookings_one_active_per_client_uq` — ONE open go-now booking per
   *     client, whatever the client sends. `create()` translates its 23505 into
   *     the same friendly `active_booking_exists` error, so the race and the
   *     read-then-throw produce one response shape.
   */
  @Throttle({default: {limit: 5, ttl: 60_000}})
  @UseGuards(UserThrottlerGuard)
  @Post()
  @UseInterceptors(OptionalIdempotencyInterceptor)
  async create(
    @Body() dto: CreateBookingDto,
    @CurrentUser() user: AccessClaims,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<{booking: ClientBooking}> {
    // Module Access — blocks STARTING a booking only; existing bookings, their
    // payment, tracking and SOS are untouched (module-catalog SAFETY RULE).
    await this.moduleAccess.assertEnabled(
      user.sub, dto.service === 'executive_protection' ? 'executive_protection' : 'secure_lite');
    // No key = an app built before 2026-09-04: no per-booking UI and no
    // double-submit key. It keeps the one-active rule it was built against.
    return this.bookings.create(user.sub, dto, {legacyClient: !idempotencyKey});
  }

  @Get()
  list(
    @CurrentUser() user: AccessClaims,
    @Query('status') status?: string,
    @Query('page') page?: string,
  ): Promise<{bookings: ClientBooking[]; total: number}> {
    const pageNum = page !== undefined && /^\d+$/.test(page) ? Number(page) : undefined;
    return this.bookings.list(user.sub, {status, page: pageNum});
  }

  /**
   * B-786 — the client's booking HISTORY (rich rows: payment state, receipt,
   * rating, crew, mission timing), cursor-paged with a TRUE total.
   *
   * MUST stay declared above `@Get(':id')`: Nest matches routes in declaration
   * order, so a later declaration would make /bookings/history resolve as a
   * booking whose id is the literal string "history" (a 404 that reads as a
   * missing feature). Pinned by booking.history.spec.ts.
   *
   * Every query value is allow-listed inside the service; nothing here is
   * interpolated into SQL. An unknown value is DROPPED rather than 400'd, which
   * matches the existing GET /bookings status behaviour.
   */
  @Get('history')
  getHistory(
    @CurrentUser() user: AccessClaims,
    @Query('bucket') bucket?: string,
    @Query('service') service?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('payment') payment?: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ): Promise<HistoryPage> {
    const lim = limit !== undefined && /^\d{1,3}$/.test(limit) ? Number(limit) : undefined;
    return this.history.history(user.sub, {bucket, service, from, to, payment, limit: lim, before});
  }

  /**
   * Founder 2026-08-26 — the live service-pricing board (ops-editable), for
   * the client mirror. The apps keep their compiled numbers as the fail-open
   * fallback; at the shipped values this returns exactly those.
   */
  @Get('service-pricing')
  servicePricing(@Query('region') region?: string, @Query('lat') lat?: string, @Query('lng') lng?: string) {
    // OP-01 — this used to return the GLOBAL board unconditionally while the
    // charge path prices the booking's region, so any ops region override
    // showed one number and charged another. The client names the zone it is
    // quoting for THE WAY THE CHARGE DOES: by the pickup point (same
    // `regionFromPoint`), falling back to the draft's zone code before a pin
    // exists. Safe to trust here: it only picks which board is DISPLAYED — the
    // charge still derives the region server-side at create time, and an
    // unknown code simply resolves to the global board.
    const num = (v?: string) => (v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
    const la = num(lat), ln = num(lng);
    const fromPoint = la !== null && ln !== null ? regionFromPoint(la, ln) : null;
    const code = fromPoint ?? (region ?? '').trim().toUpperCase().slice(0, 8);
    const valid = /^[A-Z]{2,8}$/.test(code) ? code : undefined;
    return this.pricing.config(valid).then(cfg => ({pricing: cfg, region: valid ?? 'GLOBAL'}));
  }

  @Get('add-ons')
  addOns(
    @Query('region') region = 'AE',
  ) {
    return this.bookings.listAddOns(region);
  }

  // Audit fix 3.1 — live CPO availability per region. Drives the Lite
  // ZoneMap/BookingHome screens (replaces the hardcoded REGIONS const).
  @Get('regions/availability')
  regionsAvailability() {
    return this.bookings.listRegionsAvailability();
  }

  @Post('estimate')
  // The caller's id rides along so a referral campaign's per-user limit is
  // quoted honestly ("you have already used this code") before submit.
  estimate(@CurrentUser() user: AccessClaims, @Body() dto: EstimateBookingDto) {
    return this.bookings.estimate(dto, user?.sub);
  }

  @Get(':id')
  getById(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ): Promise<ClientBooking> {
    return this.bookings.getById(user.sub, id);
  }

  @Get(':id/team')
  getTeam(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.bookings.getTeam(user.sub, id);
  }

  // F1 — the numbered, line-itemised receipt (COMPLETED) or credit note
  // (refunded terminal). Idempotent: issued once, then re-served.
  @Get(':id/invoice')
  getInvoice(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.invoices.getOrCreateForClient(user.sub, id);
  }

  @Post(':id/cancel')
  cancel(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.bookings.cancel(user.sub, id);
  }

  // Idempotency-Key is required: a network blip retry or a multi-device
  // race must not double-debit the wallet. The interceptor collapses
  // identical-key replays onto the cached first response (24h TTL).
  // Client mints `paywc:<bookingId>` so retries against the same booking
  // converge; a separate retry for a new charge attempt rotates the key.
  //
  // B-843 — the optional body carries `payerUserId` so a member under several
  // roots can re-fire this charge against a different one after a refusal. The
  // service re-resolves it against the caller's own memberships; the body can
  // only ever NARROW to something the caller is already entitled to.
  @Post(':id/pay-with-credits')
  @UseInterceptors(IdempotencyInterceptor)
  payWithCredits(
    @Param('id') id: string,
    @Body() body: PayWithCreditsDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.bookings.payWithCredits(user.sub, id, body);
  }

  // Step 11 — client confirms early; releases the escrow to the agency NOW.
  // Idempotency-Key required (a retry must not double-release).
  @Post(':id/confirm-complete')
  @UseInterceptors(IdempotencyInterceptor)
  confirmComplete(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.bookings.confirmComplete(user.sub, id);
  }

  // Step 11 — client raises a dispute, freezing the escrow (beats the release sweep).
  @Post(':id/dispute')
  @UseInterceptors(IdempotencyInterceptor)
  dispute(
    @Param('id') id: string,
    @Body() dto: CreateDisputeDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.bookings.openDispute(user.sub, id, dto);
  }

  // Step 24 — client rates the agency on a COMPLETED booking; recomputes agents.rating
  // (the dispatch-ranking trust signal). Owner+COMPLETED-only, idempotent (one per booking).
  @Post(':id/rating')
  @UseInterceptors(IdempotencyInterceptor)
  submitRating(
    @Param('id') id: string,
    @Body() dto: SubmitRatingDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.bookings.submitRating(user.sub, id, dto);
  }

  // Step 11 — hold state + final split for the receipt/UI (client owner or agency).
  @Get(':id/escrow')
  getEscrow(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.bookings.getEscrow(user.sub, id);
  }

  // Step 19 — client reads the coarse provider reveal (name/call-sign/★/missions) for the
  // agency that accepted their auto booking. Owner-scoped; no precise location (LB1).
  @Get(':id/provider')
  getProvider(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.bookings.getProvider(user.sub, id);
  }

  // Step 16 — client reads the on-arrival verify code (HMAC-derived, never stored)
  // to confirm the assigned lead guard's identity at handover. Read → no interceptor.
  @Get(':id/verify-code')
  getVerifyCode(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.bookings.getVerifyCode(user.sub, id);
  }

  // Step 16 — client escalates a stranded NO_PROVIDER booking to the hotline.
  // Side-channel only (no status flip); idempotency-collapsed so a retry is a no-op.
  @Post(':id/escalate')
  @UseInterceptors(IdempotencyInterceptor)
  escalate(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.bookings.escalate(user.sub, id);
  }
}
