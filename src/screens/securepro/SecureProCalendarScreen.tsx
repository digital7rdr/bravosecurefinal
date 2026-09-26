/**
 * Bravo Secure Pro — premium period calendar (founder spec: "AI Itinerary" v1).
 *
 * A month-grid calendar spanning the plan's coverage period (e.g. Aug–Oct for
 * a 3-month plan). Mission dates are highlighted: SCHEDULED solid cobalt,
 * REQUESTED amber ring. "Request Dates" flips into select mode — tap future
 * in-coverage days, add a note, submit → the Bravo Control System schedules
 * CPOs/responsibilities for those dates (no per-mission charge, covered by
 * the plan).
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar,
  TextInput, Modal, Pressable, ActivityIndicator, useWindowDimensions,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {secureProApi, type ProPlanMission} from '@services/api';
import {useSecureProStore} from '@store/secureProStore';
import {useAuthStore} from '@store/authStore';
import {useProPlanGate} from '@hooks/useProPlanGate';
import {useProAppRealtime} from './useProAppRealtime';
import {todayGulf} from './gulfDay';
import {monthsBetween, initialMonthIndex} from './calendarMonths';
import {
  paintedDateStatus, missionsByDate, paintedDaysByMonth, MISSION_STATUS_TONE,
  requesterOf, requesterChips, filterByRequester, REQUESTER_ALL, REQUESTER_SELF,
  type PlanViewer,
} from './calendarMissions';
import {Alert} from '@utils/alert';
import {scaleTextStyles} from '@utils/scaling';
import {formatDateRanges, fmtDateUtc, fmtDateTimeUtc} from '@utils/datetime';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'SecureProCalendar'>;

const D = {
  bg:         '#0A1F3F',
  text:       '#FFFFFF',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  textFaint:  'rgba(180,188,204,0.22)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#1E88FF',
  accentDeep: '#166ED1',
  accentSoft: '#3BA6FF',
  signal:     '#4ADE80',
  amber:      '#F5C76B',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/** Status word leading each REQUESTS row — the legend's own labels. */
