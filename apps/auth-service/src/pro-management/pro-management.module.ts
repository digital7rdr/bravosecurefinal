import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {OpsModule} from '../ops/ops.module';
import {OrgModule} from '../org/org.module';
import {ProtectionModule} from '../protection/protection.module';
import {PasswordService} from '../common/services/password.service';
import {ProManagementService} from './pro-management.service';
import {ProFleetService} from './pro-fleet.service';
import {ProMissionActivationService} from './pro-mission-activation.service';
import {ProManagementOpsController} from './pro-management-ops.controller';
import {ProFleetOpsController} from './pro-fleet-ops.controller';
import {CpoMissionCodeController} from './cpo-mission-code.controller';

/**
 * Ops Pro management — internal orgs, ops-created CPOs, overlap-safe
 * CPO↔Pro-member assignments, mission-code gate. Inherits the org machinery
 * (OrgModule exports OrgCpoService — the one "make a deployable officer"
 * primitive) and the /ops guard chain + realtime/push bridges from OpsModule.
 * PasswordService is provided locally (AuthModule doesn't export it — same
 * pattern as OrgModule).
 *
 * ProtectionModule (exports ProtectionService) is imported for
 * ProMissionActivationService — the E2E-01 sweeper that turns a reserved date
 * into a real protection session, and the single fenced driver of the
 * protection sweeps that used to run on the console's 2 s poll (E2E-35).
 * DatabaseService and RedisService are @Global.
 */
@Module({
  imports:     [AuthModule, OpsModule, OrgModule, ProtectionModule],
  controllers: [ProManagementOpsController, ProFleetOpsController, CpoMissionCodeController],
  providers:   [ProManagementService, ProFleetService, PasswordService, ProMissionActivationService],
})
export class ProManagementModule {}
