/**
 * The Secure shell's "Summary" tab — the client's BOOKINGS surface.
 *
 * B-786 (founder, 2026-09-03): _"the booking summary is not ok, no history
 * coming. this should be very rich, like each booking with type, payment, time,
 * category, all industry standard."_ This screen used to render exactly ONE
 * in-flight booking or an empty state, with no list and no door to one — while
 * `secureFlowTab.ts` already mapped BookingHistory to this tab as "the list of
 * summaries". For a Pro-active client (whose Home is ProDashboard, B-661, with
 * no "View All") the history was reachable only from the profile drawer.
 *
 * Now it is the pinned active-mission card ON TOP OF the shared, filterable,
 * month-grouped history (`BookingHistoryList`) — the same component the pushed
 * "My Bookings" screen renders, so the two can never drift.
 *
 * The ACTIVE card is deliberately unchanged: it still reads `useBookingStore`
 * through the shared `findResumableBooking` / `resumeTargetFor` resolvers, and
 * it still does NOT auto-navigate. This tab is where the user CHOSE to look at
 * their mission, so it presents a card and lets them tap (B-405 / LB17). The
 * resume navigate still bubbles up to BookingNavigator, which owns the routes.
 */
import React, {useCallback, useMemo} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, StatusBar} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import FitLine from '@components/ui/FitLine';
import {UI} from '@components/ui/tokens';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {useBookingStore} from '@store/bookingStore';
import {describeStatus, findResumableBooking} from './bookingStatus';
import {buildHistoryRow, serviceTitle} from './bookingHistoryRows';
import {BookingHistoryList, openBookingFromRow, s as listStyles} from './BookingHistoryList';

type Nav = NativeStackNavigationProp<BookingStackParamList>;

export default function SecureSummaryScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  const bookings = useBookingStore(st => st.bookings);
  const loadBookings = useBookingStore(st => st.loadBookings);

  const active = findResumableBooking(bookings);
  const status = active ? describeStatus(active.status) : null;

  // The list drives refresh (focus + pull-to-refresh); the active card's own
  // model rides along so both halves of the screen refresh together.
  const refreshActive = useCallback(() => { void loadBookings(); }, [loadBookings]);

  // Memoised: the resume model polls, and rebuilding this subtree on every tick
  // re-mounts views for no reason (view mounting is the measured cost here).
  const activeCard = useMemo(() => (active && status ? (
    <TouchableOpacity
      style={listStyles.activeCard}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={`Resume ${serviceTitle(active)}, ${status.label}`}
      onPress={() => openBookingFromRow(navigation, active.id, active.status, active.mission_status)}>
      <View style={listStyles.activeTop}>
        <View style={[listStyles.dot, {backgroundColor: status.color}]} />
        <FitLine style={[listStyles.activeStatus, {color: status.color}]} text={status.label} />
      </View>
      <Text style={listStyles.activeTitle} numberOfLines={1}>{serviceTitle(active)}</Text>
      <Text style={listStyles.activeSub} numberOfLines={1}>
        {buildHistoryRow(active).when || 'Active mission'}
      </Text>
      <View style={listStyles.activeCta}>
        <Text style={listStyles.activeCtaText}>View mission</Text>
        <Icon name="arrow-right" size={16} color={UI.accent} />
      </View>
    </TouchableOpacity>
  ) : null), [active, status, navigation]);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg} />
      <AmbientBg />
      <BookingHistoryList
        eyebrow="BRAVO SECURE"
        title="Bookings"
        activeCard={activeCard}
        // The pinned card IS this booking — without this it also appears as a
        // row a few pixels below itself.
        excludeId={active?.id ?? null}
        onRefreshExtra={refreshActive}
        paddingTop={insets.top + 20}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: UI.bg},
});
