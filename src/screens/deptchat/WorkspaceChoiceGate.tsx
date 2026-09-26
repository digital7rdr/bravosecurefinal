import React, {useCallback} from 'react';
import {View, Text, StyleSheet, TouchableOpacity} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation} from '@react-navigation/native';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {useAuthStore} from '@store/authStore';
import {useActiveWorkspace} from '@store/activeWorkspace';
import {enterableAffiliations, needsWorkspaceChoice} from '@store/workspaceEntry';
import {openWorkspaceHub, type ResolvableNavigation} from '@navigation/departmentalEntry';

/**
 * B-848 — "Not all organization must show when I open 1 organization."
 *
 * A NULL workspace context used to mean "every organisation": both scoping
 * belts are fail-open, so `GET /department/channels` with no `orgId` answered
 * with every company the caller holds a membership in, and the Channels
 * directory rendered them in one list. The resolver in `authStore` removes
 * that for anybody with exactly ONE affiliation — it enters theirs — but a
 * person with two or more genuinely has a choice to make, and nothing may
 * decide it for them.
 *
 * So this is the second belt (D3): no surface renders a cross-organisation
 * list. Even if a future entry point forgets the resolver, the list cannot mix
 * organisations — it becomes this card. `orgSectionsOf` and the per-org
 * headers STAY behind it as B-624 containment for old servers and mixed rows.
 *
 * Renders NULL for everyone else, so the three host surfaces mount it
 * unconditionally and the condition lives in exactly one place.
 *
 * Hardware back on the gate is ordinary back (N1): this adds no handler, and
 * the forward press goes through `navigateOnce` inside the shared hub ladder
 * (N-NAV-10) because it is the hottest button on a screen whose only job is to
 * be tapped.
 */

/** The gate condition, for a HOST that must also suppress its own fetch while
 *  the card is up (the directory's `load`, the Vault's company shelf). */
export function useNeedsWorkspaceChoice(): boolean {
  const user = useAuthStore(s => s.user);
  const ctx = useActiveWorkspace(s => s.workspace);
  return needsWorkspaceChoice(user, ctx);
}

export function WorkspaceChoiceGate() {
  const navigation = useNavigation<ResolvableNavigation>();
  const user = useAuthStore(s => s.user);
  const ctx = useActiveWorkspace(s => s.workspace);
  const open = useCallback(() => { openWorkspaceHub(navigation); }, [navigation]);
  if (!needsWorkspaceChoice(user, ctx)) {return null;}
  const count = enterableAffiliations(user).length;
  return (
    <View style={g.wrap} testID="workspace-choice-gate">
      <View style={g.icon}>
        <Icon name="office-building-outline" size={22} color={T.accent} />
      </View>
      <Text style={g.title}>Choose a workspace</Text>
      <Text style={g.body}>
        {`You belong to ${count} organisations. Pick the one you want to work in.`}
      </Text>
      <TouchableOpacity
        style={g.btn}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel="Open Workspaces"
        onPress={open}>
        <Icon name="view-grid-outline" size={16} color="#FFF" />
        <Text style={g.btnText}>Open Workspaces</Text>
      </TouchableOpacity>
    </View>
  );
}

/** The obsidian surface tokens, locally — importing `_obsidian` for four hexes
 *  would pull `expo-linear-gradient` into VaultScreen's module graph, and this
 *  card is mounted on three screens with three different test rigs. */
const T = {
  card:     'rgba(22,27,37,0.72)',
  hair:     'rgba(255,255,255,0.09)',
  text:     '#FFFFFF',
  textDim:  'rgba(229,233,242,0.62)',
  accent:   '#1E88FF',
};

const g = StyleSheet.create(scaleTextStyles({
  wrap: {
    marginHorizontal: 20, marginTop: 14, marginBottom: 6, padding: 18,
    borderRadius: 18, backgroundColor: T.card, borderWidth: 1, borderColor: T.hair,
    alignItems: 'center',
  },
  icon: {
    width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(30,136,255,0.14)', borderWidth: 1, borderColor: 'rgba(30,136,255,0.25)',
    marginBottom: 12,
  },
  title: {color: T.text, fontFamily: BravoFont.bold, fontSize: 16, textAlign: 'center'},
  body: {
    color: T.textDim, fontFamily: BravoFont.regular, fontSize: 12.5,
    textAlign: 'center', lineHeight: 18, marginTop: 6,
  },
  btn: {
    // 48dp, comfortably over the 44dp minimum target even before fontScale.
    minHeight: 48, marginTop: 14, paddingHorizontal: 18, borderRadius: 14,
    backgroundColor: T.accent, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 8, alignSelf: 'stretch',
  },
  btnText: {color: '#FFF', fontFamily: BravoFont.semiBold, fontSize: 14},
}));
