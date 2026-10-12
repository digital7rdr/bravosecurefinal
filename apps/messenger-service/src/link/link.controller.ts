import {
  Controller, Post, Get, Delete, Body, Param, Query, UseGuards, HttpCode, HttpStatus, BadRequestException,
} from '@nestjs/common';
import {Throttle} from '@nestjs/throttler';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min,
} from 'class-validator';
import {Type} from 'class-transformer';
import {JwtAnyDeviceGuard} from '../common/guards/jwt-http.guard';
import type {CallerContext} from '../common/guards/jwt-http.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {CurrentCaller} from '../common/decorators/current-caller.decorator';
import {LinkService, type LinkRecord, type LinkSide} from './link.service';

const LINK_ID = /^[A-Za-z0-9_-]{22}$/;
/** One item: `lnk1.` + base64url(iv|ciphertext). 512 KB covers a chunk of history or a thumbnail. */
const ITEM_RE = /^lnk1\.[A-Za-z0-9_-]{16,700000}$/;
const MAX_ITEMS_BYTES = 6 * 1024 * 1024;

class StartLinkDto {
  @IsOptional() @IsString() @MaxLength(120)
  label?: string;
}

class ApproveLinkDto {
  @IsString() @Matches(LINK_ID)
  linkId!: string;
}

class SendLinkDto {
  @IsIn(['web', 'phone'])
  to!: LinkSide;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100)
  @IsString({each: true}) @Matches(ITEM_RE, {each: true})
  items!: string[];
}

class AckLinkDto {
  @IsIn(['web', 'phone'])
  side!: LinkSide;

  @Type(() => Number) @IsInt() @Min(0)
  upTo!: number;
}

function linkIdParam(id: string): string {
  if (!LINK_ID.test(id)) throw new BadRequestException('bad_link_id');
  return id;
}

/** What a client may see of a link: never the other side's install id. */
function view(r: LinkRecord, install: string) {
  return {
    linkId:     r.linkId,
    label:      r.label,
    wsDeviceId: r.wsDeviceId,
    approvedAt: r.approvedAt,
    lastSeenAt: r.lastSeenAt,
    role:       r.webInstall === install ? 'web' : r.phoneInstall === install ? 'phone' : 'other',
  };
}

/**
 * Linked devices (see link-policy.ts / link.service.ts).
 *
 *   POST   /link/start            browser  → {linkId, expiresAt}
 *   GET    /link/status/:id       browser  → pending | active(+wsDeviceId) | expired
 *   POST   /link/approve          phone    → link
 *   GET    /link/mine             either   → this account's links
 *   DELETE /link/:id              either   → unlink
 *   POST   /link/:id/send         either   → queue ciphertext for the other side
 *   GET    /link/:id/inbox        either   → own queue after `after`
 *   POST   /link/:id/ack          either   → drop own queue up to `upTo`
 */
@Controller('link')
@UseGuards(JwtAnyDeviceGuard, UserThrottlerGuard)
export class LinkController {
  constructor(private readonly links: LinkService) {}

  @Post('start')
  @Throttle({default: {limit: 10, ttl: 60_000}})
  start(@CurrentCaller() c: CallerContext, @Body() dto: StartLinkDto) {
    return this.links.start(c.claims.sub, c.claims.deviceId, dto.label ?? '');
  }

  @Get('status/:id')
  @Throttle({default: {limit: 120, ttl: 60_000}})
  status(@CurrentCaller() c: CallerContext, @Param('id') id: string) {
    return this.links.status(c.claims.sub, c.claims.deviceId, linkIdParam(id));
  }

  @Post('approve')
  @Throttle({default: {limit: 10, ttl: 60_000}})
  async approve(@CurrentCaller() c: CallerContext, @Body() dto: ApproveLinkDto) {
    // The approver must be a real (Signal) device — a linked browser cannot
    // link further browsers.
    if (c.signalDeviceId < 1 || c.signalDeviceId >= 100) throw new BadRequestException('approver_must_be_phone');
    const rec = await this.links.approve(c.claims.sub, c.claims.deviceId, dto.linkId);
    return view(rec, c.claims.deviceId);
  }

  @Get('mine')
  async mine(@CurrentCaller() c: CallerContext) {
    const rows = await this.links.list(c.claims.sub);
    return {links: rows.map(r => view(r, c.claims.deviceId))};
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(@CurrentCaller() c: CallerContext, @Param('id') id: string) {
    await this.links.revoke(c.claims.sub, linkIdParam(id));
  }

  @Post(':id/send')
  @Throttle({default: {limit: 300, ttl: 60_000}})
  send(@CurrentCaller() c: CallerContext, @Param('id') id: string, @Body() dto: SendLinkDto) {
    const total = dto.items.reduce((n, s) => n + s.length, 0);
    if (total > MAX_ITEMS_BYTES) throw new BadRequestException('batch_too_large');
    return this.links.send(c.claims.sub, c.claims.deviceId, linkIdParam(id), dto.to, dto.items);
  }

  @Get(':id/inbox')
  @Throttle({default: {limit: 300, ttl: 60_000}})
  inbox(
    @CurrentCaller() c: CallerContext,
    @Param('id') id: string,
    @Query('side') side: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ) {
    if (side !== 'web' && side !== 'phone') throw new BadRequestException('bad_side');
    const a = Number(after ?? 0);
    const l = Number(limit ?? 0);
    return this.links.inbox(
      c.claims.sub, c.claims.deviceId, linkIdParam(id), side,
      Number.isFinite(a) ? a : 0, Number.isFinite(l) ? l : 0,
    );
  }

  @Post(':id/ack')
  @HttpCode(HttpStatus.NO_CONTENT)
  async ack(@CurrentCaller() c: CallerContext, @Param('id') id: string, @Body() dto: AckLinkDto) {
    await this.links.ack(c.claims.sub, c.claims.deviceId, linkIdParam(id), dto.side, dto.upTo);
  }
}
