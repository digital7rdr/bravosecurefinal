/**
 * Bravo Secure Pro — Linked Members (mock page 15's management half).
 *
 * Owner adds members from their phone contacts (messenger-style: contacts
 * matched against registered Bravo accounts — members MUST already hold an
 * individual account). Members are neutrally named — no declared relationship,
 * no badge (B-833) — can spend the owner's credits up to a limit, and can be
 * put on hold for a period or removed. Active members ride the owner's Pro plan
 * (dashboard access + owner-paid bookings tagged "under the owner").
 *
 * There is NO member cap (B-832). The roster is server-paged and server-searched
 * (B-835): a page of 50, "Show more" for the next, and the header counts come
 * from the server so they are right even when only one page is loaded.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, TextInput,
  Modal, Pressable, ActivityIndicator, Image, FlatList, Linking, Platform,
  RefreshControl,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {useProPlanGate} from '@hooks/useProPlanGate';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useNavigation, useFocusEffect, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {UsersHttpClient} from '@bravo/messenger-core';
import {useDiscoveredContacts, type DiscoveredRow} from '@/modules/messenger/contacts/useDiscoveredContacts';
import {filterContacts} from '@/modules/messenger/contacts/contactSearch';
import {familyApi, tokenStore, type FamilyCreditRequest, type FamilyMember, type FamilyMemberLocation, type FamilyMemberSpend} from '@services/api';
import {fundMembersRefusalMessage, quotaFloorFrom} from '@screens/booking/creditErrors';
import {FundingRequestCard, hasPendingFundingAsk} from '@screens/settings/FundingRequestCard';
import {useRosterRowFocus} from '@screens/settings/useRosterRowFocus';
import {buildPinMapUrl} from '@/modules/news/mapbox';
import {API_BASE_URL} from '@utils/constants';
import {useAuthStore} from '@store/authStore';
import {Alert} from '@utils/alert';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'SecureProMembers'>;

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

const D = {
  bg:         '#07090D',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  accentSoft: '#A9C5FF',
  signal:     '#4ADE80',
  amber:      '#F5C76B',
  alert:      '#FF5D5D',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

const INVITE_ERRORS: Record<string, string> = {
  not_a_bravo_user: 'They need their own Bravo Secure account first (Lite or Pro).',
  not_an_individual_account: 'Only individual accounts can be added as members.',
  // Why: a new APK against a not-yet-deployed server still gets `family_full`.
  family_full: 'Member limit reached — update the app or contact Ops.',
  // B-843 — `member_in_another_family` is gone: a person may be a member under
  // any number of roots now, so the server never emits it. The SAME-root guard
  // replaced it (A2) and needs its own copy, or the raw code reaches the sheet.
  already_in_this_family: "They're already a member on this account.",
  invite_already_pending: "They're already on your plan.",
  cannot_invite_self: "That's your own number.",
};

/**
 * A13 — offset paging over `invited_at DESC` re-serves a row when a new one
 * lands at the top mid-session, so pages merge by id rather than concatenate.
 */
function mergeById(prev: FamilyMember[], next: FamilyMember[]): FamilyMember[] {
  const byId = new Map(prev.map(m => [m.id, m]));
  for (const m of next) {byId.set(m.id, m);}
  return Array.from(byId.values());
}

function initials(name: string): string {
  return name.split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || 'M';
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {return '—';}
  return d.toLocaleDateString('en-GB', {day: '2-digit', month: 'short'});
}

function isHeld(m: FamilyMember): boolean {
  return !!m.heldUntil && new Date(m.heldUntil).getTime() > Date.now();
}


function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) {return 'just now';}
  const m = Math.floor(ms / 60_000);
  if (m < 60) {return `${m}m ago`;}
  const h = Math.floor(m / 60);
  if (h < 24) {return `${h}h ago`;}
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d ago` : fmtDate(iso);
}

function featureLabel(f: string | null): string {
  if (!f) {return 'Other';}
  if (f === 'booking') {return 'Protection booking';}
  if (f === 'secure_pro_plan' || f === 'pro_application') {return 'Secure Pro plan';}
  if (f === 'messenger_plan' || f.endsWith('_subscription')) {return 'Messenger plan';}
  return f.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

function locationLine(loc: FamilyMemberLocation): string {
  const place = loc.label ?? `${loc.lat.toFixed(3)}, ${loc.lng.toFixed(3)}`;
  return `${place} · ${timeAgo(loc.recordedAt)}`;
}

function openInMaps(loc: FamilyMemberLocation, name: string): void {
  const ll = `${loc.lat},${loc.lng}`;
  // geo: pin labels break on parentheses even when percent-encoded.
  const label = encodeURIComponent(name.replace(/[()]/g, ''));
  const url = Platform.OS === 'android'
    ? `geo:${ll}?q=${ll}(${label})`
    : `https://maps.apple.com/?ll=${ll}&q=${label}`;
  void Linking.openURL(url).catch(() => {});
}

