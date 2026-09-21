import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import {FileInterceptor} from '@nestjs/platform-express';
import {memoryStorage} from 'multer';
import {AttendancePhotoService} from './attendance-photo.service';
import type {Response} from 'express';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {DeptChatV2Guard} from '../common/guards/dept-chat-v2.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {OrgManagerGuard, type OrgManagerContext} from '../org/org-manager.guard';
import {CurrentOrgManager} from '../org/current-org-manager.decorator';
import {readOrgContextHeader} from '../org/org-context';
import {AttendanceService} from './attendance.service';

/** Just enough of the request to read a header from. */
type RawRequest = {headers?: Record<string, unknown>};
import {
  AnswerPingDto, AssignCposDto, ClockInDto, ClockOutDto, CreateShiftDto, DisputeSessionDto,
  PatchAssignmentsDto, EditShiftDto, ExportSessionsDto, RefusePingDto, ReviewSessionDto,
  SetDayStatusDto, UpdateShiftDto,
} from './dto/attendance.dto';

/**
 * Attendance — provider-managed CPO shift clock-in/out.
 *
 * Two trust scopes on one controller:
 *  - CPO self (JwtAuthGuard, scoped to user.sub): clock-in/out + own history.
 *  - Provider (OrgManagerGuard, scoped to manager.org_user_id): roster view +
 *    edit. OrgManagerGuard runs after JwtAuthGuard so req.user is populated.
 */
