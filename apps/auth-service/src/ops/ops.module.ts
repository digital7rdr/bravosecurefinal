import {Module} from '@nestjs/common';
import {AuthModule}          from '../auth/auth.module';
import {BookingModule}       from '../booking/booking.module';
import {AgentModule}         from '../agents/agent.module';
import {ConversationsModule} from '../conversations/conversations.module';
import {WalletModule}        from '../wallet/wallet.module';
import {DepartmentModule}    from '../department/department.module';
import {SettlementModule}    from '../settlement/settlement.module';
import {ComplianceModule}    from '../compliance/compliance.module';
import {FamilyModule}        from '../family/family.module';
import {IdentityModule}      from '../identity/identity.module';

import {OpsController}        from './ops.controller';
import {OpsDataController}    from './ops-data.controller';
import {OpsAdminsController}  from './ops-admins.controller';
import {AdminInviteAcceptController} from './admin-invite-accept.controller';
import {OpsService}           from './ops.service';
import {OpsDataService}       from './ops-data.service';
import {OpsSectionsController} from './ops-sections.controller';
import {OpsSectionsService}    from './ops-sections.service';
import {OpsReferralCampaignsController} from './ops-referral-campaigns.controller';
import {AdminInvitesService}  from './admin-invites.service';
import {PasswordService}      from '../common/services/password.service';
import {MissionService}       from './mission.service';
import {JobFeedService}       from './job-feed.service';
import {OpsAuditService}      from './ops-audit.service';
import {AdminGuard}           from './admin.guard';
import {SettingsController}   from '../settings/settings.controller';
import {ModuleAccessController} from '../module-access/module-access.controller';
import {MissionStateMachine}  from './mission-state-machine.service';
import {JobStateMachine}      from './job-state-machine.service';
import {SystemMessengerService} from './system-messenger.service';
import {MapboxDirectionsService} from './mapbox-directions.service';
import {MissionEventsService}    from './mission-events.service';
import {BookingPushBridge}       from './booking-push-bridge.service';
import {DispatchKillswitchService} from './dispatch-killswitch.service';
import {MissionDriftJanitorService} from './mission-drift-janitor.service';
import {CsrfGuard}              from '../common/guards/csrf.guard';
import {IdempotencyInterceptor} from '../common/interceptors/idempotency.interceptor';
import {SubscriptionModule}     from '../subscription/subscription.module';
import {OpsSubscriptionController} from './ops-subscription.controller';
import {OpsServicePricingController} from './ops-service-pricing.controller';
import {OpsRegionsController} from './ops-regions.controller';
import {OpsDispatchAreasController} from './ops-dispatch-areas.controller';
import {ReferralCodesController} from './referral-codes.controller';
import {ReferralCodesService}    from './referral-codes.service';

/**
 * Bravo Ops Console module — backs the Next.js admin console at apps/ops-console.
 *
 * Exposes the `/ops/*` REST surface behind JwtAuthGuard + AdminGuard,
 * plus pure state-machine services reused by the mobile app flows.
 */
@Module({
  // A4 — FamilyModule backs the B-836 console roster routes on OpsDataController.
  // The direction is OpsModule → FamilyModule only: FamilyModule deliberately
  // re-provides BookingPushBridge/OpsAuditService locally, so there is no cycle.
  imports:     [AuthModule, BookingModule, AgentModule, ConversationsModule, WalletModule, DepartmentModule, SettlementModule, ComplianceModule, SubscriptionModule, FamilyModule,
    // B-867 — the audited identity-document read on OpsDataController. Direction
    // OpsModule → IdentityModule only (it re-provides OpsAuditService locally).
    IdentityModule],
  controllers: [OpsController, OpsDataController, OpsAdminsController, AdminInviteAcceptController, OpsSubscriptionController, OpsServicePricingController, OpsRegionsController, OpsDispatchAreasController, ReferralCodesController, OpsSectionsController, OpsReferralCampaignsController, SettingsController, ModuleAccessController],
  providers: [
    OpsService, OpsDataService, MissionService, JobFeedService, OpsAuditService,
    // 2026-09-03 IA restructure — config status, provider agencies, enterprise queue.
    OpsSectionsService,
    // Client 2026-09-01 — regions are ops-managed rows now, not a compiled array.
    // OP-05 — RegionsService is IMPORTED from BookingModule (exported there), not
    // re-provided: a second instance meant two boot loads and two 30 s tickers.
    // RS-09 — invite-only admin provisioning + role management.
    AdminInvitesService, PasswordService,
    SystemMessengerService, MapboxDirectionsService,
    AdminGuard, MissionStateMachine, JobStateMachine, CsrfGuard,
    // Audit fix 4.3 — Idempotency-Key handler interceptor. DI-resolved
    // per handler annotated with @UseInterceptors(IdempotencyInterceptor).
    IdempotencyInterceptor,
    // Audit fix 5.1 — mission lifecycle pub/sub bridge to messenger-service.
    MissionEventsService,
    // Booking-approved push bridge (Redis pub/sub → messenger-service FCM fan-out).
    BookingPushBridge,
    // Step 26 — runtime auto-dispatch kill switch (Redis-backed).
    DispatchKillswitchService,
    // LM-D1 — heals missions left active under a terminal booking (drift janitor).
    MissionDriftJanitorService,
    // Issue 28 — the referral-code write side (mint / deactivate, ops console).
    ReferralCodesService,
  ],
  exports: [
    OpsAuditService, MissionService, JobFeedService,
    SystemMessengerService, MapboxDirectionsService,
    MissionStateMachine, JobStateMachine,
    MissionEventsService,
    BookingPushBridge,
    DispatchKillswitchService,
    // Exported so the dispatch admin controller (DispatchModule, which imports OpsModule)
    // can reuse the same admin guard chain as the /ops surface.
    AdminGuard, CsrfGuard,
  ],
})
export class OpsModule {}
