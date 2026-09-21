import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {OrgModule} from '../org/org.module';
import {DeptChatV2Guard} from '../common/guards/dept-chat-v2.guard';
import {AttendanceController} from './attendance.controller';
import {AttendanceService} from './attendance.service';
import {AttendanceRollupService} from './attendance-rollup.service';
import {RosterController} from './roster.controller';
import {RosterService} from './roster.service';
import {GeocodeService} from '../vbg/geocode.service';
import {AttendancePhotoService} from './attendance-photo.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';

/**
 * Attendance module — provider-managed CPO shift clock-in/out.
 *
 * AuthModule supplies JwtAuthGuard; OrgModule exports OrgManagerGuard (the
 * provider-scoped routes). DatabaseService is global.
 */
@Module({
  imports:     [AuthModule, OrgModule],
  controllers: [AttendanceController, RosterController],
  providers:   [
    AttendanceService, AttendanceRollupService, RosterService, DeptChatV2Guard,
    // 2026-09-05 — check-in place names (server-side reverse geocode; the
    // family module provides GeocodeService the same way) and the sealed,
    // retention-bounded check-in photo lane.
    GeocodeService, AttendancePhotoService,
    // B-859 — the ping wake. BookingPushBridge is a stateless Redis publisher
    // (RedisModule and NotificationsModule are @Global), so it is re-provided
    // locally exactly as department/family/agent do, rather than importing
    // OpsModule and inviting a cycle.
    BookingPushBridge,
  ],
  // RosterService deliberately NOT exported: `ensureMonth` must stay reachable
  // from exactly one route (POST month/ensure) — the single-caller invariant
  // the roster.spec scan pins. Nothing outside this module injects it.
  exports:     [AttendanceService],
})
export class AttendanceModule {}
