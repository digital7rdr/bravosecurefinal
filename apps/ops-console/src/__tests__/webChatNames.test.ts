/**
 * 2026-10-25 — linked browser showed "Bravo user" instead of names. The web
 * directory made one /users/profiles call per chat row and hit the server's
 * 60-per-10-minutes limit; rows past it had no name. Lookups are batched, and
 * a known phone number is shown before the placeholder.
 */
import fs from 'fs';
import path from 'path';
import {profileBatcher} from '../lib/web/directory';

const flush = () => new Promise(r => setTimeout(r, 60));

describe('profileBatcher', () => {
  it('lookups made together share one request', async () => {
    const fetchMany = jest.fn(async (ids: string[]) => new Map(ids.filter(i => i !== 'x').map(i => [i, {id: i, name: `N-${i}`, subtitle: ''}])));
    const get = profileBatcher(fetchMany);
    const all = Promise.all(['a', 'b', 'c', 'x', 'a'].map(get));
    await flush();
    const out = await all;
    expect(fetchMany).toHaveBeenCalledTimes(1);
    expect(fetchMany.mock.calls[0][0].sort()).toEqual(['a', 'b', 'c', 'x']);
    expect(out.map(p => p?.name ?? null)).toEqual(['N-a', 'N-b', 'N-c', null, 'N-a']);
  });

  it('splits more than `max` ids into several requests', async () => {
    const fetchMany = jest.fn(async () => new Map());
    const get = profileBatcher(fetchMany, {max: 2});
    const all = Promise.all(['a', 'b', 'c'].map(get));
    await flush();
    await all;
    expect(fetchMany).toHaveBeenCalledTimes(2);
  });

  it('a failed request rejects its callers (the row keeps its fallback)', async () => {
    const get = profileBatcher(async () => { throw new Error('429'); });
    const assertion = expect(get('a')).rejects.toThrow('429');
    await flush();
    await assertion;
  });
});

describe('chat rows fall back to the phone number', () => {
  it('usePeerProfile ends with the linked number before "Bravo user"', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'features', 'messenger', 'ChatWorkspace.tsx'), 'utf8');
    expect(src).toMatch(/return fromPhone \?\? cached \?\? data \?\? linkedNumber\(linked, userId\) \?\? null;/);
  });
});
