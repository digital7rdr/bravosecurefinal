import {Module} from '@nestjs/common';
import {RegionsService} from '../common/regions.service';
import {AuthModule}        from '../auth/auth.module';
import {WalletModule}      from '../wallet/wallet.module';
import {FamilyModule}      from '../family/family.module';
import {SettlementModule}  from '../settlement/settlement.module';
import {BookingService}    from './booking.service';
import {BookingHistoryService} from './booking-history.service';
import {BookingController} from './booking.controller';
import {PricingService}    from './pricing.service';
import {BookingStateMachine} from './state-machine.service';
import {CpoAssignmentService} from './assignment/cpo-assignment.service';
import {VehiclePoolService}   from './assignment/vehicle-pool.service';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';
import {OptionalIdempotencyInterceptor} from '../common/interceptors/optional-idempotency.interceptor';
import {PaymentPendingExpiryService} from './payment-pending-expiry.service';
import {EscrowReleaseSweepService} from './escrow-release-sweep.service';
import {EscrowReconciliationService} from './escrow-reconciliation.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';
import {InvoiceService} from './invoice.service';
import {ReferralCampaignsService} from './referral-campaigns.service';
import {ReferralsPublicController} from './referrals-public.controller';

/**
 * Lite Booking module — REST endpoints backing the 5-step Lite wizard.
 *
 * Future evolution (from Master Build Prompt 2.3):
 * - Move into its own `apps/booking-service/` NestJS microservice
 * - WebSocket gateway (`/booking` namespace) for live status pushes
 * - Kafka audit topics (booking.submitted / approved / confirmed / ...)
 * - Redis-backed payment-enabled TTL
 */
@Module({
  imports:     [AuthModule, WalletModule, FamilyModule, SettlementModule],
  // The public referral-link resolve rides this module: it is the campaign
  // service's own read, unauthenticated by design (see the controller doc).
  controllers: [BookingController, ReferralsPublicController],
  providers:   [
    BookingService,
    // Referral / discount campaigns (2026-09-05): quoted in estimate(),
    // applied in createBooking(), managed from OpsModule (exported below).
    ReferralCampaignsService,
    // B-786 — the history READ MODEL. Separate from BookingService.list on
    // purpose: that list is the resume/Home model and must not change shape.
    BookingHistoryService,
    // Client 2026-09-01 — ops-managed regions; publishes into the module
    // cache that regions() reads synchronously.
    RegionsService,
    PricingService,
    BookingStateMachine,
    CpoAssignmentService,
    VehiclePoolService,
    // DI-resolved interceptor for @UseInterceptors() on pay-with-credits.
    IdempotencyInterceptor,
    // E2E-23 — DI-resolved interceptor for @UseInterceptors() on POST /bookings.
    // Key-optional (shipped clients send none on that route); see the class doc.
    OptionalIdempotencyInterceptor,
    // Sweep stale PAYMENT_PENDING bookings so a stalled top-up doesn't
    // permanently block the user's "one mission at a time" slot.
    PaymentPendingExpiryService,
    // Step 11 — Redis-locked escrow release sweep (pays the agency after the
    // dispute window). Ships dark on AUTO_DISPATCH_ENABLED.
    EscrowReleaseSweepService,
    // Step 11 — daily read-only reconciliation sweep (asserts the money invariant).
    EscrowReconciliationService,
    // LM-B2 — stateless Redis publisher (RedisModule is @Global), provided directly
    // like AgentModule does with MissionEventsService to avoid an OpsModule cycle.
    BookingPushBridge,
    // F1 — numbered receipt / credit-note issuance.
    InvoiceService,
  ],
  // OP-05 — RegionsService exported so OpsModule shares ONE instance (one boot
  // load, one background tick) instead of re-providing its own.
  exports:     [BookingService, BookingStateMachine, CpoAssignmentService, VehiclePoolService, PricingService, RegionsService, ReferralCampaignsService],
})
export class BookingModule {}
