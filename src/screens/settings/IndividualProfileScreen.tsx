import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  Modal,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useKeyboardOverlap} from '@hooks/useKeyboardLayout';
import {useFocusEffect, useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {BookingStackParamList} from '@navigation/types';
import {useAuthStore} from '@store/authStore';
import {familyApi, type FamilyCreditRequest, type FamilyMember, type FamilyUsage} from '@/services/api';
import {normalizeBatch, regionFromOwnPhone} from '@/modules/messenger/contacts/phoneNormalize';
import {BravoFont} from '@/theme/bravo';
import LoadingView from '@components/LoadingView';
import {isProActive} from '@utils/tier';
import {goBackOnce} from '@navigation/tapGuard';
import {Alert} from '@utils/alert';
import {FamilyQuotaCard} from './FamilyQuotaCard';
import {FundingRequestCard, hasPendingFundingAsk} from './FundingRequestCard';
import {useRosterRowFocus} from './useRosterRowFocus';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

const T = {
  bg:        '#0A1F3F',
  text:      '#FFFFFF',
  textDim:   'rgba(229,233,242,0.62)',
  textMute:  'rgba(180,188,204,0.45)',
  textFaint: 'rgba(180,188,204,0.28)',
  hair:      'rgba(255,255,255,0.06)',
  hair2:     'rgba(255,255,255,0.09)',
  accent:    '#1E88FF',
  accentDeep:'#166ED1',
  accentSoft:'#7FA8FF',
  accentGlow:'rgba(91,141,239,0.35)',
  blue:      '#3BA6FF',
  signal:    '#4ADE80',
  gold:      '#E2C893',
  alert:     '#FF8585',
  card:      'rgba(18,22,30,0.85)',
} as const;

const USAGE_COLORS = ['#3BA6FF', '#6EE7B7', '#FCD34D', '#FCA5A5'];

function initialsOf(name: string): string {
  return name.split(/[\s@.+]/).filter(Boolean).map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase() || '?';
}

/** A13 — offset paging re-serves a row when a new one lands at the top. */
function mergeById(prev: FamilyMember[], next: FamilyMember[]): FamilyMember[] {
  const byId = new Map(prev.map(m => [m.id, m]));
  for (const m of next) {byId.set(m.id, m);}
  return Array.from(byId.values());
}

export default function IndividualProfileScreen() {
  const navigation = useNavigation();
  // B-843/A11 — a money refusal that named a root deep-links here with its id,
  // so the member lands on the card that refused instead of a stack of them.
  const route = useRoute<RouteProp<BookingStackParamList, 'IndividualProfile'>>();
  const paramFocus = route.params?.focusHolderId ?? null;
  // P2-6 — spend the highlight once. React Navigation RETAINS route params, so
  // leaving it set kept the card highlighted for the whole session and made
  // every later visit open on a highlight that meant nothing. The value is
  // adopted into state (so this visit still shows it) and the PARAM is cleared;
  // a fresh deep link re-arms it because the effect re-runs on the new value.
  const [focusHolderId, setFocusHolderId] = useState<string | null>(paramFocus);
  useEffect(() => {
    if (!paramFocus) {return;}
    setFocusHolderId(paramFocus);
    navigation.setParams({focusHolderId: undefined} as never);
  }, [paramFocus, navigation]);
  // B-854 — the same one-shot highlight, addressed by membership ROW id. A push
  // payload carries `familyRowId` and no holder id (ids only on the wire), so
  // without this the funding wakes land on a stack of look-alike cards.
  const paramRowFocus = route.params?.focusRowId ?? null;
  const [focusRowId, setFocusRowId] = useState<string | null>(paramRowFocus);
  useEffect(() => {
    if (!paramRowFocus) {return;}
    setFocusRowId(paramRowFocus);
    navigation.setParams({focusRowId: undefined} as never);
  }, [paramRowFocus, navigation]);
  // B-854/P1-2 — the HOLDER's counterpart. Same id space, opposite side: this
  // one addresses a row on the roster below, which is the only list an `(A,B)`
  // row can appear in for its holder.
  const rosterFocus = useRosterRowFocus(
    route.params?.focusMemberRowId ?? null,
    useCallback(() => { navigation.setParams({focusMemberRowId: undefined} as never); }, [navigation]),
  );
  const insets = useSafeAreaInsets();
  // B-84 / KB-12 — Android Modal windows don't resize for the IME.
  const keyboardOverlap = useKeyboardOverlap();
  const {user} = useAuthStore();
  const [showInviteToast, setShowInviteToast] = useState(false);
  const [toastMsg, setToastMsg] = useState('');

  const holderName = user?.full_name ?? user?.email ?? 'Account Holder';
  const holderInitials = initialsOf(holderName);
  const tierLabel = isProActive(user) ? 'PRO' : 'INDIVIDUAL';

  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [counts, setCounts] = useState<{active: number; pending: number; held: number} | null>(null);
  const [usage, setUsage] = useState<FamilyUsage | null>(null);
  // B-724 — pending credit requests were only visible on the Pro-gated members
  // sheet; a non-Pro holder was notified of a request but had nowhere to act.
  const [creditRequests, setCreditRequests] = useState<FamilyCreditRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [pagingBusy, setPagingBusy] = useState(false);
  const [rosterQuery, setRosterQuery] = useState('');

  /**
   * B-835 — the roster is unbounded, so it is server-searched and server-paged.
   * Every request carries a sequence number and only the latest may write
   * state: a slow page for an older query must never overwrite a newer one.
   */
  const seqRef = useRef(0);
  const qRef = useRef('');
  const fetchPage = useCallback(async (q: string, offset: number) => {
    const seq = ++seqRef.current;
    try {
      const {data} = await familyApi.members({q: q || undefined, limit: PAGE_SIZE, offset});
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

  const load = useCallback(() => {
    // A13 — a focus reload re-issues the CURRENT query at offset 0 and REPLACES.
    void fetchPage(qRef.current, 0);
    void familyApi.usage().then(r => setUsage(r.data)).catch(() => {});
    void familyApi.creditRequests()
      .then(r => setCreditRequests(r.data.requests.filter(q => q.status === 'pending')))
      .catch(() => {});
  }, [fetchPage]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

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
    // Why: a fetch, not money — but the guard is a synchronous ref so a double
    // tap cannot issue two page requests (NAV rapid-use).
    if (pagingRef.current) {return;}
    pagingRef.current = true;
    setPagingBusy(true);
    void fetchPage(qRef.current, members.length)
      .finally(() => { pagingRef.current = false; setPagingBusy(false); });
  }, [fetchPage, members.length]);

  // Counts come from the SERVER (unfiltered; `active` includes held) so they
  // stay right when only the first page is loaded. Older servers send none.
  const activeCount = counts ? counts.active : members.filter(m => m.status === 'active').length;
  const pendingCount = counts ? counts.pending : members.filter(m => m.status === 'pending').length;

  // A17 — `usage.members` is the server's top 50 by spend; everyone below it is
  // rolled into one bar so the shares still visibly total.
  const othersCount = Math.max(0, (usage?.memberCount ?? 0) - (usage?.members.length ?? 0));
  const othersSpent = usage?.othersSpent ?? 0;

  const [inviteOpen, setInviteOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [limit, setLimit] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toast = (m: string) => { setToastMsg(m); setShowInviteToast(true); setTimeout(() => setShowInviteToast(false), 3000); };

  const handleAddMember = () => {
    setErr(null); setPhone(''); setLimit(''); setInviteOpen(true);
  };

  const submitInvite = async () => {
    setErr(null);
    const code = regionFromOwnPhone(user?.phone_e164 ?? null);
    const [e164] = normalizeBatch([phone], code);
    if (!e164) { setErr('Enter a valid phone number with country code.'); return; }
    const cap = limit.trim() ? Math.max(0, Math.floor(Number(limit))) : null;
    if (limit.trim() && !Number.isFinite(cap)) { setErr('Spend limit must be a number.'); return; }
    setBusy(true);
    try {
      await familyApi.invite(e164, cap);
      setInviteOpen(false);
      toast('Invite sent. They appear once they accept.');
      load();
    } catch (e) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      // Why: `family_full` can still arrive from a not-yet-updated server.
      setErr(msg === 'family_full' ? 'Member limit reached — update the app or contact Ops.'
        : msg === 'cannot_invite_self' ? "That's your own number."
        // B-843 — `member_in_another_family` is gone: a person may be a member
        // under any number of roots now, so the server never emits it. The
        // SAME-root guard replaced it (A2), and it needs its own copy or the
        // snake_case code reaches this sheet verbatim.
        : msg === 'already_in_this_family' ? "They're already a member on this account."
        : msg === 'invite_already_pending' ? 'Invite already pending for that number.'
        : 'Could not send invite. Try again.');
    } finally {
      setBusy(false);
    }
  };

  // B-724 — the old handler was an unlabeled ×, no confirmation, and its
  // .catch(() => {}) swallowed every failure: a failed remove was
  // indistinguishable from a mis-tap. Confirm first, surface failure, and
  // guard re-entry synchronously (NAV rule: never disabled={state} alone).
  const removingRef = useRef(false);
  const removeMember = (m: FamilyMember) => {
    const pending = m.status === 'pending';
    Alert.alert(
      pending ? 'Cancel this invite?' : `Remove ${m.name}?`,
      pending
        ? 'They will no longer be able to use your plan or credits.'
        : 'They immediately lose access to your credits. Their spending history stays recorded.',
      [
        {text: 'Keep', style: 'cancel'},
        {
          text: pending ? 'Cancel invite' : 'Remove',
          style: 'destructive',
          onPress: () => {
            if (removingRef.current) {return;}
            removingRef.current = true;
            familyApi.remove(m.id)
              .then(() => { toast(pending ? 'Invite cancelled.' : 'Member removed.'); load(); })
              .catch(() => {
                Alert.alert('Could not remove', 'Something went wrong — no change was made. Check your connection and try again.');
              })
              .finally(() => { removingRef.current = false; });
          },
        },
      ],
    );
  };

  // B-724 — "cannot change member info": limit editing existed only behind the
  // Pro-gated members sheet; this surface rendered the limit as static text.
  const [editMember, setEditMember] = useState<FamilyMember | null>(null);
  const [editLimit, setEditLimit] = useState('');
  const [editErr, setEditErr] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const openEditLimit = (m: FamilyMember) => {
    setEditErr(null);
    setEditLimit(m.spendLimit !== null && m.spendLimit !== undefined ? String(m.spendLimit) : '');
    setEditMember(m);
  };
  const submitEditLimit = async () => {
    if (!editMember || editBusy) {return;}
    const trimmed = editLimit.trim();
    const cap = trimmed ? Math.floor(Number(trimmed)) : null;
    if (trimmed && (!Number.isFinite(cap) || (cap as number) < 0)) {
      setEditErr('Spend limit must be a number.');
      return;
    }
    setEditBusy(true);
    try {
      await familyApi.setLimit(editMember.id, cap);
      setEditMember(null);
      toast(cap === null ? 'Limit removed — shared credits.' : `Limit set to ${cap} cr.`);
      load();
    } catch (e) {
      const body = (e as {response?: {data?: {message?: string; minimumCredits?: number}}})?.response?.data;
      setEditErr(body?.message === 'quota_below_spent' || (body as {code?: string} | undefined)?.code === 'QUOTA_BELOW_SPENT'
        ? `Cannot set below what they've already spent${typeof body?.minimumCredits === 'number' ? ` (${body.minimumCredits} cr)` : ''}.`
        : 'Could not update the limit. Try again.');
    } finally {
      setEditBusy(false);
    }
  };

  // B-724 — approve / partial-approve / reject a member's credit request,
  // from the ungated surface. Synchronous ref guard per the NAV mutation rule.
  const decidingRef = useRef(false);
  const decideRequest = (req: FamilyCreditRequest, action: 'approve' | 'reject', credits?: number) => {
    if (decidingRef.current) {return;}
    decidingRef.current = true;
    const call = action === 'approve'
      ? familyApi.approveCredit(req.id, credits ?? undefined)
      : familyApi.rejectCredit(req.id);
    call
      .then(() => {
        toast(action === 'approve'
          ? `Approved ${credits ?? req.requestedCredits} cr for ${req.memberName ?? 'member'}.`
          : 'Request rejected.');
        setAdjustReq(null);
        load();
      })
      .catch(() => {
        Alert.alert('Could not update', 'Something went wrong — the request is unchanged. Try again.');
      })
      .finally(() => { decidingRef.current = false; });
  };
  const confirmReject = (req: FamilyCreditRequest) => {
    Alert.alert(
      'Reject this request?',
      `${req.memberName ?? 'The member'} asked for ${req.requestedCredits} cr. They will be notified.`,
      [
        {text: 'Keep', style: 'cancel'},
        {text: 'Reject', style: 'destructive', onPress: () => decideRequest(req, 'reject')},
      ],
    );
  };
  // Partial approval: a small amount editor, mirroring the limit modal.
  const [adjustReq, setAdjustReq] = useState<FamilyCreditRequest | null>(null);
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustErr, setAdjustErr] = useState<string | null>(null);
  const submitAdjust = () => {
    if (!adjustReq) {return;}
    const parsed = Math.floor(Number(adjustAmount.trim()));
    if (!Number.isFinite(parsed) || parsed <= 0) { setAdjustErr('Enter a positive amount.'); return; }
    decideRequest(adjustReq, 'approve', parsed);
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={T.bg} />

      <View style={styles.header}>
        <TouchableOpacity style={styles.back} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
          <Icon name="chevron-left" size={22} color={T.text} />
        </TouchableOpacity>
        <View>
          <Text style={styles.headerTitle}>Individual Profile</Text>
          <Text style={styles.headerSub}>Manage your account & members</Text>
        </View>
        <View style={{width: 36}} />
      </View>

      <ScrollView ref={rosterFocus.scrollRef as never} showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 24}]}>

        {/* ── Identity card ── */}
        <View style={styles.idCard}>
          <LinearGradient colors={['rgba(20,32,60,0.8)', 'rgba(12,17,27,0.7)']} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={StyleSheet.absoluteFill} />
          <View style={styles.idGlow} pointerEvents="none" />
          <View style={styles.idRow}>
            {user?.avatar_url ? (
              <Image source={{uri: user.avatar_url}} style={styles.idAvatarImg} />
            ) : (
              <LinearGradient colors={['#7C5AD6', '#5B43C9']} start={{x: 0.2, y: 0}} end={{x: 0.8, y: 1}} style={styles.idAvatar}>
                <Text style={styles.idAvatarText}>{holderInitials}</Text>
              </LinearGradient>
            )}
            <View style={{flex: 1, minWidth: 0}}>
              <FitLine style={styles.idName} floorScale={0.7} text={holderName} />
              <View style={styles.idBadges}>
                <View style={[styles.badge, {backgroundColor: 'rgba(91,141,239,0.14)', borderColor: 'rgba(91,141,239,0.34)'}]}>
                  <Text style={[styles.badgeText, {color: T.blue}]}>{tierLabel}</Text>
                </View>
                <View style={[styles.badge, {backgroundColor: 'rgba(212,179,122,0.12)', borderColor: 'rgba(212,179,122,0.4)'}]}>
                  <Text style={[styles.badgeText, {color: T.gold}]}>ACCOUNT HOLDER</Text>
                </View>
              </View>
            </View>
          </View>
        </View>

        {/* ── Your own spending limit, when you are a MEMBER of someone else's
            plan (spec §41/§42). Renders null otherwise, so an account holder
            who is not also a member sees nothing here. ── */}
        <FamilyQuotaCard focusHolderId={focusHolderId} focusRowId={focusRowId} />

        {/* ── Members (B-832: no cap, so no seat meter and no fixed slots) ── */}
        <View style={styles.sectionHead}>
          <Text style={styles.sectionLabel}>
            Members · {activeCount} active{pendingCount > 0 ? ` · ${pendingCount} pending` : ''}
          </Text>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={handleAddMember}
            accessibilityRole="button"
            accessibilityLabel="Add a member">
            <LinearGradient colors={['#3BA6FF', T.accent, T.accentDeep]} start={{x: 0, y: 0}} end={{x: 0, y: 1}} style={styles.addBtn}>
              <Icon name="plus" size={18} color="#fff" />
            </LinearGradient>
          </TouchableOpacity>
        </View>

        {/* B-835 — search the whole roster server-side, not the loaded page. */}
        {!loading && (members.length > 0 || rosterQuery.trim().length > 0) && (
          <View style={styles.searchWrap}>
            <Icon name="magnify" size={17} color={T.textMute} importantForAccessibility="no" />
            <TextInput
              style={styles.searchInput}
              value={rosterQuery}
              onChangeText={setRosterQuery}
              placeholder="Search members…"
              placeholderTextColor={T.textMute}
              autoCorrect={false}
              accessibilityLabel="Search members"
            />
          </View>
        )}

        {loading && (
          <View style={{paddingVertical: 28, alignItems: 'center'}}>
            <LoadingView compact label="Loading profile…" />
          </View>
        )}

        {/* B-724 — holder-side pending credit requests (ungated; the Pro
            members sheet keeps its richer panel for ACTIVE-plan holders) */}
        {creditRequests.length > 0 && (
          <View style={[styles.detailCard, {marginBottom: 14, padding: 14}]}>
            {creditRequests.map((req, i) => (
              <View key={req.id} style={i > 0 ? {marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: T.hair2} : undefined}>
                <Text style={styles.memberName} numberOfLines={1}>
                  {(req.memberName ?? 'A member')} requests {req.requestedCredits} cr
                </Text>
                {!!req.reason && (
                  <Text style={styles.memberRole} numberOfLines={2}>“{req.reason}”</Text>
                )}
                <View style={{flexDirection: 'row', gap: 8, marginTop: 10}}>
                  <TouchableOpacity
                    style={{flex: 1, borderRadius: 10, paddingVertical: 9, alignItems: 'center', backgroundColor: T.accent}}
                    activeOpacity={0.85}
                    accessibilityRole="button"
                    accessibilityLabel={`Approve ${req.requestedCredits} credits`}
                    onPress={() => decideRequest(req, 'approve')}>
                    <Text style={{color: '#fff', fontFamily: BravoFont.semiBold, fontSize: 13}}>Approve</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={{flex: 1, borderRadius: 10, paddingVertical: 9, alignItems: 'center', borderWidth: 1, borderColor: T.hair2}}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel="Approve a different amount"
                    onPress={() => { setAdjustErr(null); setAdjustAmount(String(req.requestedCredits)); setAdjustReq(req); }}>
                    <Text style={{color: T.text, fontFamily: BravoFont.semiBold, fontSize: 13}}>Adjust</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={{flex: 1, borderRadius: 10, paddingVertical: 9, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(239,91,91,0.45)'}}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel="Reject request"
                    onPress={() => confirmReject(req)}>
                    <Text style={{color: '#EF5B5B', fontFamily: BravoFont.semiBold, fontSize: 13}}>Reject</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* member detail rows (pending + active with limits/remove) */}
        {!loading && members.length > 0 && (
          <View style={styles.detailCard} onLayout={rosterFocus.onListLayout}>
            {members.map((m, i) => (
              // B-854 — the row plus, when they are waiting on one, the funding
              // decision. The separator moves to this wrapper so it sits under
              // the whole member, card included.
              <View
                key={m.id}
                testID={`member-row-${m.id}`}
                onLayout={rosterFocus.onRowLayout(m.id)}
                accessibilityState={{selected: rosterFocus.isFocused(m.id)}}
                style={[
                  i < members.length - 1 ? styles.memberRowBorder : undefined,
                  rosterFocus.isFocused(m.id) ? styles.memberRowFocused : undefined,
                ]}>
              <View style={styles.memberRow}>
                <View style={styles.memberAvatar}><Text style={styles.memberAvatarText}>{initialsOf(m.name)}</Text></View>
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={styles.memberName} numberOfLines={1}>{m.name}</Text>
                  <Text style={styles.memberRole}>
                    {m.status === 'pending' ? 'Invite pending'
                      : m.spendLimit !== null ? `Limit ${m.spendLimit} cr · spent ${m.spent}`
                      : 'Shared credits'}
                  </Text>
                </View>
                {m.status === 'pending' ? (
                  // B-724 — a pending invite previously had NO cancel control at
                  // all on this screen; the badge now pairs with the same ×.
                  <View style={[styles.badge, {backgroundColor: 'rgba(245,181,68,0.12)', borderColor: 'rgba(245,181,68,0.3)'}]}>
                    <Text style={[styles.badgeText, {color: '#F5B544'}]}>PENDING</Text>
                  </View>
                ) : (
                  <TouchableOpacity
                    onPress={() => openEditLimit(m)}
                    hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                    activeOpacity={0.7}
                    accessibilityLabel={`Edit ${m.name}'s spending limit`}
                    style={{marginRight: 12}}>
                    <Icon name="pencil-outline" size={19} color={T.textMute} />
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  onPress={() => removeMember(m)}
                  hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
                  activeOpacity={0.7}
                  accessibilityLabel={m.status === 'pending' ? `Cancel invite for ${m.name}` : `Remove ${m.name}`}>
                  <Icon name="close-circle-outline" size={20} color={T.textMute} />
                </TouchableOpacity>
              </View>
              {/* B-854 — a holder does NOT need a Secure Pro plan to hold
                  members, so the ask they are pushed about has to be
                  answerable HERE, not only on the plan-gated sheet (B-724). */}
              {hasPendingFundingAsk(m) ? (
                <FundingRequestCard member={m} style={styles.fundingAsk} onDecided={load} />
              ) : null}
              </View>
            ))}
            {hasMore && (
              <TouchableOpacity
                style={styles.moreRow}
                activeOpacity={0.8}
                disabled={pagingBusy}
                onPress={loadMore}
                accessibilityRole="button"
                accessibilityLabel="Show more members"
                accessibilityState={{disabled: pagingBusy}}>
                {pagingBusy
                  ? <ActivityIndicator color={T.accent} />
                  : <Text style={styles.moreText}>Show more · {members.length} of {total}</Text>}
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* empty invite CTA */}
        {!loading && members.length === 0 && rosterQuery.trim().length > 0 && (
          <View style={styles.emptyCard}>
            <View style={styles.emptyIcon}><Icon name="account-search-outline" size={26} color={T.blue} /></View>
            <Text style={styles.emptyTitle}>No members match</Text>
            <Text style={styles.emptySub}>Try part of a name, or their phone number.</Text>
          </View>
        )}
        {!loading && members.length === 0 && rosterQuery.trim().length === 0 && (
          <View style={styles.emptyCard}>
      <ImageryBackdrop source={Imagery.authClientApp} variant="card" radius={20} />
            <View style={styles.emptyIcon}><Icon name="account-multiple-plus-outline" size={26} color={T.blue} /></View>
            <Text style={styles.emptyTitle}>No members yet</Text>
            <Text style={styles.emptySub}>Add people who can spend from your Bravo Credits once they accept.</Text>
            <TouchableOpacity activeOpacity={0.85} onPress={handleAddMember} style={{width: '100%', marginTop: 20}}>
              <LinearGradient colors={['#3BA6FF', T.accent, T.accentDeep]} start={{x: 0, y: 0}} end={{x: 0, y: 1}} style={styles.emptyBtn}>
                <Icon name="account-plus-outline" size={17} color="#fff" />
                <Text style={styles.emptyBtnText}>Add a member</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Credit usage ── */}
        {usage && usage.members.length > 0 && (
          <View style={styles.usageCard}>
            <View style={styles.usageHeader}>
              <Text style={styles.sectionLabelInline}>Credit Usage</Text>
              <Text style={styles.usageTotal}>{usage.totalSpent.toLocaleString()} BC total</Text>
            </View>
            {usage.members.map((m, i) => {
              const c = USAGE_COLORS[i % USAGE_COLORS.length];
              const denom = m.spendLimit ?? (usage.totalSpent || 1);
              const pct = Math.min(100, Math.round((m.spent / Math.max(denom, 1)) * 100));
              return (
                <View key={m.id} style={styles.usageRow}>
                  <View style={styles.usageRowTop}>
                    <Text style={styles.usageName}>{m.name}</Text>
                    <Text style={styles.usageVal}>
                      {m.spent.toLocaleString()}{m.spendLimit !== null ? ` / ${m.spendLimit.toLocaleString()}` : ''} BC
                      <Text style={styles.usageShare}>  ·  {m.sharePct}%</Text>
                    </Text>
                  </View>
                  <View style={styles.usageTrack}>
                    <View style={[styles.usageFill, {width: `${pct}%`, backgroundColor: c}]} />
                  </View>
                </View>
              );
            })}
            {/* A17 — `members` is the server's top 50 by spend. Without this row
                the bars would silently omit everyone else's spending and the
                shares would not add up to the total above. */}
            {othersCount > 0 && (
              <View style={styles.usageRow}>
                <View style={styles.usageRowTop}>
                  <Text style={styles.usageName}>Others ({othersCount} members)</Text>
                  <Text style={styles.usageVal}>{othersSpent.toLocaleString()} BC</Text>
                </View>
                <View style={styles.usageTrack}>
                  <View style={[styles.usageFill, {
                    width: `${Math.min(100, Math.round((othersSpent / Math.max(usage.totalSpent || 1, 1)) * 100))}%`,
                    backgroundColor: T.textMute,
                  }]} />
                </View>
              </View>
            )}
          </View>
        )}

        {/* shared-credits note */}
        <View style={styles.note}>
          <Icon name="information-outline" size={16} color={T.textMute} style={{marginTop: 1}} />
          <Text style={styles.noteText}>Members share your wallet balance. You stay in control and can remove anyone at any time.</Text>
        </View>

        {showInviteToast && (
          <View style={styles.toast}><Text style={styles.toastText}>{toastMsg}</Text></View>
        )}
      </ScrollView>

      {/* Invite modal */}
      <Modal visible={inviteOpen} transparent animationType="fade" onRequestClose={() => setInviteOpen(false)}>
        {/* B-184 — one rule, both platforms: the backdrop shrinks by the IME
            overlap so the centered card re-centres above the keyboard. */}
        <View style={[styles.modalOverlay, {paddingBottom: keyboardOverlap}]}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Add a member</Text>
            <Text style={styles.modalSub}>They can spend your Bravo Credits once they accept.</Text>
            <TextInput
              style={styles.modalInput}
              value={phone}
              onChangeText={t => { setPhone(t); setErr(null); }}
              placeholder="+971 50 123 4567"
              placeholderTextColor={T.textMute}
              keyboardType="phone-pad"
              autoFocus
            />
            <TextInput
              style={styles.modalInput}
              value={limit}
              onChangeText={t => { setLimit(t); setErr(null); }}
              placeholder="Spend limit (credits) — optional"
              placeholderTextColor={T.textMute}
              keyboardType="number-pad"
            />
            {err && <Text style={styles.modalErr}>{err}</Text>}
            <View style={styles.modalRow}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setInviteOpen(false)} activeOpacity={0.8}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalSend, (!phone.trim() || busy) && {opacity: 0.4}]}
                disabled={!phone.trim() || busy}
                onPress={() => { void submitInvite(); }}
                activeOpacity={0.85}>
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.modalSendText}>Invite</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* B-724 — partial-approval amount editor */}
      <Modal visible={adjustReq !== null} transparent animationType="fade" onRequestClose={() => setAdjustReq(null)}>
        <View style={[styles.modalOverlay, {paddingBottom: keyboardOverlap}]}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Approve a different amount</Text>
            <Text style={styles.modalSub}>
              {(adjustReq?.memberName ?? 'The member')} asked for {adjustReq?.requestedCredits ?? 0} cr.
            </Text>
            <TextInput
              style={styles.modalInput}
              value={adjustAmount}
              onChangeText={t => { setAdjustAmount(t); setAdjustErr(null); }}
              placeholder="Credits to approve"
              placeholderTextColor={T.textMute}
              keyboardType="number-pad"
              autoFocus
            />
            {adjustErr && <Text style={styles.modalErr}>{adjustErr}</Text>}
            <View style={styles.modalRow}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setAdjustReq(null)} activeOpacity={0.8}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalSend} onPress={submitAdjust} activeOpacity={0.85}>
                <Text style={styles.modalSendText}>Approve</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* B-724 — spending-limit editor (mirrors the invite modal + B-184 IME rule) */}
      <Modal visible={editMember !== null} transparent animationType="fade" onRequestClose={() => setEditMember(null)}>
        <View style={[styles.modalOverlay, {paddingBottom: keyboardOverlap}]}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Edit spending limit</Text>
            <Text style={styles.modalSub}>{editMember?.name ?? ''} — leave empty for shared credits (no limit).</Text>
            <TextInput
              style={styles.modalInput}
              value={editLimit}
              onChangeText={t => { setEditLimit(t); setEditErr(null); }}
              placeholder="Spend limit (credits)"
              placeholderTextColor={T.textMute}
              keyboardType="number-pad"
              autoFocus
            />
            {editErr && <Text style={styles.modalErr}>{editErr}</Text>}
            <View style={styles.modalRow}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setEditMember(null)} activeOpacity={0.8}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalSend, editBusy && {opacity: 0.4}]}
                disabled={editBusy}
                onPress={() => { void submitEditLimit(); }}
                activeOpacity={0.85}>
                {editBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.modalSendText}>Save</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: T.bg},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10},
  back: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {fontFamily: BravoFont.bold, fontSize: 17, letterSpacing: -0.3, color: T.text, textAlign: 'center'},
  headerSub: {fontFamily: BravoFont.regular, fontSize: 11, color: T.textMute, textAlign: 'center', marginTop: 1},

  content: {paddingHorizontal: 20, paddingTop: 8, gap: 18},

  idCard: {position: 'relative', overflow: 'hidden', borderRadius: 22, padding: 20, borderWidth: 1, borderColor: 'rgba(91,141,239,0.22)'},
  idGlow: {position: 'absolute', top: -50, right: -40, width: 180, height: 180, borderRadius: 90, backgroundColor: 'rgba(91,141,239,0.1)'},
  idRow: {flexDirection: 'row', alignItems: 'center', gap: 16},
  idAvatar: {width: 70, height: 70, borderRadius: 20, alignItems: 'center', justifyContent: 'center'},
  idAvatarImg: {width: 70, height: 70, borderRadius: 20},
  idAvatarText: {fontFamily: BravoFont.extraBold, fontSize: 30, color: '#fff'},
  idName: {fontFamily: BravoFont.extraBold, fontSize: 23, letterSpacing: -0.5, color: T.text},
  idBadges: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 9},
  badge: {paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1},
  badgeText: {fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '800', letterSpacing: 1},

  sectionHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: -8, marginLeft: 4},
  sectionLabel: {fontFamily: BravoFont.semiBold, fontSize: 10.5, letterSpacing: 1.5, color: T.textMute, textTransform: 'uppercase'},
  sectionLabelInline: {fontFamily: BravoFont.semiBold, fontSize: 10.5, letterSpacing: 1.5, color: T.textMute, textTransform: 'uppercase'},
  addBtn: {width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)'},

  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 13,
    borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1, borderColor: T.hair2,
  },
  searchInput: {flex: 1, minWidth: 0, paddingVertical: 11, color: T.text, fontFamily: BravoFont.regular, fontSize: 13.5},
  moreRow: {
    minHeight: 46, alignItems: 'center', justifyContent: 'center',
    borderTopWidth: 1, borderTopColor: T.hair,
  },
  moreText: {fontFamily: BravoFont.semiBold, fontSize: 12.5, color: T.blue},

  detailCard: {borderRadius: 18, backgroundColor: T.card, borderWidth: 1, borderColor: T.hair2, overflow: 'hidden'},
  memberRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12},
  memberRowBorder: {borderBottomWidth: 1, borderBottomColor: T.hair},
  // B-854/P1-2 — the row a funding wake named.
  memberRowFocused: {backgroundColor: 'rgba(91,141,239,0.10)'},
  // B-854 — inset to the row's own gutter so the ask reads as belonging to the
  // member above it rather than to the card as a whole.
  fundingAsk: {marginHorizontal: 14, marginBottom: 12},
  memberAvatar: {width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(91,141,239,0.15)'},
  memberAvatarText: {fontFamily: BravoFont.bold, fontSize: 13, color: T.blue},
  memberName: {fontFamily: BravoFont.bold, fontSize: 13.5, color: T.text},
  memberRole: {fontFamily: BravoFont.regular, fontSize: 11, color: T.textMute, marginTop: 1},

  emptyCard: {alignItems: 'center', borderRadius: 20, padding: 26, backgroundColor: T.card, borderWidth: 1, borderColor: T.hair},
  emptyIcon: {width: 60, height: 60, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)', marginBottom: 16},
  emptyTitle: {fontFamily: BravoFont.bold, fontSize: 18, letterSpacing: -0.3, color: T.text},
  emptySub: {fontFamily: BravoFont.regular, fontSize: 13, lineHeight: 20, color: T.textDim, textAlign: 'center', marginTop: 8, paddingHorizontal: 10},
  emptyBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, height: 50, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)'},
  emptyBtnText: {fontFamily: BravoFont.bold, fontSize: 15, color: '#fff'},

  usageCard: {borderRadius: 18, backgroundColor: T.card, borderWidth: 1, borderColor: T.hair2, padding: 16, gap: 12},
  usageHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  usageTotal: {fontFamily: BravoFont.bold, fontSize: 12, color: T.text},
  usageRow: {gap: 6},
  usageRowTop: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  usageName: {fontFamily: BravoFont.bold, fontSize: 12, color: T.text},
  usageVal: {fontFamily: BravoFont.regular, fontSize: 11, color: T.textDim},
  usageShare: {color: T.textMute},
  usageTrack: {height: 7, borderRadius: 99, backgroundColor: 'rgba(255,255,255,0.05)', overflow: 'hidden'},
  usageFill: {height: '100%', borderRadius: 99},

  note: {flexDirection: 'row', alignItems: 'flex-start', gap: 11, paddingHorizontal: 4},
  noteText: {flex: 1, fontFamily: BravoFont.regular, fontSize: 11.5, lineHeight: 17, color: T.textMute},

  toast: {borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: 'rgba(91,141,239,0.08)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.2)'},
  toastText: {fontFamily: BravoFont.semiBold, fontSize: 12, color: T.blue},

  modalOverlay: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: 24},
  modalCard: {width: '100%', backgroundColor: '#11151D', borderRadius: 20, borderWidth: 1, borderColor: T.hair2, padding: 22},
  modalTitle: {fontFamily: BravoFont.extraBold, fontSize: 17, letterSpacing: -0.3, color: T.text},
  modalSub: {fontFamily: BravoFont.regular, fontSize: 12, color: T.textMute, marginTop: 5},
  modalInput: {marginTop: 14, height: 50, borderRadius: 13, paddingHorizontal: 16, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: T.hair2, fontFamily: BravoFont.semiBold, fontSize: 15, color: T.text},
  modalErr: {fontFamily: BravoFont.semiBold, fontSize: 11.5, color: T.alert, marginTop: 8},
  modalRow: {flexDirection: 'row', gap: 12, marginTop: 18},
  modalCancel: {flex: 1, height: 48, borderRadius: 13, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: T.hair2, backgroundColor: 'rgba(255,255,255,0.05)'},
  modalCancelText: {fontFamily: BravoFont.bold, fontSize: 14, color: T.textDim},
  modalSend: {flex: 1, height: 48, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: T.accent},
  modalSendText: {fontFamily: BravoFont.bold, fontSize: 14, color: '#fff'},
});
