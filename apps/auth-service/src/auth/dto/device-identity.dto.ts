import {IsOptional, IsString, MaxLength} from 'class-validator';

/**
 * B-794 — the optional, client-reported device identity carried on the two
 * session-creating bodies (verify + register-verify).
 *
 * Every field is optional: an older app build sends none of them, the
 * ops-console (`platform: 'web'`) has no hardware model, and iOS reports no
 * model without a native module. Absent stays absent — see the COALESCE in
 * AuthService.issueSession, which must never let a later refresh overwrite a
 * captured name with a null.
 *
 * These are cosmetic identification for support, never an authz input, so the
 * only validation that matters is a length cap (they land in a `text` column
 * and are rendered into the ops console).
 */
export class DeviceIdentityDto {
  @IsOptional() @IsString() @MaxLength(64) deviceModel?: string;
  @IsOptional() @IsString() @MaxLength(64) deviceBrand?: string;
  @IsOptional() @IsString() @MaxLength(64) osVersion?:   string;
  @IsOptional() @IsString() @MaxLength(32) appVersion?:  string;
}

/** The same four fields as the service passes them around. */
export interface DeviceIdentity {
  deviceModel?: string | null;
  deviceBrand?: string | null;
  osVersion?:   string | null;
  appVersion?:  string | null;
}

/**
 * Trim, drop empties, and hard-cap — the DTO validator covers the HTTP surface,
 * but issueSession is also reached from paths that never saw a DTO, so the
 * clamp lives next to the type rather than only at the edge.
 */
export function normalizeDeviceIdentity(raw: DeviceIdentity | undefined): {
  model: string | null; brand: string | null; os: string | null; app: string | null;
} {
  const clean = (v: unknown, max: number): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t === '' ? null : t.slice(0, max);
  };
  return {
    model: clean(raw?.deviceModel, 64),
    brand: clean(raw?.deviceBrand, 64),
    os:    clean(raw?.osVersion, 64),
    app:   clean(raw?.appVersion, 32),
  };
}
