import {Global, Module} from '@nestjs/common';
import {ModuleAccessService} from './module-access.service';
import {ModuleAccessGuard} from './module-access.guard';

/**
 * @Global so any feature module can bind @ModuleGate(...) (which needs
 * ModuleAccessGuard → ModuleAccessService) without importing this module.
 * The admin REST surface lives in OpsModule (its guard chain + audit).
 */
@Global()
@Module({
  providers: [ModuleAccessService, ModuleAccessGuard],
  exports: [ModuleAccessService, ModuleAccessGuard],
})
export class ModuleAccessModule {}
