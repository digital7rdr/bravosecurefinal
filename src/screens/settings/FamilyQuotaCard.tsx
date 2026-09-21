/**
 * The FAMILY MEMBER's own spending view — spec §41, §42.
 *
 * Renders nothing for a user who is not an active family member, so it is safe
 * to mount unconditionally on a profile screen.
 *
 * Two rules this component exists to obey:
 *
 *  · §41 — the primary value for the member is THEIR OWN remaining quota. The
 *    holder's raw balance is never shown; the server sends `effectiveSpendable`
 *    (`min(remaining quota, root credit)`) so a member can understand a refusal
 *    without being handed the holder's finances.
 *
 *  · §42/§12 — when the quota is spent, offer "Request More Credit" ONCE. If a
 *    request is already open the button becomes a status line, because a second
 *    button would create a duplicate the server is going to refuse anyway.
 *
 * Every number here comes from the server on each focus (§46/§47/§48): this
 * card is a display of server state, never an authority on it, and it is
 * refetched rather than reasoned about after any failed action.
 */
import React, {useCallback, useRef, useState} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, TextInput} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Alert} from '@utils/alert';
import {familyApi, type FamilyMembership} from '@services/api';
import {fundMembersRefusalMessage, pendingCreditRequestFrom} from '@screens/booking/creditErrors';

const T = {
  text:      '#F2F4F8',
  textDim:   'rgba(229,233,242,0.62)',
  textMute:  'rgba(180,188,204,0.45)',
  hair:      'rgba(255,255,255,0.06)',
  hair2:     'rgba(255,255,255,0.09)',
  accent:    '#5B8DEF',
  accentDeep:'#2F5BE0',
  accentSoft:'#A9C5FF',
  signal:    '#4ADE80',
  amber:     '#F5C76B',
  alert:     '#FF8585',
  card:      'rgba(18,22,30,0.85)',
} as const;

/** Usage bands mirror the server's warning thresholds (§34) so the bar colour
 *  and the notification the holder receives can never disagree. */
function barColor(pct: number): string {
  if (pct >= 100) {return T.alert;}
  if (pct >= 90)  {return T.amber;}
  if (pct >= 80)  {return T.amber;}
  return T.accent;
}

/**
 * B-843/D6 — ONE card per root.
 *
 * A person may be on their family's plan and their employer's at the same
 * time, so this is a list, not a card: each root has its own quota, its own
 * warnings and its own request button. `focusHolderId` (set by a money refusal
 * that named the root — A11) highlights the card the refusal was about, so the
 * member lands on the one they need instead of a stack of look-alikes.
 */
