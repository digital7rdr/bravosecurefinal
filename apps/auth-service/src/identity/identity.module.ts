import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {OpsAuditService} from '../ops/ops-audit.service';
import {IdentityDocumentController} from './identity-document.controller';
import {IdentityDocumentService} from './identity-document.service';

/**
 * B-867 — the identity document lane. AuthModule supplies JwtAuthGuard.
 * OpsAuditService is re-provided locally (its deps are global) exactly as
 * family / attendance do, because OpsModule imports THIS module for the
 * console read and importing it back would be a cycle.
 */
@Module({
  imports:     [AuthModule],
  controllers: [IdentityDocumentController],
  providers:   [IdentityDocumentService, OpsAuditService],
  exports:     [IdentityDocumentService],
})
export class IdentityModule {}
