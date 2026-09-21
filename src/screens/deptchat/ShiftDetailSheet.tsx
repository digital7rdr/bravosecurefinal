import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View,
  useWindowDimensions,
} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {navigateOnce} from '@navigation/tapGuard';
import type {DeptAttendStackParamList} from '@navigation/types';
import {AvatarViewer, type AvatarViewTarget} from '@/modules/messenger/ui/AvatarViewer';
import {attendanceApi, type ShiftAssigneeDto, type ShiftAssigneePingDto, type ShiftDto} from '@services/api';
import {OB, ErrorState, loadErrorText} from './_obsidian';
import {AssigneeRow, PingControl, pingIsLive} from './AssigneeRow';
import {CheckInPhotoModal} from './CheckInPhotoModal';
import {fmtWindow, fmtTime} from './geo';
import {deptMemberNoun} from './deptNoun';

type Nav = NativeStackNavigationProp<DeptAttendStackParamList>;

/**
 * B-855 — the shift detail. Founder 2026-09-11: _"each shift is shown but when
 * we expand each shift we should see which users are assigned, their location,
 * and all required information for each worker with their picture"_.
 *
 * ⚠️ `open` and `shift` are SEPARATE props on purpose (the B-821 trap). A sheet
 * whose visibility is derived from its content (`visible={shift !== null}`)
 * collapses mid-dismiss: clearing the content to close it removes the card
 * before the slide-out has run, and the user sees the sheet blink out of
 * existence. The caller keeps the content until the animation is done.
 *
 * Assignees load on OPEN, not on mount — this sheet is rendered once per list
 * screen and would otherwise fetch a shift nobody asked about.
 */
