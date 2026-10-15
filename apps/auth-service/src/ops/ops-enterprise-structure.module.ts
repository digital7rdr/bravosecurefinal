import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {DepartmentModule} from '../department/department.module';
import {OrgAuditService} from '../org/org-audit.service';
import {WorkspaceService} from '../org/workspace.service';
import {OpsModule} from './ops.module';
import {OpsEnterpriseStructureController} from './ops-enterprise-structure.controller';
import {OpsEnterpriseStructureService} from './ops-enterprise-structure.service';
import {OrgStructureController} from './org-structure.controller';
import {OrgManagerGuard} from '../org/org-manager.guard';
import {OrgModuleGuard} from '../org/org-module.guard';

/**
 * Enterprise structure editor (ops console, 2026-10-15). OpsModule supplies
 * AdminGuard + CsrfGuard + OpsAuditService; DepartmentModule the one channel
 * writer; AuthModule the JwtService JwtAuthGuard needs in this module's
 * context. WorkspaceService (level names) and its OrgAuditService are provided
 * locally — both are stateless, and importing OrgModule here would grow its
 * graph for one method. Separate module, like OpsDeptChatModule: nothing
 * imports it, so it cannot create a cycle.
 */
@Module({
  imports:     [AuthModule, OpsModule, DepartmentModule],
  // OrgStructureController (2026-10-15): the same editor for the org's own
  // admins in the provider console.
  controllers: [OpsEnterpriseStructureController, OrgStructureController],
  providers:   [OpsEnterpriseStructureService, WorkspaceService, OrgAuditService, OrgManagerGuard, OrgModuleGuard],
})
export class OpsEnterpriseStructureModule {}
