import React, {useCallback, useRef, useState} from 'react';
import {RefreshControl, ScrollView, StatusBar, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useFocusEffect, useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import LoadingView from '@components/LoadingView';
import {navigateOnce} from '@navigation/tapGuard';
import type {DeptAttendStackParamList} from '@navigation/types';
import {attendanceApi, type MemberAttendanceHistoryDto, type ShiftSessionDto} from '@services/api';
import {OB, ObHeader, Card, SectionLabel, ErrorState, loadErrorText} from './_obsidian';
import {KpiTile, SessionRow} from './attendanceRows';
import {CheckInPhotoModal} from './CheckInPhotoModal';
import {dayWindow, placeLabel, type DayPresetKey} from './attendanceDay';
import {fmtTime} from './geo';

/**
 * One member's full attendance record with KPIs (founder, 2026-09-05). The
 * numbers are computed server-side (attendanceKpis.ts) over the chosen
 * window; the rows are the same shape as the day list, so a place opens the
 * map and a viewable check-in photo opens the audited photo modal.
 */
type Nav = NativeStackNavigationProp<DeptAttendStackParamList>;
type R = RouteProp<DeptAttendStackParamList, 'MemberAttendance'>;

const RANGES: Array<{key: DayPresetKey; label: string}> = [
  {key: '30d', label: '30 days'},
  {key: '7d', label: '7 days'},
  {key: 'all', label: 'All time'},
];

export default function MemberAttendanceScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const {params} = useRoute<R>();
  const [range, setRange] = useState<DayPresetKey>('30d');
  const [data, setData] = useState<MemberAttendanceHistoryDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [photoFor, setPhotoFor] = useState<ShiftSessionDto | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) {return;}
    inFlight.current = true;
    try {
      const w = dayWindow(range);
      const {data: d} = await attendanceApi.memberHistory(params.cpoUserId, w);
      setData(d);
      setError(null);
    } catch (e) {
      setError(loadErrorText(e));
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, [params.cpoUserId, range]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const name = data?.member?.display_name ?? params.displayName ?? 'Member';
  const k = data?.kpis;
  const openMap = (s: ShiftSessionDto) => {
    if (typeof s.clock_in_lat !== 'number' || typeof s.clock_in_lng !== 'number') {return;}
    navigateOnce(navigation, 'CheckInMap', {
      lat: s.clock_in_lat, lng: s.clock_in_lng, place: placeLabel(s),
      title: 'Check-in location', subtitle: `${name} · ${fmtTime(s.clock_in_at)}`,
      siteLat: s.site_lat ?? null, siteLng: s.site_lng ?? null, radiusM: s.approved_radius_m ?? null,
      distanceM: s.distance_m ?? null, withinRadius: s.within_radius ?? null, siteLabel: s.site_label ?? null,
    });
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader
        title={name}
        onBack={() => navigation.goBack()}
        pill={k && k.punctuality_pct !== null ? `${k.punctuality_pct}% ON TIME` : undefined}
        pillTone={k && k.punctuality_pct !== null ? (k.punctuality_pct >= 90 ? 'good' : k.punctuality_pct >= 70 ? 'default' : 'warn') : 'default'}
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingTop: 8, paddingBottom: insets.bottom + 32}}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={OB.accentSoft} />}>
        {data?.member ? (
          <Card style={{gap: 3}}>
            <Text style={s.who} numberOfLines={1}>
              {data.member.call_sign ? `${data.member.call_sign} · ` : ''}{data.member.department ?? 'No department'}
            </Text>
            {data.member.member_since ? (
              <Text style={s.since}>Member since {new Date(data.member.member_since).toLocaleDateString('en-GB', {day: '2-digit', month: 'short', year: 'numeric'})}</Text>
            ) : null}
          </Card>
        ) : null}

        <View style={s.rangeRow}>
          {RANGES.map(r => (
            <TouchableOpacity key={r.key} style={[s.chip, range === r.key && s.chipOn]} activeOpacity={0.8}
              accessibilityRole="button" accessibilityState={{selected: range === r.key}}
              onPress={() => setRange(r.key)}>
              <Text style={[s.chipText, range === r.key && s.chipTextOn]}>{r.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {error ? (
          <ErrorState message={error} onRetry={() => { void load(); }} />
        ) : !data ? (
          <LoadingView compact label="Loading record…" />
        ) : (
          <>
            <SectionLabel>KPIS</SectionLabel>
            <View style={s.kpiGrid}>
              <KpiTile label="Punctuality" value={k!.punctuality_pct === null ? '—' : `${k!.punctuality_pct}%`}
                color={k!.punctuality_pct === null ? OB.textMute : k!.punctuality_pct >= 90 ? OB.signal : k!.punctuality_pct >= 70 ? OB.amber : OB.alert}
                sub={`${k!.present} clean of ${k!.present + k!.late + k!.absent + k!.early_checkout} expected`} />
              <KpiTile label="Clean streak" value={String(k!.clean_streak)} color={OB.signal} sub="consecutive on-time days" />
              <KpiTile label="Present" value={String(k!.present)} color={OB.signal} />
              <KpiTile label="Late" value={String(k!.late)} color={OB.amber}
                sub={k!.avg_late_minutes !== null ? `avg ${k!.avg_late_minutes} min late` : undefined} />
              <KpiTile label="Absent" value={String(k!.absent)} color={OB.alert} />
              <KpiTile label="Early out" value={String(k!.early_checkout)} color={OB.amber} />
              <KpiTile label="Hours on duty" value={k!.hours_on_duty.toFixed(1)} sub="closed sessions" />
              <KpiTile label="Leave / off" value={String(k!.leave)} color={OB.accentSoft}
                sub={k!.pending_review > 0 ? `${k!.pending_review} pending review` : undefined} />
            </View>

            <View style={{marginTop: 18}}>
              <SectionLabel>HISTORY · {data.sessions.length}</SectionLabel>
              {data.sessions.length === 0 ? (
                <Card><Text style={s.empty}>No sessions in this window.</Text></Card>
              ) : (
                <View style={{gap: 10}}>
                  {data.sessions.map(row => (
                    <SessionRow key={row.id} s={row} showName={false} onOpenMap={openMap} onOpenPhoto={setPhotoFor} />
                  ))}
                </View>
              )}
            </View>
          </>
        )}
      </ScrollView>
      <CheckInPhotoModal sessionId={photoFor?.id ?? null} memberName={name} onClose={() => setPhotoFor(null)} />
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  who: {color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 12.5},
  since: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 10, letterSpacing: 0.4},
  rangeRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12, marginBottom: 12},
  chip: {paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)', backgroundColor: 'rgba(255,255,255,0.03)'},
  chipOn: {borderColor: 'rgba(91,141,239,0.55)', backgroundColor: 'rgba(91,141,239,0.14)'},
  chipText: {color: OB.textDim, fontFamily: BravoFont.semiBold, fontSize: 11.5},
  chipTextOn: {color: OB.accentSoft},
  kpiGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8},
  empty: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12, textAlign: 'center'},
}));
