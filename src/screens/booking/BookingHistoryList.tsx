/**
 * B-786 — the shared BOOKING HISTORY list.
 *
 * ONE implementation behind two doors, so they cannot drift:
 *   - `SecureSummaryScreen` — the Secure shell's Summary TAB, with the pinned
 *     active-mission card above the list;
 *   - `BookingHistoryScreen` — the pushed "My Bookings" screen that every
 *     existing door already points at (profile drawer, Profile, Dashboard,
 *     Home's "View All", and now the Pro dashboard's "Activity & Reports").
 *
 * Keeping the pushed route alive is deliberate. Its callers pass `initial:
 * false` to seed BookingHome beneath it (the cold-stack-seed rule, BB-*), and
 * re-pointing them at a nested tab would re-open that class for no product gain.
 *
 * Founder, 2026-09-03: _"no history coming … each booking with type, payment,
 * time, category, all industry standard."_ So a row answers five questions:
 * WHAT (service + task type), WHEN (date AND time, LOCAL — B-786b), WHERE,
 * WHAT HAPPENED (one chip carrying status AND where the money is), HOW MUCH
 * (amount + how it was paid). The view-model behind it is `bookingHistoryRows`,
 * which the node `booking` Jest project pins.
 *
 * A windowed SectionList, never a ScrollView of cards: the measured cost on
 * this app is UI-thread view MOUNTING (B-279/B-285), so an unwindowed history
 * is the one thing that would make this screen the lag the founder reports.
 */
