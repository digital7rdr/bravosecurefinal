/**
 * B-868 P2-2 — `launchedZones.ts`'s two NEW pure resolvers, under real tests.
 *
 * `zoneDraftFields` is a money-path function: its answer becomes the draft's
 * `region` (what the server prices and dispatches on), its `zone_label` becomes
 * `create()`'s `region_label` on the ops console, and its
 * `zone_utc_offset_hours` is the clock every schedule picker reads in (B-789b —
 * a wrong offset books the wrong HOUR). Its verbatim twin inside
 * `CustomizeAddOnsScreen` is line-pinned by `zoneFollowsPickup`; this copy is
 * the one the EXECUTIVE flow calls, so it gets its own behavioural pins rather
 * than a source scan.
 *
 * `zoneChipCopy` is the header-chip rule from B-868 P1-1: the chip may only
 * NAME a zone once a pick-up has derived one. The store is not persisted and
 * `resetDraft` has no callers, so `draft.zone_code` is the compiled seed on
 * every cold start — asserting "United Arab Emirates" to a Johannesburg client,
 * with the door to change it now removed, is a confident lie.
 */
import {
  LAUNCHED_ZONES,
  launchedZone,
  launchedZonesLabel,
  zoneChipCopy,
  zoneDraftFields,
} from '../launchedZones';

const AE = LAUNCHED_ZONES[0];
const ZA = LAUNCHED_ZONES[1];

/** A draft that is sitting in the OTHER launched zone, for the fallback arms. */
const draftIn = (code: string, label: string, offset: number | null) => ({
  zone_code: code, zone_label: label, zone_utc_offset_hours: offset,
});

describe('B-868 — zoneDraftFields: a LAUNCHED code answers entirely from its row', () => {
  it('takes code, label, region AND clock from the launched zone, never from the draft', () => {
    // The draft deliberately disagrees on every field: a launched row must win.
    const out = zoneDraftFields(ZA.code, draftIn(AE.code, 'STALE LABEL', 99));
    expect(out.zone_code).toBe(ZA.code);
    expect(out.zone_label).toBe(ZA.name);
    // `region` is the DISPATCH key and must be the RESOLVED zone, never the
    // draft's previous one — that is the whole point of the pin-derived zone.
    expect(out.region).toBe(ZA.code);
    expect(out.region).not.toBe(AE.code);
    expect(out.zone_utc_offset_hours).toBe(ZA.utcOffsetHours);
    // The notice name is the human COUNTRY ("South Africa"), not the long
    // `zone_label` ("South Africa — Johannesburg, Cape Town").
    expect(out.display).toBe(ZA.country);
    expect(out.display).not.toBe(ZA.name);
  });

  it('is case/whitespace tolerant the way launchedZone() is', () => {
    const out = zoneDraftFields(' za ', draftIn(AE.code, AE.name, AE.utcOffsetHours));
    expect(out.zone_code).toBe(ZA.code);
    expect(out.zone_utc_offset_hours).toBe(ZA.utcOffsetHours);
    expect(launchedZone(' za ')?.code).toBe(ZA.code);
  });

  it('answers the seeded zone from its row too (the cold-start case)', () => {
    const out = zoneDraftFields(AE.code, draftIn(AE.code, AE.name, AE.utcOffsetHours));
    expect(out).toEqual({
      zone_code: AE.code, zone_label: AE.name, region: AE.code,
      zone_utc_offset_hours: AE.utcOffsetHours, display: AE.country,
    });
  });
});

describe('B-868 — zoneDraftFields: an UNLAUNCHED code never invents a clock', () => {
  /**
   * OP-04 — ops can launch a region AFTER this build. `zoneFromPickup` accepts
   * it (the caller declared it launched), but there is no compiled row for it,
   * so the label and clock can only come from what the draft already carries
   * FOR THAT SAME CODE.
   */
  it('a code the DRAFT already holds keeps the draft label and the draft clock', () => {
    const out = zoneDraftFields('QA', draftIn('QA', 'Qatar — Doha', 3));
    expect(out.zone_code).toBe('QA');
    expect(out.region).toBe('QA');
    expect(out.zone_label).toBe('Qatar — Doha');
    expect(out.zone_utc_offset_hours).toBe(3);
    expect(out.display).toBe('Qatar — Doha');
  });

  it('a code the draft does NOT hold falls back to null — never a guessed offset', () => {
    const out = zoneDraftFields('QA', draftIn(AE.code, AE.name, AE.utcOffsetHours));
    expect(out.zone_code).toBe('QA');
    expect(out.region).toBe('QA');
    expect(out.zone_label).toBe('QA');
    // B-789b — `null` already means "use the device clock" downstream. A
    // fabricated number (0 included) silently books the wrong hour.
    expect(out.zone_utc_offset_hours).toBeNull();
    expect(out.display).toBe('QA');
  });

  it('an unknown code whose draft clock is already null stays null', () => {
    expect(zoneDraftFields('QA', draftIn('QA', 'Qatar', null)).zone_utc_offset_hours).toBeNull();
  });
});

describe('B-868 P1-1 — zoneChipCopy: the chip names a zone ONLY once a pin derived one', () => {
  const chip = {name: 'United Arab Emirates', badge: 'ARE'};

  it('with a confirmed pick-up it states the zone', () => {
    const out = zoneChipCopy(true, chip);
    expect(out.text).toBe('ARE');
    expect(out.a11y).toBe('Operating zone: United Arab Emirates');
  });

  it('WITHOUT a pick-up it names NO single zone — it states where we operate', () => {
    const out = zoneChipCopy(false, chip);
    // The regression this exists for: the seeded zone leaking into the chip.
    expect(out.text).not.toContain('ARE');
    expect(out.a11y).not.toContain('United Arab Emirates');
    // ...and it says what actually decides the zone.
    expect(out.a11y).toContain('follows your pick-up');
    expect(out.a11y).toContain(launchedZonesLabel());
  });

  it('the pre-pin text lists EVERY launched zone, from the one list', () => {
    const out = zoneChipCopy(false, chip);
    for (const z of LAUNCHED_ZONES) {
      expect(out.text).toContain(z.label);
    }
    // Short enough for a header chip — this is not a sentence slot.
    expect(out.text.length).toBeLessThanOrEqual(24);
  });
});
