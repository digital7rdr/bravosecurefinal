/**
 * B-787 — the team-composition vehicle count must follow the party size in BOTH
 * directions.
 *
 * Founder, 2026-09-03 (screenshot of Secure Transfer / "Build & confirm your
 * detail"): _"this + sign work dynamically like vehicle calculator but when do
 * - after plus doesn't change the State"_.
 *
 * Reproduced exactly: with 2 passengers the party needs 1 vehicle. Take it to 4
 * and the screen correctly grows the team to 2 vehicles. Take it back to 2 and
 * the count STAYS at 2 — because the sync only ever raised it:
 *
 *     if (!driver_only && (vehicle_count ?? 1) < minVehicles) {
 *       updateDraft({vehicle_count: minVehicles});
 *     }
 *
 * So the client keeps paying for a second vehicle (the rate is computed from
 * `vehicle_count`) while the screen's own banner still reads "1 vehicle covers
 * this party", and `handleSubmit` re-pinned the same ratchet with
 * `Math.max(draft.vehicle_count, minVehicles)` — meaning the inflated count was
 * what actually got booked and escrow-charged.
 *
 * `nextVehicleCount` is the replacement rule. The loop below models the screen's
 * handler + sync effect, so these are RED against the old one-way clamp.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  nextVehicleCount, vehiclesForPassengers, rateBcPerHour, MAX_CPOS,
} from '../pricing';

/**
 * The screen's state machine, modelled: a passenger change re-runs the sync
 * effect, and a vehicle stepper press records an explicit choice.
 */
function makeScreen(passengers = 2) {
  const state = {
    passengers,
    vehicle_count: vehiclesForPassengers(passengers),
    driver_only: false,
    chosen: null as number | null,
  };
  const sync = () => {
    if (!state.driver_only) {
      state.vehicle_count = nextVehicleCount({
        passengers: state.passengers,
        chosen: state.chosen,
        driverOnly: false,
      });
    }
  };
  return {
    state,
    setPassengers(d: number) {
      state.passengers = Math.min(12, Math.max(1, state.passengers + d));
      sync();
    },
    stepVehicles(d: number) {
      const floor = vehiclesForPassengers(state.passengers);
      const next = Math.max(floor, Math.min(4, state.vehicle_count + d));
      // Mirrors the screen: a step back down TO the floor returns to auto.
      state.chosen = next > floor ? next : null;
      state.vehicle_count = next;
    },
    setDriverOnly(on: boolean) {
      state.driver_only = on;
      if (on) {
        state.chosen = null;
        state.vehicle_count = 0;
      } else {
        sync();
      }
    },
  };
}

describe('B-787 — the vehicle count comes back down', () => {
  it('returns to 1 when the party shrinks back to 2 passengers', () => {
    const s = makeScreen(2);
    expect(s.state.vehicle_count).toBe(1);
    s.setPassengers(+1);            // 3 pax — still 1 vehicle
    expect(s.state.vehicle_count).toBe(1);
    s.setPassengers(+1);            // 4 pax — needs 2
    expect(s.state.vehicle_count).toBe(2);
    s.setPassengers(-1);            // back to 3 — needs 1 again
    expect(s.state.vehicle_count).toBe(1);
    s.setPassengers(-1);            // back to 2
    expect(s.state.vehicle_count).toBe(1);
  });

  it('never leaves the count disagreeing with the banner', () => {
    // The banner renders `vehiclesForPassengers(passengers)`. Any divergence
    // from an AUTO count is the founder's screenshot: "1 vehicle covers this
    // party" printed above a 2-vehicle charge.
    const s = makeScreen(2);
    for (const d of [+1, +1, +1, +1, -1, -1, -1, -1, +1, -1]) {
      s.setPassengers(d);
      expect(s.state.vehicle_count).toBe(vehiclesForPassengers(s.state.passengers));
    }
  });

  it('brings the PRICE back down too, not just the number', () => {
    // The defect was only visible as money: rateBcPerHour bills per vehicle.
    const s = makeScreen(2);
    const rate = () => rateBcPerHour({
      cpoCount: 1, vehicleCount: s.state.vehicle_count,
      driverOnly: false, addOnsBcPerHour: 0,
    });
    const before = rate();
    s.setPassengers(+2);                       // 4 pax -> 2 vehicles
    expect(rate()).toBeGreaterThan(before);
    s.setPassengers(-2);                       // back to 2 pax
    expect(rate()).toBe(before);
  });
});

describe('an explicit choice is still respected', () => {
  it('keeps a hand-picked count when the party changes', () => {
    const s = makeScreen(2);
    s.stepVehicles(+1);                        // the user asks for 2
    expect(s.state.vehicle_count).toBe(2);
    s.setPassengers(+1);                       // 3 pax, floor 1
    expect(s.state.vehicle_count).toBe(2);     // their choice stands
    s.setPassengers(-1);
    expect(s.state.vehicle_count).toBe(2);
  });

  it('grows past the choice when the party physically outgrows it', () => {
    const s = makeScreen(2);
    s.stepVehicles(+1);                        // chose 2
    s.setPassengers(+8);                       // 10 pax needs 4
    expect(s.state.vehicle_count).toBe(4);
  });

  it('stepping back down to the minimum hands control back to auto', () => {
    // The residual ratchet: chose 3, stepped back to the floor, then changed
    // the party. Without this the count pinned at the OLD floor.
    const s = makeScreen(4);                   // floor 2
    s.stepVehicles(+1);                        // 3
    s.stepVehicles(-1);                        // back to 2 = the floor
    s.setPassengers(-2);                       // 2 pax -> floor 1
    expect(s.state.vehicle_count).toBe(1);     // follows the party again
  });

  it('does NOT ratchet the choice upward after the party shrinks again', () => {
    // The subtle half: if the rule read the CURRENT count back as the choice,
    // a temporary party spike would permanently raise the user's number.
    const s = makeScreen(2);
    s.stepVehicles(+1);                        // chose 2
    s.setPassengers(+8);                       // 10 pax -> 4
    expect(s.state.vehicle_count).toBe(4);
    s.setPassengers(-8);                       // back to 2 pax
    expect(s.state.vehicle_count).toBe(2);     // their 2, not the spike's 4
  });
});

