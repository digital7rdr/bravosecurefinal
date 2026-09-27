import {Module}           from '@nestjs/common';
import {APP_GUARD}        from '@nestjs/core';
import {ConfigModule}     from '@nestjs/config';
import {ThrottlerModule}  from '@nestjs/throttler';
import {GlobalHttpThrottlerGuard} from './common/guards/global-http-throttler.guard';
import configuration      from './config/configuration';
import {DatabaseModule}   from './database/database.module';
import {RedisModule}      from './redis/redis.module';
import {SettingsModule}     from './settings/settings.module';
import {MessagingModule}    from './messaging/messaging.module';
import {ModuleAccessModule} from './module-access/module-access.module';
import {KafkaModule}      from './kafka/kafka.module';
import {AuthModule}       from './auth/auth.module';
import {KeysModule}       from './keys/keys.module';
import {SenderCertModule} from './sender-cert/sender-cert.module';
import {TotpModule}       from './totp/totp.module';
import {BiometricModule}  from './biometric/biometric.module';
import {VaultPinModule}   from './vault-pin/vault-pin.module';
import {UsersModule}      from './users/users.module';
import {ConversationsModule} from './conversations/conversations.module';
import {BookingModule}       from './booking/booking.module';
import {WalletModule}        from './wallet/wallet.module';
import {TelemetryModule}     from './telemetry/telemetry.module';
import {AgentModule}         from './agents/agent.module';
import {OrgModule}           from './org/org.module';
import {AttendanceModule}    from './attendance/attendance.module';
import {IncidentModule}      from './incident/incident.module';
import {OpsModule}           from './ops/ops.module';
import {OpsDeptChatModule}   from './ops/ops-deptchat.module';
import {DispatchModule}      from './dispatch/dispatch.module';
import {ComplianceModule}    from './compliance/compliance.module';
import {SosModule}           from './sos/sos.module';
import {EventsModule}        from './events/events.module';
import {NotificationsModule} from './notifications/notifications.module';
import {VbgModule}           from './vbg/vbg.module';
import {FamilyModule}        from './family/family.module';
import {SubscriptionModule}  from './subscription/subscription.module';
import {ProApplicationsModule} from './pro-applications/pro-applications.module';
import {ProManagementModule} from './pro-management/pro-management.module';
import {ProtectionModule}    from './protection/protection.module';
import {DepartmentModule}    from './department/department.module';
import {IdentityModule}      from './identity/identity.module';
import {ObservabilityModule} from './observability/observability.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load:     [configuration],
      envFilePath: ['.env'],
    }),

    // Audit Rev2 API-01 — this module was imported but NO guard consulted it,
    // so every @Throttle below was dead metadata (see GlobalHttpThrottlerGuard,
    // bound as APP_GUARD in `providers`). The default is a coarse ABUSE CEILING
    // well above measured peak (the ops-console SOS bar polls ~300/10min, and
    // those routes bind UserThrottlerGuard so the global guard skips them
    // anyway); the real per-route limits are the @Throttle decorators. Window
    // is per-MINUTE now so a burst clears quickly instead of locking a shared
    // NAT egress out for 10 minutes.
    // E2E-20 (2026-09-03) — the global guard now ENFORCES by default
    // (GlobalHttpThrottlerGuard), so this number is a real 429 boundary rather
    // than a log line. That makes what it is SIZED FOR the important part.
    //
    // ⚠️ THIS IS A DDoS BACKSTOP, NOT A RATE LIMIT. It is IP-keyed and cannot be
    // anything else: APP_GUARDs run before JwtAuthGuard, so `req.user` is not
    // set when the tracker is computed. An IP is therefore a WHOLE OFFICE or a
    // WHOLE CARRIER CGNAT POOL, not a person:
    //
    //   * the ops console polls at 2 s / 5 s with 5-10 SWR hooks per page —
    //     ~120-200 req/min PER SEAT. Four seats behind one office NAT already
    //     pass 600/min; twenty seats would be throttled continuously.
    //   * mobile on carrier-grade NAT reaches it at ~30 concurrent users on one
    //     egress address, mid-mission.
    //
    // So the ceiling is set where only a genuinely pathological source lands:
    // 3000/min = 50 rps sustained from ONE address. Far above any plausible
    // office or CGNAT pool of humans; far below the regime that saturates the
    // 20-connection pg pool and 500s the fleet, which is what E2E-20 is about.
    //
    // THE REAL LIMITS ARE PER-USER. Anything that needs a defensible per-actor
    // rate binds `UserThrottlerGuard` (per-user buckets) plus its own tight
    // `@Throttle` — telemetry, SOS, dispatch, family, vbg/news, the room-intent
    // routes, `POST /bookings`, and the ops controllers. `shouldSkip` in
    // GlobalHttpThrottlerGuard excludes every one of those from this bucket.
    // If a surface is being abused, give it a per-user throttle; do NOT lower
    // this number, because lowering it punishes shared egress, not the abuser.
    //
    // Why: storage is the in-memory default, so EVERY limit above is multiplied
    // by the replica count and no counter survives a restart. That is correct
    // for the single-process deployment this ships to (one container per
    // service) and WRONG the moment a second replica exists — a Redis-backed
    // ThrottlerStorage is REQUIRED before scale-out, or the effective ceiling
    // silently becomes 3000 x N. Tracked as E2E-10 in the 2026-09-03 audit.
    ThrottlerModule.forRoot([{
      name:  'default',
      ttl:   60_000,      // 1 minute window in ms (NestJS v6 throttler uses ms)
      limit: 3_000,       // DDoS backstop per IP; per-USER @Throttle are the real limits
    }]),

    DatabaseModule,
    RedisModule,
    SettingsModule,
    MessagingModule,
    ModuleAccessModule,
    KafkaModule,

    AuthModule,
    KeysModule,
    SenderCertModule,
    TotpModule,
    BiometricModule,
    VaultPinModule,
    UsersModule,
    ConversationsModule,
    BookingModule,
    WalletModule,
    TelemetryModule,
    AgentModule,
    OrgModule,
    AttendanceModule,
    OpsModule,
    OpsDeptChatModule,
    DispatchModule,
    ComplianceModule,
    SosModule,
    EventsModule,
    NotificationsModule,
    VbgModule,
    FamilyModule,
    SubscriptionModule,
    ProApplicationsModule,
    ProManagementModule,
    ProtectionModule,
    DepartmentModule,
    IdentityModule,
    // Audit fix 5.4 — Sentry shim + audit-failure alert hook. @Global,
    // so OpsAuditService picks it up via optional DI without circular
    // module imports.
    ObservabilityModule,
  ],
  // Audit Rev2 API-01 — the missing piece. Without a guard in the chain,
  // @Throttle() is inert metadata. Bound globally; per-route @Throttle and the
  // 8 controllers' UserThrottlerGuard still apply (the latter is skipped by the
  // global guard so its per-user buckets aren't re-bucketed by IP).
  providers: [
    {provide: APP_GUARD, useClass: GlobalHttpThrottlerGuard},
  ],
})
export class AppModule {}