export default function SecureProMembersScreen() {
  useProPlanGate(); // Audit Rev2 SP-01 — activation gate (see the hook)
  const insets = useSafeAreaInsets();
  const {contentBottom, bottomPad} = useBottomInset();
  // Why: both modals sit under edge-to-edge — their bottom-most element owns
  // the inset (nav bar when the IME is closed, keyboard when it is up).
  const {bottomPad: kbBottomPad} = useKeyboardLayout();
  const navigation = useNavigation<Nav>();
  const user = useAuthStore(s => s.user);
  // B-854/P1-2 — a funding wake names the `(A,B)` roster row. One-shot: the
  // param is spent on adoption so a later visit does not reopen on a stale mark.
  const route = useRoute<RouteProp<BookingStackParamList, 'SecureProMembers'>>();
  const rosterFocus = useRosterRowFocus(
    route.params?.focusMemberRowId ?? null,
    useCallback(() => { navigation.setParams({focusMemberRowId: undefined} as never); }, [navigation]),
  );

  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [counts, setCounts] = useState<{active: number; pending: number; held: number} | null>(null);
  const [loading, setLoading] = useState(true);
  const [pagingBusy, setPagingBusy] = useState(false);
  const [busy, setBusy] = useState(false);

  // B-835 — server-side roster search. `query` below is the CONTACT picker's
  // filter; this one is the roster's.
  const [rosterQuery, setRosterQuery] = useState('');

  // Add flow
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picked, setPicked] = useState<DiscoveredRow | null>(null);
  const [query, setQuery] = useState('');
  const [limitText, setLimitText] = useState('');

  // Spec §43 — open credit requests awaiting this holder's decision.
  const [requests, setRequests] = useState<FamilyCreditRequest[]>([]);
  // §14 — the id of the request whose "approve a different amount" input is
  // open, and its text. One at a time: two open inputs on one screen is two
  // amounts the holder can confuse for each other.
  const [partialFor, setPartialFor] = useState<string | null>(null);
  const [partialText, setPartialText] = useState('');

  // Manage sheet
  const [manage, setManage] = useState<FamilyMember | null>(null);
  const [manageLimit, setManageLimit] = useState('');
  const [spend, setSpend] = useState<FamilyMemberSpend | null>(null);
  const [spendLoading, setSpendLoading] = useState(false);
  const [spendError, setSpendError] = useState(false);
  const [spendNonce, setSpendNonce] = useState(0); // bump = retry

  // Spending breakdown loads when the sheet opens on an accepted member.
  useEffect(() => {
    setSpend(null);
    setSpendError(false);
    if (!manage || manage.status === 'pending') {return;}
    let stale = false;
    setSpendLoading(true);
    familyApi.memberSpend(manage.id)
      .then(({data}) => { if (!stale) {setSpend(data);} })
      .catch(() => { if (!stale) {setSpendError(true);} })
      .finally(() => { if (!stale) {setSpendLoading(false);} });
    return () => { stale = true; };
  }, [manage, spendNonce]);

  const managePinUrl = manage?.lastLocation
    ? buildPinMapUrl({lng: manage.lastLocation.lng, lat: manage.lastLocation.lat})
    : '';

  /**
   * B-835 — one fetch path for the roster.
   *
   * Every request carries a monotonic sequence number; only the LATEST one may
   * write state, so a slow page for an older query can never overwrite the
   * newer one's results (N-11). `offset === 0` REPLACES, anything else merges
   * by id (A13).
   */
  const seqRef = useRef(0);
  const qRef = useRef('');
  const fetchPage = useCallback(async (q: string, offset: number) => {
    const seq = ++seqRef.current;
    try {
      const {data} = await familyApi.members({
        q: q || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      if (seq !== seqRef.current) {return;}
      setMembers(prev => (offset === 0 ? data.members : mergeById(prev, data.members)));
      // Why: a ≤1.0.304 server answers `{members}` only — absent is not zero.
      setTotal(typeof data.total === 'number' ? data.total : null);
      setCounts(data.counts ?? null);
    } catch {
      // keep last good list
    } finally {
      if (seq === seqRef.current) {setLoading(false);}
    }
  }, []);

  const load = useCallback(() => fetchPage(qRef.current, 0), [fetchPage]);

  // A13 — a focus reload re-issues the CURRENT query at offset 0 and replaces,
  // so the roster can never show two interleaved page sets.
  const firstQueryRun = useRef(true);
  useEffect(() => {
    if (firstQueryRun.current) { firstQueryRun.current = false; return; }
    const t = setTimeout(() => {
      qRef.current = rosterQuery.trim();
      void fetchPage(qRef.current, 0);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [rosterQuery, fetchPage]);

  const hasMore = total !== null && members.length < total;
  const pagingRef = useRef(false);
  const loadMore = useCallback(() => {
    // Why: a fetch, not navigation or money — but the guard is still a
    // SYNCHRONOUS ref, so a double tap cannot issue two page requests before
    // the re-render lands (NAV rapid-use).
    if (pagingRef.current) {return;}
    pagingRef.current = true;
    setPagingBusy(true);
    void fetchPage(qRef.current, members.length)
      .finally(() => { pagingRef.current = false; setPagingBusy(false); });
  }, [fetchPage, members.length]);

  /**
   * Spec §43 — pending credit requests belong on the root dashboard.
   *
   * Fetched separately from `members` so a request-endpoint failure cannot
   * blank the member list, and re-fetched on focus: a member may have filed one
   * from their own device while this screen sat in the background (§47).
   */
  const loadRequests = useCallback(async () => {
    try {
      const {data} = await familyApi.creditRequests();
      setRequests(data.requests.filter(r => r.status === 'pending'));
    } catch {
      // keep last good list — a missing request panel must not break the screen
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
    void loadRequests();
  }, [load, loadRequests]));

  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const onRefresh = useCallback(() => {
    if (refreshingRef.current) {return;}
    refreshingRef.current = true;
    setRefreshing(true);
    // A pull resets to page 0 under the CURRENT query — it never silently
    // clears what the holder typed.
    void Promise.all([fetchPage(qRef.current, 0), loadRequests()])
      .finally(() => { refreshingRef.current = false; setRefreshing(false); });
  }, [fetchPage, loadRequests]);

  const usersClient = useMemo(
    () => new UsersHttpClient({
      baseUrl:      API_BASE_URL,
      getToken:     () => tokenStore.get(),
      refreshToken: () => require('@/services/api').refreshAccessTokenShared() as Promise<void>,
    }),
    [],
  );
  const contacts = useDiscoveredContacts({
    users:        usersClient,
    ownPhoneE164: user?.phone_e164 ?? null,
    enabled:      pickerOpen,
  });
  const visibleMatches = useMemo(
    () => filterContacts(contacts.matches, query).filter(
      row => !members.some(m => m.memberId === row.userId && (m.status === 'active' || m.status === 'pending'))),
    [contacts.matches, query, members],
  );

  // The header counts come from the SERVER (unfiltered, `active` includes held)
  // so a root with 3,000 members reads correctly off one loaded page. An older
  // server sends none — fall back to counting what is loaded.
  const activeCount = counts ? counts.active : members.filter(m => m.status === 'active').length;
  const pendingCount = counts ? counts.pending : members.filter(m => m.status === 'pending').length;

  const sendInvite = async () => {
    if (!picked || busy) {return;}
    setBusy(true);
    try {
      const limit = limitText.trim() ? parseInt(limitText, 10) : null;
      await familyApi.invite(picked.phoneE164, Number.isFinite(limit as number) ? limit : null);
      setPickerOpen(false);
      setPicked(null); setLimitText(''); setQuery('');
      await load();
      Alert.alert('Invite sent', 'They can accept it from their profile.');
    } catch (e) {
      const code = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Could not add member', INVITE_ERRORS[code ?? ''] ?? 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const applyHold = async (m: FamilyMember, days: number | null) => {
    setBusy(true);
    try {
      const until = days === null ? null : new Date(Date.now() + days * 86400_000).toISOString();
      await familyApi.setHold(m.id, until);
      setManage(null);
      await load();
    } catch {
      Alert.alert('Could not update hold', 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const saveLimit = async (m: FamilyMember) => {
    setBusy(true);
    try {
      const parsed = manageLimit.trim() ? parseInt(manageLimit, 10) : null;
      await familyApi.setLimit(m.id, Number.isFinite(parsed as number) ? parsed : null);
      setManage(null);
      await load();
    } catch (e) {
      // Spec §19/§44 — a quota may never be reduced below what the member has
      // ALREADY spent; the server refuses it and returns the floor. Showing
      // "Please try again" here would send the holder round a loop that can
      // never succeed, so the real reason and the real minimum are surfaced.
      // The floor comes from the server, never from the row this screen is
      // holding, which may already be stale (§48).
      const floor = quotaFloorFrom(e);
      if (floor !== undefined) {
        Alert.alert(
          'Limit is below what they’ve spent',
          `${m.name} has already spent ${floor.toLocaleString()} credits, so their limit cannot go below that. `
          + 'Set it to that amount or higher.',
        );
      } else {
        Alert.alert('Could not save limit', 'Please try again.');
      }
      // Either way, re-read: the refusal usually means this screen's numbers
      // are behind the server's.
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  /**
   * Spec §13-§15 — decide a member's request for more credit.
   *
   * Approve adds to the quota server-side (under a lock, with an audit row);
   * this screen never computes the new limit itself. `approvedCredits` omitted
   * = approve IN FULL; a smaller number is §14's partial approval.
   *
   * The confirmation names BOTH figures whenever they differ, because §14's
   * whole point is that the holder (and then the member) can see that 2,000 of
   * a requested 5,000 was granted. `res.data.approvedCredits` is the server's
   * number, never the one typed here: the two agree today, and if they ever
   * stop agreeing the server is right.
   */
  const decideRequest = async (
    req: FamilyCreditRequest, action: 'approve' | 'reject', approvedCredits?: number,
  ) => {
    setBusy(true);
    try {
      if (action === 'approve') {
        const res = await familyApi.approveCredit(req.id, approvedCredits ?? null);
        const granted = res.data.approvedCredits;
        const who = req.memberName ?? 'Your member';
        Alert.alert(
          granted < req.requestedCredits ? 'Partially approved' : 'Credit approved',
          (granted < req.requestedCredits
            ? `Requested ${req.requestedCredits.toLocaleString()} BC · Approved ${granted.toLocaleString()} BC.
`
            : '')
          + `${who}’s limit is now ${res.data.newLimit.toLocaleString()} credits.`,
        );
        setPartialFor(null);
        setPartialText('');
      } else {
        await familyApi.rejectCredit(req.id);
      }
      await loadRequests();
      await load();
    } catch (e) {
      // A request decided elsewhere (another device, or the member cancelled)
      // comes back REQUEST_NOT_PENDING — that is not an error to retry, it is a
      // stale screen. §47/§48: reconcile rather than insist.
      const raw = String((e as {response?: {data?: {message?: unknown}}})?.response?.data?.message ?? '');
      // §8 — every refusal the server can produce here says WHY. "Please try
      // again" on a rule that can never be satisfied by retrying is the loop
      // §19's floor message already exists to avoid.
      const decided: Array<[string, string, string]> = [
        ['request_not_pending', 'Already decided', 'This request was already handled. Refreshing.'],
        ['approval_exceeds_request', 'More than they asked for',
          `You can approve up to ${req.requestedCredits.toLocaleString()} BC on this request. `
          + 'To give more than that, change their limit from the member sheet.'],
        ['quota_already_unlimited', 'No limit to raise',
          `${req.memberName ?? 'This member'} already has an unlimited allowance, so there is nothing to top up. `
          + 'Reject the request instead.'],
        ['quota_limit_reached', 'Limit too high', 'That would take their limit past the maximum allowed.'],
        ['member_not_active', 'Member is not active', 'They are on hold or removed, so their limit cannot change.'],
        ['invalid_amount', 'Enter a valid amount', 'Use a whole number of credits above zero.'],
      ];
      const hit = decided.find(([code]) => raw.includes(code));
      Alert.alert(hit ? hit[1] : 'Could not update request', hit ? hit[2] : 'Please try again.');
      await loadRequests().catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  /**
   * B-854/A11 — the chain is the ROOT's decision, because it is the root's
   * wallet that pays. Three acts share one runner: allow, decline, and stop.
   *
   * N4: the guard is a SYNCHRONOUS ref reset in `finally`, not `busy`. Both
   * confirm presses land in the same tick, and approving twice is not
   * idempotent on a request row — the second call comes back as a failure the
   * root cannot explain.
   */
  const fundBusyRef = useRef(false);
  const runFundAction = async (op: () => Promise<unknown>) => {
    if (fundBusyRef.current) {return;}
    fundBusyRef.current = true;
    setBusy(true);
    try {
      await op();
      setManage(null);
      await load();
    } catch (e) {
      // A10's `chained_bookings_in_flight` is the one that matters: bookings
      // are STILL RUNNING on this chain, so "Please try again" is a loop the
      // root cannot exit. The server's own count is the answer.
      Alert.alert('Could not update funding', fundMembersRefusalMessage(e) ?? 'Please try again.');
      await load().catch(() => {});
    } finally {
      fundBusyRef.current = false;
      setBusy(false);
    }
  };

  // Allow / Decline live in `FundingRequestCard` — one control shared with the
  // UNGATED profile surface, because a non-Pro holder can hold members too and
  // must be able to answer the same ask (B-724).
  const confirmStopFunding = (m: FamilyMember) => {
    Alert.alert(
      'Stop funding their members?',
      `${m.name}’s members go back to paying from ${m.name}’s own wallet. `
      + `${m.name} keeps their own allowance on your plan.`,
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Stop funding', style: 'destructive',
          onPress: () => { void runFundAction(() => familyApi.setFundMembers(m.id, false)); }},
      ],
    );
  };

  const removeMember = (m: FamilyMember) => {
    Alert.alert(
      'Remove member?',
      `${m.name} will lose access to your plan and credits.`,
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Remove', style: 'destructive', onPress: () => {
          void (async () => {
            setBusy(true);
            try {
              await familyApi.remove(m.id);
              setManage(null);
              await load();
            } finally {
              setBusy(false);
            }
          })();
        }},
      ],
    );
  };

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
          <Text style={s.headerTitle}>Linked Members</Text>
          <FitLine style={s.headerSub} text={`${activeCount} ACTIVE · ${pendingCount} PENDING · BRAVO SECURE PRO`} />
        </View>
      </View>

      <ScrollView
        ref={rosterFocus.scrollRef as never}
        style={{flex: 1}}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: contentBottom(110)}}
        // B-732 — this scroll hosts an input; sibling sheets already set
        // 'handled', the main body was the one missed.
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={D.accent}
            colors={[D.accent]}
          />
        }
        showsVerticalScrollIndicator={false}>

        {/* Spec §43 — pending credit requests, above the roster: they are the
            one thing on this screen that is WAITING on the holder. Rendered
            whatever the roster's loading state is, so a slow member list never
            hides a decision the member is blocked on. */}
        {requests.length > 0 && (
          <View style={{gap: 10, marginBottom: 16}}>
            <Text style={s.sectionLabel}>
              {requests.length === 1 ? 'CREDIT REQUEST' : `CREDIT REQUESTS · ${requests.length}`}
            </Text>
            {requests.map(r => {
              const partialOpen = partialFor === r.id;
              const typed = parseInt(partialText, 10);
              // §30 — the same rules the server applies, applied here too so a
              // holder is told before a round trip. The server is still the
              // authority; this only saves a refusal they can pre-empt.
              const partialOk = Number.isInteger(typed) && typed > 0 && typed <= r.requestedCredits;
              return (
              <View key={r.id} style={s.requestCard}>
                <View style={s.requestRow}>
                  <View style={{flex: 1, minWidth: 0, gap: 3}}>
                    <Text style={s.requestName} numberOfLines={1}>
                      {r.memberName ?? 'Member'}
                    </Text>
                    <Text style={s.requestAmount}>
                      Requested {r.requestedCredits.toLocaleString()} BC
                    </Text>
                    {!!r.reason && (
                      <Text style={s.requestReason} numberOfLines={2}>“{r.reason}”</Text>
                    )}
                  </View>
                  <View style={{flexDirection: 'row', gap: 8}}>
                    <TouchableOpacity
                      style={[s.requestBtn, s.requestBtnGhost]}
                      disabled={busy}
                      onPress={() => { void decideRequest(r, 'reject'); }}
                      accessibilityRole="button"
                      accessibilityLabel={`Reject ${r.memberName ?? 'member'}'s request for ${r.requestedCredits} credits`}>
                      <Text style={s.requestBtnGhostText}>Reject</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[s.requestBtn, s.requestBtnPrimary]}
                      disabled={busy}
                      onPress={() => { void decideRequest(r, 'approve'); }}
                      accessibilityRole="button"
                      accessibilityLabel={`Approve ${r.requestedCredits} credits for ${r.memberName ?? 'member'}`}>
                      <Text style={s.requestBtnPrimaryText}>Approve</Text>
                    </TouchableOpacity>
                  </View>
                </View>

                {/* §14 — root may approve LESS than was asked for. A text link
                    rather than a third button: three buttons crowd the row at
                    320dp, and this is the deliberate path, not the common one. */}
                <TouchableOpacity
                  disabled={busy}
                  onPress={() => {
                    setPartialText('');
                    setPartialFor(partialOpen ? null : r.id);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={partialOpen
                    ? 'Cancel approving a different amount'
                    : `Approve a different amount for ${r.memberName ?? 'member'}`}>
                  <Text style={s.requestPartialLink}>
                    {partialOpen ? 'Cancel' : 'Approve a different amount'}
                  </Text>
                </TouchableOpacity>

                {partialOpen && (
                  <View style={s.requestPartialRow}>
                    <TextInput
                      style={[s.input, {flex: 1}]}
                      value={partialText}
                      onChangeText={setPartialText}
                      keyboardType="number-pad"
                      placeholder={`Up to ${r.requestedCredits.toLocaleString()} BC`}
                      placeholderTextColor={D.textMute}
                      accessibilityLabel="Amount to approve, in credits"
                    />
                    <TouchableOpacity
                      style={[s.requestBtn, partialOk ? s.requestBtnPrimary : s.requestBtnGhost]}
                      disabled={busy || !partialOk}
                      onPress={() => { void decideRequest(r, 'approve', typed); }}
                      accessibilityRole="button"
                      // Distinct from the full-approve button's name on purpose: two
                      // controls with the SAME accessible name is a screen-reader trap,
                      // and "of 5,000" is also the clearer announcement.
                      accessibilityLabel={`Approve ${partialOk ? typed : 0} of ${r.requestedCredits} credits for ${r.memberName ?? 'member'}`}>
                      <Text style={partialOk ? s.requestBtnPrimaryText : s.requestBtnGhostText}>
                        Approve
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            );})}
          </View>
        )}

        {/* B-835 — the roster search box. Rendered whenever there is anything
            to search OR a query is already typed, so a search that finds
            nothing does not remove the box that would let you clear it. */}
        {!loading && (members.length > 0 || rosterQuery.trim().length > 0) && (
          <View style={[s.searchWrap, {marginHorizontal: 0, marginBottom: 12}]}>
            <Icon name="magnify" size={17} color={D.textMute} importantForAccessibility="no" />
            <TextInput
              style={s.searchInput}
              value={rosterQuery}
              onChangeText={setRosterQuery}
              placeholder="Search members…"
              placeholderTextColor={D.textMute}
              selectionColor={D.accent}
              autoCorrect={false}
              accessibilityLabel="Search members"
            />
          </View>
        )}

        {loading ? (
          <View style={{paddingVertical: 48, alignItems: 'center'}}>
            <ActivityIndicator color={D.accent} />
          </View>
        ) : members.length === 0 && rosterQuery.trim().length > 0 ? (
          <View style={s.emptyCard}>
            <Icon name="account-search-outline" size={26} color={D.textMute} />
            <Text style={s.emptyTitle}>No members match</Text>
            <Text style={s.emptySub}>Try part of a name, or their phone number.</Text>
          </View>
        ) : members.length === 0 ? (
          <View style={s.emptyCard}>
      <ImageryBackdrop source={Imagery.proLinkedMembers} variant="card" radius={18} />
            <Icon name="account-multiple-plus-outline" size={26} color={D.textMute} />
            <Text style={s.emptyTitle}>No linked members yet</Text>
            <Text style={s.emptySub}>
              Add members from your contacts — they use your plan and credits, under your control.
            </Text>
          </View>
        ) : (
          <View style={{gap: 10}} onLayout={rosterFocus.onListLayout}>
            {members.map(m => {
              const held = isHeld(m);
              // B-854 — what the root has to be able to see at a glance: this
              // member holds members of their OWN, and (when on) their bookings
              // come out of this wallet. A14 — neither badge may read as a plan
              // perk: the Pro root and the paying root can differ, and this row
              // is about money, not entitlement.
              const holds = m.holdsMembersCount ?? 0;
              const chained = m.fundsSubMembers === true;
              return (
                <TouchableOpacity
                  key={m.id}
                  testID={`member-row-${m.id}`}
                  style={[
                    s.memberCard,
                    held && {opacity: 0.65},
                    rosterFocus.isFocused(m.id) && s.memberCardFocused,
                  ]}
                  onLayout={rosterFocus.onRowLayout(m.id)}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityState={{selected: rosterFocus.isFocused(m.id)}}
                  accessibilityLabel={`Manage ${m.name}`}
                  onPress={() => { setManageLimit(m.spendLimit !== null ? String(m.spendLimit) : ''); setManage(m); }}>
                  <View style={s.avatar}>
                    {m.avatarUrl ? (
                      <Image source={{uri: m.avatarUrl}} style={s.avatarImg} />
                    ) : (
                      <Text style={s.avatarText}>{initials(m.name)}</Text>
                    )}
                  </View>
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={s.memberName} numberOfLines={1}>{m.name}</Text>
                    <Text style={s.memberSub} numberOfLines={1}>
                      {m.status === 'pending'
                        ? 'Invite pending'
                        : held
                          ? `On hold until ${fmtDate(m.heldUntil!)}`
                          : m.spendLimit !== null
                            ? `${m.spent.toLocaleString()} / ${m.spendLimit.toLocaleString()} BC used`
                            : `${m.spent.toLocaleString()} BC used · no limit`}
                    </Text>
                    {m.status === 'active' && !held && m.lastLocation ? (
                      <View style={s.memberLocRow}>
                        <Icon name="map-marker" size={11} color={D.accentSoft} importantForAccessibility="no" />
                        <Text style={s.memberLoc} numberOfLines={1}>{locationLine(m.lastLocation)}</Text>
                      </View>
                    ) : null}
                    {holds > 0 || chained ? (
                      <View style={s.chainRow}>
                        {holds > 0 ? (
                          <View style={s.chainPill}>
                            <Text style={s.chainPillText}>
                              {`Holds ${holds} ${holds === 1 ? 'member' : 'members'}`}
                            </Text>
                          </View>
                        ) : null}
                        {chained ? (
                          <View style={[s.chainPill, s.chainPillOn]}>
                            <Text style={[s.chainPillText, s.chainPillOnText]}>
                              Funds their members from you
                            </Text>
                          </View>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                  {m.status === 'pending' ? (
                    <View style={[s.statePill, {borderColor: 'rgba(245,199,107,0.4)', backgroundColor: 'rgba(245,199,107,0.1)'}]}>
                      <Text style={[s.statePillText, {color: D.amber}]}>PENDING</Text>
                    </View>
                  ) : held ? (
                    <View style={[s.statePill, {borderColor: 'rgba(255,93,93,0.4)', backgroundColor: 'rgba(255,93,93,0.08)'}]}>
                      <Text style={[s.statePillText, {color: D.alert}]}>HOLD</Text>
                    </View>
                  ) : null}
                </TouchableOpacity>
              );
            })}

            {hasMore && (
              <TouchableOpacity
                style={s.moreRow}
                activeOpacity={0.8}
                disabled={pagingBusy}
                onPress={loadMore}
                accessibilityRole="button"
                accessibilityLabel="Show more members"
                accessibilityState={{disabled: pagingBusy}}>
                {pagingBusy ? (
                  <ActivityIndicator color={D.accent} />
                ) : (
                  <Text style={s.moreText}>
                    Show more · {members.length} of {total}
                  </Text>
                )}
              </TouchableOpacity>
            )}
          </View>
        )}

        <View style={s.noteCard}>
          <Icon name="shield-check" size={15} color={D.accentSoft} />
          <Text style={s.noteText}>
            Members need their own Bravo Secure account (Lite or Pro). Active members share your
            Pro dashboard, and their bookings are paid from your credits — capped by the limit
            you set and visibly marked as under your plan.
          </Text>
        </View>
      </ScrollView>

      {/* Bottom CTA — Add Member, always. B-832 removed the cap, so there is no
          "Family Full" dead end and no seat-request escape hatch behind it. */}
      <LinearGradient
        colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
        locations={[0, 0.5]}
        style={[s.ctaWrap, {paddingBottom: bottomPad(12)}]}>
        <TouchableOpacity
          activeOpacity={0.9}
          onPress={() => setPickerOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Add member">
          <LinearGradient
            colors={['#6E9BF5', D.accent, D.accentDeep]}
            locations={[0, 0.55, 1]}
            start={{x: 0, y: 0}}
            end={{x: 0, y: 1}}
            style={s.cta}>
            <Icon name="account-plus" size={18} color="#fff" importantForAccessibility="no" />
            <Text style={s.ctaText}>Add Member</Text>
          </LinearGradient>
        </TouchableOpacity>
      </LinearGradient>

      {/* ── Add-member modal: contact picker → spend limit ── */}
      <Modal visible={pickerOpen} animationType="slide" onRequestClose={() => { if (!busy) {setPickerOpen(false); setPicked(null);} }}>
        <View style={[s.root, {paddingTop: insets.top}]}>
          <View style={s.header}>
            <TouchableOpacity
              style={s.back}
              onPress={() => {
                if (busy) {return;}
                if (picked) {setPicked(null);} else {setPickerOpen(false); setQuery('');}
              }}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="Back">
              <Icon name="chevron-left" size={20} color={D.text} />
            </TouchableOpacity>
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={s.headerTitle}>{picked ? 'Member Details' : 'Add From Contacts'}</Text>
              <FitLine style={s.headerSub} text={picked ? picked.phoneE164 : 'CONTACTS WITH A BRAVO SECURE ACCOUNT'} />
            </View>
          </View>

          {!picked ? (
            <>
              <View style={s.searchWrap}>
                <Icon name="magnify" size={17} color={D.textMute} />
                <TextInput
                  style={s.searchInput}
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search name or number…"
                  placeholderTextColor={D.textMute}
                  selectionColor={D.accent}
                />
              </View>
              {contacts.permission === 'denied' ? (
                <View style={s.centerFill}>
                  <Icon name="account-lock-outline" size={26} color={D.textMute} />
                  <Text style={s.emptyTitle}>Contacts permission needed</Text>
                  <Text style={s.emptySub}>Allow contact access in system settings to pick members.</Text>
                </View>
              ) : contacts.loading ? (
                <View style={s.centerFill}><ActivityIndicator color={D.accent} /></View>
              ) : visibleMatches.length === 0 ? (
                <View style={s.centerFill}>
                  <Icon name="account-search-outline" size={26} color={D.textMute} />
                  <Text style={s.emptyTitle}>No matches</Text>
                  <Text style={s.emptySub}>
                    Only contacts who already have a Bravo Secure account appear here.
                  </Text>
                </View>
              ) : (
                <FlatList
                  data={visibleMatches}
                  keyExtractor={r => r.userId}
                  contentContainerStyle={{paddingHorizontal: 20, paddingBottom: contentBottom(24)}}
                  keyboardShouldPersistTaps="handled"
                  renderItem={({item}) => (
                    <TouchableOpacity
                      style={s.contactRow}
                      activeOpacity={0.8}
                      accessibilityRole="button"
                      accessibilityLabel={`Pick ${item.localName ?? item.displayName}`}
                      onPress={() => setPicked(item)}>
                      <View style={s.avatar}>
                        {item.avatarUrl ? (
                          <Image source={{uri: item.avatarUrl}} style={s.avatarImg} />
                        ) : (
                          <Text style={s.avatarText}>{initials(item.localName ?? item.displayName ?? 'M')}</Text>
                        )}
                      </View>
                      <View style={{flex: 1, minWidth: 0}}>
                        <Text style={s.memberName} numberOfLines={1}>{item.localName ?? item.displayName}</Text>
                        <Text style={s.memberSub} numberOfLines={1}>{item.phoneE164}</Text>
                      </View>
                      <Icon name="chevron-right" size={20} color={D.textMute} />
                    </TouchableOpacity>
                  )}
                />
              )}
            </>
          ) : (
            <ScrollView
              style={{flex: 1}}
              contentContainerStyle={{paddingHorizontal: 20, paddingBottom: kbBottomPad(40)}}
              keyboardShouldPersistTaps="handled">
              <View style={s.pickedCard}>
                <View style={[s.avatar, {width: 52, height: 52, borderRadius: 26}]}>
                  {picked.avatarUrl ? (
                    <Image source={{uri: picked.avatarUrl}} style={{width: 52, height: 52, borderRadius: 26}} />
                  ) : (
                    <Text style={[s.avatarText, {fontSize: 16}]}>{initials(picked.localName ?? picked.displayName ?? 'M')}</Text>
                  )}
                </View>
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={[s.memberName, {fontSize: 16}]} numberOfLines={1}>
                    {picked.localName ?? picked.displayName}
                  </Text>
                  <Text style={s.memberSub}>{picked.phoneE164}</Text>
                </View>
              </View>

              <Text style={s.sectionLabel}>SPEND LIMIT (OPTIONAL)</Text>
              <TextInput
                style={s.input}
                value={limitText}
                onChangeText={t => setLimitText(t.replace(/[^\d]/g, ''))}
                placeholder="Max BC they can spend from your wallet — empty = no limit"
                placeholderTextColor={D.textMute}
                selectionColor={D.accent}
                keyboardType="number-pad"
                maxLength={7}
              />

              <TouchableOpacity
                style={{marginTop: 24}}
                activeOpacity={0.9}
                disabled={busy}
                onPress={() => { void sendInvite(); }}
                accessibilityRole="button"
                accessibilityLabel="Send invite"
                accessibilityState={{disabled: busy}}>
                <LinearGradient
                  colors={['#6E9BF5', D.accent, D.accentDeep]}
                  locations={[0, 0.55, 1]}
                  start={{x: 0, y: 0}}
                  end={{x: 0, y: 1}}
                  style={s.cta}>
                  {busy ? <ActivityIndicator color="#fff" /> : (
                    <>
                      <Icon name="send" size={17} color="#fff" importantForAccessibility="no" />
                      <Text style={s.ctaText}>Send Invite</Text>
                    </>
                  )}
                </LinearGradient>
              </TouchableOpacity>
            </ScrollView>
          )}
        </View>
      </Modal>

      {/* ── Manage sheet ── */}
      <Modal visible={!!manage} transparent animationType="slide" onRequestClose={() => { if (!busy) {setManage(null);} }}>
        <Pressable style={s.sheetBackdrop} onPress={() => { if (!busy) {setManage(null);} }}>
          <Pressable style={[s.sheetCard, {paddingBottom: kbBottomPad(24)}]} onPress={() => {}}>
            {manage && (
              <ScrollView
                showsVerticalScrollIndicator={false}
                bounces={false}
                keyboardShouldPersistTaps="handled">
                <View style={{flexDirection: 'row', alignItems: 'center', gap: 12}}>
                  <Text style={[s.sheetTitle, {flex: 1, minWidth: 0}]} numberOfLines={1}>{manage.name}</Text>
                </View>

                {/* B-854/A11 — the one thing on this sheet WAITING on the root.
                    Above everything else for the same reason §43's credit
                    requests sit above the roster: it is a decision, not a
                    detail, and it is about who may spend their money. */}
                {hasPendingFundingAsk(manage) ? (
                  <FundingRequestCard
                    member={manage}
                    style={s.fundCard}
                    onDecided={() => { setManage(null); return load(); }}
                  />
                ) : null}

                {manage.status === 'active' && !isHeld(manage) && (
                  <>
                    <Text style={s.sectionLabel}>LAST LOCATION</Text>
                    {manage.lastLocation ? (
                      <View style={s.locCard}>
                        {managePinUrl ? (
                          <Image
                            source={{uri: managePinUrl}}
                            style={s.locMap}
                            resizeMode="cover"
                            accessibilityLabel={`Map of ${manage.name}'s last location`}
                          />
                        ) : null}
                        <View style={s.locMetaRow}>
                          <View style={{flex: 1, minWidth: 0}}>
                            <Text style={s.locPlace} numberOfLines={1}>
                              {manage.lastLocation.label
                                ?? `${manage.lastLocation.lat.toFixed(4)}, ${manage.lastLocation.lng.toFixed(4)}`}
                            </Text>
                            <Text style={s.locTime}>Updated {timeAgo(manage.lastLocation.recordedAt)}</Text>
                          </View>
                          <TouchableOpacity
                            style={[s.sheetBtn, {paddingVertical: 10}]}
                            activeOpacity={0.85}
                            onPress={() => { if (manage.lastLocation) {openInMaps(manage.lastLocation, manage.name);} }}
                            accessibilityRole="button"
                            accessibilityLabel={`Open ${manage.name}'s location in maps`}>
                            <Text style={s.sheetBtnText}>Open in Maps</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    ) : (
                      <View style={s.locEmpty}>
                        <Icon name="map-marker-off-outline" size={16} color={D.textMute} importantForAccessibility="no" />
                        <Text style={s.locEmptyText}>
                          No location yet — it appears after they open the app with location on.
                        </Text>
                      </View>
                    )}
                  </>
                )}

                {manage.status !== 'pending' && (
                  <>
                    <Text style={s.sectionLabel}>SPENDING · FROM YOUR CREDITS</Text>
                    {spendLoading ? (
                      <View style={{paddingVertical: 14, alignItems: 'center'}}>
                        <ActivityIndicator color={D.accent} />
                      </View>
                    ) : spendError ? (
                      <TouchableOpacity
                        style={s.locEmpty}
                        activeOpacity={0.8}
                        onPress={() => setSpendNonce(n => n + 1)}
                        accessibilityRole="button"
                        accessibilityLabel="Retry loading spending">
                        <Icon name="refresh" size={16} color={D.textMute} importantForAccessibility="no" />
                        <Text style={s.locEmptyText}>Couldn't load spending — tap to retry.</Text>
                      </TouchableOpacity>
                    ) : !spend || spend.transactions.length === 0 ? (
                      <Text style={s.spendEmpty}>Nothing spent from your credits yet.</Text>
                    ) : (
                      <>
                        {spend.byFeature.map(f => (
                          <View key={f.feature} style={s.spendFeatureRow}>
                            <Text style={s.spendFeatureName} numberOfLines={1}>{featureLabel(f.feature)}</Text>
                            <Text style={s.spendFeatureAmt}>
                              {f.spent.toLocaleString()} BC
                              {f.refunded > 0 ? ` · ${f.refunded.toLocaleString()} back` : ''}
                            </Text>
                          </View>
                        ))}
                        <View style={s.spendDivider} />
                        {spend.transactions.slice(0, 6).map(t => (
                          <View key={t.id} style={s.spendTxRow}>
                            <View style={{flex: 1, minWidth: 0}}>
                              {/* B-854/A6 — the ledger actor for a chained charge is
                                  THEIR member, not them. Without this line the root
                                  reads a total with no owner. The "via" half is
                                  load-bearing: an unnamed actor must still not render
                                  as this member's own spend. */}
                              <Text style={s.spendTxLabel} numberOfLines={1}>
                                {t.viaUserId
                                  ? `${t.actorName ?? 'Their member'} via ${manage.name} · ${featureLabel(t.feature)}`
                                  : featureLabel(t.feature)}
                              </Text>
                              <Text style={s.spendTxDate}>{fmtDate(t.at)}</Text>
                            </View>
                            <Text style={[s.spendTxAmt, t.amount > 0 && {color: D.signal}]}>
                              {t.amount > 0
                                ? `+${t.amount.toLocaleString()}`
                                : `−${Math.abs(t.amount).toLocaleString()}`} BC
                            </Text>
                          </View>
                        ))}
                        {spend.transactions.length > 6 ? (
                          <Text style={s.spendMore}>
                            {spend.transactions.length - 6} more in your wallet history
                          </Text>
                        ) : null}
                      </>
                    )}
                  </>
                )}

                {manage.status === 'active' && (
                  <>
                    <Text style={s.sectionLabel}>SPEND LIMIT (BC)</Text>
                    <View style={{flexDirection: 'row', gap: 10}}>
                      <TextInput
                        style={[s.input, {flex: 1, marginTop: 0}]}
                        value={manageLimit}
                        onChangeText={t => setManageLimit(t.replace(/[^\d]/g, ''))}
                        placeholder="No limit"
                        placeholderTextColor={D.textMute}
                        selectionColor={D.accent}
                        keyboardType="number-pad"
                        maxLength={7}
                      />
                      <TouchableOpacity
                        style={s.sheetBtn}
                        activeOpacity={0.85}
                        disabled={busy}
                        onPress={() => { void saveLimit(manage); }}
                        accessibilityRole="button"
                        accessibilityLabel="Save limit">
                        <Text style={s.sheetBtnText}>Save</Text>
                      </TouchableOpacity>
                    </View>

                    <Text style={s.sectionLabel}>{isHeld(manage) ? 'ON HOLD' : 'PUT ON HOLD'}</Text>
                    {isHeld(manage) ? (
                      <TouchableOpacity
                        style={[s.sheetRow]}
                        activeOpacity={0.8}
                        disabled={busy}
                        onPress={() => { void applyHold(manage, null); }}
                        accessibilityRole="button"
                        accessibilityLabel="Lift hold">
                        <Icon name="play-circle-outline" size={18} color={D.signal} />
                        <Text style={[s.sheetRowText, {color: D.signal}]}>
                          Lift hold (held until {fmtDate(manage.heldUntil!)})
                        </Text>
                      </TouchableOpacity>
                    ) : (
                      <View style={{flexDirection: 'row', gap: 9}}>
                        {[7, 14, 30].map(d => (
                          <TouchableOpacity
                            key={d}
                            style={[s.chip, {flex: 1, alignItems: 'center'}]}
                            activeOpacity={0.8}
                            disabled={busy}
                            onPress={() => { void applyHold(manage, d); }}
                            accessibilityRole="button"
                            accessibilityLabel={`Hold ${d} days`}>
                            <Text style={s.chipText}>{d} days</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    )}
                  </>
                )}

                {/* B-854/A10 — the root's stop button. Only rendered while the
                    chain is actually ON: a control that can only ever answer
                    "nothing to switch off" is noise. The server may still
                    refuse it while their members' bookings are in flight. */}
                {manage.status === 'active' && manage.fundsSubMembers === true ? (
                  <>
                    <Text style={s.sectionLabel}>THEIR MEMBERS’ SPENDING</Text>
                    <TouchableOpacity
                      style={[s.sheetRow, {borderColor: 'rgba(245,199,107,0.3)', backgroundColor: 'rgba(245,199,107,0.06)'}]}
                      activeOpacity={0.8}
                      disabled={busy}
                      onPress={() => confirmStopFunding(manage)}
                      accessibilityRole="button"
                      accessibilityState={{disabled: busy}}
                      accessibilityLabel={`Stop funding ${manage.name}’s members`}>
                      <Icon name="account-cancel-outline" size={18} color={D.amber} />
                      <Text style={[s.sheetRowText, {color: D.amber}]}>
                        Stop paying for their members
                      </Text>
                    </TouchableOpacity>
                  </>
                ) : null}

                <TouchableOpacity
                  style={[s.sheetRow, {marginTop: 18, borderColor: 'rgba(255,93,93,0.3)', backgroundColor: 'rgba(255,93,93,0.06)'}]}
                  activeOpacity={0.8}
                  disabled={busy}
                  onPress={() => removeMember(manage)}
                  accessibilityRole="button"
                  accessibilityLabel="Remove member">
                  <Icon name="account-remove-outline" size={18} color={D.alert} />
                  <Text style={[s.sheetRowText, {color: D.alert}]}>
                    {manage.status === 'pending' ? 'Cancel invite' : 'Remove member'}
                  </Text>
                </TouchableOpacity>
              </ScrollView>
            )}
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
  headerSub: {fontFamily: D.fMono, fontSize: 9.5, fontWeight: '600', letterSpacing: 1.6, color: D.textMute, marginTop: 5},

  centerFill: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 40},
  emptyCard: {
    alignItems: 'center', gap: 9, borderRadius: 18, padding: 26,
    backgroundColor: 'rgba(22,27,37,0.72)', borderWidth: 1, borderColor: D.hair,
  },
  emptyTitle: {color: D.textDim, fontFamily: D.fBold, fontSize: 14.5},
  emptySub: {color: D.textMute, fontFamily: D.fSans, fontSize: 12, lineHeight: 17, textAlign: 'center'},

  memberCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 13, borderRadius: 16,
    backgroundColor: 'rgba(22,27,37,0.72)', borderWidth: 1, borderColor: D.hair,
  },
  // B-854/P1-2 — the row a funding wake named, marked the same way the quota
  // card marks the root a money refusal named.
  memberCardFocused: {borderColor: D.accent, backgroundColor: 'rgba(91,141,239,0.10)'},
  // §43 — the pending-request card. An amber edge, not the member card's neutral
  // hairline: this row is the only thing on the screen waiting on the holder,
  // and it reads as a task rather than a roster entry.
  // Now a COLUMN: the name/amount/actions line, then §14's partial-approval
  // affordance under it. The row that used to be this container is `requestRow`.
  requestCard: {
    gap: 8,
    padding: 13, borderRadius: 16,
    backgroundColor: 'rgba(245,199,107,0.06)',
    borderWidth: 1, borderColor: 'rgba(245,199,107,0.28)',
  },
  requestRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  requestPartialLink: {
    color: D.accentSoft, fontSize: 12, fontFamily: D.fSemi,
    // A text link still needs a real touch target.
    paddingVertical: 6,
  },
  requestPartialRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  requestName:   {color: D.text, fontSize: 14, fontFamily: D.fSemi},
  requestAmount: {color: D.amber, fontSize: 12.5, fontFamily: D.fSemi},
  requestReason: {color: D.textDim, fontSize: 11.5, fontFamily: D.fSans, fontStyle: 'italic'},
  requestBtn: {
    minHeight: 36, paddingHorizontal: 14, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  requestBtnGhost:      {backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2},
  requestBtnGhostText:  {color: D.textDim, fontSize: 12.5, fontFamily: D.fSemi},
  requestBtnPrimary:    {backgroundColor: D.accentDeep},
  requestBtnPrimaryText:{color: '#FFFFFF', fontSize: 12.5, fontFamily: D.fSemi},
  avatar: {
    width: 44, height: 44, borderRadius: 22, flexShrink: 0, overflow: 'hidden',
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarImg: {width: 44, height: 44, borderRadius: 22},
  avatarText: {color: D.accentSoft, fontFamily: D.fBold, fontSize: 13},
  memberName: {color: D.text, fontFamily: D.fBold, fontSize: 14},
  memberSub: {color: D.textMute, fontFamily: D.fSans, fontSize: 11, marginTop: 3},
  memberLocRow: {flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3, minWidth: 0},
  memberLoc: {flex: 1, minWidth: 0, color: D.accentSoft, fontFamily: D.fSans, fontSize: 10.5},

  // B-854 — chain badges. Wrapping, because "Funds their members from you" is
  // long and a 320dp row must not clip a statement about money.
  chainRow:  {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 5},
  chainPill: {
    paddingVertical: 3, paddingHorizontal: 7, borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
  },
  chainPillText:   {color: D.textDim, fontFamily: D.fSemi, fontSize: 10},
  chainPillOn:     {backgroundColor: 'rgba(91,141,239,0.12)', borderColor: 'rgba(91,141,239,0.36)'},
  chainPillOnText: {color: D.accentSoft},

  // The pending funding ask carries its own look (FundingRequestCard, shared
  // with the ungated profile surface); this is only where it sits on the sheet.
  fundCard: {marginTop: 14},

  moreRow: {
    minHeight: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.08)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.24)',
  },
  moreText: {color: D.accentSoft, fontFamily: D.fSemi, fontSize: 12.5},
  statePill: {flexShrink: 0, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 7, borderWidth: 1},
  statePillText: {fontFamily: D.fMono, fontSize: 8.5, fontWeight: '800', letterSpacing: 1},

  noteCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    marginTop: 18, padding: 14, borderRadius: 14,
    backgroundColor: 'rgba(91,141,239,0.07)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.22)',
  },
  noteText: {flex: 1, minWidth: 0, fontFamily: D.fSans, fontSize: 11.5, lineHeight: 17, color: D.textDim},

  ctaWrap: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 28},
  cta: {
    minHeight: 56, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  ctaText: {fontFamily: D.fBold, fontSize: 15.5, letterSpacing: 0.3, color: '#fff'},

  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 9,
    marginHorizontal: 20, marginBottom: 12, paddingHorizontal: 13,
    borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1, borderColor: D.hair2,
  },
  searchInput: {flex: 1, minWidth: 0, paddingVertical: 11, color: D.text, fontFamily: D.fSans, fontSize: 13.5},

  contactRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: D.hair,
  },

  pickedCard: {
    flexDirection: 'row', alignItems: 'center', gap: 13,
    padding: 15, borderRadius: 16, marginBottom: 6,
    backgroundColor: 'rgba(22,27,37,0.72)', borderWidth: 1, borderColor: D.hair,
  },

  sectionLabel: {
    color: D.textDim, fontFamily: D.fMono, fontSize: 10, fontWeight: '600',
    letterSpacing: 2, textTransform: 'uppercase', marginTop: 20, marginBottom: 10,
  },
  chip: {
    paddingVertical: 9, paddingHorizontal: 14, borderRadius: 99,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  chipText: {fontFamily: D.fSemi, fontSize: 12.5, color: D.textDim},

  input: {
    marginTop: 0, borderRadius: 13, paddingHorizontal: 14, paddingVertical: 12,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
    color: D.text, fontFamily: D.fSans, fontSize: 13.5,
  },

  sheetBackdrop: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)'},
  sheetCard: {
    backgroundColor: '#10151F', borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: 20, paddingTop: 20, maxHeight: '86%',
  },

  locCard: {
    borderRadius: 14, overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  locMap: {width: '100%', height: 140, backgroundColor: 'rgba(91,141,239,0.08)'},
  locMetaRow: {flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12},
  locPlace: {color: D.text, fontFamily: D.fSemi, fontSize: 13},
  locTime: {color: D.textMute, fontFamily: D.fSans, fontSize: 10.5, marginTop: 2},
  locEmpty: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 13, borderRadius: 13,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  locEmptyText: {flex: 1, minWidth: 0, color: D.textMute, fontFamily: D.fSans, fontSize: 11.5, lineHeight: 16},

  spendEmpty: {color: D.textMute, fontFamily: D.fSans, fontSize: 11.5},
  spendFeatureRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 5},
  spendFeatureName: {flex: 1, minWidth: 0, color: D.textDim, fontFamily: D.fSemi, fontSize: 12.5},
  spendFeatureAmt: {flexShrink: 0, color: D.text, fontFamily: D.fBold, fontSize: 12.5},
  spendDivider: {height: 1, backgroundColor: D.hair, marginVertical: 8},
  spendTxRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 5},
  spendTxLabel: {color: D.textDim, fontFamily: D.fSans, fontSize: 12},
  spendTxDate: {color: D.textMute, fontFamily: D.fSans, fontSize: 10, marginTop: 1},
  spendTxAmt: {flexShrink: 0, color: D.text, fontFamily: D.fSemi, fontSize: 12.5},
  spendMore: {color: D.textMute, fontFamily: D.fSans, fontSize: 10.5, marginTop: 6, textAlign: 'center'},
  sheetTitle: {color: D.text, fontFamily: D.fBold, fontSize: 17},
  sheetBtn: {
    paddingHorizontal: 18, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.45)',
  },
  sheetBtnText: {color: D.accentSoft, fontFamily: D.fBold, fontSize: 13},
  sheetRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 13, borderRadius: 13,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  sheetRowText: {fontFamily: D.fSemi, fontSize: 13.5},
}));
