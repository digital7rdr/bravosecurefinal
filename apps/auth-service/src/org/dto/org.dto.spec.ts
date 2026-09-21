import 'reflect-metadata';
import {plainToInstance} from 'class-transformer';
import {validate} from 'class-validator';
import {AssignCrewDto} from './org.dto';
import {TEAM_UNIT_MAX} from '../../booking/dto/create-booking.dto';

/**
 * B-876 (founder, 2026-09-14: "The limit is still here") — the agency's crew
 * cap had NO coverage at all, and it was a hard-coded 4 while the booking DTO
 * moved to TEAM_UNIT_MAX.
 *
 * This is the seam that makes a raised booking ceiling real: a client may now
 * book a team of 6, and if `AssignCrewDto` still refused more than 4 ids the
 * agency could never CREW it — the booking would dead-end AFTER the escrow hold.
 * So the two caps are pinned to the SAME exported const, not to two literals
 * that happen to agree today.
 */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function crewErrors(count: number): Promise<string[]> {
  const dto = plainToInstance(AssignCrewDto, {
    cpo_user_ids: Array.from({length: count}, (_, i) => uuid(i + 1)),
    lead_user_id: uuid(1),
  });
  const errs = await validate(dto);
  const ids = errs.find(e => e.property === 'cpo_user_ids');
  return ids ? Object.values(ids.constraints ?? {}) : [];
}

describe('AssignCrewDto — the crew cap tracks the booking team ceiling (B-876)', () => {
  it('still refuses an empty crew', async () => {
    expect(await crewErrors(0)).not.toEqual([]);
  });

  it('accepts a crew of 5 (REFUSED under the old @ArrayMaxSize(4))', async () => {
    expect(await crewErrors(5)).toEqual([]);
  });

  it(`accepts exactly TEAM_UNIT_MAX (${TEAM_UNIT_MAX}) — every bookable team is crewable`, async () => {
    expect(await crewErrors(TEAM_UNIT_MAX)).toEqual([]);
  });

  it(`refuses TEAM_UNIT_MAX + 1 (${TEAM_UNIT_MAX + 1}) — the sanity bound still holds`, async () => {
    expect(await crewErrors(TEAM_UNIT_MAX + 1)).not.toEqual([]);
  });
});