export function ShiftDetailSheet({open, shift, onClose}: {
  open: boolean;
  shift: ShiftDto | null;
  onClose: () => void;
}) {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const {height} = useWindowDimensions();
  const [rows, setRows] = useState<ShiftAssigneeDto[]>([]);
  const [more, setMore] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<AvatarViewTarget | null>(null);
  const [photoSession, setPhotoSession] = useState<{id: string; name: string} | null>(null);
  /**
   * Assignees whose Ping was refused `not_on_shift` while this sheet was open.
   *
   * That refusal creates NO ping row, so `pollWhilePending` below is false and
   * nothing about the row would ever change again: the manager sat on "Not
   * clocked in" with Ping dead while the worker clocked in behind them.
   */
  const [awaitingClockIn, setAwaitingClockIn] = useState<string[]>([]);

  const shiftId = open ? shift?.id ?? null : null;

  /**
   * `initial` — the OPEN fetch, which owns the empty/error states.
   *
   * A 15-second POLL must never clear what is on screen. The first cut shared
   * one handler, so a single failed poll (a tunnel, a dropped Wi-Fi hop) blanked
   * a sheet the manager was reading mid-shift and replaced a roster of assignees
   * with "Could not load" — for data the app still had. A poll that fails keeps
   * the last good answer and says nothing; the next tick fixes it. This is the
   * F15 rule read the other way round: a failure must not read as "no one
   * assigned" EITHER.
   */
  const load = useCallback(async (initial = false) => {
    if (!shiftId) {return;}
    try {
      const {data} = await attendanceApi.listShiftAssignments(shiftId);
      setRows(data.assignments ?? []);
      setMore(data.more ?? 0);
      setError(null);
    } catch (e) {
      if (!initial) {return;}
      setRows([]);
      setMore(0);
      setError(loadErrorText(e));
    } finally {
      if (initial) {setLoading(false);}
    }
  }, [shiftId]);

  useEffect(() => {
    if (!shiftId) {return;}
    setLoading(true);
    setRows([]);
    setMore(0);
    setError(null);
    void load(true);
  }, [shiftId, load]);

  /**
   * B-859 — poll the detail while a request is still live.
   *
   * `useFocusEffect`, so it stops the moment the manager leaves the screen (a
   * blurred screen polling every 15 s is the N7 cost this repo keeps paying),
   * and the effect is torn down when the sheet closes because `open` is a
   * dependency. The stop condition is the PING, not a timer: once every pending
   * row is past its ten-minute life the interval clears itself, so a server
   * that never flips the row to `expired` cannot leave this running forever.
   */
  const pollWhilePending = rows.some(a => pingIsLive(a.last_ping));
  /**
   * …and while a refused row is still not clocked in.
   *
   * SELF-LIMITING by the same rule as the ping one: the moment the session
   * reads 'open' this goes false on its own, so a worker who never clocks in
   * costs one refresh every 15 s for as long as the sheet is on screen, and
   * nothing at all once it is closed or blurred.
   */
  const pollWhileRefused = rows.some(
    a => awaitingClockIn.includes(a.cpo_user_id) && a.session?.status !== 'open');
  const shouldPoll = pollWhilePending || pollWhileRefused;
  useFocusEffect(useCallback(() => {
    if (!open || !shiftId || !shouldPoll) {return;}
    const timer = setInterval(() => { void load(); }, 15_000);
    return () => clearInterval(timer);
  }, [open, shiftId, shouldPoll, load]));

  /** A ping just came back from the POST — show it without waiting for a poll. */
  const adoptPing = (cpoUserId: string, ping: ShiftAssigneePingDto) => {
    setRows(prev => prev.map(a => (a.cpo_user_id === cpoUserId ? {...a, last_ping: ping} : a)));
  };

  const site = shift ? {lat: shift.site_lat, lng: shift.site_lng} : null;

  const openPingMap = (a: ShiftAssigneeDto, fix: {lat: number; lng: number; at: string}) => {
    onClose();
    navigateOnce(navigation, 'CheckInMap', {
      lat: fix.lat, lng: fix.lng, place: null,
      title: 'Shared location',
      subtitle: `${a.display_name ?? 'Member'} · ${fmtTime(fix.at)}`,
      siteLat: shift?.site_lat ?? null, siteLng: shift?.site_lng ?? null,
      radiusM: shift?.approved_radius_m ?? null,
      // NOT a check-in verdict: the server stored no within/distance for a ping,
      // and reusing the session's would caption one fix with another's judgement.
      distanceM: null, withinRadius: null,
      siteLabel: shift?.site_label ?? null,
    });
  };

  const openMap = (a: ShiftAssigneeDto) => {
    const ses = a.session;
    const lat = ses?.clock_in_lat ?? null;
    const lng = ses?.clock_in_lng ?? null;
    if (lat === null || lng === null) {return;}
    // Close first: the map is PUSHED underneath this Modal, which would
    // otherwise cover it completely (the sheet is not part of the stack).
    onClose();
    navigateOnce(navigation, 'CheckInMap', {
      lat, lng, place: ses?.clock_in_place ?? null,
      title: 'Check-in location',
      subtitle: `${a.display_name ?? 'Member'} · ${fmtTime(ses?.clock_in_at)}`,
      siteLat: shift?.site_lat ?? null, siteLng: shift?.site_lng ?? null,
      radiusM: shift?.approved_radius_m ?? null,
      distanceM: ses?.distance_m ?? null, withinRadius: ses?.within_radius ?? null,
      siteLabel: shift?.site_label ?? null,
    });
  };

  const title = shift?.site_label ?? 'Assigned site';

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close shift details"
        />
        {/* B-245/B-784 — a `<Modal>` sheet is exactly the case where the RAW
            safe-area inset is correct: it draws OVER the tab bar, so there is
            no bar already padding by it, and without this the last row sits
            under the gesture pill / nav bar. */}
        <View style={[s.sheet, {paddingBottom: insets.bottom + 20}]} testID="shift-detail-sheet">
          <View style={s.grabber} />
          <View style={s.head}>
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={s.title} numberOfLines={1}>{title}</Text>
              <Text style={s.sub} numberOfLines={1}>
                {shift ? fmtWindow(shift.start_at, shift.end_at) : ''}
                {shift?.department ? ` · ${shift.department}` : ''}
              </Text>
            </View>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
              accessibilityRole="button"
              accessibilityLabel="Close"
              testID="shift-detail-close">
              <Icon name="close" size={22} color={OB.textDim} />
            </TouchableOpacity>
          </View>

          {loading ? (
            <View style={s.centre}><ActivityIndicator color={OB.accentSoft} /></View>
          ) : error ? (
            <View style={{paddingVertical: 8}}>
              {/* A manual retry IS an initial load: it owns the states again. */}
              <ErrorState message={error} onRetry={() => { setLoading(true); void load(true); }} />
            </View>
          ) : rows.length === 0 ? (
            <View style={s.centre}>
              <Icon name="account-alert-outline" size={26} color={OB.textMute} />
              <Text style={s.empty}>
                No one assigned — nobody can check in. Tap edit to add {deptMemberNoun(true)}.
              </Text>
            </View>
          ) : (
            <FlatList
              data={rows}
              keyExtractor={a => a.cpo_user_id}
              initialNumToRender={8}
              style={{maxHeight: height * 0.7}}
              showsVerticalScrollIndicator={false}
              ItemSeparatorComponent={renderSeparator}
              ListFooterComponent={more > 0 ? <Text style={s.more}>+{more} more</Text> : null}
              renderItem={({item}) => (
                <AssigneeRow
                  a={item}
                  onOpenAvatar={a => setAvatar({
                    uri: a.avatar_url ?? '',
                    name: a.display_name ?? a.call_sign ?? 'Removed member',
                  })}
                  onOpenMap={openMap}
                  onOpenPhoto={a => {
                    if (!a.session?.id) {return;}
                    setPhotoSession({id: a.session.id, name: a.display_name ?? 'Member'});
                  }}
                  pingSlot={shiftId ? (
                    <PingControl
                      a={item}
                      shiftId={shiftId}
                      site={site}
                      onPinged={p => adoptPing(item.cpo_user_id, p)}
                      onOpenPingMap={openPingMap}
                      onNotOnShift={() => setAwaitingClockIn(prev =>
                        prev.includes(item.cpo_user_id) ? prev : [...prev, item.cpo_user_id])}
                    />
                  ) : null}
                />
              )}
            />
          )}
        </View>

        {/* Nested rather than sibling: two sibling Modals cannot both present. */}
        <AvatarViewer target={avatar} onClose={() => setAvatar(null)} />
        <CheckInPhotoModal
          sessionId={photoSession?.id ?? null}
          memberName={photoSession?.name ?? null}
          onClose={() => setPhotoSession(null)}
        />
      </View>
    </Modal>
  );
}

function renderSeparator() {
  return <View style={s.sep} />;
}

const s = StyleSheet.create(scaleTextStyles({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.62)', justifyContent: 'flex-end'},
  sheet: {
    backgroundColor: '#0C1017', borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: 1, borderColor: OB.hair2, paddingHorizontal: 18, paddingTop: 10,
  },
  grabber: {
    alignSelf: 'center', width: 38, height: 4, borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.16)', marginBottom: 10,
  },
  head: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 10},
  title: {color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 16.5, letterSpacing: -0.3},
  sub: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 12, marginTop: 2},
  sep: {height: 1, backgroundColor: OB.hair},
  centre: {alignItems: 'center', gap: 10, paddingVertical: 28},
  empty: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 12.5, textAlign: 'center', maxWidth: 260, lineHeight: 18},
  more: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 10.5, letterSpacing: 0.4, paddingVertical: 12, textAlign: 'center'},
}));
