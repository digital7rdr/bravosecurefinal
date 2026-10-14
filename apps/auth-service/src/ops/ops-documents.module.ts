import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {OpsModule} from './ops.module';
import {OpsDocumentsController} from './ops-documents.controller';
import {OpsDocumentsService} from './ops-documents.service';

/**
 * Bravo controlled-document library (ISO 9001:2015 naming, 2026-10-15).
 * OpsModule supplies AdminGuard + CsrfGuard + OpsAuditService; AuthModule the
 * JwtService for JwtAuthGuard. Nothing imports this module.
 */
@Module({
  imports:     [AuthModule, OpsModule],
  controllers: [OpsDocumentsController],
  providers:   [OpsDocumentsService],
})
export class OpsDocumentsModule {}
