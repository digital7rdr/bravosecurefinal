import 'reflect-metadata';
import {plainToInstance} from 'class-transformer';
import {validate} from 'class-validator';
import {CreateBookingDto, EstimateBookingDto, TEAM_UNIT_MAX} from './dto/create-booking.dto';

// #4 — "Driver Only (Client Vehicle)" sends vehicle_count=0. class-validator's
// @IsOptional() does NOT skip a present 0, so the old @Min(1) rejected it with
// "vehicle_count must not be less than 1". After the @Min(0) fix, 0 is valid and
// the @Max upper bound + negative guard still hold.
async function fieldErrors(
  Cls: new () => object,
  field: string,
  value: number,
): Promise<string[]> {
  const dto = plainToInstance(Cls, {[field]: value});
  const errs = await validate(dto);
  const vc = errs.find(e => e.property === field);
  return vc ? Object.values(vc.constraints ?? {}) : [];
}

const vehicleCountErrors = (Cls: new () => object, vehicle_count: number) =>
  fieldErrors(Cls, 'vehicle_count', vehicle_count);

describe('vehicle_count validation (#4 Driver-only Client Vehicle)', () => {
  for (const Cls of [CreateBookingDto, EstimateBookingDto] as const) {
    describe(Cls.name, () => {
      it('accepts 0 (driver-only — client supplies the vehicle)', async () => {
        expect(await vehicleCountErrors(Cls, 0)).toEqual([]);
      });

      it('still rejects a negative vehicle_count', async () => {
        expect(await vehicleCountErrors(Cls, -1)).not.toEqual([]);
      });
    });
  }
});

/**
 * B-876 (founder, 2026-09-14: "The limit is still here") — the team ceiling is
 * TEAM_UNIT_MAX, not 4. These cases USED to read "above the max of 4" with 5
 * rejected; 5 is now a perfectly ordinary team and the only thing the DTO still
 * refuses is garbage above the sanity bound.
 *
 * Pinned on BOTH fields and BOTH DTOs, because the estimate and the create must
 * admit the same team — a preview that quotes a team create() would 400 on is
 * the exact divergence E-9 exists to prevent.
 *
 * The bound is read from the exported const rather than retyped, so this suite
 * can never drift from the decorator; the literal itself is pinned once, below.
 */
describe('B-876 — the team ceiling on cpo_count / vehicle_count', () => {
  it('TEAM_UNIT_MAX is 50 (the ONE literal the client mirrors)', () => {
    expect(TEAM_UNIT_MAX).toBe(50);
  });

  for (const Cls of [CreateBookingDto, EstimateBookingDto] as const) {
    for (const field of ['cpo_count', 'vehicle_count'] as const) {
      describe(`${Cls.name}.${field}`, () => {
        it('accepts a 5-unit team (was REJECTED under the old max of 4)', async () => {
          expect(await fieldErrors(Cls, field, 5)).toEqual([]);
        });

        it(`accepts exactly TEAM_UNIT_MAX (${TEAM_UNIT_MAX})`, async () => {
          expect(await fieldErrors(Cls, field, TEAM_UNIT_MAX)).toEqual([]);
        });

        it(`rejects TEAM_UNIT_MAX + 1 (${TEAM_UNIT_MAX + 1}) — the sanity bound still holds`, async () => {
          expect(await fieldErrors(Cls, field, TEAM_UNIT_MAX + 1)).not.toEqual([]);
        });
      });
    }
  }
});