import React, {useCallback, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, SectionList, ActivityIndicator,
  RefreshControl, Modal, ScrollView,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import FitLine from '@components/ui/FitLine';
import {UI} from '@components/ui/tokens';
import {scaleTextStyles} from '@utils/scaling';
import {navigateOnce} from '@navigation/tapGuard';
import {
  useBookingHistoryStore, hasActiveFilters, type HistoryFilters,
} from '@store/bookingHistoryStore';
import type {HistoryBucket, HistoryPaymentFilter} from '@services/api';
import {resumeTargetFor, isTerminalBookingStatus} from './bookingStatus';
import {
  buildHistoryRow, groupByMonth, formatCredits, rangeKeyFor, type HistoryRowVM,
} from './bookingHistoryRows';
import {SERVICE_LABELS} from './bookingSummaryRows';

type Nav = NativeStackNavigationProp<BookingStackParamList>;

const SEGMENTS: Array<{key: HistoryBucket; label: string}> = [
  {key: 'all', label: 'All'},
  {key: 'upcoming', label: 'Upcoming'},
  {key: 'past', label: 'Completed'},
  {key: 'cancelled', label: 'Cancelled'},
];

const PAYMENT_FILTERS: Array<{key: HistoryPaymentFilter; label: string}> = [
  {key: 'paid', label: 'Paid'},
  {key: 'held', label: 'On hold'},
  {key: 'refunded', label: 'Refunded'},
  {key: 'under_review', label: 'Under review'},
];

const DATE_RANGES: Array<{key: string; label: string; days: number | null}> = [
  {key: 'any', label: 'Any time', days: null},
  {key: '30', label: 'Last 30 days', days: 30},
  {key: '90', label: 'Last 90 days', days: 90},
  {key: '365', label: 'Last year', days: 365},
];


/**
 * Open a booking. In-flight rows resume into their own screen; anything
 * terminal opens the read-only detail. It is the SAME `resumeTargetFor` the
 * rest of the app uses, so the chip and the destination can never tell the user
 * two different stories.
 *
 * `navigateOnce` because this is a hot forward press on a list (the N-series
 * rapid-use rule); programmatic navigation elsewhere stays unguarded.
 */
export function openBookingFromRow(
  navigation: Nav,
  id: string,
  bookingStatus?: string | null,
  missionStatus?: string | null,
): void {
  // A TERMINAL booking opens its read-only detail even if a stale mission row
  // still says LIVE. `resumeTargetFor` checks mission_status FIRST and must keep
  // doing so — the Home auto-resume depends on it, because the booking FSM stays
  // CONFIRMED for the whole mission. But that precedence is wrong once the
  // booking itself has finished: `describeBookingRow` already renders such a row
  // as COMPLETED, and without this the chip said COMPLETED while the tap opened
  // LiveTracking — exactly the "two different stories" this file promises not to
  // tell. Only the mapping is overridden here; the shared resolver is untouched.
  if (isTerminalBookingStatus(bookingStatus)) {
    navigateOnce(navigation, 'TripSummary', {bookingId: id});
    return;
  }
  const target = resumeTargetFor(id, bookingStatus, missionStatus);
  if (target?.screen === 'BookingConfirmation') {
    navigateOnce(navigation, 'BookingConfirmation', {
      bookingId: id, amountPaid: 0, currency: 'BC',
      paymentMethod: 'bravo_credits', creditsAwarded: 0,
    });
  } else if (target) {
    navigateOnce(navigation, target.screen, {bookingId: id});
  } else {
    navigateOnce(navigation, 'TripSummary', {bookingId: id});
  }
}

// ─── row ────────────────────────────────────────────────────────────────────

const HistoryRow = React.memo(function HistoryRow({
  vm, onPress,
}: {vm: HistoryRowVM; onPress: (id: string) => void}) {
  return (
    <TouchableOpacity
      style={s.row}
      activeOpacity={0.8}
      onPress={() => onPress(vm.id)}
      accessibilityRole="button"
      accessibilityLabel={vm.accessibilityLabel}>
      <View style={s.rowTop}>
        <View style={{flex: 1, minWidth: 0}}>
          <Text style={s.rowTitle} numberOfLines={1}>{vm.title}</Text>
          <Text style={s.rowWhen} numberOfLines={1}>{vm.when}</Text>
        </View>
        {!!vm.amount && (
          <View style={s.amountBox}>
            <Text style={s.amount} numberOfLines={1}>{vm.amount}</Text>
            {/* An amount that has NOT been charged says so, rather than
                implying money moved. */}
            <Text style={s.paidWith} numberOfLines={1}>
              {vm.quoted ? 'Quoted' : vm.paidWith ?? ''}
            </Text>
          </View>
        )}
      </View>

      {!!vm.where && <Text style={s.rowMeta} numberOfLines={1}>{vm.where}</Text>}
      {!!vm.team && <Text style={s.rowMetaDim} numberOfLines={1}>{vm.team}</Text>}

      <View style={s.rowBottom}>
        <View style={[s.chip, {backgroundColor: vm.status.color + '14', borderColor: vm.status.color + '4D'}]}>
          <FitLine style={[s.chipText, {color: vm.status.color}]} text={vm.status.label} />
        </View>
        {!!vm.status.money && (
          <View style={s.moneyChip}>
            <FitLine style={s.moneyChipText} text={vm.status.money} />
          </View>
        )}
        <View style={{flex: 1}} />
        {vm.stars !== null && (
          <View style={s.stars}>
            <Icon name="star" size={12} color={UI.amber} importantForAccessibility="no" />
            <Text style={s.starsText}>{vm.stars}</Text>
          </View>
        )}
        <Text style={s.ref} numberOfLines={1}>{vm.receiptNumber ?? vm.reference}</Text>
      </View>
    </TouchableOpacity>
  );
});

// ─── list ───────────────────────────────────────────────────────────────────

export interface BookingHistoryListProps {
  /** Hidden from the list because it is already pinned above it as the active
   *  card — otherwise the Summary tab shows the same booking twice. */
  excludeId?: string | null;
  /** Page title beside the filter button. */
  title: string;
  /** Small caps line above the title. */
  eyebrow?: string;
  /** Back affordance — omitted on the tab, present on the pushed screen. */
  onBack?: () => void;
  /** The pinned active-mission card (Summary tab only). */
  activeCard?: React.ReactNode;
  /** Runs alongside the history refresh — the tab also refreshes the resume
   *  model that its active card reads. */
  onRefreshExtra?: () => void;
  paddingTop: number;
}

export function BookingHistoryList({
  title, eyebrow, onBack, activeCard, onRefreshExtra, paddingTop, excludeId,
}: BookingHistoryListProps) {
  const navigation = useNavigation<Nav>();
  const {contentBottom} = useBottomInset();

  const rows = useBookingHistoryStore(st => st.rows);
  const total = useBookingHistoryStore(st => st.total);
  const summary = useBookingHistoryStore(st => st.summary);
  const filters = useBookingHistoryStore(st => st.filters);
  const status = useBookingHistoryStore(st => st.status);
  const error = useBookingHistoryStore(st => st.error);
  const cursor = useBookingHistoryStore(st => st.cursor);
  const degraded = useBookingHistoryStore(st => st.degraded);
  const load = useBookingHistoryStore(st => st.load);
  const loadMore = useBookingHistoryStore(st => st.loadMore);
  const setFilters = useBookingHistoryStore(st => st.setFilters);
  const clearFilters = useBookingHistoryStore(st => st.clearFilters);

  const [sheetOpen, setSheetOpen] = useState(false);
  // Focus fetches dedupe: a tab hop back within a few seconds must not re-fetch
  // the whole first page (the N-series focus-fetch rule).
  const lastFetch = useRef(0);

  useFocusEffect(
    useCallback(() => {
      onRefreshExtra?.();
      const now = Date.now();
      if (now - lastFetch.current > 3000) {
        lastFetch.current = now;
        void load();
      }
      // `onRefreshExtra` is intentionally out of the dep list: callers pass an
      // inline closure, and depending on it would re-run this effect on every
      // render of the parent, defeating the dedupe above.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [load]),
  );

  const refresh = useCallback(() => {
    lastFetch.current = Date.now();
    onRefreshExtra?.();
    void load('refresh');
  }, [load, onRefreshExtra]);

  // Rows read through a ref so this callback's identity does NOT change when a
  // page lands. Depending on `rows` re-created it on every fetch and busted
  // React.memo on every mounted row, forcing a full re-render pass — and view
  // mounting is the measured cost on this app (B-279/B-285).
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const onRowPress = useCallback(
    (id: string) => {
      const r = rowsRef.current.find(x => x.id === id);
      openBookingFromRow(navigation, id, r?.status, r?.mission_status);
    },
    [navigation],
  );

  const sections = useMemo(
    () => groupByMonth(
      rows.filter(r => r.id !== excludeId).map(r => buildHistoryRow(r)),
    ),
    [rows, excludeId],
  );

  // While degraded there is no server-side filtering to apply, so offering the
  // controls would show chips and a "N results · filtered" count over a list
  // that did not change. Hide them and say why instead.
  const canFilter = !degraded;
  const filtered = canFilter && hasActiveFilters(filters);
  const firstLoad = (status === 'loading' || status === 'idle') && rows.length === 0;

  return (
    <>
      <SectionList
        sections={sections}
        keyExtractor={r => r.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop,
          // Under a tab bar the bar already pads by the safe-area inset; adding
          // it here again is the B-245/B-784 double count. `contentBottom`
          // is the ONE rule and it returns the plain inset when no bar is up,
          // so the pushed screen is correct through the same call.
          paddingBottom: contentBottom(24),
          flexGrow: 1,
        }}
        refreshControl={
          <RefreshControl
            refreshing={status === 'refreshing'}
            onRefresh={refresh}
            tintColor={UI.accent}
          />
        }
        onEndReachedThreshold={0.4}
        onEndReached={() => { void loadMore(); }}
        ListHeaderComponent={
          <View>
            <View style={s.header}>
              {onBack && (
                <TouchableOpacity
                  style={s.back}
                  activeOpacity={0.75}
                  onPress={onBack}
                  hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                  accessibilityRole="button"
                  accessibilityLabel="Go back">
                  <Icon name="chevron-left" size={20} color={UI.text} />
                </TouchableOpacity>
              )}
              <View style={{flex: 1, minWidth: 0}}>
                {!!eyebrow && <Text style={s.eyebrow}>{eyebrow}</Text>}
                <Text style={s.title} numberOfLines={1}>{title}</Text>
              </View>
              {canFilter && (
                <TouchableOpacity
                  style={[s.iconBtn, filtered && s.iconBtnOn]}
                  activeOpacity={0.8}
                  onPress={() => setSheetOpen(true)}
                  accessibilityRole="button"
                  accessibilityLabel={filtered ? 'Filters, active' : 'Filter bookings'}>
                  <Icon name="tune-variant" size={18} color={filtered ? UI.accent : UI.text} />
                </TouchableOpacity>
              )}
            </View>

            {activeCard}

            {summary && (
              <View style={s.stats}>
                <Stat label="BOOKINGS" value={String(summary.count_all)} />
                <View style={s.statDivider} />
                <Stat label="IN FLIGHT" value={String(summary.count_in_flight)} />
                <View style={s.statDivider} />
                <Stat label="SPENT · 30D" value={formatCredits(summary.spent_30d_credits)} />
              </View>
            )}

            {canFilter && (
            <View style={s.segments}>
              {SEGMENTS.map(seg => {
                const on = filters.bucket === seg.key;
                return (
                  <TouchableOpacity
                    key={seg.key}
                    style={[s.segment, on && s.segmentOn]}
                    activeOpacity={0.85}
                    onPress={() => setFilters({bucket: seg.key})}
                    accessibilityRole="button"
                    accessibilityState={{selected: on}}
                    accessibilityLabel={seg.label}>
                    <FitLine style={[s.segmentText, on && s.segmentTextOn]} text={seg.label} />
                  </TouchableOpacity>
                );
              })}
            </View>
            )}

            {filtered && (
              <View style={s.chipRow}>
                <Text style={s.chipRowText} numberOfLines={1}>
                  {total} result{total === 1 ? '' : 's'} · filtered
                </Text>
                <TouchableOpacity
                  onPress={clearFilters}
                  activeOpacity={0.8}
                  hitSlop={{top: 12, bottom: 12, left: 12, right: 12}}
                  accessibilityRole="button"
                  accessibilityLabel="Clear filters">
                  <Text style={s.clearText}>Clear</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* This device is talking to a server that predates the history
                endpoint (deploy order). The rows are real, but they carry no
                payment state, receipt or rating and cannot be filtered — say so
                rather than showing a poorer list as if it were the full one. */}
            {degraded && (
              <Text style={s.inlineNote} numberOfLines={2}>
                Showing basic booking details. Payment status and receipts appear once your app reconnects.
              </Text>
            )}

            {/* A failed "load more" keeps the rows on screen and reports itself
                here, instead of replacing the list the user is reading. */}
            {!!error && rows.length > 0 && (
              <Text style={s.inlineErr} numberOfLines={2}>{error}</Text>
            )}
          </View>
        }
        renderSectionHeader={({section}) => <Text style={s.monthHeader}>{section.label}</Text>}
        renderItem={({item}) => <HistoryRow vm={item} onPress={onRowPress} />}
        ItemSeparatorComponent={ItemGap}
        ListEmptyComponent={
          firstLoad ? (
            <View style={s.emptyTop}>
              {[0, 1, 2].map(i => <View key={i} style={s.skeleton} />)}
            </View>
          ) : status === 'error' ? (
            <View style={s.empty}>
              <Icon name="alert-circle-outline" size={26} color={UI.alert} importantForAccessibility="no" />
              <Text style={s.emptyBody}>{error}</Text>
              <TouchableOpacity
                style={s.emptyBtn}
                activeOpacity={0.85}
                onPress={() => { void load(); }}
                accessibilityRole="button"
                accessibilityLabel="Retry loading bookings">
                <Text style={s.emptyBtnText}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : filtered || filters.bucket !== 'all' ? (
            <View style={s.empty}>
              <Icon name="filter-remove-outline" size={40} color={UI.textMute} importantForAccessibility="no" />
              <Text style={s.emptyTitle}>Nothing here</Text>
              <Text style={s.emptyBody}>No bookings match these filters.</Text>
              <TouchableOpacity
                style={s.emptyBtn}
                activeOpacity={0.85}
                onPress={() => setFilters({bucket: 'all', services: [], from: null, to: null, payment: null})}
                accessibilityRole="button"
                accessibilityLabel="Show all bookings">
                <Text style={s.emptyBtnText}>Show all</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={s.empty}>
              <Icon name="shield-check-outline" size={44} color={UI.textMute} importantForAccessibility="no" />
              <Text style={s.emptyTitle}>No bookings yet</Text>
              <Text style={s.emptyBody}>
                Every protection detail you book appears here with its team, timing and receipt.
              </Text>
              <TouchableOpacity
                style={s.emptyBtn}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Book protection"
                onPress={() => navigateOnce(navigation, 'ServiceType')}>
                <Text style={s.emptyBtnText}>Book protection</Text>
              </TouchableOpacity>
            </View>
          )
        }
        ListFooterComponent={
          status === 'more' ? (
            <View style={s.footer}><ActivityIndicator color={UI.accent} /></View>
          ) : cursor ? (
            <TouchableOpacity
              style={s.moreBtn}
              activeOpacity={0.85}
              onPress={() => { void loadMore(); }}
              accessibilityRole="button"
              accessibilityLabel="Load more bookings">
              <Text style={s.moreText}>Load more</Text>
            </TouchableOpacity>
          ) : rows.length > 0 ? (
            <Text style={s.endText}>{total} booking{total === 1 ? '' : 's'}</Text>
          ) : null
        }
      />

      <FilterSheet
        open={sheetOpen}
        filters={filters}
        onClose={() => setSheetOpen(false)}
        onApply={next => { setSheetOpen(false); setFilters(next); }}
      />
    </>
  );
}

// Hoisted so React does not see a fresh component type on every render.
function ItemGap() {
  return <View style={{height: 10}} />;
}

function Stat({label, value}: {label: string; value: string}) {
  return (
    <View style={s.stat}>
      <FitLine style={s.statValue} text={value} />
      <FitLine style={s.statLabel} text={label} />
    </View>
  );
}

// ─── filter sheet ───────────────────────────────────────────────────────────

/**
 * A `<Modal>`, so the RAW safe-area inset is correct here — a modal sheet is
 * not laid out under the tab bar, which is the documented carve-out to the
 * B-784 rule rather than a violation of it.
 */
function FilterSheet({
  open, filters, onClose, onApply,
}: {
  open: boolean;
  filters: HistoryFilters;
  onClose: () => void;
  onApply: (next: Partial<HistoryFilters>) => void;
}) {
  const insets = useSafeAreaInsets();
  const [services, setServices] = useState<string[]>(filters.services);
  const [payment, setPayment] = useState<HistoryPaymentFilter | null>(filters.payment);
  const [range, setRange] = useState<string>(() => rangeKeyFor(filters.from));

  // Re-seed from the LIVE filters each time the sheet opens, or a cancelled
  // edit is silently re-applied on the next open.
  const onShow = useCallback(() => {
    setServices(filters.services);
    setPayment(filters.payment);
    // Derive the pill from the actual window, not "is there a from at all" —
    // that collapsed "Last 90 days" to the 30-day pill on reopen, and a
    // subsequent Apply then silently narrowed a range the user never touched.
    setRange(rangeKeyFor(filters.from));
  }, [filters]);

  const apply = () => {
    const days = DATE_RANGES.find(r => r.key === range)?.days ?? null;
    onApply({
      services,
      payment,
      from: days ? new Date(Date.now() - days * 86_400_000).toISOString() : null,
      to: null,
    });
  };

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose} onShow={onShow}>
      <View style={s.backdrop}>
        <TouchableOpacity
          style={{flex: 1}}
          activeOpacity={1}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close filters"
        />
        <View style={[s.sheet, {paddingBottom: Math.max(insets.bottom, 12) + 12}]}>
          <View style={s.grabber} />
          <Text style={s.sheetTitle}>Filter bookings</Text>
          <ScrollView style={{maxHeight: 400}} showsVerticalScrollIndicator={false}>
            <Text style={s.sheetLabel}>SERVICE</Text>
            <View style={s.pillWrap}>
              {Object.entries(SERVICE_LABELS).map(([key, label]) => {
                const on = services.includes(key);
                return (
                  <Pill
                    key={key}
                    label={label}
                    on={on}
                    onPress={() => setServices(prev =>
                      prev.includes(key) ? prev.filter(x => x !== key) : [...prev, key])}
                  />
                );
              })}
            </View>

            <Text style={s.sheetLabel}>PAYMENT</Text>
            <View style={s.pillWrap}>
              {PAYMENT_FILTERS.map(p => (
                <Pill
                  key={p.key}
                  label={p.label}
                  on={payment === p.key}
                  onPress={() => setPayment(payment === p.key ? null : p.key)}
                />
              ))}
            </View>

            <Text style={s.sheetLabel}>WHEN</Text>
            <View style={s.pillWrap}>
              {DATE_RANGES.map(r => (
                <Pill key={r.key} label={r.label} on={range === r.key} onPress={() => setRange(r.key)} />
              ))}
            </View>
          </ScrollView>

          <TouchableOpacity
            style={s.applyBtn}
            activeOpacity={0.85}
            onPress={apply}
            accessibilityRole="button"
            accessibilityLabel="Apply filters">
            <Text style={s.applyText}>Apply</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function Pill({label, on, onPress}: {label: string; on: boolean; onPress: () => void}) {
  return (
    <TouchableOpacity
      style={[s.pill, on && s.pillOn]}
      activeOpacity={0.85}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{selected: on}}
      accessibilityLabel={label}>
      <Text style={[s.pillText, on && s.pillTextOn]}>{label}</Text>
    </TouchableOpacity>
  );
}

export const s = StyleSheet.create(scaleTextStyles({
  header: {flexDirection: 'row', alignItems: 'flex-start', gap: 12},
  back: {
    width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: UI.hair, marginTop: 4,
  },
  eyebrow: {color: UI.textMute, fontFamily: UI.fBold, fontSize: 11, letterSpacing: 2.5},
  title: {color: UI.text, fontFamily: UI.fBold, fontSize: 28, marginTop: 4, letterSpacing: -0.4},
  iconBtn: {
    width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: UI.hair, marginTop: 4,
  },
  iconBtnOn: {borderColor: 'rgba(30,136,255,0.45)', backgroundColor: 'rgba(30,136,255,0.10)'},

  activeCard: {
    marginTop: 18, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 16,
    borderWidth: 1, borderColor: 'rgba(30,136,255,0.28)', padding: 18, gap: 5,
  },
  activeTop: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2},
  dot: {width: 8, height: 8, borderRadius: 4},
  activeStatus: {fontFamily: UI.fBold, fontSize: 11, letterSpacing: 1, flexShrink: 1},
  activeTitle: {color: UI.text, fontFamily: UI.fSemi, fontSize: 18},
  activeSub: {color: UI.textDim, fontFamily: UI.fSans, fontSize: 13},
  activeCta: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, minHeight: 24},
  activeCtaText: {color: UI.accent, fontFamily: UI.fSemi, fontSize: 14},

  stats: {
    flexDirection: 'row', alignItems: 'center', marginTop: 16,
    backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 14,
    borderWidth: 1, borderColor: UI.hair, paddingVertical: 12,
  },
  stat: {flex: 1, alignItems: 'center', gap: 3, paddingHorizontal: 6},
  statValue: {color: UI.text, fontFamily: UI.fBold, fontSize: 15},
  statLabel: {color: UI.textMute, fontFamily: UI.fSemi, fontSize: 9, letterSpacing: 1.2},
  statDivider: {width: 1, height: 26, backgroundColor: UI.hair},

  segments: {
    flexDirection: 'row', marginTop: 16, gap: 6,
    backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 12, padding: 4,
  },
  segment: {
    flex: 1, minHeight: 38, borderRadius: 9, alignItems: 'center',
    justifyContent: 'center', paddingHorizontal: 4,
  },
  segmentOn: {backgroundColor: 'rgba(30,136,255,0.16)'},
  segmentText: {color: UI.textDim, fontFamily: UI.fSemi, fontSize: 12.5},
  segmentTextOn: {color: UI.accentSoft},

  chipRow: {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12, minHeight: 32},
  chipRowText: {flex: 1, color: UI.textDim, fontFamily: UI.fSans, fontSize: 12},
  clearText: {color: UI.accent, fontFamily: UI.fSemi, fontSize: 12.5},
  inlineErr: {color: UI.amber, fontFamily: UI.fSans, fontSize: 12, marginTop: 10},
  inlineNote: {color: UI.textMute, fontFamily: UI.fSans, fontSize: 11.5, marginTop: 10, lineHeight: 17},

  monthHeader: {
    color: UI.textMute, fontFamily: UI.fBold, fontSize: 10, letterSpacing: 1.8,
    marginTop: 20, marginBottom: 10,
  },

  row: {
    backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 14, borderWidth: 1,
    borderColor: UI.hair, paddingHorizontal: 14, paddingVertical: 13, gap: 3, minHeight: 48,
  },
  rowTop: {flexDirection: 'row', alignItems: 'flex-start', gap: 10},
  rowTitle: {color: UI.text, fontFamily: UI.fSemi, fontSize: 14.5},
  rowWhen: {color: UI.textDim, fontFamily: UI.fSans, fontSize: 12, marginTop: 2},
  amountBox: {alignItems: 'flex-end', maxWidth: '44%'},
  amount: {color: UI.text, fontFamily: UI.fBold, fontSize: 14},
  paidWith: {color: UI.textMute, fontFamily: UI.fSans, fontSize: 10.5, marginTop: 2},
  rowMeta: {color: UI.textDim, fontFamily: UI.fSans, fontSize: 12, marginTop: 4},
  rowMetaDim: {color: UI.textMute, fontFamily: UI.fSans, fontSize: 11.5},
  rowBottom: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8},
  chip: {paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: 1, maxWidth: '46%'},
  chipText: {fontFamily: UI.fSemi, fontSize: 9.5, letterSpacing: 0.6},
  moneyChip: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: 1,
    borderColor: UI.hair, backgroundColor: 'rgba(255,255,255,0.03)', maxWidth: '40%',
  },
  moneyChipText: {fontFamily: UI.fSemi, fontSize: 9.5, letterSpacing: 0.6, color: UI.textDim},
  stars: {flexDirection: 'row', alignItems: 'center', gap: 2},
  starsText: {color: UI.textDim, fontFamily: UI.fSemi, fontSize: 11},
  ref: {color: UI.textMute, fontFamily: UI.fSans, fontSize: 10, letterSpacing: 0.3, flexShrink: 1},

  empty: {alignItems: 'center', justifyContent: 'center', paddingTop: 50, gap: 12, flex: 1},
  emptyTop: {paddingTop: 20},
  emptyTitle: {color: UI.text, fontFamily: UI.fSemi, fontSize: 18, textAlign: 'center'},
  emptyBody: {
    color: UI.textDim, fontFamily: UI.fSans, fontSize: 13,
    textAlign: 'center', lineHeight: 20, maxWidth: 300,
  },
  emptyBtn: {
    marginTop: 8, minHeight: 48, justifyContent: 'center', paddingHorizontal: 28,
    borderRadius: 12, backgroundColor: UI.accent,
  },
  emptyBtnText: {color: '#fff', fontFamily: UI.fSemi, fontSize: 15},
  skeleton: {
    height: 96, width: '100%', borderRadius: 14, marginBottom: 10,
    backgroundColor: 'rgba(255,255,255,0.035)', borderWidth: 1, borderColor: UI.hair,
  },

  footer: {paddingVertical: 22, alignItems: 'center'},
  moreBtn: {
    marginTop: 18, minHeight: 48, justifyContent: 'center', alignItems: 'center',
    borderRadius: 12, borderWidth: 1, borderColor: UI.hair,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  moreText: {color: UI.accentSoft, fontFamily: UI.fSemi, fontSize: 13.5},
  endText: {
    color: UI.textMute, fontFamily: UI.fSans, fontSize: 11.5,
    textAlign: 'center', marginTop: 20,
  },

  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end'},
  sheet: {
    backgroundColor: '#0C1017', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderWidth: 1, borderColor: UI.hair, paddingHorizontal: 20, paddingTop: 10,
  },
  grabber: {
    width: 40, height: 4, borderRadius: 2, alignSelf: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)', marginBottom: 14,
  },
  sheetTitle: {color: UI.text, fontFamily: UI.fBold, fontSize: 18, marginBottom: 8},
  sheetLabel: {
    color: UI.textMute, fontFamily: UI.fBold, fontSize: 10,
    letterSpacing: 1.6, marginTop: 16, marginBottom: 8,
  },
  pillWrap: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  pill: {
    minHeight: 38, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 999,
    borderWidth: 1, borderColor: UI.hair, backgroundColor: 'rgba(255,255,255,0.03)',
  },
  pillOn: {borderColor: 'rgba(30,136,255,0.5)', backgroundColor: 'rgba(30,136,255,0.14)'},
  pillText: {color: UI.textDim, fontFamily: UI.fSemi, fontSize: 12.5},
  pillTextOn: {color: UI.accentSoft},
  applyBtn: {
    marginTop: 18, minHeight: 50, borderRadius: 14, backgroundColor: UI.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  applyText: {color: '#fff', fontFamily: UI.fBold, fontSize: 15},
}));
