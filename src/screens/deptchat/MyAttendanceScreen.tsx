import React, {useCallback, useMemo, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, RefreshControl, ActivityIndicator, Modal, TextInput, TouchableOpacity} from 'react-native';
import {Alert} from '@utils/alert';
import {useShowOrgLabels, orgLabelFor} from './crossOrgLabel';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useKeyboardOverlap} from '@hooks/useKeyboardLayout';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import LoadingView from '@components/LoadingView';
import type {AgentStackParamList} from '@navigation/types';
import {attendanceApi, type MyPingDto, type ShiftSessionDto} from '@services/api';
import {OB, ObHeader, SectionLabel, Card, ErrorState, loadErrorText, attendanceStatusMeta, reviewReasonLabel} from './_obsidian';
import {fmtTime} from './geo';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

// PDF p.8 — member history with monthly grouping, the full review outcome per
// row, and the dispute support route (flags an own record back to the manager
// Pending Review queue with reason 'disputed').
export default function MyAttendanceScreen() {
  const insets = useSafeAreaInsets();
  // B-84 / KB-14 — Android Modal windows don't resize for the IME.
  const keyboardOverlap = useKeyboardOverlap();
  const navigation = useNavigation<Nav>();
  const [shifts, setShifts] = useState<ShiftSessionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [disputeTarget, setDisputeTarget] = useState<ShiftSessionDto | null>(null);
  const [disputeNote, setDisputeNote] = useState('');
  const [busy, setBusy] = useState(false);
  // F15 — a failed history fetch must not read as "no attendance records".
  const [loadError, setLoadError] = useState<string | null>(null);

  /**
   * B-859 — the worker's OWN record of every location request made of them.
   *
   * `org_audit_log` is manager-readable only, so without this list a location
   * capture is something that happens to a person with no way for them to see
   * it — which is surveillance, not attendance. Best-effort: an older server
   * 404s this route and the section simply does not render. It NEVER blocks the
   * attendance history, which is what the screen is actually for.
   */
  const [pings, setPings] = useState<MyPingDto[]>([]);

  const load = useCallback(async () => {
    void attendanceApi.myPings()
      .then(({data}) => setPings(data.pings ?? []))
      .catch(() => setPings([]));
    try {
      const {data} = await attendanceApi.myShifts();
      setShifts(data);
      setLoadError(null);
    } catch (e) {
      setShifts([]);
      setLoadError(loadErrorText(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const count = (pred: (s: ShiftSessionDto) => boolean) => shifts.filter(pred).length;
  const present = count(s => s.attendance_status === 'present');
  // B-856 — this screen lives in the DEPARTMENTAL shell, so `attendanceApi`
  // stamps the active workspace and the list is that workspace's records only.
  // `rows` is the second half of the rule: an undeployed server ignores the
  // header and answers cross-org, and a merged list with no labels is worse
  // than a labelled one.
  const showOrgLabels = useShowOrgLabels({scoped: true, rows: shifts});
  const late = count(s => s.attendance_status === 'late');
  const pending = count(s => s.review_status === 'pending');

  // Weekly/monthly view (PDF p.8): newest-first month sections.
  const sections = useMemo(() => {
    const byMonth = new Map<string, ShiftSessionDto[]>();
    for (const sh of shifts) {
      const d = new Date(sh.clock_in_at);
      const key = isNaN(d.getTime())
        ? 'Undated'
        : d.toLocaleDateString(undefined, {month: 'long', year: 'numeric'});
      const list = byMonth.get(key) ?? [];
      list.push(sh);
      byMonth.set(key, list);
    }
    return Array.from(byMonth.entries());
  }, [shifts]);

  const submitDispute = async () => {
    const target = disputeTarget;
    const note = disputeNote.trim();
    if (!target) {return;}
    if (note.length < 3) {
      Alert.alert('Dispute', 'Please describe why this record is wrong.');
      return;
    }
    setDisputeTarget(null);
    setBusy(true);
    try {
      await attendanceApi.disputeSession(target.id, note);
      Alert.alert('Dispute', 'Your dispute was sent to your admin for review.');
      await load();
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Dispute', msg === 'already_pending_review'
        ? 'This record is already waiting for admin review.'
        : msg ?? 'Could not send the dispute. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title="My Attendance" onBack={() => navigation.goBack()} />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 32}}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={OB.accentSoft} />
        }>

        <View style={s.statsRow}>
          <Stat label="Present" value={present} color={OB.signal} />
          <Stat label="Late" value={late} color={OB.amber} />
          <Stat label="Pending" value={pending} color={OB.amber} />
        </View>

        {/* B-859 — who asked where you were, when, and what your phone did about
            it. Above the history on purpose: it is the newest thing on this
            screen and the one a worker would come looking for. */}
        {pings.length > 0 ? (
          <View style={{marginTop: 22}} testID="my-location-requests">
            <SectionLabel>LOCATION REQUESTS</SectionLabel>
            <View style={{gap: 10}}>
              {pings.slice(0, 10).map(p => (
                <Card key={p.id} style={s.pingCard}>
                  <Icon name="crosshairs-gps" size={16} color={OB.accentSoft} />
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={s.pingWho} numberOfLines={1}>
                      {p.requested_by_name ?? 'A manager'} asked for your location
                    </Text>
                    <Text style={s.pingWhen} numberOfLines={1}>
                      {fmtPingWhen(p.requested_at)} · {myPingOutcome(p)}
                    </Text>
                  </View>
                </Card>
              ))}
            </View>
          </View>
        ) : null}

        {loading ? (
          <LoadingView compact label="Loading attendance…" />
        ) : loadError ? (
          <View style={{marginTop: 22}}>
            <ErrorState message={loadError} onRetry={() => { setLoading(true); void load(); }} />
          </View>
        ) : shifts.length === 0 ? (
          <View style={{marginTop: 22}}>
            <SectionLabel>HISTORY</SectionLabel>
            <Card><Text style={s.empty}>No attendance records yet.</Text></Card>
          </View>
        ) : (
          sections.map(([month, rows]) => (
            <View key={month} style={{marginTop: 22}}>
              <SectionLabel>{month.toUpperCase()}</SectionLabel>
              <View style={{gap: 10}}>
                {rows.map(sh => {
                  const meta = attendanceStatusMeta(sh.attendance_status ?? (sh.status === 'open' ? null : 'present'));
                  const outcome = reviewOutcome(sh);
                  const canDispute = sh.status !== 'open' && sh.review_status !== 'pending';
                  const day = fmtDay(sh.clock_in_at);
                  return (
                    <Card key={sh.id} style={s.row}>
                      <View style={s.left}>
                        <Icon name={meta.icon} size={18} color={meta.color} />
                        <View style={{flex: 1, minWidth: 0}}>
                          <Text style={s.in}>{day ? `${day} · ` : ''}{fmtTime(sh.clock_in_at)}</Text>
                          <Text style={s.out} numberOfLines={2}>
                            {sh.clock_out_at ? `→ ${fmtTime(sh.clock_out_at)}` : '→ open'}
                            {outcome ? ` · ${outcome}` : ''}
                          </Text>
                          {/* vs2 item 4 — this list is cross-org by decision, so a
                              multi-org person is told which company each shift was
                              for. Absent entirely for the single-org majority. */}
                          {orgLabelFor(sh, showOrgLabels) ? (
                            <Text style={s.orgTag} numberOfLines={1}>
                              {orgLabelFor(sh, showOrgLabels)}
                            </Text>
                          ) : null}
                        </View>
                      </View>
                      <View style={s.right}>
                        <View style={[s.chip, {backgroundColor: meta.color + '14', borderColor: meta.color + '4D'}]}>
                          <Text style={[s.chipText, {color: meta.color}]}>{meta.label}</Text>
                        </View>
                        {canDispute ? (
                          <Text
                            style={s.disputeLink}
                            onPress={() => { setDisputeNote(''); setDisputeTarget(sh); }}>
                            Dispute
                          </Text>
                        ) : null}
                      </View>
                    </Card>
                  );
                })}
              </View>
            </View>
          ))
        )}
      </ScrollView>

      <Modal visible={disputeTarget !== null} transparent animationType="fade" onRequestClose={() => setDisputeTarget(null)}>
        {/* B-184 — one rule, both platforms: the backdrop shrinks by the IME
            overlap so the centered card re-centres above the keyboard. */}
        <View style={[s.modalBackdrop, {paddingBottom: keyboardOverlap}]}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Dispute this record</Text>
            <Text style={s.modalSub}>
              Tell your admin why this record is wrong. It goes back into their review queue.
            </Text>
            <TextInput
              style={s.modalInput}
              value={disputeNote}
              onChangeText={setDisputeNote}
              placeholder="e.g. I was on site — GPS was off"
              placeholderTextColor={OB.textMute}
              multiline
              maxLength={500}
            />
            <View style={s.modalActions}>
              <TouchableOpacity style={[s.actBtn, s.cancel]} activeOpacity={0.8} onPress={() => setDisputeTarget(null)}>
                <Text style={[s.actText, {color: OB.textDim}]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.actBtn, s.send]} activeOpacity={0.8} disabled={busy} onPress={() => { void submitDispute(); }}>
                {busy ? <ActivityIndicator size="small" color={OB.accentSoft} /> : (
                  <Text style={[s.actText, {color: OB.accentSoft}]}>Send Dispute</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// The full review trail for a row: pending reason, or the admin's outcome.
function reviewOutcome(sh: ShiftSessionDto): string | null {
  if (sh.review_status === 'pending') {return reviewReasonLabel(sh.review_reason) ?? 'Pending review';}
  if (sh.review_status === 'approved') {return 'Approved by admin';}
  if (sh.review_status === 'rejected') {return 'Rejected by admin';}
  return null;
}

function fmtDay(iso?: string | null): string | null {
  if (!iso) {return null;}
  const d = new Date(iso);
  if (isNaN(d.getTime())) {return null;}
  return d.toLocaleDateString(undefined, {weekday: 'short', day: 'numeric'});
}

/**
 * B-859 — "Tue 9 Sep · 14:12". Date AND time: "which shift was that" needs
 * both — but each exactly ONCE.
 *
 * D3 — this used to append `fmtTime`, which is a date-AND-time formatter
 * (geo.ts, day + month + hour + minute), so the row read "Sat, Sep 12,
 * Sep 12, 2:16 AM". The time half is formatted here instead, and the two
 * halves are joined with the row separator the rest of this screen uses.
 */
export function fmtPingWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) {return '';}
  const day = d.toLocaleDateString(undefined, {weekday: 'short', day: 'numeric', month: 'short'});
  const time = d.toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'});
  return `${day} · ${time}`;
}

/**
 * B-859 — what the phone did, in the worker's words.
 *
 * `refused` is NOT one outcome: the reason is the whole point of showing it at
 * all. A worker who reads "Declined" for a request their phone turned down
 * because Location was off learns nothing they can act on.
 */
export function myPingOutcome(p: Pick<MyPingDto, 'status' | 'refuse_reason'>): string {
  if (p.status === 'answered') {return 'Your location was shared';}
  if (p.status === 'pending')  {return 'Waiting for your phone to answer';}
  if (p.status === 'expired')  {return 'Not answered';}
  switch (p.refuse_reason) {
    case 'no_permission': return 'Not shared — location permission is off';
    case 'no_fix':        return 'Not shared — no location available';
    case 'off_shift':     return 'Not shared — you were not clocked in';
    default:              return 'Not shared';
  }
}

function Stat({label, value, color}: {label: string; value: number; color: string}) {
  return (
    <Card style={s.statCell}>
      <Text style={[s.statValue, {color}]}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </Card>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  orgTag: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 10, marginTop: 2},
  pingCard: {flexDirection: 'row', alignItems: 'center', gap: 11},
  pingWho: {color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 13},
  pingWhen: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 11.5, marginTop: 2},
  root: {flex: 1, backgroundColor: OB.bg},
  statsRow: {flexDirection: 'row', gap: 10, marginTop: 8},
  statCell: {flex: 1, alignItems: 'center', paddingVertical: 18},
  statValue: {fontFamily: BravoFont.extraBold, fontSize: 26, letterSpacing: -0.5},
  statLabel: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', marginTop: 4},
  empty: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12, textAlign: 'center'},
  row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 13},
  left: {flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1, minWidth: 0},
  right: {alignItems: 'flex-end', gap: 6},
  in: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 13},
  out: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11, marginTop: 2},
  chip: {paddingHorizontal: 9, paddingVertical: 4, borderRadius: 7, borderWidth: 1},
  chipText: {fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '700', letterSpacing: 0.8},
  disputeLink: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 11, paddingVertical: 2},
  modalBackdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24},
  modalCard: {
    width: '100%', borderRadius: 18, padding: 20, gap: 10,
    backgroundColor: '#0C1017', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)',
  },
  modalTitle: {color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 17, letterSpacing: -0.3},
  modalSub: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 12.5, lineHeight: 18},
  modalInput: {
    minHeight: 72, maxHeight: 140, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10,
    color: OB.text, fontFamily: BravoFont.regular, fontSize: 13, textAlignVertical: 'top',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)',
  },
  modalActions: {flexDirection: 'row', gap: 10},
  actBtn: {flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 42, borderRadius: 12, borderWidth: 1},
  cancel: {backgroundColor: 'rgba(255,255,255,0.04)', borderColor: 'rgba(255,255,255,0.12)'},
  send: {backgroundColor: 'rgba(91,141,239,0.10)', borderColor: 'rgba(91,141,239,0.4)'},
  actText: {fontFamily: BravoFont.bold, fontSize: 12.5},
}));
