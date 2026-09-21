/**
 * B-854/P1-2 — "which member row was this notification about?", for the two
 * HOLDER rosters.
 *
 * The holder's funding wakes carry the `(A,B)` `family_members` row id. That
 * row lives on their ROSTER — `SecureProMembersScreen` and the member list on
 * `IndividualProfileScreen`. It can never appear in `FamilyQuotaCard`, which
 * lists the rows where the READER is the member, so the first cut's
 * `focusRowId` was a highlight with nothing to land on. Hence a second,
 * separate param consumed here, and `focusRowId` left to the member side.
 *
 * One hook rather than a copy per screen: the two rosters differ in markup but
 * not at all in this rule, and a second copy is where the two would drift.
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import type {LayoutChangeEvent} from 'react-native';

interface ScrollLike {
  scrollTo?: (opts: {y: number; animated?: boolean}) => void;
}

export function useRosterRowFocus(paramRowId: string | null | undefined, clearParam: () => void) {
  /**
   * P2-6/B-843 precedent — spend the highlight ONCE. React Navigation retains
   * route params, so leaving it set keeps the row marked for the whole session
   * and every later visit opens on a highlight that means nothing. The value is
   * adopted into state (so this visit still shows it) and the PARAM cleared; a
   * fresh tap re-arms it because the effect re-runs on the new value.
   */
  const [focusId, setFocusId] = useState<string | null>(paramRowId ?? null);
  useEffect(() => {
    if (!paramRowId) {return;}
    setFocusId(paramRowId);
    clearParam();
    // `clearParam` is a fresh closure each render; keying on it would re-fire
    // the clear forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramRowId]);

  const scrollRef = useRef<ScrollLike | null>(null);
  // The row's y is relative to the LIST container, and the list container's own
  // y is relative to the scroll content — so the content offset is their sum.
  // Measuring either alone scrolls to the wrong place on both screens.
  const [listY, setListY] = useState(0);
  const [rowY, setRowY] = useState<number | null>(null);

  const onListLayout = useCallback((e: LayoutChangeEvent) => {
    setListY(e.nativeEvent.layout.y);
  }, []);

  const onRowLayout = useCallback((id: string) => (e: LayoutChangeEvent) => {
    const y = e.nativeEvent.layout.y;
    setRowY(prev => (id === focusId ? y : prev));
  }, [focusId]);

  useEffect(() => {
    if (!focusId || rowY === null) {return;}
    // A little headroom so the row lands under the header rather than against it.
    scrollRef.current?.scrollTo?.({y: Math.max(0, listY + rowY - 24), animated: true});
  }, [focusId, rowY, listY]);

  const isFocused = useCallback((id: string) => focusId === id, [focusId]);

  return {focusId, isFocused, onRowLayout, onListLayout, scrollRef};
}