@Controller('attendance')
@UseGuards(JwtAuthGuard)
export class AttendanceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly photos: AttendancePhotoService,
  ) {}

  // ── 2026-09-05 — the check-in face photo ─────────────────────────────
  //
  // Member uploads ONE frame right after their own clock-in (owner + window +
  // once, enforced in the service); the responsible manager reads it back
  // through an audited route while the review is open; the bytes are wiped
  // once the review is decided and the shift has ended. Multipart in memory,
  // 2 MB cap, mime sniffed server-side.
  @Post('sessions/:id/photo')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('photo', {storage: memoryStorage(), limits: {fileSize: 2 * 1024 * 1024, files: 1}}))
  uploadPhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: {buffer?: Buffer} | undefined,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.photos.store(id, user.sub, file?.buffer ?? Buffer.alloc(0));
  }

  /** Manager view — JSON with a data URL so the app renders it with no second auth hop. */
  @Get('sessions/:id/photo')
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  async viewPhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentOrgManager() manager: OrgManagerContext,
    @Res({passthrough: true}) res: Response,
  ) {
    const photo = await this.photos.read(manager.org_user_id, manager.user_id, manager.department, id);
    res.setHeader('Cache-Control', 'no-store');
    return {
      mime: photo.mime,
      captured_at: photo.created_at,
      data_url: `data:${photo.mime};base64,${photo.bytes.toString('base64')}`,
    };
  }

  /** The people behind a Present / Late / Absent tile for a window. */
  @Get('org/day')
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  orgDay(
    @CurrentOrgManager() manager: OrgManagerContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
    @Query('department') department?: string,
  ) {
    return this.attendance.orgDay(manager.org_user_id, manager.department, {from, to, status, department});
  }

  /** One member's full attendance record with KPIs. */
  @Get('org/members/:cpoUserId/history')
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  memberHistory(
    @Param('cpoUserId', ParseUUIDPipe) cpoUserId: string,
    @CurrentOrgManager() manager: OrgManagerContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.attendance.memberHistory(manager.org_user_id, manager.department, cpoUserId, {from, to});
  }

  // ── CPO self ──────────────────────────────────────────────────────
  @Post('clock-in')
  @HttpCode(200)
  clockIn(@Body() dto: ClockInDto, @CurrentUser() user: AccessClaims, @Req() req: RawRequest) {
    return this.attendance.clockIn(user.sub, dto, readOrgContextHeader(req));
  }

  @Post('clock-out')
  @HttpCode(200)
  clockOut(@Body() dto: ClockOutDto, @CurrentUser() user: AccessClaims) {
    return this.attendance.clockOut(user.sub, dto);
  }

  @Get('me')
  myShifts(@CurrentUser() user: AccessClaims, @Req() req: RawRequest) {
    // B-611 — scope "my shifts" to the org being viewed (twin of B-610 incidents);
    // an absent header shows all the CPO's own shifts, never a partial list.
    return this.attendance.myShifts(user.sub, readOrgContextHeader(req));
  }

  // CPO self: dispute an own (closed/reviewed) record → back to the manager queue.
  @Post('sessions/:id/dispute')
  @HttpCode(200)
  @UseGuards(DeptChatV2Guard)
  disputeSession(
    @Param('id') id: string,
    @Body() dto: DisputeSessionDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return this.attendance.disputeSession(user.sub, id, dto.note);
  }

  // ── Provider (org-scoped) ─────────────────────────────────────────
  @Get('org/sessions')
  @UseGuards(OrgManagerGuard)
  orgShifts(
    @CurrentOrgManager() manager: OrgManagerContext,
    @Query('cpo_user_id') cpoUserId?: string,
  ) {
    // manager.department is the FORCED branch filter, same as pendingQueue —
    // this list is the Corrections picker, so it must offer only sessions the
    // correction verbs will accept.
    return this.attendance.orgShifts(manager.org_user_id, {cpoUserId}, manager.department);
  }

  @Patch('sessions/:id')
  @UseGuards(OrgManagerGuard)
  editShift(
    @Param('id') shiftId: string,
    @Body() dto: EditShiftDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.attendance.editShift(manager.org_user_id, manager.user_id, shiftId, {
      clock_in_at: dto.clock_in_at,
      clock_out_at: dto.clock_out_at,
      edit_reason: dto.edit_reason,
    }, manager.department); // AUTHZ-3 — branch scope
  }

  // ── Dept Chat v2 · shifts (flag-gated; legacy routes above unchanged) ──
  //
  // DeptChatV2Guard runs first → 404 when the flag is off, so these routes are
  // invisible until rollout. The real auth guards (JwtAuthGuard at the class
  // level, OrgManagerGuard here) still apply — the flag never replaces a guard.

  @Post('shifts')
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  createShift(
    @Body() dto: CreateShiftDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.attendance.createShift(manager.org_user_id, manager.user_id, dto, manager.department);
  }

  @Post('shifts/:id/assignments')
  @HttpCode(200)
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  assignCpos(
    @Param('id') shiftId: string,
    @Body() dto: AssignCposDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.attendance.assignCpos(manager.org_user_id, shiftId, dto.cpo_user_ids, manager.user_id, manager.department);
  }

  /** B-855 — the shift DETAIL: every assignee with their photo, call sign,
   *  department, how they are doing on THIS shift, and their latest ping.
   *  Still the edit-mode prefill's source — the envelope key and both original
   *  fields are unchanged. */
  @Get('shifts/:id/assignments')
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  listAssignments(
    // ParseUUIDPipe on the two routes this batch owns: a malformed id reaches
    // `WHERE id = $1` on a uuid column and raises 22P02 — an uncaught 500 that
    // anyone holding a manager token can trigger. 400 is the honest answer.
    @Param('id', ParseUUIDPipe) shiftId: string,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.attendance.listAssignments(manager.org_user_id, shiftId, manager.department);
  }

  /** B-859 — ask ONE assigned, clocked-in worker where they are. Manager-gated
   *  exactly like listAssignments above. The `{ping}` envelope matches the
   *  projection's `last_ping` slot, so the sheet can drop the answer straight
   *  in without a second shape to learn. */
  @Post('shifts/:id/assignments/:cpoUserId/ping')
  @HttpCode(200)
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  async pingAssignee(
    @Param('id', ParseUUIDPipe) shiftId: string,
    @Param('cpoUserId', ParseUUIDPipe) cpoUserId: string,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return {ping: await this.attendance.requestPing(
      manager.org_user_id, shiftId, cpoUserId, manager.user_id, manager.department)};
  }

  /** G-ab — diff the assignment set (the un-assign that never existed:
   *  assignCpos is insert-only, so a mis-assignment was permanent). The
   *  branch scope rides the argument, never the body (F HIGH-1 lesson). */
  @Patch('shifts/:id/assignments')
  @HttpCode(200)
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  patchAssignments(
    @Param('id') shiftId: string,
    @Body() dto: PatchAssignmentsDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.attendance.patchAssignments(manager.org_user_id, shiftId,
      {add: dto.add, remove: dto.remove, assign_department: dto.assign_department},
      manager.user_id, manager.department);
  }

  @Patch('shifts/:id')
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  updateShift(
    @Param('id') shiftId: string,
    @Body() dto: UpdateShiftDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.attendance.updateShift(manager.org_user_id, manager.user_id, shiftId, dto, manager.department);
  }

  @Delete('shifts/:id')
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  archiveShift(
    @Param('id') shiftId: string,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    return this.attendance.archiveShift(manager.org_user_id, manager.user_id, shiftId, manager.department);
  }

  @Get('shifts')
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  listShifts(@CurrentOrgManager() manager: OrgManagerContext) {
    return this.attendance.listOrgShifts(manager.org_user_id, undefined, manager.department);
  }

  // CPO self: "today's assigned shift" (or null → UI blocks check-in).
  //
  // B-856 — "if a member belongs to 2 workspaces his attendance should be shown
  // in their individual channel". GET /attendance/me already honoured the
  // header (B-611); this route did not, so inside workspace A the check-in card
  // could name workspace B's shift. The header NARROWS a list of shifts the CPO
  // is already ASSIGNED to, so it can only ever return fewer of their own rows —
  // which is why this needs no pickOrgContext. Absent header (an old APK, or
  // the officer shell, which passes {crossOrg: true} on purpose) → the
  // unchanged cross-org answer: a sticky context must never strand a check-in.
  @Get('my-shift/today')
  @UseGuards(DeptChatV2Guard)
  myTodayShift(@CurrentUser() user: AccessClaims, @Req() req: RawRequest) {
    return this.attendance.myTodayShift(user.sub, readOrgContextHeader(req) ?? undefined);
  }

  // ── B-859 · the worker's side of a ping (JWT, own rows only) ──────────

  /** Answer with ONE fix. The server re-checks the open session and records a
   *  refusal instead when the worker has clocked out — the coordinates in this
   *  body are then dropped, never stored.
   *
   *  S1 — this handler ENUMERATES what it forwards, so a field added to the
   *  DTO and nowhere else is silently dropped at the door. `mocked` is the
   *  device's own mock-location verdict and is the difference between a pin a
   *  manager can act on and one they cannot. */
  @Post('pings/:id/answer')
  @HttpCode(200)
  @UseGuards(DeptChatV2Guard)
  async answerPing(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnswerPingDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return {ping: await this.attendance.answerPing(user.sub, id, {
      lat: dto.lat, lng: dto.lng, accuracy_m: dto.accuracy_m, mocked: dto.mocked,
    })};
  }

  /** The device declines (no permission, no fix, or the worker said no). */
  @Post('pings/:id/refuse')
  @HttpCode(200)
  @UseGuards(DeptChatV2Guard)
  async refusePing(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RefusePingDto,
    @CurrentUser() user: AccessClaims,
  ) {
    return {ping: await this.attendance.refusePing(user.sub, id, dto.reason)};
  }

  /** A7 — the worker's OWN trace of who asked for their location and when.
   *  org_audit_log is manager-readable only; without this, a location capture
   *  is something that happens to a person with no way for them to see it.
   *
   *  S2 — header-scoped like my-shift/today above. B-856 scoped the
   *  Departmental shell to ONE workspace, and this route stayed blind: inside
   *  Acme, a member of Acme and Meridian read Meridian's managers asking
   *  Meridian questions. The header NARROWS a list of the caller's OWN rows,
   *  so it needs no pickOrgContext — and an absent one (an old APK, or the
   *  officer shell, which passes {crossOrg: true} on purpose) keeps the
   *  unchanged cross-org answer: a sticky context must never blank the trace
   *  of having been asked. */
  @Get('pings/mine')
  @UseGuards(DeptChatV2Guard)
  myPings(@CurrentUser() user: AccessClaims, @Req() req: RawRequest) {
    return this.attendance.myPings(user.sub, readOrgContextHeader(req));
  }

  // ── Dept Chat v2 · review workflow + admin view + export (Steps 6,7) ──

  @Patch('sessions/:id/review')
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  async reviewSession(
    @Param('id') id: string,
    @Body() dto: ReviewSessionDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    const out = await this.attendance.reviewSession(manager.org_user_id, manager.user_id, id, dto.decision, dto.notes, manager.department); // AUTHZ-3 — branch scope
    // 2026-09-05 — "when approved and shift done, image will delete": the
    // decision is the first half; the purge checks the shift half itself and
    // the sweep catches whatever this misses. Never fails the review.
    void this.photos.purgeIfDue(id).catch(() => undefined);
    return out;
  }

  @Post('day-status')
  @HttpCode(200)
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  setDayStatus(
    @Body() dto: SetDayStatusDto,
    @CurrentOrgManager() manager: OrgManagerContext,
  ) {
    // The FORCED branch filter, same as every scoped handler below: a
    // delegated manager writes only their own branch (F review HIGH-1). The
    // force applies ONLY when the caller chose department MODE — forcing it
    // unconditionally populated a second targeting mode on every scoped
    // call and 400'd the whole feature for scoped managers (HIGH-A). The
    // member_ids/legacy paths are branch-constrained by the 4th argument
    // instead, inside the membership query.
    return this.attendance.setDayStatus(manager.org_user_id, manager.user_id, {
      cpoUserId: dto.cpo_user_id, memberIds: dto.member_ids,
      department: dto.department != null ? (manager.department ?? dto.department) : undefined,
      status: dto.status, date: dto.date, dates: dto.dates, notes: dto.notes,
    }, manager.department);
  }

  // Department scoping (PDF p.9/p.16): a department-scoped manager's view is
  // FORCED to their department — a requested filter can only narrow within it.
  @Get('org/summary')
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  orgSummary(
    @CurrentOrgManager() manager: OrgManagerContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cpo_user_id') cpoUserId?: string,
    @Query('department') department?: string,
    @Query('shift_id') shiftId?: string,
  ) {
    return this.attendance.orgSummary(manager.org_user_id, {
      from, to, cpoUserId, shiftId,
      department: manager.department ?? department,
    });
  }

  @Get('org/pending')
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  pendingQueue(
    @CurrentOrgManager() manager: OrgManagerContext,
    @Query('department') department?: string,
  ) {
    return this.attendance.pendingQueue(manager.org_user_id, {
      department: manager.department ?? department,
    });
  }

  @Post('org/export')
  @HttpCode(200)
  @UseGuards(DeptChatV2Guard, OrgManagerGuard)
  async exportSessions(
    @Body() dto: ExportSessionsDto,
    @CurrentOrgManager() manager: OrgManagerContext,
    @Res({passthrough: true}) res: Response,
  ): Promise<string> {
    const out = await this.attendance.exportSessions(manager.org_user_id, manager.user_id, {
      from: dto.from, to: dto.to, cpoUserId: dto.cpo_user_id, shiftId: dto.shift_id,
      department: manager.department ?? dto.department,
    });
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    return out.body;
  }
}
