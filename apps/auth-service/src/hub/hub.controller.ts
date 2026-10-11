import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException,
  Post, Req, Res, UseGuards,
} from '@nestjs/common';
import type {Request, Response} from 'express';
import {Throttle} from '@nestjs/throttler';
import {
  IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength,
} from 'class-validator';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import {clientIp} from '../common/http/client-ip';
import {HUB_SESSION_COOKIES, sessionCookiesFor} from '../common/http/session-cookies';
import {setSessionCookies} from '../auth/auth.controller';
import {AuthService} from '../auth/auth.service';
import {JwtService, type AccessClaims} from '../auth/jwt.service';
import {AuditService} from '../kafka/audit.service';
import {DatabaseService} from '../database/database.service';
import {TotpChallengeService} from '../common/services/totp-challenge.service';
import {HubService} from './hub.service';
import {SignupService} from './signup.service';
import {PasswordResetService} from './password-reset.service';

const refreshTtlSec = (jwt: JwtService) => jwt.ttlToSeconds(process.env.JWT_REFRESH_TTL ?? '30d');

/* ── DTOs ─────────────────────────────────────────────────────────────── */

class SignupStartDto {
  @IsString() @MinLength(2) @MaxLength(120) displayName!: string;
  @IsEmail() @MaxLength(254) email!: string;
  @Matches(/^\+\d{7,15}$/, {message: 'phone must be E.164, e.g. +971501234567'}) phoneE164!: string;
  @IsString() @MinLength(10) @MaxLength(128) password!: string;
  @IsIn([true], {message: 'terms must be accepted'}) acceptTerms!: boolean;
}

class SignupResendDto {
  @IsString() @MaxLength(64) signupId!: string;
  @IsIn(['phone', 'email']) channel!: 'phone' | 'email';
}

class SignupCompleteDto {
  @IsString() @MaxLength(64) signupId!: string;
  @IsOptional() @Matches(/^\d{4,8}$/) phoneCode?: string;
  @IsOptional() @Matches(/^\d{4,8}$/) emailCode?: string;
  @IsString() @MinLength(1) @MaxLength(128) deviceId!: string;
}

class LaunchDto {
  @Matches(/^[a-z][a-z0-9_]{1,39}$/) app!: string;
}

class ExchangeDto {
  @Matches(/^[A-Za-z0-9_-]{40,64}$/) code!: string;
  @IsString() @MinLength(1) @MaxLength(128) deviceId!: string;
}

class TotpConfirmDto {
  @Matches(/^[A-Za-z0-9]{6,10}$/) code!: string;
}

class ResetStartDto {
  @IsString() @MinLength(5) @MaxLength(254) identifier!: string;
}

class ResetCompleteDto {
  @IsString() @MaxLength(64) resetId!: string;
  @Matches(/^\d{4,8}$/) code!: string;
  @IsString() @MinLength(10) @MaxLength(128) newPassword!: string;
  @IsOptional() @Matches(/^[A-Za-z0-9 -]{6,12}$/) totpCode?: string;
}

/* ── Registration (home site) ─────────────────────────────────────────── */

@Controller('auth/signup')
export class SignupController {
  constructor(
    private readonly signup: SignupService,
    private readonly auth: AuthService,
    private readonly jwt: JwtService,
  ) {}

  /** Whether the home site should offer registration at all. */
  @Get('status')
  status() {
    return {available: this.signup.available()};
  }

  @Throttle({default: {limit: 5, ttl: 600_000}})
  @Post('start')
  @HttpCode(200)
  start(@Body() dto: SignupStartDto, @Req() req: Request) {
    return this.signup.start(dto, clientIp(req));
  }

  @Throttle({default: {limit: 6, ttl: 600_000}})
  @Post('resend')
  @HttpCode(200)
  resend(@Body() dto: SignupResendDto) {
    return this.signup.resend(dto.signupId, dto.channel);
  }

  @Throttle({default: {limit: 15, ttl: 600_000}})
  @Post('complete')
  @HttpCode(200)
  async complete(@Body() dto: SignupCompleteDto, @Req() req: Request, @Res({passthrough: true}) res: Response) {
    const out = await this.signup.complete(dto.signupId, {phoneCode: dto.phoneCode, emailCode: dto.emailCode}, clientIp(req));
    if (!out.done) return out;
    const names = sessionCookiesFor(req);
    if (names.console !== 'hub') {
      // The account exists; only the home site gets a session out of this call.
      return {done: true, signedIn: false};
    }
    const s = await this.auth.issueSession(out.user, dto.deviceId, 'web', false);
    setSessionCookies(res, names, s.accessToken, s.expiresIn, s.refreshToken, refreshTtlSec(this.jwt));
    return {done: true, signedIn: true, expiresIn: s.expiresIn};
  }
}

/* ── Forgot password (home site, 2026-10-11) ─────────────────────────── */

@Controller('auth/password/reset')
export class PasswordResetController {
  constructor(private readonly reset: PasswordResetService) {}

  @Get('status')
  status() {
    return {available: this.reset.available()};
  }

  @Throttle({default: {limit: 5, ttl: 600_000}})
  @Post('start')
  @HttpCode(200)
  start(@Body() dto: ResetStartDto, @Req() req: Request) {
    return this.reset.start(dto.identifier, clientIp(req));
  }