const MISSION_STATUS_LABEL: Record<ProPlanMission['status'], string> = {
  REQUESTED: 'Requested',
  SCHEDULED: 'Scheduled',
  DECLINED: 'Declined',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

function ymd(y: number, m: number, d: number): string {
  return `${y}-${`${m + 1}`.padStart(2, '0')}-${`${d}`.padStart(2, '0')}`;
}

/** "Wed 26 Aug 2026" — the app's UTC day format plus the year the sheet needs. */
function dayWithYear(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${fmtDateUtc(d)} ${d.getUTCFullYear()}`;
}

/** Month cells (Monday-first), null = leading/trailing blank. */
function monthCells(y: number, m: number): Array<number | null> {
  const first = new Date(Date.UTC(y, m, 1));
  const lead = (first.getUTCDay() + 6) % 7; // Mon=0
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cells: Array<number | null> = Array(lead).fill(null);
  for (let d = 1; d <= days; d++) {cells.push(d);}
  while (cells.length % 7 !== 0) {cells.push(null);}
  return cells;
}

export default function SecureProCalendarScreen() {
  const insets = useSafeAreaInsets();
  const {contentBottom, bottomPad} = useBottomInset();
  // Why: the note sheet is a transparent Modal under edge-to-edge — it owns its
  // own bottom inset (nav bar when the IME is closed, keyboard when it is up).
  const {bottomPad: kbBottomPad} = useKeyboardLayout();
  const {height: winHeight} = useWindowDimensions();
  useProPlanGate(); // Audit Rev2 SP-01 — activation gate (loads the app + redirects)
  const navigation = useNavigation<Nav>();
  const application = useSecureProStore(st => st.application);
  const selfId = useAuthStore(st => st.user?.id);
  // B-852 — `via_owner` is set by the server ONLY when this plan is the family
  // holder's, surfaced to a linked member. Its absence is the holder signal, so
  // the holder is the one viewer whose id we can pin to the plan; a member has
  // no way to name the holder, which is why `isHolder` travels separately.
  const isHolder = !application?.via_owner;
  const viewer = useMemo<PlanViewer>(
    () => ({isHolder, holderId: isHolder ? selfId : null}),
    [isHolder, selfId],
  );

  const [missions, setMissions] = useState<ProPlanMission[]>([]);
  const [loading, setLoading] = useState(true);
  // B-814 — null until the user pages: the page the calendar OPENS on is
  // derived from today (Gulf day) inside the covered period, never index 0.
  const [monthIx, setMonthIx] = useState<number | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  // B-821 — the day/row detail sheet. Why: content and visibility are SEPARATE
  // state. Clearing the content on close empties the card while the Modal is
  // still sliding down, so the sheet visibly collapses on its own dismiss.
  const [sheet, setSheet] = useState<{title: string; missions: ProPlanMission[]} | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // B-852 — which rider's dates the whole screen is showing. Not persisted.
  const [requesterKey, setRequesterKey] = useState<string>(REQUESTER_ALL);
  // E2E-07 — releasing a reserved date. The in-flight set is a REF, not state:
  // a `disabled={state}` alone loses the race to a double tap (the second press
  // lands before React commits), and this call releases officers.
  const releasingRef = useRef<Set<string>>(new Set());
  // Keyed BY MISSION ID, not a single id: two releases can overlap, and the
  // second one's `finally` would otherwise clear the first one's spinner.
  const [releasing, setReleasing] = useState<Set<string>>(new Set());

  const appId = application?.id;
  const loadMissions = useCallback(async () => {
    if (!appId) {return;}
    try {
      const {data} = await secureProApi.missions(appId);
      setMissions(data.missions);
    } catch {
      // keep last good list
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useFocusEffect(useCallback(() => {
    void loadMissions();
  }, [loadMissions]));
  useProAppRealtime(appId, () => { void loadMissions(); });

  const proposal = application?.proposal ?? null;
  const coverageStart = proposal?.coverage_start ?? application?.start_date ?? null;
  const coverageEnd = proposal?.coverage_end ?? null;

  const months = useMemo(
    () => (coverageStart && coverageEnd ? monthsBetween(coverageStart, coverageEnd) : []),
    [coverageStart, coverageEnd],
  );
  const safeIx = Math.min(
    monthIx ?? initialMonthIndex(months, todayGulf()),
    Math.max(0, months.length - 1),
  );

  // B-852 — ONE filtered list feeds paint, the month chips, REQUESTS and both
  // sheets. Anything reading `missions` directly below this line would show a
  // filtered-out rider's dates on one surface and hide them on the next.
  const requesterOptions = useMemo(
    () => requesterChips(missions, selfId, viewer),
    [missions, selfId, viewer],
  );
  // SELECT MODE IS ALWAYS UNFILTERED. The grid is what stops the client
  // double-booking a date they already hold, so a rider filter must never be
  // able to paint a reserved day as free. Derived, not a reset, so no future
  // edit can leave a path into select mode that forgets to clear the key.
  const activeRequester = !selectMode && requesterOptions.some(c => c.key === requesterKey)
    ? requesterKey
    : REQUESTER_ALL;
  const visibleMissions = useMemo(
    () => filterByRequester(missions, activeRequester, selfId, viewer),
    [missions, activeRequester, selfId, viewer],
  );

  // A rider whose last request is released loses their chip. Drop the key with
  // it: parking it would silently re-apply the old filter the moment they book
  // again, and the calendar would go quiet on everyone else's dates.
  useEffect(() => {
    if (requesterKey !== REQUESTER_ALL && !requesterOptions.some(c => c.key === requesterKey)) {
      setRequesterKey(REQUESTER_ALL);
    }
  }, [requesterOptions, requesterKey]);

  const dateStatus = useMemo(() => paintedDateStatus(visibleMissions), [visibleMissions]);
  const byDate = useMemo(() => missionsByDate(visibleMissions), [visibleMissions]);
  const bookedMonths = useMemo(() => paintedDaysByMonth(dateStatus, months), [dateStatus, months]);

  // E2E-09 — the Gulf calendar day, the SAME definition the server validates
  // `date_in_past` against and activates the mission on. A UTC "today" let the
  // grid offer a day the server then refused, and vice versa.
  const today = todayGulf();

  const toggleDay = (iso: string) => {
    if (!selectMode) {return;}
    if (iso < today || (coverageStart && iso < coverageStart) || (coverageEnd && iso > coverageEnd)) {return;}
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(iso)) {next.delete(iso);} else if (next.size < 31) {next.add(iso);}
      return next;
    });
  };

  const submitRequest = async () => {
    if (!appId || selected.size === 0 || busy) {return;}
    setBusy(true);
    try {
      const r = await secureProApi.requestMission(appId, [...selected].sort(), note.trim() || undefined);
      setNoteOpen(false);
      setSelectMode(false);
      setSelected(new Set());
      setNote('');
      await loadMissions();
      // Dedicated-officer fast path: a covered request comes back SCHEDULED.
      if (r.data.mission.status === 'SCHEDULED') {
        Alert.alert('Protection scheduled', 'Your dedicated officer covers those dates — no further approval needed.');
      } else {
        Alert.alert('Request sent', 'The Bravo Control System will schedule your protection for those dates.');
      }
    } catch (e) {
      const code = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Could not send request',
        code === 'date_outside_coverage' ? 'One of the dates is outside your covered period.'
          : code === 'plan_not_active' ? 'Your plan is not active.'
          : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  /** A reservation the client may still release themselves (E2E-07): open, and
   *  every date still ahead. Once a date is TODAY the officer is dedicated and a
   *  session may be live, so that case belongs to ops. */
  const canRelease = useCallback(
    (mi: ProPlanMission) =>
      (mi.status === 'REQUESTED' || mi.status === 'SCHEDULED') &&
      mi.mission_dates.every(d => d > today),
    [today],
  );

  /** B-852 — the plan holder releases anyone's dates; a member only their own.
   *  The server refuses the rest (403 not_your_mission), so offering the button
   *  would only ever produce an error the tapper cannot act on. */
  const mayRelease = useCallback(
    (mi: ProPlanMission) =>
      canRelease(mi) && (isHolder || requesterOf(mi, selfId, viewer).kind === 'self'),
    [canRelease, isHolder, selfId, viewer],
  );

  const releaseMission = (mi: ProPlanMission) => {
    if (!appId || releasingRef.current.has(mi.id)) {return;}
    Alert.alert(
      'Release these dates?',
      `${formatDateRanges(mi.mission_dates)} will be removed from your calendar and any assigned officer released. Your plan is unchanged — reserved dates carry no charge.`,
      [
        {text: 'Keep', style: 'cancel'},
        {
          text: 'Release', style: 'destructive',
          onPress: () => {
            if (releasingRef.current.has(mi.id)) {return;}
            releasingRef.current.add(mi.id);
            setReleasing(prev => new Set(prev).add(mi.id));
            void (async () => {
              try {
                await secureProApi.cancelMission(appId, mi.id);
                await loadMissions();
              } catch (e) {
                const code = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
                Alert.alert('Could not release',
                  code === 'mission_already_started'
                    ? 'These dates have started. Message the Bravo Control System to stand the team down.'
                    : code === 'mission_has_live_session'
                      ? 'Protection is live on these dates. Message the Bravo Control System to stand the team down.'
                      : 'Please try again.');
              } finally {
                releasingRef.current.delete(mi.id);
                setReleasing(prev => {
                  const next = new Set(prev);
                  next.delete(mi.id);
                  return next;
                });
              }
            })();
          },
        },
      ],
    );
  };

  const openMission = (mi: ProPlanMission) => {
    const first = [...mi.mission_dates].sort()[0];
    if (first) {
      const ix = months.findIndex(([yy, mm]) => yy === Number(first.slice(0, 4)) && mm === Number(first.slice(5, 7)) - 1);
      if (ix >= 0) {setMonthIx(ix);}
    }
    setSheet({title: formatDateRanges(mi.mission_dates), missions: [mi]});
    setSheetOpen(true);
  };

  const [year, month] = months[safeIx] ?? [new Date().getFullYear(), new Date().getMonth()];
  const cells = monthCells(year, month);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View pointerEvents="none" style={s.ambient} />

      <View style={s.header}>
        <TouchableOpacity
          style={s.back}
          onPress={() => goBackOnce(navigation)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="chevron-left" size={20} color={D.text} />
        </TouchableOpacity>
        <View style={{flex: 1, minWidth: 0}}>
          <Text style={s.headerTitle}>Coverage Calendar</Text>
          <FitLine style={s.headerSub} text={coverageStart && coverageEnd
              ? `${coverageStart.slice(0, 10)} → ${coverageEnd.slice(0, 10)} · BRAVO SECURE PRO`
              : 'BRAVO SECURE PRO'} />
        </View>
      </View>

      {!application || (loading && missions.length === 0) ? (
        <View style={s.centerFill}><ActivityIndicator color={D.accent} /></View>
      ) : !coverageStart || !coverageEnd ? (
        <View style={s.centerFill}>
          <Icon name="calendar-blank-outline" size={28} color={D.textMute} />
          <Text style={s.emptyTitle}>No covered period yet</Text>
          <Text style={s.emptySub}>Your calendar appears once your Pro plan is active.</Text>
        </View>
      ) : (
        <>
          <ScrollView
            style={{flex: 1}}
            contentContainerStyle={{paddingHorizontal: 20, paddingBottom: contentBottom(120)}}
            showsVerticalScrollIndicator={false}>

            {/* B-852 — whose dates. Only when this plan carries more than one
                rider's bookings; a single-rider plan sees nothing new. Hidden
                in select mode, where the grid is deliberately unfiltered. */}
            {!selectMode && requesterOptions.length > 0 && (
              <View style={s.whoseRow}>
                {requesterOptions.map(chip => {
                  const on = chip.key === activeRequester;
                  return (
                    <TouchableOpacity
                      key={chip.key}
                      style={[s.whoseChip, on && s.whoseChipOn]}
                      activeOpacity={0.75}
                      onPress={() => setRequesterKey(chip.key)}
                      testID={`pro-requester-chip-${chip.key}`}
                      accessibilityRole="button"
                      accessibilityLabel={
                        chip.key === REQUESTER_ALL ? 'Show all dates'
                          : chip.key === REQUESTER_SELF ? 'Show dates you booked'
                          : `Show dates booked by ${chip.label}`}
                      accessibilityState={{selected: on}}>
                      <Text style={[s.whoseChipText, on && {color: D.accentSoft}]} numberOfLines={1}>
                        {chip.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {/* Month pager */}
            <View style={s.pager}>
              <TouchableOpacity
                style={[s.pagerBtn, safeIx === 0 && {opacity: 0.35}]}
                disabled={safeIx === 0}
                onPress={() => setMonthIx(Math.max(0, safeIx - 1))}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel="Previous month">
                <Icon name="chevron-left" size={19} color={D.text} />
              </TouchableOpacity>
              <View style={{alignItems: 'center', flex: 1, minWidth: 0}}>
                <Text style={s.pagerTitle}>{MONTHS[month]} {year}</Text>
                <View style={s.pagerDots}>
                  {months.map(([, mm], i) => (
                    <View key={`${mm}-${i}`} style={[s.pagerDot, i === safeIx && s.pagerDotOn]} />
                  ))}
                </View>
              </View>
              <TouchableOpacity
                style={[s.pagerBtn, safeIx >= months.length - 1 && {opacity: 0.35}]}
                disabled={safeIx >= months.length - 1}
                onPress={() => setMonthIx(Math.min(months.length - 1, safeIx + 1))}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel="Next month">
                <Icon name="chevron-right" size={19} color={D.text} />
              </TouchableOpacity>
            </View>

            {/* Grid */}
            <LinearGradient
              colors={['rgba(20,32,60,0.6)', 'rgba(11,15,23,0.55)']}
              start={{x: 0.5, y: 0}}
              end={{x: 0.5, y: 1}}
              style={s.gridCard}>
              <View style={s.dowRow}>
                {DOW.map((d, i) => (
                  <Text key={`${d}-${i}`} style={s.dowText}>{d}</Text>
                ))}
              </View>
              <View style={s.grid}>
                {cells.map((day, i) => {
                  if (day === null) {
                    return <View key={i} style={s.cell} />;
                  }
                  const iso = ymd(year, month, day);
                  const status = dateStatus.get(iso);
                  const inCoverage = iso >= coverageStart && iso <= coverageEnd;
                  const past = iso < today;
                  const isSel = selected.has(iso);
                  const isToday = iso === today;
                  const dayMissions = byDate.get(iso);
                  const hasDetail = !selectMode && !!dayMissions && dayMissions.length > 0;
                  return (
                    <TouchableOpacity
                      key={i}
                      style={s.cell}
                      activeOpacity={(selectMode ? inCoverage && !past : hasDetail) ? 0.7 : 1}
                      onPress={() => {
                        if (selectMode) {toggleDay(iso); return;}
                        if (dayMissions?.length) {
                          setSheet({title: dayWithYear(iso), missions: dayMissions});
                          setSheetOpen(true);
                        }
                      }}
                      testID={`pro-day-${iso}`}
                      accessibilityRole={selectMode || hasDetail ? 'button' : 'text'}
                      accessibilityLabel={`${day} ${MONTHS[month]}${status ? `, ${status.toLowerCase()}` : ''}`}>
                      <View style={[
                        s.dayDot,
                        !inCoverage && {opacity: 0.25},
                        status === 'SCHEDULED' && s.dayScheduled,
                        status === 'COMPLETED' && s.dayCompleted,
                        status === 'REQUESTED' && s.dayRequested,
                        isSel && s.daySelected,
                        isToday && !status && !isSel && s.dayToday,
                      ]}>
                        <Text style={[
                          s.dayText,
                          past && !status && {color: D.textFaint},
                          (status === 'SCHEDULED' || isSel) && {color: '#fff', fontFamily: D.fBold},
                          status === 'COMPLETED' && !isSel && {color: D.accentSoft, fontFamily: D.fBold},
                          status === 'REQUESTED' && {color: D.amber},
                        ]}>
                          {day}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </LinearGradient>

            {/* Legend */}
            <View style={s.legendRow}>
              <View style={s.legendItem}><View style={[s.legendDot, {backgroundColor: D.accent}]} /><Text style={s.legendText}>Scheduled</Text></View>
              <View style={s.legendItem}><View style={[s.legendDot, {borderWidth: 1.5, borderColor: D.amber, backgroundColor: 'transparent'}]} /><Text style={s.legendText}>Requested</Text></View>
              <View style={s.legendItem}><View style={[s.legendDot, s.dayCompleted]} /><Text style={s.legendText}>Completed</Text></View>
              {selectMode && (
                <View style={s.legendItem}><View style={[s.legendDot, {backgroundColor: D.signal}]} /><Text style={s.legendText}>Selected · {selected.size}</Text></View>
              )}
            </View>

            {/* Booked days per month — the founder's ten August days were a page away */}
            {bookedMonths.length > 0 && (
              <>
                <Text style={[s.sectionLabel, {marginTop: 14}]}>BOOKED DAYS</Text>
                <View style={s.chipRow}>
                  {bookedMonths.map(({ix, count}) => {
                    const on = ix === safeIx;
                    return (
                      <TouchableOpacity
                        key={ix}
                        style={[s.monthChip, on && s.monthChipOn]}
                        activeOpacity={0.75}
                        onPress={() => setMonthIx(ix)}
                        testID={`pro-month-chip-${ix}`}
                        accessibilityRole="button"
                        accessibilityLabel={`${MONTHS[months[ix][1]]}, ${count} booked day${count > 1 ? 's' : ''}`}>
                        <Text style={[s.monthChipText, on && {color: D.accentSoft}]}>
                          {`${MONTHS[months[ix][1]].slice(0, 3)} · ${count}`}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </>
            )}

            {/* Upcoming */}
            {visibleMissions.length > 0 && (
              <>
                <Text style={s.sectionLabel}>REQUESTS</Text>
                <View style={{gap: 9}}>
                  {visibleMissions.map(mi => {
                    const who = requesterOf(mi, selfId, viewer);
                    return (
                      <TouchableOpacity
                        key={mi.id}
                        style={s.missionRow}
                        activeOpacity={0.75}
                        onPress={() => openMission(mi)}
                        testID={`pro-mission-row-${mi.id}`}
                        accessibilityRole="button"
                        accessibilityLabel={`Open request, ${formatDateRanges(mi.mission_dates, {prefix: MISSION_STATUS_LABEL[mi.status]})}${who.kind === 'other' ? `, booked by ${who.name}` : ''}`}>
                        <Icon
                          name={mi.status === 'SCHEDULED' ? 'calendar-check' : mi.status === 'REQUESTED' ? 'calendar-clock' : mi.status === 'DECLINED' ? 'calendar-remove' : mi.status === 'CANCELLED' ? 'calendar-remove-outline' : 'calendar-check-outline'}
                          size={17}
                          color={mi.status === 'SCHEDULED' ? D.signal : mi.status === 'REQUESTED' ? D.amber : D.textMute}
                        />
                        <View style={s.missionBody}>
                          <Text style={s.missionText} numberOfLines={2}>
                            {mi.mission_dates.length} date{mi.mission_dates.length > 1 ? 's' : ''} · {formatDateRanges(mi.mission_dates, {prefix: MISSION_STATUS_LABEL[mi.status]})}
                          </Text>
                          {who.kind === 'other' ? (
                            <Text style={s.missionBy} numberOfLines={1} testID={`pro-mission-by-${mi.id}`}>
                              {`Booked by ${who.name}`}
                            </Text>
                          ) : null}
                        </View>
                        {mayRelease(mi) ? (
                          <TouchableOpacity
                            onPress={() => releaseMission(mi)}
                            disabled={releasing.has(mi.id)}
                            activeOpacity={0.7}
                            hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
                            accessibilityRole="button"
                            accessibilityLabel={`Release ${mi.mission_dates.length} reserved date${mi.mission_dates.length > 1 ? 's' : ''}`}
                            accessibilityState={{disabled: releasing.has(mi.id)}}
                            testID={`pro-mission-release-${mi.id}`}>
                            <Text style={[s.missionStatus, {color: releasing.has(mi.id) ? D.textFaint : D.textDim}]}>
                              {releasing.has(mi.id) ? '…' : 'RELEASE'}
                            </Text>
                          </TouchableOpacity>
                        ) : (
                          <Text style={[s.missionStatus, {
                            color: mi.status === 'SCHEDULED' ? D.signal : mi.status === 'REQUESTED' ? D.amber : D.textMute,
                          }]}>
                            {mi.status}
                          </Text>
                        )}
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </>
            )}
          </ScrollView>

          {/* CTA */}
          <LinearGradient
            colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
            locations={[0, 0.5]}
            style={[s.ctaWrap, {paddingBottom: bottomPad(12)}]}>
            {selectMode ? (
              <View style={{flexDirection: 'row', gap: 10}}>
                <TouchableOpacity
                  style={s.ghostBtn}
                  activeOpacity={0.8}
                  onPress={() => { setSelectMode(false); setSelected(new Set()); }}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel selection">
                  <Text style={s.ghostText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={{flex: 1.6}}
                  activeOpacity={0.9}
                  disabled={selected.size === 0}
                  onPress={() => setNoteOpen(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Continue with selected dates"
                  accessibilityState={{disabled: selected.size === 0}}>
                  <LinearGradient
                    colors={selected.size === 0
                      ? ['rgba(91,141,239,0.35)', 'rgba(91,141,239,0.35)', 'rgba(47,91,224,0.35)']
                      : ['#3BA6FF', D.accent, D.accentDeep]}
                    locations={[0, 0.55, 1]}
                    start={{x: 0, y: 0}}
                    end={{x: 0, y: 1}}
                    style={s.cta}>
                    <Text style={s.ctaText}>
                      {selected.size === 0 ? 'Tap dates to select' : `Request ${selected.size} date${selected.size > 1 ? 's' : ''}`}
                    </Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            ) : application.status === 'ACTIVE' ? (
              <TouchableOpacity
                activeOpacity={0.9}
                onPress={() => setSelectMode(true)}
                accessibilityRole="button"
                accessibilityLabel="Request protection dates">
                <LinearGradient
                  colors={['#3BA6FF', D.accent, D.accentDeep]}
                  locations={[0, 0.55, 1]}
                  start={{x: 0, y: 0}}
                  end={{x: 0, y: 1}}
                  style={s.cta}>
                  <Icon name="calendar-plus" size={18} color="#fff" importantForAccessibility="no" />
                  <Text style={s.ctaText}>Request Protection Dates</Text>
                </LinearGradient>
              </TouchableOpacity>
            ) : null}
          </LinearGradient>
        </>
      )}

      {/* Note sheet */}
      <Modal visible={noteOpen} transparent animationType="slide" onRequestClose={() => { if (!busy) {setNoteOpen(false);} }}>
        <Pressable style={s.sheetBackdrop} onPress={() => { if (!busy) {setNoteOpen(false);} }}>
          <Pressable style={[s.sheetCard, {paddingBottom: kbBottomPad(24)}]} onPress={() => {}}>
            <Text style={s.sheetTitle}>Request {selected.size} date{selected.size > 1 ? 's' : ''}</Text>
            {/* numberOfLines caps a pathological many-non-consecutive selection so
                the range summary can't push the note field off the sheet. */}
            <Text style={s.sheetSub} numberOfLines={2}>
              {formatDateRanges([...selected])}
            </Text>
            <TextInput
              style={s.sheetInput}
              value={note}
              onChangeText={setNote}
              placeholder="Anything the team should know for these dates… (optional)"
              placeholderTextColor={D.textMute}
              selectionColor={D.accent}
              multiline
              maxLength={1000}
              textAlignVertical="top"
            />
            <TouchableOpacity
              activeOpacity={0.9}
              disabled={busy}
              onPress={() => { void submitRequest(); }}
              accessibilityRole="button"
              accessibilityLabel="Send request">
              <LinearGradient
                colors={['#3BA6FF', D.accent, D.accentDeep]}
                locations={[0, 0.55, 1]}
                start={{x: 0, y: 0}}
                end={{x: 0, y: 1}}
                style={s.sheetCta}>
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.ctaText}>Send Request</Text>}
              </LinearGradient>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Day / request detail sheet */}
      <Modal visible={sheetOpen} transparent animationType="slide" onRequestClose={() => setSheetOpen(false)}>
        <Pressable style={s.sheetBackdrop} onPress={() => setSheetOpen(false)}>
          <Pressable style={[s.sheetCard, {paddingBottom: kbBottomPad(24)}]} onPress={() => {}} testID="pro-day-sheet">
            <Text style={s.sheetTitle}>{sheet?.title ?? ''}</Text>
            <ScrollView
              style={{maxHeight: winHeight * 0.68}}
              bounces={false}
              showsVerticalScrollIndicator={false}>
              <View style={{gap: 11, paddingTop: 14}}>
                {(sheet?.missions ?? []).map(mi => {
                  const tone = MISSION_STATUS_TONE[mi.status];
                  const who = requesterOf(mi, selfId, viewer);
                  return (
                    <View key={mi.id} style={s.detailCard} testID={`pro-day-mission-${mi.id}`}>
                      <View style={[s.pill, {backgroundColor: tone.bg, borderColor: tone.border}]}>
                        <Text style={[s.pillText, {color: tone.color}]}>{MISSION_STATUS_LABEL[mi.status]}</Text>
                      </View>
                      <Text style={s.detailDates}>
                        {`${mi.mission_dates.length} date${mi.mission_dates.length > 1 ? 's' : ''} · ${formatDateRanges(mi.mission_dates)}`}
                      </Text>
                      {who.kind === 'other' ? (
                        <Text style={s.detailBy} testID={`pro-day-by-${mi.id}`}>
                          {`Booked by ${who.name}`}
                        </Text>
                      ) : null}
                      {mi.note ? (
                        <>
                          <Text style={s.detailLabel}>{who.kind === 'other' ? 'Note' : 'Your note'}</Text>
                          <Text style={s.detailBody}>{mi.note}</Text>
                        </>
                      ) : null}
                      {mi.assigned_team.length > 0 ? (
                        <>
                          <Text style={s.detailLabel}>Protection team</Text>
                          {mi.assigned_team.map((t, ti) => (
                            <View key={`${t.role}-${ti}`}>
                              <Text style={s.detailBody}>{`${t.count}× ${t.role}`}</Text>
                              {t.label ? <Text style={s.detailNames}>{t.label}</Text> : null}
                            </View>
                          ))}
                        </>
                      ) : null}
                      {mi.ops_note ? (
                        <>
                          <Text style={s.detailLabel}>Bravo Control System</Text>
                          <Text style={s.detailBody}>{mi.ops_note}</Text>
                        </>
                      ) : null}
                      <Text style={s.detailMeta}>{`Requested on ${dayWithYear(mi.created_at)}`}</Text>
                      {mi.activated_at ? (
                        <Text style={s.detailMeta}>{`Protection activated ${fmtDateTimeUtc(mi.activated_at)}`}</Text>
                      ) : null}
                      {mayRelease(mi) ? (
                        <TouchableOpacity
                          style={s.sheetGhost}
                          activeOpacity={0.8}
                          onPress={() => { setSheetOpen(false); releaseMission(mi); }}
                          testID={`pro-day-release-${mi.id}`}
                          accessibilityRole="button"
                          accessibilityLabel={`Release ${mi.mission_dates.length} reserved date${mi.mission_dates.length > 1 ? 's' : ''}`}>
                          <Text style={s.ghostText}>Release these dates</Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            </ScrollView>
            <TouchableOpacity
              style={s.sheetGhost}
              activeOpacity={0.8}
              onPress={() => setSheetOpen(false)}
              testID="pro-day-sheet-close"
              accessibilityRole="button"
              accessibilityLabel="Close details">
              <Text style={s.ghostText}>Close</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg, overflow: 'hidden'},

  ambient: {
    position: 'absolute', top: -100, alignSelf: 'center',
    width: 460, height: 280, borderRadius: 230,
    backgroundColor: 'rgba(91,141,239,0.07)',
  },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14,
  },
  back: {
    width: 40, height: 40, borderRadius: 12, flexShrink: 0,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: {fontFamily: D.fBold, fontSize: 21, letterSpacing: -0.5, color: D.text, lineHeight: 24},
  headerSub: {fontFamily: D.fMono, fontSize: 9, fontWeight: '600', letterSpacing: 1.2, color: D.textMute, marginTop: 5},

  centerFill: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 40},
  emptyTitle: {color: D.textDim, fontFamily: D.fBold, fontSize: 15},
  emptySub: {color: D.textMute, fontFamily: D.fSans, fontSize: 12, textAlign: 'center', lineHeight: 17},

  // B-852 — the "whose dates" filter. 44 dp tall so it clears the minimum
  // touch target on the smallest supported width without a hitSlop crutch.
  whoseRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14},
  whoseChip: {
    minHeight: 44, maxWidth: '100%', paddingHorizontal: 15, borderRadius: 13,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
  },
  whoseChipOn: {backgroundColor: 'rgba(91,141,239,0.16)', borderColor: 'rgba(91,141,239,0.5)'},
  whoseChipText: {color: D.textDim, fontFamily: D.fSemi, fontSize: 12.5},

  pager: {flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14},
  pagerBtn: {
    width: 38, height: 38, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  pagerTitle: {color: D.text, fontFamily: D.fBold, fontSize: 17, letterSpacing: -0.3},
  pagerDots: {flexDirection: 'row', gap: 5, marginTop: 6},
  pagerDot: {width: 5, height: 5, borderRadius: 3, backgroundColor: D.hair2},
  pagerDotOn: {backgroundColor: D.accentSoft, width: 14},

  gridCard: {
    borderRadius: 20, padding: 14, borderWidth: 1, borderColor: D.hair2, overflow: 'hidden',
  },
  dowRow: {flexDirection: 'row', marginBottom: 8},
  dowText: {
    flex: 1, textAlign: 'center',
    color: D.textMute, fontFamily: D.fMono, fontSize: 9.5, fontWeight: '700', letterSpacing: 1,
  },
  grid: {flexDirection: 'row', flexWrap: 'wrap'},
  cell: {width: `${100 / 7}%`, aspectRatio: 1, alignItems: 'center', justifyContent: 'center', padding: 3},
  dayDot: {
    width: '100%', height: '100%', borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
  },
  dayText: {color: D.textDim, fontFamily: D.fSemi, fontSize: 12.5},
  dayScheduled: {
    backgroundColor: D.accent,
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 10, shadowOffset: {width: 0, height: 4}, elevation: 5,
  },
  dayCompleted: {backgroundColor: 'rgba(91,141,239,0.20)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.55)'},
  dayRequested: {borderWidth: 1.5, borderColor: 'rgba(245,199,107,0.6)', backgroundColor: 'rgba(245,199,107,0.06)'},
  daySelected: {backgroundColor: '#2E9E5B'},
  dayToday: {borderWidth: 1, borderColor: 'rgba(91,141,239,0.5)'},

  legendRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 14, justifyContent: 'center'},
  legendItem: {flexDirection: 'row', alignItems: 'center', gap: 7},
  legendDot: {width: 11, height: 11, borderRadius: 6},
  legendText: {color: D.textMute, fontFamily: D.fSans, fontSize: 11.5},

  chipRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  monthChip: {
    minHeight: 32, paddingHorizontal: 12, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
  },
  monthChipOn: {backgroundColor: 'rgba(91,141,239,0.16)', borderColor: 'rgba(91,141,239,0.5)'},
  monthChipText: {color: D.textDim, fontFamily: D.fSemi, fontSize: 12},

  sectionLabel: {
    color: D.textDim, fontFamily: D.fMono, fontSize: 10, fontWeight: '600',
    letterSpacing: 2, textTransform: 'uppercase', marginTop: 22, marginBottom: 10,
  },
  missionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 11,
    padding: 13, borderRadius: 14,
    backgroundColor: 'rgba(22,27,37,0.72)', borderWidth: 1, borderColor: D.hair,
  },
  missionBody: {flex: 1, minWidth: 0},
  missionText: {color: D.text, fontFamily: D.fSemi, fontSize: 12.5},
  missionBy: {color: D.accentSoft, fontFamily: D.fSans, fontSize: 11.5, marginTop: 3},
  missionStatus: {fontFamily: D.fMono, fontSize: 9, fontWeight: '800', letterSpacing: 1},

  ctaWrap: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 28},
  cta: {
    minHeight: 54, borderRadius: 17,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  ctaText: {fontFamily: D.fBold, fontSize: 15, letterSpacing: 0.2, color: '#fff'},
  ghostBtn: {
    flex: 1, minHeight: 54, borderRadius: 17,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
  },
  ghostText: {color: D.textDim, fontFamily: D.fSemi, fontSize: 14},

  sheetBackdrop: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)'},
  sheetCard: {
    backgroundColor: '#10151F', borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: 20, paddingTop: 20,
  },
  sheetTitle: {color: D.text, fontFamily: D.fBold, fontSize: 17},
  sheetSub: {color: D.textMute, fontFamily: D.fMono, fontSize: 10.5, marginTop: 7, letterSpacing: 0.4},
  sheetInput: {
    marginTop: 14, borderRadius: 13, paddingHorizontal: 14, paddingVertical: 12,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
    color: D.text, fontFamily: D.fSans, fontSize: 13.5, minHeight: 84,
  },
  sheetCta: {
    minHeight: 52, borderRadius: 15, marginTop: 14,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  sheetGhost: {
    minHeight: 48, borderRadius: 14, marginTop: 12,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
  },

  detailCard: {
    borderRadius: 16, padding: 14,
    backgroundColor: 'rgba(22,27,37,0.72)', borderWidth: 1, borderColor: D.hair,
  },
  pill: {alignSelf: 'flex-start', paddingVertical: 4, paddingHorizontal: 9, borderRadius: 7, borderWidth: 1},
  pillText: {fontFamily: D.fMono, fontSize: 9.5, fontWeight: '800', letterSpacing: 0.6},
  detailDates: {color: D.text, fontFamily: D.fSemi, fontSize: 13, lineHeight: 18, marginTop: 10},
  detailBy: {color: D.accentSoft, fontFamily: D.fSemi, fontSize: 12, lineHeight: 17, marginTop: 6},
  detailLabel: {
    color: D.textMute, fontFamily: D.fMono, fontSize: 9, fontWeight: '700',
    letterSpacing: 1.2, textTransform: 'uppercase', marginTop: 12,
  },
  detailBody: {color: D.textDim, fontFamily: D.fSans, fontSize: 12.5, lineHeight: 18, marginTop: 5},
  detailNames: {color: D.accentSoft, fontFamily: D.fSemi, fontSize: 12, lineHeight: 17, marginTop: 2},
  detailMeta: {color: D.textMute, fontFamily: D.fMono, fontSize: 10, letterSpacing: 0.3, marginTop: 12},
}));
