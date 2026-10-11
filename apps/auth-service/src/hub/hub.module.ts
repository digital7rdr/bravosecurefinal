import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {OpsModule} from '../ops/ops.module';
import {PasswordService} from '../common/services/password.service';
import {HubService} from './hub.service';
import {SignupService} from './signup.service';
import {PasswordResetService} from './password-reset.service';
import {HubController, PasswordResetController, SignupController, SsoController} from './hub.controller';
import {OpsPlatformAppsController} from './ops-platform-apps.controller';

/**
 * Bravo Secure home site (bravosecure.cloud, 2026-10-10): registration, the
 * app launcher, the single sign-on hand-off, and the Super Admin app editor.
 */
@Module({
  imports:     [AuthModule, OpsModule],
  controllers: [SignupController, PasswordResetController, HubController, SsoController, OpsPlatformAppsController],
  providers:   [HubService, SignupService, PasswordResetService, PasswordService],
})
export class HubModule {}
