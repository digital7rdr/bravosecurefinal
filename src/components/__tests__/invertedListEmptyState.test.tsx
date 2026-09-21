/**
 * B-780 — the department chat's "No messages yet." rendered MIRRORED on Android.
 *
 * React Native inverts a vertical list with `{scale: -1}` on Android (a 180°
 * rotation) and `{scaleY: -1}` elsewhere, and it applies that SAME style to the
 * `ListEmptyComponent` element itself so the empty state comes out upright.
 * `DepartmentChatScreen` added its own `scaleY: -1` "to flip it back" — on
 * Android that composes with RN's rotation into a horizontal mirror, which is
 * exactly the founder's screenshot.
 *
 * Pins:
 *  1. RN's contract: an inverted list clones ListEmptyComponent with exactly
 *     ONE inversion transform of its own (so nobody re-adds a counter-flip
 *     "to be safe"). The Jest preset resolves the platform at module load, so
 *     the accepted forms are RN's two known inversion styles.
 *  2. Neither chat screen adds a transform of its own to its empty state.
 */
import React from 'react';
import {FlatList, StyleSheet, Text, View} from 'react-native';
import {render} from '@testing-library/react-native';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function flattenTransform(style: unknown): Array<Record<string, number>> {
  const out: Array<Record<string, number>> = [];
  const walk = (s: unknown): void => {
    if (!s) {return;}
    if (Array.isArray(s)) {s.forEach(walk); return;}
    const t = (s as {transform?: Array<Record<string, number>>}).transform;
    if (Array.isArray(t)) {out.push(...t);}
  };
  walk(style);
  return out;
}

describe('inverted list empty state (B-780)', () => {
  it('RN applies its own inversion transform to ListEmptyComponent exactly once', () => {
    const {getByTestId} = render(
      <FlatList
        inverted
        data={[]}
        renderItem={() => null}
        ListEmptyComponent={<View testID="empty"><Text>No messages yet.</Text></View>}
      />,
    );
    const transforms = flattenTransform(getByTestId('empty').props.style);
    expect(transforms).toHaveLength(1);
    // Android: {scale: -1} (180° rotation); iOS / default: {scaleY: -1}.
    expect([{scale: -1}, {scaleY: -1}]).toContainEqual(transforms[0]);
  });

  it('THE B-780 MECHANISM: an empty element with its OWN transform replaces RN\'s inversion instead of composing with it', () => {
    // VirtualizedList._renderEmptyComponent clones the element with
    // StyleSheet.compose(inversionStyle, element.props.style). `transform` is
    // ONE style key, so the element's own transform WINS and RN's inversion is
    // dropped — the container is still rotated (Android: {scale: -1}), the
    // element only carries the screen's scaleY(-1), and rotation ∘ vertical flip
    // is a horizontal MIRROR: ".tey segassem oN". Which is why "flip it back"
    // was never a counter-flip at all.
    const {getByTestId} = render(
      <FlatList
        inverted
        data={[]}
        renderItem={() => null}
        ListEmptyComponent={
          <View testID="empty" style={{transform: [{scaleY: -1}]}}><Text>No messages yet.</Text></View>
        }
      />,
    );
    // The style ARRAY still lists both; what reaches the native view is the
    // flattened style, where the later `transform` key wins — flatten it the
    // way the renderer does.
    const flat = StyleSheet.flatten(getByTestId('empty').props.style) as {transform?: Array<Record<string, number>>};
    expect(flat.transform).toEqual([{scaleY: -1}]);        // the element's own, alone
    expect(flat.transform).not.toContainEqual({scale: -1});   // RN's Android inversion is gone
    expect(flat.transform).not.toContainEqual({scaleY: -1, scale: -1});
  });

  it('a non-inverted list leaves the empty element untouched (the transform above is the inversion, not a default)', () => {
    const {getByTestId} = render(
      <FlatList
        data={[]}
        renderItem={() => null}
        ListEmptyComponent={<View testID="empty"><Text>No messages yet.</Text></View>}
      />,
    );
    expect(flattenTransform(getByTestId('empty').props.style)).toHaveLength(0);
  });

  it('DepartmentChatScreen and ChatScreen add no transform of their own to the empty state', () => {
    const dept = read('src/screens/messenger/DepartmentChatScreen.tsx');
    const a = dept.indexOf('ListEmptyComponent={');
    expect(a).toBeGreaterThan(-1);
    const block = dept.slice(a, dept.indexOf('/>', a));
    expect(block).toMatch(/No messages yet\./);
    // Strip the explanatory comment before asserting — prose mentions the old transform.
    const code = block.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    expect(code).not.toMatch(/transform/);

    const chat = read('src/screens/messenger/ChatScreen.tsx');
    const wrap = chat.match(/emptyWrap:\s*\{[^}]*\}/);
    expect(wrap).not.toBeNull();
    expect(wrap![0]).not.toMatch(/transform/);
  });
});
