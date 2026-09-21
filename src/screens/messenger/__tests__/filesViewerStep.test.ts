import {stepViewable} from '../filesViewerStep';

const rows = [{id: 'a'}, {id: 'b'}, {id: 'c'}];

describe('stepViewable (B-782 — swipe to the next/previous file)', () => {
  it('moves one item forward and back', () => {
    expect(stepViewable(rows, 'a', 1)?.id).toBe('b');
    expect(stepViewable(rows, 'b', -1)?.id).toBe('a');
  });
  it('clamps at both ends', () => {
    expect(stepViewable(rows, 'c', 1)).toBeNull();
    expect(stepViewable(rows, 'a', -1)).toBeNull();
  });
  it('an id that is no longer on screen stays put', () => {
    expect(stepViewable(rows, 'zzz', 1)).toBeNull();
    expect(stepViewable([], 'a', 1)).toBeNull();
  });
});
