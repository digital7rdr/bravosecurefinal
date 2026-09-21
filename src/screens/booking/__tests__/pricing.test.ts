import fs from 'fs';
import path from 'path';
import {
  BASE_RATE_BC,
  rateBcPerHour,
  vehiclesForPassengers,
  PASSENGERS_PER_VEHICLE,
  MAX_CPOS,
  MAX_VEHICLES,
} from '../pricing';

describe('vehiclesForPassengers', () => {
  it('needs 1 vehicle for 1–3 passengers', () => {
    expect(vehiclesForPassengers(1)).toBe(1);
    expect(vehiclesForPassengers(3)).toBe(1);
  });

  it('needs 2 vehicles once passengers exceed 3', () => {
    expect(vehiclesForPassengers(4)).toBe(2);
    expect(vehiclesForPassengers(6)).toBe(2);
  });

  it('adds a vehicle per 3 passengers thereafter', () => {
    expect(vehiclesForPassengers(7)).toBe(3);
    expect(vehiclesForPassengers(9)).toBe(3);
  });

  it('never returns fewer than 1 (baseline includes a vehicle)', () => {
    expect(vehiclesForPassengers(0)).toBe(1);
    expect(vehiclesForPassengers(-2)).toBe(1);
  });

  it('uses the documented 3-pax-per-vehicle constant', () => {
    expect(PASSENGERS_PER_VEHICLE).toBe(3);
  });
});

describe('B-864 — the CPO count is NOT bounded by the client vehicle', () => {
  // Founder, 2026-09-12: "cpo now increase as per vehicle, no it should not
  // boundry on booking", then "No vehicle but pricing should update".
  //
  // The driver-only seat cap (4 - passengers) used to kill the + button at ONE
  // CPO for a party of four, and create() silently repriced a bigger Lite team
  // down to what fit. Both are gone. Bravo still assigns no vehicle in
  // driver-only mode; what moves instead is the PRICE, which already charges
  // 25% of base per CPO past the first.
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
  const stripComments = (src: string) =>
    src.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');

  it('the seat-cap helper and its seat constant are gone from pricing.ts', () => {
    // Anchored on the EXPORT sites, not on the token: the block comment that
    // records WHY they went still names both, and a bare token scan would read
    // that prose as code (the repo's most expensive false positive).
    const src = read('../pricing.ts');
    expect(src).not.toMatch(/export function maxCposForClientVehicle/);
    expect(src).not.toMatch(/export const SEATS_PER_VEHICLE_EX_DRIVER/);
  });

  it('no booking or executive screen still caps CPOs by the client car', () => {
    for (const f of [
      '../CustomizeAddOnsScreen.tsx',
      '../../executive/ExecTeamScreen.tsx',
      '../../executive/ExecReviewScreen.tsx',
      '../../executive/ExecTransportScreen.tsx',
    ]) {
      expect(read(f)).not.toMatch(/maxCposForClientVehicle/);
    }
  });

  it('the booking screen ceiling is MAX_CPOS, with no passenger input', () => {
    expect(stripComments(read('../CustomizeAddOnsScreen.tsx')))
      .toMatch(/const maxCpos = MAX_CPOS;/);
  });

  /**
   * B-876 (founder 2026-09-14: "The limit is still here") — RE-POINTED from 4.
   *
   * The founder's rule is "no boundary on booking" (B-864, restated), and 4 was
   * still a boundary: the CPO + died at 4 and the Vehicle + was drawn LIVE at 4
   * and silently no-opped (the B-590 "rendered button that no-ops" class). 50 is
   * a SANITY bound against garbage input, not a product limit — anything past
   * the baseline is reviewed by the Bravo Control System.
   */
  it('the ceilings are SANITY bounds at 50, not the old product limit of 4', () => {
    expect(MAX_CPOS).toBe(50);
    expect(MAX_VEHICLES).toBe(50);
    expect(MAX_CPOS).not.toBe(4);
  });

  /**
   * B-876 — the STEPPER wiring, read as source (the RN screen cannot be
   * imported by the node `booking` project).
   *
   * The vehicle cell is the half that was actually broken: its ceiling was a
   * LITERAL 4 in `setCount` and it carried no `plusDisabled`, so the + rendered
   * live at 4 and did nothing. A ceiling without a disabled button is the bug.
   */
  it('both steppers ceiling on the shared constants, and neither + can no-op', () => {
    const screen = stripComments(read('../CustomizeAddOnsScreen.tsx'));
    // A ternary's `?` is a regex QUANTIFIER, so this is a plain string compare:
    // as a regex the positive half could not match and the absence half below it
    // would have passed vacuously (CLAUDE.md source-scan trap).
    expect(screen).toContain("const ceil = k === 'cpo_count' ? maxCpos : MAX_VEHICLES;");
    // The literal the founder kept hitting.
    expect(screen).not.toContain("const ceil = k === 'cpo_count' ? maxCpos : 4;");
    expect(screen).toMatch(/plusDisabled={cpo_count >= maxCpos}/);
    expect(screen).toMatch(/plusDisabled={vehicle_count >= MAX_VEHICLES}/);
    expect(screen).toMatch(/MAX_CPOS, MAX_VEHICLES/);
  });

  it('pricing STILL moves with the CPO count in driver-only mode', () => {
    const driverOnly = {vehicleCount: 0, driverOnly: true, addOnsBcPerHour: 0};
    // 86 * 0.65 = 55.9 -> 56
    expect(rateBcPerHour({...driverOnly, cpoCount: 1})).toBe(56);
    // (86 + 2 * 21.5) * 0.65 = 83.85 -> 84
    expect(rateBcPerHour({...driverOnly, cpoCount: 3})).toBe(84);
    expect(rateBcPerHour({...driverOnly, cpoCount: 3}))
      .toBeGreaterThan(rateBcPerHour({...driverOnly, cpoCount: 1}));
  });
});