export function FamilyQuotaCard(
  {focusHolderId, focusRowId}: {focusHolderId?: string | null; focusRowId?: string | null} = {},
) {
  const [memberships, setMemberships] = useState<FamilyMembership[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const {data} = await familyApi.memberships();
      const list = Array.isArray(data?.memberships) ? data.memberships : null;
      if (!list) {throw new Error('memberships_unavailable');}
      setMemberships(list);
    } catch {
      // A ≤1.0.306 server has no `/family/memberships`. Fall back to the single
      // read so upgrading the APK before the server cannot blank this surface.
      try {
        const {data} = await familyApi.membership();
        setMemberships(data?.membership ? [data.membership] : []);
      } catch {
        // Keep the last good view rather than flashing an error card: a
        // transient network failure does not mean the member lost their quota.
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // §47 — the same member may be spending on another device, so re-read on
  // every focus rather than trusting what this screen last drew.
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  if (loading) {
    return (
      <View style={s.loading}><ActivityIndicator color={T.accent} /></View>
    );
  }
  // Not a member of any root — this whole surface does not apply.
  if (memberships.length === 0) {return null;}

  return (
    <>
      {memberships.map(m => (
        // A14 — keyed by the membership ROW id when the server sent one, so a
        // `family-quota-changed {familyRowId}` wake maps to the card it changed.
        <QuotaCard
          key={m.id ?? m.holderId}
          membership={m}
          // B-854 — a push names the ROW (ids only on the wire); a money
          // refusal names the HOLDER. Either address highlights the same card.
          focused={
            (!!focusHolderId && focusHolderId === m.holderId)
            || (!!focusRowId && !!m.id && focusRowId === m.id)
          }
          onChanged={load}
        />
      ))}
    </>
  );
}

function QuotaCard({membership, focused, onChanged}: {
  membership: FamilyMembership;
  focused: boolean;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [amountText, setAmountText] = useState('');
  // B-724 — the spec's "optionally, a reason" was accepted by the API but
  // never collectible from this UI.
  const [reasonText, setReasonText] = useState('');
  const holder = membership.holderName ?? 'your plan holder';
  const load = onChanged;

  const submitRequest = async () => {
    const parsed = parseInt(amountText.trim(), 10);
    // §30 — a client-side gate for the obvious cases only; the server validates
    // independently and is the authority.
    if (!Number.isFinite(parsed) || parsed <= 0) {
      Alert.alert('Enter an amount', 'How many more credits do you need?');
      return;
    }
    setBusy(true);
    try {
      // A13 — the request names WHICH root is being asked; the server refuses a
      // holder-less request once the member is under more than one.
      await familyApi.requestCredit(parsed, reasonText.trim() || undefined, membership.holderId);
      setAsking(false);
      setAmountText('');
      setReasonText('');
      Alert.alert('Request sent', `${holder} will be notified.`);
      await load();
    } catch (e) {
      // §12/§42 — a request is already open. Not a retryable failure: show the
      // truth and reconcile, never a second create attempt.
      const open = pendingCreditRequestFrom(e);
      if (open) {
        setAsking(false);
        Alert.alert('Request already pending', 'You already have a credit request awaiting approval.');
        await load();
      } else {
        Alert.alert('Could not send request', 'Please try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  const cancelRequest = async (id: string) => {
    setBusy(true);
    try {
      await familyApi.cancelCredit(id);
      await load();
    } catch {
      Alert.alert('Could not cancel', 'Please try again.');
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  /**
   * B-854/A11 — ask this root to fund this member's OWN members.
   *
   * N4: the guard is a SYNCHRONOUS ref reset in `finally`, not the `busy`
   * state. Two confirm presses land in the same tick, before any re-render can
   * disable anything — and this one widens who may spend the root's money, so a
   * duplicate is not just noise.
   */
  const fundBusyRef = useRef(false);
  const sendFundRequest = async (rowId: string) => {
    if (fundBusyRef.current) {return;}
    fundBusyRef.current = true;
    setBusy(true);
    try {
      await familyApi.requestFundMembers(rowId);
      Alert.alert('Request sent', `${holder} will decide whether your members can spend their allowance.`);
      await load();
    } catch (e) {
      // Each of these is a rule a retry cannot satisfy (one funding root, a
      // cycle, an inactive membership, an ask already open), so "Please try
      // again" is the wrong answer wherever the server named one. The root's
      // name rides along so `funding_request_pending` can say WHO is deciding.
      Alert.alert(
        'Could not send request',
        fundMembersRefusalMessage(e, {side: 'member', holderName: holder}) ?? 'Please try again.',
      );
      await load().catch(() => {});
    } finally {
      fundBusyRef.current = false;
      setBusy(false);
    }
  };
  /**
   * Stop the chain. Shares `fundBusyRef` with the ask on purpose: the two can
   * never be on screen together, and one guard means one place for the reset.
   */
  const stopFunding = async (rowId: string) => {
    if (fundBusyRef.current) {return;}
    fundBusyRef.current = true;
    setBusy(true);
    try {
      await familyApi.stopFundMembers(rowId);
      await load();
    } catch (e) {
      // A10 — their own members may still have bookings running on this chain.
      // Told in the MEMBER's words: "their members" names nobody here.
      Alert.alert(
        'Could not stop funding',
        fundMembersRefusalMessage(e, {side: 'member', holderName: holder}) ?? 'Please try again.',
      );
      await load().catch(() => {});
    } finally {
      fundBusyRef.current = false;
      setBusy(false);
    }
  };
  const askToStopFunding = (rowId: string) => {
    Alert.alert(
      'Stop funding your members?',
      `Their bookings go back to coming out of your own wallet. You would have to ask ${holder} again `
      + 'to turn this back on.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Stop', style: 'destructive', onPress: () => { void stopFunding(rowId); }},
      ],
    );
  };

  const askToFund = (rowId: string) => {
    Alert.alert(
      `Ask ${holder}?`,
      `Your members’ bookings would be paid from ${holder}’s allowance instead of your own wallet, `
      + `still capped by your own spending limit. ${holder} decides, and can switch it off at any time.`,
      [
        {text: 'Not now', style: 'cancel'},
        {text: 'Send request', onPress: () => { void sendFundRequest(rowId); }},
      ],
    );
  };

  const {spendLimit, spent, remaining, effectiveSpendable, rootSuspended, pendingRequest} = membership;
  const unlimited = spendLimit === null;
  // B-854 — the chain. Every field is optional (a ≤1.0.309 server sends none),
  // and absent must read as OFF, never as a half-drawn control. The row id is
  // part of the gate: without it there is no address to send the request to.
  const spentByMembers = membership.spentByMembers ?? 0;
  const holdsMembers = membership.holdsMembersCount ?? 0;
  // The LATEST request of any status, so `declined` and `expired` are real
  // states to render rather than absences. An interim server projected no
  // `status` at all from a pending-only subquery — a request with none is read
  // as pending, because against that build keying on 'pending' matched nothing
  // and the member kept seeing the Ask button while their ask was open.
  const fundingStatus = membership.fundingRequest
    ? (membership.fundingRequest.status ?? 'pending')
    : null;
  // The FLAG is the truth, not the request: a root who approves and later
  // switches it off leaves an 'approved' request behind on a dead chain.
  const fundsSubMembers = membership.fundsSubMembers === true;
  const showFunding = holdsMembers > 0 && !!membership.id;
  // Guarded against a zero limit so the bar never divides by zero; a zero quota
  // is 100% used by definition, which matches the server's own band rule.
  const pct = unlimited ? 0
    : spendLimit === 0 ? 100
    : Math.min(100, Math.round((spent / spendLimit) * 100));
  const exhausted = !unlimited && (remaining ?? 0) <= 0;
  // §9 — the member's quota is fine but nothing is spendable, so the ROOT is the
  // problem. These must read differently; conflating them is the defect §9 names.
  const rootShort = !exhausted && effectiveSpendable <= 0;

  return (
    <View
      style={[s.card, focused && s.cardFocused]}
      testID={`quota-card-${membership.holderId}`}
      accessibilityState={{selected: focused}}
      accessibilityLabel={`Your spending limit on ${holder}’s plan`}>
      <View style={s.headRow}>
        <Icon name="wallet-outline" size={16} color={T.accentSoft} />
        <Text style={s.head}>YOUR SPENDING LIMIT</Text>
      </View>
      <Text style={s.holder} numberOfLines={1}>
        On {holder}’s plan
      </Text>

      {unlimited ? (
        <Text style={s.unlimited}>No spending limit set</Text>
      ) : (
        <>
          {/* §41 — allocated / used / remaining, with remaining given the most
              weight: it is the number the member actually acts on. */}
          <View style={s.figures}>
            <Figure label="Limit" value={spendLimit} />
            <Figure label="Used" value={spent} />
            <Figure label="Remaining" value={remaining ?? 0} strong />
          </View>
          <View style={s.track}>
            <View style={[s.fill, {width: `${pct}%`, backgroundColor: barColor(pct)}]} />
          </View>
        </>
      )}

      {/* B-854/A12 — the member's own allowance pays for their members'
          bookings, so the part of "Used" they did not spend has to be named.
          Without it they watch Remaining fall for bookings they never made. */}
      {spentByMembers > 0 ? (
        <Text style={s.subFigure}>
          Includes {spentByMembers.toLocaleString()} BC spent by your members.
        </Text>
      ) : null}

      {/* §21 — outranks everything else, and says nothing about their limit. */}
      {rootSuspended ? (
        <Text style={[s.notice, {color: T.alert}]}>
          {holder}’s account is suspended, so spending is paused.
        </Text>
      ) : rootShort ? (
        // §9 — do NOT tell them their own quota is exhausted; it isn't.
        <Text style={[s.notice, {color: T.amber}]}>
          The Root Account currently has insufficient credit. Your own limit is unaffected.
        </Text>
      ) : exhausted ? (
        <Text style={[s.notice, {color: T.amber}]}>
          You’ve reached your spending limit.
        </Text>
      ) : !unlimited && pct >= 80 ? (
        <Text style={[s.notice, {color: T.amber}]}>
          You’re approaching your spending limit.
        </Text>
      ) : null}

      {/* §42 — one action, and never a duplicate-creating one. */}
      {pendingRequest ? (
        <View style={s.pendingRow}>
          <Text style={s.pendingText} numberOfLines={2}>
            Request for {pendingRequest.requestedCredits.toLocaleString()} BC is pending approval.
          </Text>
          <TouchableOpacity
            style={[s.btn, s.btnGhost]}
            disabled={busy}
            onPress={() => { void cancelRequest(pendingRequest.id); }}
            accessibilityRole="button"
            accessibilityLabel={`Cancel your pending credit request to ${holder}`}>
            <Text style={s.btnGhostText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      ) : asking ? (
        <View>
          <TextInput
            style={[s.input, {marginBottom: 8}]}
            value={reasonText}
            onChangeText={setReasonText}
            placeholder="Reason (optional)"
            placeholderTextColor={T.textMute}
            maxLength={140}
            accessibilityLabel={`Reason for the credit request to ${holder} (optional)`}
          />
          <View style={s.askRow}>
          <TextInput
            style={s.input}
            value={amountText}
            onChangeText={setAmountText}
            placeholder="Amount (BC)"
            placeholderTextColor={T.textMute}
            keyboardType="number-pad"
            maxLength={7}
            accessibilityLabel={`Additional credits requested from ${holder}`}
          />
          <TouchableOpacity
            style={[s.btn, s.btnGhost]}
            disabled={busy}
            onPress={() => { setAsking(false); setAmountText(''); }}
            accessibilityRole="button"
            accessibilityLabel={`Cancel request to ${holder}`}>
            <Text style={s.btnGhostText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.btn, s.btnPrimary]}
            disabled={busy}
            onPress={() => { void submitRequest(); }}
            accessibilityRole="button"
            accessibilityLabel={`Send credit request to ${holder}`}>
            <Text style={s.btnPrimaryText}>Send</Text>
          </TouchableOpacity>
          </View>
        </View>
      ) : (
        // Offered whenever there is a limit to raise — approaching it is reason
        // enough to ask, and a member who has JUST been blocked should not have
        // to spend more to find the button. Not offered on an unlimited quota:
        // there is no ceiling to raise, and the server refuses that anyway.
        !unlimited && (
          <TouchableOpacity
            style={[s.btn, s.btnPrimary, s.btnWide]}
            disabled={busy}
            onPress={() => setAsking(true)}
            accessibilityRole="button"
            accessibilityLabel={`Request more credit from ${holder}`}>
            <Icon name="plus-circle-outline" size={14} color="#FFF" />
            <Text style={s.btnPrimaryText}>Request More Credit</Text>
          </TouchableOpacity>
        )
      )}

      {/* B-854 — the chain, from this member's side.
          Hidden outright when they hold nobody: there is nothing to fund, and a
          control that can only ever be refused is worse than no control.
          A11 — there is NO off switch here on purpose. It is the root's money,
          so the root decides; the member asks, and may ask again if declined. */}
      {showFunding ? (
        <View style={s.fundBlock} testID={`fund-row-${membership.holderId}`}>
          <View style={s.fundHeadRow}>
            <Icon name="account-supervisor-outline" size={14} color={T.accentSoft} importantForAccessibility="no" />
            <Text style={s.fundHead} numberOfLines={2}>
              Fund my members from {holder}’s allowance
            </Text>
          </View>
          {fundsSubMembers ? (
            <>
              <Text style={[s.fundState, {color: T.signal}]}>
                On · your members spend from {holder}’s allowance, inside your own limit.
              </Text>
              {/* A11 is about who may WIDEN the spend. Switching it off only
                  narrows who can reach the root's money, so it needs nobody's
                  approval — and the member is the one who knows when their
                  members no longer need it. Turning it back ON still does. */}
              <TouchableOpacity
                style={[s.btn, s.btnGhost, s.btnWide]}
                disabled={busy}
                onPress={() => { askToStopFunding(membership.id!); }}
                accessibilityRole="button"
                accessibilityState={{disabled: busy}}
                accessibilityLabel={`Stop funding your members from ${holder}`}>
                <Text style={s.btnGhostText}>Stop</Text>
              </TouchableOpacity>
            </>
          ) : fundingStatus === 'pending' ? (
            <Text style={[s.fundState, {color: T.amber}]}>
              Waiting for {holder} to decide.
            </Text>
          ) : (
            <>
              {fundingStatus === 'declined' ? (
                <Text style={[s.fundState, {color: T.textDim}]}>
                  Declined — you can ask again.
                </Text>
              ) : fundingStatus === 'expired' ? (
                // NOT "declined": nobody said no, the window simply closed.
                // Reporting a refusal that never happened is a statement about
                // the root they did not make.
                <Text style={[s.fundState, {color: T.textDim}]}>
                  Your last request expired — you can ask again.
                </Text>
              ) : null}
              <TouchableOpacity
                style={[s.btn, s.btnGhost, s.btnWide]}
                disabled={busy}
                onPress={() => { askToFund(membership.id!); }}
                accessibilityRole="button"
                accessibilityState={{disabled: busy}}
                accessibilityLabel={`Ask ${holder} to fund your members`}>
                <Text style={s.btnGhostText}>Ask {holder}</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

function Figure({label, value, strong}: {label: string; value: number; strong?: boolean}) {
  return (
    <View style={{flex: 1, minWidth: 0}}>
      <Text style={s.figLabel}>{label}</Text>
      <Text style={[s.figValue, strong && s.figValueStrong]} numberOfLines={1}>
        {value.toLocaleString()}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  loading: {paddingVertical: 24, alignItems: 'center'},
  card: {
    padding: 16, borderRadius: 18, gap: 10,
    backgroundColor: T.card, borderWidth: 1, borderColor: T.hair2,
  },
  // A11 — the card a money refusal named, so a stack of look-alikes still
  // points at the one the member has to act on.
  cardFocused: {borderColor: T.accent, backgroundColor: 'rgba(91,141,239,0.10)'},
  headRow: {flexDirection: 'row', alignItems: 'center', gap: 7},
  head:    {color: T.textMute, fontSize: 10.5, fontWeight: '800', letterSpacing: 1.2},
  holder:  {color: T.textDim, fontSize: 12.5, fontWeight: '600'},

  figures: {flexDirection: 'row', gap: 12, marginTop: 2},
  figLabel: {color: T.textMute, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.6},
  figValue: {color: T.textDim, fontSize: 16, fontWeight: '700', marginTop: 2},
  figValueStrong: {color: T.text, fontSize: 19, fontWeight: '800'},

  track: {height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.06)', overflow: 'hidden'},
  fill:  {height: '100%', borderRadius: 3},

  unlimited: {color: T.signal, fontSize: 13, fontWeight: '700'},
  notice:    {fontSize: 12.5, fontWeight: '600', lineHeight: 17},
  subFigure: {color: T.textMute, fontSize: 11.5, fontWeight: '600', lineHeight: 16},

  // B-854 — a hairline-separated block rather than another notice line: this is
  // a standing arrangement about whose money pays, not a transient warning.
  fundBlock:   {gap: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: T.hair},
  fundHeadRow: {flexDirection: 'row', alignItems: 'center', gap: 7},
  fundHead:    {flex: 1, minWidth: 0, color: T.textDim, fontSize: 12.5, fontWeight: '700'},
  fundState:   {fontSize: 12, fontWeight: '600', lineHeight: 17},

  pendingRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  pendingText: {flex: 1, minWidth: 0, color: T.amber, fontSize: 12.5, fontWeight: '600'},

  askRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  input: {
    flex: 1, minWidth: 0, minHeight: 40, borderRadius: 10,
    paddingHorizontal: 12, color: T.text, fontSize: 13.5,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: T.hair2,
  },

  btn: {
    minHeight: 40, paddingHorizontal: 14, borderRadius: 10,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
  },
  btnWide:        {alignSelf: 'stretch'},
  btnGhost:       {backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: T.hair2},
  btnGhostText:   {color: T.textDim, fontSize: 12.5, fontWeight: '700'},
  btnPrimary:     {backgroundColor: T.accentDeep},
  btnPrimaryText: {color: '#FFFFFF', fontSize: 12.5, fontWeight: '700'},
});
