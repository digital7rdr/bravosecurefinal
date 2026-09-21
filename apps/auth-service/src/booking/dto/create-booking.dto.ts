import {IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Matches, MaxLength, Max, Min} from 'class-validator';

/**
 * B-876 — the ONE ceiling on a booking's team units (CPOs and vehicles).
 *
 * Founder, 2026-09-14 ("The limit is still here"): this is a SANITY bound
 * against garbage input, NOT a product limit. The rule is "no boundary on
 * booking" (B-864) — any team beyond the baseline (1 CPO + 1 Vehicle) is
 * reviewed by the Bravo Control System before it is approved and dispatched,
 * which is where the real judgement happens. It used to be 4, which is what
 * drew a live `+` button that silently did nothing (the B-590 class).
 *
 * Single literal on purpose: it is imported by `booking.service.ts`
 * (`MAX_CPOS` and the executive vehicle clamp) and by `org/dto/org.dto.ts`
 * (`AssignCrewDto`), so a team the DTO admits can always be CREWED by the
 * agency. Mirrored client-side in `src/screens/booking/pricing.ts`
 * (`MAX_CPOS` / `MAX_VEHICLES`) and pinned by a client↔server drift test.
 *
 * A plain exported `const`, never config: decorators need a compile-time value.
 */
export const TEAM_UNIT_MAX = 50;

/** Legacy-compatible location payload. */
export class LocationDto {
  @IsNumber() latitude!: number;
  @IsNumber() longitude!: number;
  // E-12 — addresses are third-party geocoder strings of unpredictable length, so
  // they are TRUNCATED at persist time (booking.service), never rejected: a 400
  // here would block a paid booking over cosmetic payload size.
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() label?: string;
}

/**
 * Executive Protection — optional secure-transfer leg. Declared for typing; the nested
 * shape is validated MANUALLY in booking.service (repo pattern: the pipe does
 * not run nested validators — same as `pickup`).
 */
export class ExecTransportDto {
  mode!: 'one_way' | 'return' | 'both_ways';
  pickup!: LocationDto;
  dropoff!: LocationDto;
  /** ISO time of the transfer pickup; omitted = same as the booking start. */
  pickup_time?: string;
  passengers?: number;
}

/** POST /bookings — create a new Lite booking (DRAFT → PENDING_OPS in one call). */
export class CreateBookingDto {
  @IsIn(['transfer', 'timeslot', 'itinerary'])
  type!: 'transfer' | 'timeslot' | 'itinerary';

  @IsNotEmpty() pickup!: LocationDto;

  @IsOptional() dropoff?: LocationDto;

  @IsString() @IsNotEmpty()
  start_time!: string;

  @IsOptional() @IsInt() @Min(1) @Max(24)
  duration_hours?: number;

  @IsArray() @IsString({each: true})
  add_ons!: string[];

  @IsIn(['card', 'bravo_credits', 'corporate'])
  payment_method!: 'card' | 'bravo_credits' | 'corporate';

  @IsString() @IsNotEmpty()
  region!: string;

  // E-12 — the exec wizard caps at 500; the server previously accepted unbounded
  // bytes (payload bloat + unbounded CPO-brief render). 2000 leaves legacy room.
  @IsOptional() @IsString() @MaxLength(2000)
  notes?: string;

  /**
   * Issue 28 — optional preferred-provider / partner / referral code.
   * ATTRIBUTION ONLY: it is validated and recorded, and is never read by the
   * dispatch ranker, the offer cascade or escrow. Charset is constrained so a
   * code can never carry anything but an identifier.
   */
  @IsOptional() @IsString() @MaxLength(32)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9-]*$/, {message: 'referral_code_invalid_format'})
  referral_code?: string;

  // ─── Lite wizard extras (new flow) ───────────────────────────────
  @IsOptional() @IsString() @MaxLength(120)
  region_label?: string;

  @IsOptional() @IsIn(['secure_transfer', 'executive_protection', 'recon_team', 'emergency_extraction'])
  service?: string;

  @IsOptional() @IsIn(['now', 'later'])
  booking_mode?: 'now' | 'later';

  // ─── Executive Protection (service 'executive_protection') ────────────────
  /** What the protection detail is for; validated against the executive task
   *  list in booking.service when service === 'executive_protection'. */
  @IsOptional() @IsString() @MaxLength(40)
  task_type?: string;

  /** Optional secure-transfer leg — shape validated in booking.service. */
  @IsOptional()
  exec_transport?: ExecTransportDto;

  @IsOptional() @IsInt() @Min(1) @Max(16)
  passengers?: number;

  @IsOptional() @IsInt() @Min(1) @Max(TEAM_UNIT_MAX)
  cpo_count?: number;

  @IsOptional() @IsInt() @Min(0) @Max(TEAM_UNIT_MAX)
  vehicle_count?: number;

  @IsOptional() @IsBoolean()
  driver_only?: boolean;

  // ─── Step 22 lawful-basis consent ────────────────────────────────
  // Auto-dispatch shares the client's precise pickup + live location with a
  // third-party agency, so the auto path (POST /dispatch/request) requires
  // explicit, versioned location + terms consent. Optional on the DTO so the
  // legacy ops-mediated path stays byte-for-byte unchanged; the server gates.
  @IsOptional() @IsBoolean()
  location_consent?: boolean;

  @IsOptional() @IsBoolean()
  terms_accepted?: boolean;

  @IsOptional() @IsString()
  location_consent_version?: string;

  @IsOptional() @IsString()
  terms_accepted_version?: string;

  /**
   * B-843 — WHICH root pays for this booking. A member may belong to several,
   * so the app asks and sends the chosen root's user id (or the client's own id
   * for "my wallet").
   *
   * This value is a CHOICE, never an instruction. `create()` never stamps it:
   * it is passed to `FamilyService.resolvePayer(clientId, …)`, which refuses
   * (`PAYER_NOT_ELIGIBLE`) anything that is not one of the caller's own live,
   * non-held memberships, and the RESOLVED payer is what lands on the row. Ops
   * views, refunds and history all read `payer_user_id` as truth.
   *
   * Snake-case matches every sibling on this DTO: `whitelist: true` silently
   * STRIPS a mis-cased key, and a stripped payer would charge the default one.
   */
  @IsOptional() @IsUUID()
  payer_user_id?: string;
}

