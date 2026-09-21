/**
 * B-782 — swipe navigation inside the Files viewer.
 *
 * The viewer already understands horizontal swipes (`FileViewer.onSwipe`,
 * wired by ChatScreen since the chat viewer shipped); the Files tab opened a
 * single target and never handed the swipe anywhere. This is the pure step:
 * given the rows currently on screen (already filtered to what can be viewed),
 * move one item in the swipe direction. Clamped at both ends — a swipe past
 * the last item returns null and the viewer stays put.
 */
export function stepViewable<T extends {id: string}>(
  items: readonly T[],
  currentId: string,
  direction: -1 | 1,
): T | null {
  const i = items.findIndex(it => it.id === currentId);
  if (i < 0) {return null;}
  const j = i + direction;
  if (j < 0 || j >= items.length) {return null;}
  return items[j] ?? null;
}
