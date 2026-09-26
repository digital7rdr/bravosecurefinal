/**
 * P2-BR-1 (background-reliability audit 2026-07-10) — Signal-style
 * "notification reliability" prompt. Aggressive OEM power managers (TECNO/
 * HiOS — the QA device — MIUI, ColorOS, FuntouchOS, EMUI) force-stop a
 * swiped-away app, after which Android delivers ZERO FCM: killed-app messages
 * and call rings silently black out. Shown when the app is NOT exempt from
 * battery optimization; offers the system exemption dialog and, on OEMs with
 * an auto-start kill list, a deep link to that screen. Dismiss snoozes the
 * prompt for ~7 days per owner. Mirrors the N-31 NotificationPermissionBanner
 * pattern and mounts directly beside it.
 */
import React, {useState, useCallback} from 'react';
import {View, Text, TouchableOpacity, Platform, StyleSheet, AppState} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useAuthStore} from '@store/authStore';
import {
  isIgnoringBatteryOptimizations,
  requestIgnoreBatteryOptimizations,
  openAutostartSettings,
  hasOemAutostartScreen,
  snoozeReliabilityPrompt,
  isReliabilityPromptSnoozed,
  markAutostartPromptDone,
  isAutostartPromptDone,
  canUseFullScreenIntent,
  openFullScreenIntentSettings,
  isDndEnabled,
  openDndSettings,
} from '@/modules/messenger/push/batteryOptimization';

/** B-777 — how long to hide the card when the OEM autostart screen could not be opened. */
const AUTOSTART_RETRY_SNOOZE_MS = 24 * 60 * 60 * 1000;