describe('driver-only (client vehicle)', () => {
  it('assigns no Bravo vehicle while on', () => {
    const s = makeScreen(4);
    expect(s.state.vehicle_count).toBe(2);
    s.setDriverOnly(true);
    expect(s.state.vehicle_count).toBe(0);
  });

  it('returns to the AUTO count when switched off, not to a stale choice', () => {
    const s = makeScreen(2);
    s.stepVehicles(+1);                        // chose 2
    s.setDriverOnly(true);                     // client supplies the car
    s.setDriverOnly(false);                    // hand it back to Bravo
    expect(s.state.vehicle_count).toBe(1);     // the party only needs 1
  });

  it('stays at zero for any party size while on', () => {
    const s = makeScreen(2);
    s.setDriverOnly(true);
    s.setPassengers(+8);
    expect(s.state.vehicle_count).toBe(0);
  });
});

describe('nextVehicleCount — the rule itself', () => {
  it('is the passenger floor when nothing was chosen', () => {
    for (const [pax, want] of [[1, 1], [2, 1], [3, 1], [4, 2], [6, 2], [7, 3], [12, 4]] as const) {
      expect(nextVehicleCount({passengers: pax, chosen: null, driverOnly: false})).toBe(want);
    }
  });

  it('is zero under driver-only regardless of party or choice', () => {
    expect(nextVehicleCount({passengers: 12, chosen: 4, driverOnly: true})).toBe(0);
    expect(nextVehicleCount({passengers: 1, chosen: null, driverOnly: true})).toBe(0);
  });

  it('takes the greater of the choice and the floor', () => {
    expect(nextVehicleCount({passengers: 2, chosen: 3, driverOnly: false})).toBe(3);
    expect(nextVehicleCount({passengers: 10, chosen: 2, driverOnly: false})).toBe(4);
  });

  it('never returns less than one vehicle for a Bravo-supplied team', () => {
    expect(nextVehicleCount({passengers: 0, chosen: null, driverOnly: false})).toBe(1);
    expect(nextVehicleCount({passengers: 2, chosen: 0, driverOnly: false})).toBe(1);
  });

  it('treats a CPO-only party sanely (MAX_CPOS is unrelated to vehicles)', () => {
    expect(MAX_CPOS).toBeGreaterThan(0);
    expect(nextVehicleCount({passengers: 1, chosen: null, driverOnly: false})).toBe(1);
  });
});

/**
 * The suites above model the screen's loop; these pin the SCREEN ITSELF.
 *
 * That distinction is the whole point: a model can be right while the wiring is
 * wrong, and the wiring is where B-787 actually lived. `CustomizeAddOnsScreen`
 * is an RN component the node `booking` project cannot import, so the rule is
 * pinned by reading its source — the repo's established pattern.
 *
 * Both traps of that pattern are handled: the file is CRLF (a newline-anchored
 * regex would match nothing and pass VACUOUSLY) and comments are stripped, so
 * the prose above the fix cannot satisfy or break an assertion about CODE.
 */
describe('the screen is wired to the two-way rule', () => {
  const SCREEN = (() => {
    const raw = readFileSync(
      join(process.cwd(), 'src', 'screens', 'booking', 'CustomizeAddOnsScreen.tsx'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map(l => l.replace(/\/\/.*$/, ''))
      .join('\n');
  })();

  it('no longer contains the one-way raise that WAS the bug', () => {
    // The exact shape that shipped:
    //   if (!driver_only && (vehicle_count ?? 1) < minVehicles) {
    //     updateDraft({vehicle_count: minVehicles});
    //   }
    expect(SCREEN).not.toMatch(/vehicle_count:\s*minVehicles/);
    // handleSubmit carried the other half.
    expect(SCREEN).not.toMatch(/vehicle_count:\s*Math\.max\(/);
  });

  it('syncs the count through nextVehicleCount', () => {
    expect(SCREEN).toMatch(/nextVehicleCount\(\{/);
    expect(SCREEN).toMatch(/nextVehicleCount/);
  });

  it('records an explicit stepper choice so the sync respects it', () => {
    expect(SCREEN).toMatch(/chosenVehiclesRef\.current = next > floor \? next : null/);
    expect(SCREEN).toMatch(/chosen: chosenVehiclesRef\.current/);
  });

  it('submits the SAME count the stepper rendered', () => {
    // The other half of the ratchet lived in handleSubmit, so the booking that
    // got escrow-charged could differ from the quote the user was shown.
    const submit = SCREEN.slice(SCREEN.indexOf('const handleSubmit'));
    expect(submit).toMatch(/vehicle_count: nextVehicleCount\(/);
  });

  it('re-syncs when the passenger count changes', () => {
    // `minVehicles` alone in the dep list was enough to RAISE, but the effect
    // must also re-run to LOWER; passengers is the actual input.
    const effect = SCREEN.slice(SCREEN.indexOf('nextVehicleCount({'));
    expect(effect).toMatch(/\}, \[passengers,/);
  });
});
