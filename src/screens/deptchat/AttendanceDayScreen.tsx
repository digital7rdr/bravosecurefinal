import React, {useCallback, useRef, useState} from 'react';
import {RefreshControl, ScrollView, StatusBar, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useFocusEffect, useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import LoadingView from '@components/LoadingView';
import {navigateOnce} from '@navigation/tapGuard';
import type {DeptAttendStackParamList} from '@navigation/types';
import {attendanceApi, type ShiftSessionDto} from '@services/api';
import {OB, ObHeader, Card, ErrorState, loadErrorText, attendanceStatusMeta} from './_obsidian';
import {SessionRow} from './attendanceRows';
import {CheckInPhotoModal} from './CheckInPhotoModal';
import {placeLabel} from './attendanceDay';
import {fmtTime} from './geo';

/**
 * The people behind a Present / Late / Absent tile (founder, 2026-09-05:
 * "who is in and late doesn't show, only a number — when clicked show the
 * summary: name, that day's check-in location and time; click the person for
 * their full history"). Same window and branch as the tile it came from, so
 * the list and the number agree.
 */
type Nav = NativeStackNavigationProp<DeptAttendStackParamList>;
type R = RouteProp<DeptAttendStackParamList, 'AttendanceDay'>;

export default function AttendanceDayScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const {params} = useRoute<R>();
  const [rows, setRows] = useState<ShiftSessionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [photoFor, setPhotoFor] = useState<ShiftSessionDto | null>(null);
  // N7 — one live fetch per screen; a refocus during a fetch does not start a second.
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) {return;}
    inFlight.current = true;
    try {
      const {data} = await attendanceApi.orgDay({
        from: params.from, to: params.to, status: params.status, department: params.department,
      });
      setRows(data);
      setError(null);
    } catch (e) {
      setError(loadErrorText(e));
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, [params.from, params.to, params.status, params.department]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const meta = attendanceStatusMeta(params.status);
  const openMap = (s: ShiftSessionDto) => {
    if (typeof s.clock_in_lat !== 'number' || typeof s.clock_in_lng !== 'number') {return;}
    navigateOnce(navigation, 'CheckInMap', {
      lat: s.clock_in_lat, lng: s.clock_in_lng, place: placeLabel(s),
      title: 'Check-in location', subtitle: `${s.display_name ?? 'Member'} · ${fmtTime(s.clock_in_at)}`,
      siteLat: s.site_lat ?? null, siteLng: s.site_lng ?? null, radiusM: s.approved_radius_m ?? null,
      distanceM: s.distance_m ?? null, withinRadius: s.within_radius ?? null, siteLabel: s.site_label ?? null,
    });
  };
  const openMember = (s: ShiftSessionDto) => {
    navigateOnce(navigation, 'MemberAttendance', {cpoUserId: s.cpo_user_id, displayName: s.display_name ?? null});
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader
        title={params.title ?? meta.label}
        onBack={() => navigation.goBack()}
        pill={rows ? `${rows.length} ${rows.length === 1 ? 'PERSON' : 'PEOPLE'}` : undefined}
        pillTone={params.status === 'present' ? 'good' : params.status === 'late' || params.status === 'absent' ? 'warn' : 'default'}
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingTop: 8, paddingBottom: insets.bottom + 32, gap: 10}}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={OB.accentSoft} />}>
        <Text style={s.hint}>Tap a location to see it on the map. Tap a person for their full record.</Text>
        {error ? (
          <ErrorState message={error} onRetry={() => { void load(); }} />
        ) : rows === null ? (
          <LoadingView compact label="Loading people…" />
        ) : rows.length === 0 ? (
          <Card><Text style={s.empty}>Nobody is {meta.label.toLowerCase()} in this window.</Text></Card>
        ) : rows.map(row => (
          <SessionRow key={row.id} s={row} showName onOpenMap={openMap} onOpenPhoto={setPhotoFor} onPress={openMember} />
        ))}
      </ScrollView>
      <CheckInPhotoModal sessionId={photoFor?.id ?? null} memberName={photoFor?.display_name ?? null} onClose={() => setPhotoFor(null)} />
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  hint: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11.5, lineHeight: 16, marginBottom: 2},
  empty: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12, textAlign: 'center'},
}));