export default function NotificationReliabilityCard() {
  // B-63 — the card now covers three independent reliability gaps:
  //   batt: not exempt from battery optimization (killed-app FCM blackout)
  //   fsi:  Android 14+ full-screen-intent denied (no lock-screen call UI;
  //         the 2026-07-10 rings all posted FSI_REQUESTED_BUT_DENIED)
  //   dnd:  CA-07 — Do Not Disturb silences tones/rings with every permission
  //         granted, which reads as "the app is broken"
  const [needBatt, setNeedBatt] = useState(false);
  // B-777 — the OEM auto-start prompt is its OWN gap, not a rider on the
  // battery one: the exemption can be granted while Autostart stays denied.
  const [needAuto, setNeedAuto] = useState(false);
  const [needFsi, setNeedFsi] = useState(false);
  const [needDnd, setNeedDnd] = useState(false);
  const ownerId = useAuthStore(s => s.user?.id ?? null);
  const showAutostart = hasOemAutostartScreen();

  const check = useCallback(async (): Promise<{batt: boolean; auto: boolean; fsi: boolean; dnd: boolean}> => {
    const none = {batt: false, auto: false, fsi: false, dnd: false};
    if (Platform.OS !== 'android') {return none;}
    if (await isReliabilityPromptSnoozed(ownerId)) {return none;}
    const [exempt, autoDone, fsiOk, dndOn] = await Promise.all([
      isIgnoringBatteryOptimizations(),
      showAutostart ? isAutostartPromptDone(ownerId) : Promise.resolve(true),
      canUseFullScreenIntent(),
      isDndEnabled(),
    ]);
    return {batt: !exempt, auto: showAutostart && !autoDone, fsi: !fsiOk, dnd: dndOn};
  }, [ownerId, showAutostart]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      const run = () => {
        check()
          .then(v => { if (!cancelled) {setNeedBatt(v.batt); setNeedAuto(v.auto); setNeedFsi(v.fsi); setNeedDnd(v.dnd);} })
          .catch(() => { /* best-effort */ });
      };
      run();
      // Re-check when the app returns from the system dialog / OEM settings
      // so a fresh grant hides the card without a re-navigation.
      const sub = AppState.addEventListener('change', st => {
        if (st === 'active') {run();}
      });
      return () => { cancelled = true; sub.remove(); };
    }, [check]),
  );

  const onAllow = useCallback(() => {
    requestIgnoreBatteryOptimizations().catch(() => { /* logged in wrapper */ });
  }, []);

  const onAutostart = useCallback(() => {
    setNeedAuto(false);
    // Retire the prompt for this owner ONLY when the OEM screen actually
    // opened (the op itself is not readable, so that is the strongest signal).
    // On the app-details fallback / a throw, nothing the user could act on was
    // shown: snooze a day instead of persisting a permanent "done" — the
    // silent re-creation of exactly the B-777 state.
    openAutostartSettings()
      .then(opened => (opened
        ? markAutostartPromptDone(ownerId)
        : snoozeReliabilityPrompt(ownerId, AUTOSTART_RETRY_SNOOZE_MS)))
      .catch(() => { /* logged in wrapper */ });
  }, [ownerId]);

  const onFsi = useCallback(() => {
    openFullScreenIntentSettings().catch(() => { /* logged in wrapper */ });
  }, []);

  const onDnd = useCallback(() => {
    openDndSettings().catch(() => { /* logged in wrapper */ });
  }, []);

  const onDismiss = useCallback(() => {
    setNeedBatt(false);
    setNeedAuto(false);
    setNeedFsi(false);
    setNeedDnd(false);
    snoozeReliabilityPrompt(ownerId).catch(() => { /* logged in wrapper */ });
  }, [ownerId]);

  if (!needBatt && !needAuto && !needFsi && !needDnd) {return null;}
  // Severity order: a killed-app blackout beats a silent ring beats DND.
  const text = needBatt
    ? 'Calls and messages may not arrive when the app is closed. Allow Bravo to run in the background.'
    : needAuto
      ? 'Your phone may stop Bravo from waking for new messages after you swipe it away. Allow auto-start for Bravo.'
      : needFsi
        ? 'Incoming calls can’t ring on your lock screen. Allow full-screen notifications for Bravo.'
        : 'Do Not Disturb is on — messages and calls won’t make a sound.';
  return (
    <View style={s.wrap}>
      <Icon
        name={needBatt ? 'battery-alert-variant-outline' : needAuto ? 'restart' : needFsi ? 'phone-lock' : 'minus-circle-outline'}
        size={16}
        color="#1E88FF"
      />
      <Text style={s.text} numberOfLines={3}>
        {text}
      </Text>
      {needBatt && (
        <TouchableOpacity onPress={onAllow} activeOpacity={0.7} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Text style={s.action}>Allow</Text>
        </TouchableOpacity>
      )}
      {(needBatt || needAuto) && showAutostart && (
        <TouchableOpacity
          onPress={onAutostart}
          activeOpacity={0.7}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
          accessibilityRole="button"
          accessibilityLabel="Allow auto-start for Bravo"
        >
          <Text style={s.action}>Auto-start</Text>
        </TouchableOpacity>
      )}
      {needFsi && (
        <TouchableOpacity onPress={onFsi} activeOpacity={0.7} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Text style={s.action}>{needBatt || needAuto ? 'Calls' : 'Allow'}</Text>
        </TouchableOpacity>
      )}
      {needDnd && (
        <TouchableOpacity onPress={onDnd} activeOpacity={0.7} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Text style={s.action}>{needBatt || needAuto || needFsi ? 'DND' : 'Review'}</Text>
        </TouchableOpacity>
      )}
      <TouchableOpacity
        onPress={onDismiss}
        activeOpacity={0.7}
        hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
        accessibilityRole="button"
        accessibilityLabel="Dismiss for a week"
      >
        <Icon name="close" size={15} color="#94A3B8" />
      </TouchableOpacity>
    </View>
  );
}

// Obsidian language (bg #0A1F3F family, accent #1E88FF) — a cobalt-tinted
// sibling of the N-31 red strip so "reliability" reads as guidance, not error.
const s = StyleSheet.create({
  wrap: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 10, paddingHorizontal: 14,
    backgroundColor: 'rgba(91,141,239,0.10)',
    borderBottomWidth: 1, borderBottomColor: 'rgba(91,141,239,0.25)',
  },
  text: {flex: 1, color: '#C9D7F2', fontSize: 12.5},
  action: {color: '#1E88FF', fontSize: 12.5, fontWeight: '700'},
});