  @Throttle({default: {limit: 12, ttl: 600_000}})
  @Post('complete')
  @HttpCode(200)
  complete(@Body() dto: ResetCompleteDto, @Req() req: Request) {
    return this.reset.complete(dto.resetId, {code: dto.code, newPassword: dto.newPassword, totpCode: dto.totpCode}, clientIp(req));
  }
}

/* ── Launcher + authenticator (home site session) ─────────────────────── */

@Controller('hub')
@UseGuards(JwtAuthGuard)
export class HubController {
  constructor(
    private readonly hub: HubService,
    private readonly totp: TotpChallengeService,
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  @Get('apps')
  async apps(@CurrentUser() user: AccessClaims) {
    const [tiles, me] = await Promise.all([
      this.hub.tiles(user.sub),
      this.db.qOne<{display_name: string | null; email_verified_at: string | null; phone_verified_at: string | null}>(
        `SELECT display_name, email_verified_at, phone_verified_at FROM public.users WHERE id=$1`, [user.sub]),
    ]);
    return {
      user: {id: user.sub, display_name: me?.display_name ?? null,
        email_verified: !!me?.email_verified_at, phone_verified: !!me?.phone_verified_at},
      ...tiles,
    };
  }

  /**
   * Open an app: only from the home site's own cookie session, so a phone's
   * Bearer token can never be turned into a browser session here.
   */
  @Throttle({default: {limit: 30, ttl: 60_000}})
  @Post('launch')
  @HttpCode(200)
  async launch(@CurrentUser() user: AccessClaims, @Body() dto: LaunchDto, @Req() req: Request & {cookies?: Record<string, string>}) {
    if (sessionCookiesFor(req).console !== 'hub' || !req.cookies?.[HUB_SESSION_COOKIES.token]) {
      throw new ForbiddenException('launch_requires_home_session');
    }
    const out = await this.hub.launch(user.sub, dto.app);
    await this.audit.emit({event_type: 'auth.sso.launch', user_id: user.sub, device_id: user.deviceId, ip: clientIp(req), outcome: 'success', detail: dto.app});
    return out;
  }

  /** Optional authenticator, started from the home site after registration. */
  @Post('security/totp/start')
  @HttpCode(200)
  async totpStart(@CurrentUser() user: AccessClaims, @Req() req: Request) {
    if ((await this.totp.status(user.sub)) === 'verified') throw new ConflictException('totp_already_on');
    const u = await this.db.qOne<{email: string | null; phone_e164: string | null}>(
      `SELECT email, phone_e164 FROM public.users WHERE id=$1 AND deleted_at IS NULL AND suspended_at IS NULL`, [user.sub]);
    if (!u) throw new NotFoundException('user_not_found');
    return this.totp.enrol(user.sub, u.email ?? u.phone_e164 ?? user.sub, user.deviceId, clientIp(req));
  }

  @Throttle({default: {limit: 10, ttl: 600_000}})
  @Post('security/totp/confirm')
  @HttpCode(200)
  async totpConfirm(@CurrentUser() user: AccessClaims, @Body() dto: TotpConfirmDto, @Req() req: Request) {
    // Load the account first: check() stamps verified_at (see its contract).
    const u = await this.db.qOne<{id: string}>(
      `SELECT id FROM public.users WHERE id=$1 AND deleted_at IS NULL AND suspended_at IS NULL`, [user.sub]);
    if (!u) throw new NotFoundException('user_not_found');
    if ((await this.totp.status(user.sub)) === 'none') throw new BadRequestException('totp_not_started');
    await this.totp.check(user.sub, dto.code, user.deviceId, clientIp(req));
    return {ok: true};
  }
}

/* ── Single sign-on hand-off, called by each app's /sso page ──────────── */

@Controller('auth/sso')
export class SsoController {
  constructor(
    private readonly hub: HubService,
    private readonly auth: AuthService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  @Throttle({default: {limit: 30, ttl: 60_000}})
  @Post('exchange')
  @HttpCode(200)
  async exchange(@Body() dto: ExchangeDto, @Req() req: Request, @Res({passthrough: true}) res: Response) {
    const raw = req.headers?.['origin'];
    const origin = typeof raw === 'string' ? raw : null;
    const names = sessionCookiesFor(req);
    if (names.console === 'hub') throw new ForbiddenException('sso_origin_invalid');
    try {
      const {user, app} = await this.hub.exchange(dto.code, origin);
      const s = await this.auth.issueSession(user, dto.deviceId, 'web', false);
      setSessionCookies(res, names, s.accessToken, s.expiresIn, s.refreshToken, refreshTtlSec(this.jwt));
      await this.audit.emit({event_type: 'auth.sso.exchange', user_id: user.id, device_id: dto.deviceId, ip: clientIp(req), outcome: 'success', detail: app});
      return {expiresIn: s.expiresIn, app};
    } catch (e) {
      await this.audit.emit({event_type: 'auth.sso.exchange', user_id: null, device_id: dto.deviceId, ip: clientIp(req), outcome: 'failure', detail: (e as Error).message});
      throw e;
    }
  }
}