/**
 * B-876 — the client ceiling and the SERVER ceiling are ONE number.
 *
 * A client that offers 50 against a server DTO still bounded at 4 is a 400 at
 * submit; a team above the `AssignCrewDto` bound could never be CREWED by the
 * agency, which is a booking that dies after the money moved. So this reads the
 * server files from disk and asserts the literal at each DECISION SITE.
 *
 * Scan hygiene (CLAUDE.md): comments are stripped, `\r?\n` is used everywhere,
 * and a MISSING file FAILS — `readFileSync` throwing is the point, because an
 * absent file must never read as "no violations found".
 */
describe('B-876 — the team ceiling does not drift between client and server', () => {
  const SERVER = path.join(
    __dirname, '..', '..', '..', '..', 'apps', 'auth-service', 'src');
  const strip = (src: string) =>
    src.split(/\r?\n/).filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  const serverFile = (...rel: string[]) => strip(fs.readFileSync(path.join(SERVER, ...rel), 'utf8'));

  /**
   * The server keeps ONE literal (`TEAM_UNIT_MAX`, exported from the create DTO
   * because decorators need a compile-time value) and references it everywhere
   * else. So the NUMBER is pinned once, against the client constant, and every
   * other site is pinned on the REFERENCE — anchoring those on `50` would go
   * green-then-stale the first time someone moved the literal.
   */
  it('the server literal is the client ceiling, to the number', () => {
    const dto = serverFile('booking', 'dto', 'create-booking.dto.ts');
    expect(dto.length).toBeGreaterThan(1_000);
    expect(dto).toContain('export const TEAM_UNIT_MAX = ' + MAX_CPOS + ';');
    // One ceiling covers both steppers, so the client's two constants agree too.
    expect(MAX_VEHICLES).toBe(MAX_CPOS);
  });

  it('the DTO bounds BOTH team fields in BOTH DTOs — four sites', () => {
    const dto = serverFile('booking', 'dto', 'create-booking.dto.ts');
    expect(dto).toMatch(/cpo_count/);
    expect(dto).toMatch(/vehicle_count/);
    expect((dto.match(/@Max\(TEAM_UNIT_MAX\)/g) ?? []).length).toBe(4);
    // The old product limit, at the decision site. `@Max(16)`/`@Max(24)` on other
    // fields are untouched and cannot match this.
    expect(dto).not.toMatch(/@Max\(4\)/);
  });

  it('the service clamp is that same one literal', () => {
    const svc = serverFile('booking', 'booking.service.ts');
    expect(svc.length).toBeGreaterThan(1_000);
    expect(svc).toContain("import {TEAM_UNIT_MAX} from './dto/create-booking.dto';");
    expect(svc).toMatch(/const MAX_CPOS = TEAM_UNIT_MAX;/);
    expect(svc).not.toMatch(/const MAX_CPOS = 4\b/);
  });

  it('a team that big can actually be CREWED by the agency', () => {
    const org = serverFile('org', 'dto', 'org.dto.ts');
    expect(org.length).toBeGreaterThan(500);
    expect(org).toMatch(/AssignCrewDto/);
    expect(org).toMatch(/@ArrayMaxSize\(TEAM_UNIT_MAX\)/);
    expect(org).not.toMatch(/@ArrayMaxSize\(4\)/);
  });
});

describe('rateBcPerHour', () => {
  const base = {cpoCount: 1, vehicleCount: 1, driverOnly: false, addOnsBcPerHour: 0};

  it('starts at the 86 BC base for the baseline team', () => {
    expect(rateBcPerHour(base)).toBe(BASE_RATE_BC);
    expect(rateBcPerHour(base)).toBe(86);
  });

  it('increases the rate when CPOs are added (the reported bug)', () => {
    // +1 CPO = 86 + 0.25*86 = 107.5 -> 108
    expect(rateBcPerHour({...base, cpoCount: 2})).toBe(108);
    expect(rateBcPerHour({...base, cpoCount: 2})).toBeGreaterThan(86);
    // +2 CPO = 86 + 2*21.5 = 129
    expect(rateBcPerHour({...base, cpoCount: 3})).toBe(129);
  });

  it('increases the rate when vehicles are added', () => {
    expect(rateBcPerHour({...base, vehicleCount: 2})).toBe(108);
  });

  it('applies the driver-only discount', () => {
    // 86 * 0.65 = 55.9 -> 56
    expect(rateBcPerHour({...base, driverOnly: true})).toBe(56);
  });

  it('ignores extra-vehicle surcharge when driver-only (client supplies vehicle)', () => {
    // Even with vehicleCount > 1, driver-only zeroes Bravo vehicles: 86 * 0.65.
    expect(rateBcPerHour({...base, vehicleCount: 3, driverOnly: true})).toBe(56);
  });

  it('adds optional add-on hourly prices', () => {
    expect(rateBcPerHour({...base, addOnsBcPerHour: 120})).toBe(206);
  });

  it('combines extras: 2 CPO + 2 vehicles + female CPO add-on', () => {
    // 86 + 21.5 + 21.5 + 120 = 249
    expect(rateBcPerHour({cpoCount: 2, vehicleCount: 2, driverOnly: false, addOnsBcPerHour: 120})).toBe(249);
  });
});
