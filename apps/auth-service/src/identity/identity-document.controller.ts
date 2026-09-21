import {
  BadRequestException, Body, Controller, Get, Post, UploadedFiles, UseGuards, UseInterceptors,
} from '@nestjs/common';
import {FileFieldsInterceptor} from '@nestjs/platform-express';
import {Throttle} from '@nestjs/throttler';
import {memoryStorage} from 'multer';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {IdentityDocumentService, MAX_IMAGE_BYTES} from './identity-document.service';

type Parts = {front?: Express.Multer.File[]; back?: Express.Multer.File[]};

/**
 * B-867 — the owner's side of the identity document. The bytes only ever
 * travel UP here; the ops read lives on OpsDataController
 * (`GET /ops/users/:id/identity-document`) behind AdminGuard + audit.
 */
@Controller('users/me/identity-document')
// UserThrottlerGuard LAST (after JwtAuthGuard, so req.user is set): the
// @Throttle below is then keyed per USER, not per IP — a carrier-CGNAT pool
// of registrants must never share one 10-per-10-min bucket on a REQUIRED step.
@UseGuards(JwtAuthGuard, UserThrottlerGuard)
export class IdentityDocumentController {
  constructor(private readonly docs: IdentityDocumentService) {}

  /** Existence + type + date — never the bytes. */
  @Get()
  status(@CurrentUser() user: AccessClaims) {
    return this.docs.status(user.sub);
  }

  /**
   * Submit or replace, in ONE multipart request: `doc_type` + `front`
   * (+ `back` for a national ID). Both parts are validated before any row is
   * touched, so a replace never half-applies.
   */
  @Post()
  @Throttle({default: {limit: 10, ttl: 600_000}})
  @UseInterceptors(FileFieldsInterceptor(
    [{name: 'front', maxCount: 1}, {name: 'back', maxCount: 1}],
    {storage: memoryStorage(), limits: {fileSize: MAX_IMAGE_BYTES, files: 2}},
  ))
  submit(
    @UploadedFiles() files: Parts | undefined,
    @Body('doc_type') docType: string | undefined,
    @CurrentUser() user: AccessClaims,
  ) {
    if (!docType) throw new BadRequestException('doc_type_required');
    return this.docs.submit(user.sub, docType, files?.front?.[0]?.buffer, files?.back?.[0]?.buffer);
  }
}
