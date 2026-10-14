import {
  Body, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Req, Res, UploadedFile,
  UseGuards, UseInterceptors,
} from '@nestjs/common';
import {FileInterceptor} from '@nestjs/platform-express';
import {memoryStorage} from 'multer';
import type {Request, Response} from 'express';
import {Throttle} from '@nestjs/throttler';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {AdminGuard, RequireRoles, type AdminContext} from './admin.guard';
import {OPS_THROTTLE} from './ops-throttle';
import {OpsAuditService} from './ops-audit.service';
import {MAX_DOCUMENT_BYTES, OpsDocumentsService, type UploadedDoc} from './ops-documents.service';

type OpsReq = Request & {admin: AdminContext};

const upload = FileInterceptor('file', {storage: memoryStorage(), limits: {fileSize: MAX_DOCUMENT_BYTES, files: 1}});

/**
 * Bravo controlled-document library (ISO 9001:2015 naming, 2026-10-15).
 *
 * Every console admin can read and download (shared 'any' domain — these are
 * Bravo's own policies, procedures and forms). Adding documents and versions,
 * renaming and withdrawing need SUPERVISOR rank or above, and each lands in
 * ops_audit. Nothing is ever deleted.
 */
@Controller('ops/documents')
@Throttle(OPS_THROTTLE)
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard, UserThrottlerGuard)
export class OpsDocumentsController {
  constructor(
    private readonly docs: OpsDocumentsService,
    private readonly audit: OpsAuditService,
  ) {}

  @Get()
  list() {
    return this.docs.list();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.docs.get(id);
  }

  @Get(':id/download')
  async downloadCurrent(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq, @Res() res: Response) {
    return this.send(res, req, await this.docs.file(id), id);
  }

  @Get(':id/versions/:version/download')
  async downloadVersion(
    @Param('id', ParseUUIDPipe) id: string, @Param('version', ParseIntPipe) version: number,
    @Req() req: OpsReq, @Res() res: Response,
  ) {
    return this.send(res, req, await this.docs.file(id, version), id);
  }

  private async send(res: Response, req: OpsReq, f: {name: string; mime: string; content: Buffer; number: string; version: number}, id: string) {
    await this.audit.recordAdmin(req.admin, 'document.download', 'system', id, {number: f.number, version: f.version});
    res.setHeader('Content-Type', f.mime);
    // Always a download, never rendered inline in the console's origin.
    res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.send(f.content);
  }

  @Post()
  @RequireRoles('SUPERVISOR', 'ADMIN')
  @UseInterceptors(upload)
  async create(
    @Body() body: {department_code?: string; category?: string; title?: string; change_note?: string},
    @UploadedFile() file: UploadedDoc | undefined, @Req() req: OpsReq,
  ) {
    const out = await this.docs.create(req.admin.user_id, body, file);
    await this.audit.recordAdmin(req.admin, 'document.create', 'system', out.id, {number: out.number, file_name: out.file_name});
    return out;
  }

  @Post(':id/versions')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  @UseInterceptors(upload)
  async addVersion(
    @Param('id', ParseUUIDPipe) id: string, @Body() body: {change_note?: string},
    @UploadedFile() file: UploadedDoc | undefined, @Req() req: OpsReq,
  ) {
    const out = await this.docs.addVersion(req.admin.user_id, id, body, file);
    await this.audit.recordAdmin(req.admin, 'document.version', 'system', id, {number: out.number, version: out.version});
    return out;
  }

  @Patch(':id')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async update(
    @Param('id', ParseUUIDPipe) id: string, @Body() body: {title?: string; status?: string}, @Req() req: OpsReq,
  ) {
    const out = await this.docs.update(req.admin.user_id, id, body);
    await this.audit.recordAdmin(req.admin, 'document.update', 'system', id, {
      number: out.document.number, renamed: body.title !== undefined, status: body.status ?? null,
    });
    return out;
  }
}