/** POST /bookings/estimate — price preview (no persistence). */
export class EstimateBookingDto {
  @IsIn(['transfer', 'timeslot', 'itinerary'])
  type!: 'transfer' | 'timeslot' | 'itinerary';

  /** 'executive_protection' switches the estimate to the per-unit fixed-block
   *  formula (and the fixed executive add-on catalogue). */
  @IsOptional() @IsIn(['secure_transfer', 'executive_protection', 'recon_team', 'emergency_extraction'])
  service?: string;

  @IsOptional() @IsInt() @Min(1) @Max(24)
  duration_hours?: number;

  @IsArray() @IsString({each: true})
  add_ons!: string[];

  @IsString() @IsNotEmpty()
  region!: string;

  @IsOptional() @IsInt() @Min(1) @Max(TEAM_UNIT_MAX)
  cpo_count?: number;

  @IsOptional() @IsInt() @Min(0) @Max(TEAM_UNIT_MAX)
  vehicle_count?: number;

  @IsOptional() @IsBoolean()
  driver_only?: boolean;

  /** Drives the driver-only seat cap so the preview clamps exactly like create(). */
  @IsOptional() @IsInt() @Min(1) @Max(16)
  passengers?: number;

  /**
   * Referral / discount campaign code (2026-09-05). The estimate QUOTES it —
   * applied or refused with a reason — so the client sees the discounted total
   * before submitting; create() applies the same decision. Same charset as the
   * create-side field so a quoted code is always submittable.
   */
  @IsOptional() @IsString() @MaxLength(32)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9-]*$/, {message: 'referral_code_invalid_format'})
  referral_code?: string;

  @IsOptional() @IsString()
  pickup_time?: string;

  /**
   * Pickup coordinates, 2026-09-01 — the estimate's PRICING REGION is derived
   * from these, exactly as create() derives it, so a preview cannot quote one
   * region's rate for a booking that will be charged at another's.
   *
   * Optional because an early preview may not have a pickup yet; without it the
   * estimate resolves GLOBAL, which is the same fallback create() uses and is
   * never cheaper than a region rate. `region` above is NOT used for pricing —
   * it is client-supplied and drives dispatch matching only.
   */
  // Declared, not nested-validated — the repo pattern for LocationDto (the pipe
  // does not run nested validators; see `pickup` on CreateBookingDto). Safe here
  // because regionFromPoint() refuses absent, NaN and Infinite coordinates and
  // falls back to GLOBAL pricing rather than matching a box on garbage.
  @IsOptional()
  pickup?: LocationDto;

  /**
   * E2E-47 (2026-09-03) — estimate/create parity for the two Executive
   * Protection transfer rules. `create()` REJECTS
   * `exec_transport_required` (vehicles or driver-only with no transfer leg,
   * `booking.service.ts`) and `exec_vehicle_required` (a transfer leg with
   * nothing to drive it); the estimate mirrored neither, so a direct API caller
   * could be quoted a booking `create()` refuses.
   *
   * DECLARED-STATE semantics, deliberately three-valued, because the shipped
   * client sends `vehicle_count` on an EP estimate but no transport field at
   * all — enforcing "absent means no leg" would 400 the live price preview of
   * every EP booking WITH a transfer leg on every installed build:
   *
   *   omitted        → legacy caller, neither rule is applied (today's behaviour)
   *   an object      → a leg is declared ⇒ `exec_vehicle_required` is enforced
   *   explicit null  → NO leg is declared ⇒ `exec_transport_required` is enforced
   *
   * Only PRESENCE is read here — the leg's own shape is validated by `create()`
   * (repo pattern: the pipe does not run nested validators), and a quote never
   * prices the transfer leg itself, so a malformed object cannot mis-price.
   */
  @IsOptional()
  exec_transport?: ExecTransportDto | null;
}
