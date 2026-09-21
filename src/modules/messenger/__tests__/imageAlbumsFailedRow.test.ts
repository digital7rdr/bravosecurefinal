/**
 * PG-M7 — a photo whose send FAILED never joins an album.
 *
 * Album followers emit no list row and the leader draws only ITS OWN tick, so
 * a failed follower had no red tick and no "Tap to retry" anywhere: pick five,
 * #3 fails, the grid shows five tiles and one ✓. A failed (or undelivered) row
 * now stays its own bubble, which is where the retry chip lives.
 */
import type {LocalMessage} from '../store';
import {groupAlbums, isAlbumEligible} from '../ui/imageAlbums';

const T0 = Date.UTC(2026, 8, 2, 12, 0, 0);

function photo(id: string, offsetMs: number, status: LocalMessage['status'] = 'sent'): LocalMessage {
  return {
    id, conversation_id: 'c1', sender_id: 'self', type: 'image', content: '',
    status, is_encrypted: true, created_at: new Date(T0 + offsetMs).toISOString(),
    peer: {userId: 'u2', deviceId: 1}, media_object_key: `obj-${id}`,
  } as LocalMessage;
}

describe('PG-M7 — failed rows and albums', () => {
  it('a failed photo in the middle of a burst splits the album and stands alone', () => {
    const rows = [photo('a', 0), photo('b', 1000), photo('c', 2000, 'failed'), photo('d', 3000), photo('e', 4000)];
    const albums = groupAlbums(rows);
    const ids = albums.map(a => a.map(m => m.id));
    expect(ids).toEqual([['a', 'b'], ['d', 'e']]);
    expect(ids.flat()).not.toContain('c');
  });

  it('undelivered (B-683 total-failure verdict) is treated the same way', () => {
    const rows = [photo('a', 0), photo('b', 1000, 'undelivered'), photo('c', 2000)];
    expect(groupAlbums(rows).map(a => a.map(m => m.id))).toEqual([]);
    expect(isAlbumEligible(rows[1])).toBe(false);
  });

  it('sending / sent / delivered / read photos still group (the perf half survives)', () => {
    for (const status of ['sending', 'sent', 'delivered', 'read'] as const) {
      const rows = [photo('a', 0, status), photo('b', 1000, status)];
      expect(groupAlbums(rows)).toHaveLength(1);
    }
  });
});
