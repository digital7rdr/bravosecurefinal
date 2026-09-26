import {Global, Module} from '@nestjs/common';
import {SettingsService} from './settings.service';

/**
 * @Global so any service (Stripe client, Twilio SMS/OTP, Mapbox services) can
 * inject SettingsService without each feature module importing this one. The
 * admin REST surface (SettingsController) is registered in OpsModule, which
 * already wires the JwtAuthGuard→CsrfGuard→AdminGuard chain and OpsAuditService.
 *
 * Deps (DatabaseService, RedisService, ConfigService) are themselves global.
 */
@Global()
@Module({
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
