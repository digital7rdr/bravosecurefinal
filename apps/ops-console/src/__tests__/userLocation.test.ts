/**
 * B-794 — `resolveUserLocation` exists because the ops console and the
 * auth-service deploy separately.
 *
 * The UI renders a discriminated union and narrows with `'blocked' in location`.
 * That expression THROWS on `undefined`, which is exactly what a console
 * deployed ahead of the API receives — and a TypeError in a client component
 * blanks the whole user page, not just the one row. So the raw field is never
 * read directly; everything goes through this normaliser.
 */

import {resolveUserLocation} from '../lib/userLocation';

describe('resolveUserLocation', () => {
  it('treats an API that never sent the field as "nothing on record"', () => {
    // The deploy-ordering case. Must not throw, must not claim opted-out.
    expect(resolveUserLocation(undefined)).toEqual({blocked: 'no_source'});
    expect(resolveUserLocation(null)).toEqual({blocked: 'no_source'});
  });

  it('passes a blocked reason through unchanged', () => {
    expect(resolveUserLocation({blocked: 'opted_out'})).toEqual({blocked: 'opted_out'});
    expect(resolveUserLocation({blocked: 'no_source'})).toEqual({blocked: 'no_source'});
  });

  it('passes a real fix through unchanged', () => {
    const fix = {
      lat: 25.2, lng: 55.27, recorded_at: '2026-09-04T04:00:00.000Z',
      source: 'family' as const, accuracy_m: 12, label: 'Downtown Dubai',
    };
    expect(resolveUserLocation(fix)).toBe(fix);
  });

  it('refuses coordinates that are not numbers', () => {
    // A row that arrived as strings or NULLs would render "NaN, NaN" on a map
    // link and read as a real position.
    expect(resolveUserLocation({
      lat: NaN, lng: 55.27, recorded_at: 'x', source: 'agent', accuracy_m: null, label: null,
    })).toEqual({blocked: 'no_source'});
    expect(resolveUserLocation({
      lat: '25.2' as unknown as number, lng: 55.27, recorded_at: 'x',
      source: 'agent', accuracy_m: null, label: null,
    })).toEqual({blocked: 'no_source'});
  });

  it('survives a non-object body', () => {
    expect(resolveUserLocation('nope' as never)).toEqual({blocked: 'no_source'});
  });

  it('the union it returns is always safe to narrow with `in`', () => {
    // The precise operation the component performs.
    for (const input of [undefined, null, {blocked: 'opted_out' as const}]) {
      expect(() => 'blocked' in resolveUserLocation(input)).not.toThrow();
    }
  });
});
