/**
 * B-854/A11 — "your member wants their own members to spend your allowance",
 * as ONE decision control, mounted wherever a holder manages members.
 *
 * Why a shared component and not a copy on each screen: a holder does NOT need
 * a Bravo Secure Pro plan to have linked members. B-724 already learned this —
 * `SecureProMembersScreen` sits behind `useProPlanGate`, which fails CLOSED, so
 * member management moved onto the ungated `IndividualProfileScreen` as well.
 * The first cut of this feature put the Allow/Decline card only on the Pro
 * sheet, which meant a non-Pro holder was PUSHED about an ask they could not
 * answer. Two mounts, one rule, one set of copy.
 *
 * The card owns the whole act — confirm, call, error copy, N4 guard — because
 * that is exactly the part that must not diverge between the two surfaces.
 * Callers supply the row and a reload.
 */
import React, {useRef, useState} from 'react';
import {View, Text, StyleSheet, TouchableOpacity} from 'react-native';
import {Alert} from '@utils/alert';
import {familyApi, type FamilyMember} from '@services/api';
import {fundMembersRefusalMessage} from '@screens/booking/creditErrors';

const T = {
  textDim:   'rgba(229,233,242,0.62)',
  hair2:     'rgba(255,255,255,0.09)',
  accentDeep:'#166ED1',
} as const;

/**
 * Is this member waiting on a funding decision?
 *
 * Both rosters send the LATEST request of ANY status, so "a request object
 * exists" is NOT "someone is waiting" — that reading leaves the Allow/Decline
 * card up forever after the holder already answered. A request with no `status`
 * is read as pending, which is the one tolerance worth keeping: an interim
 * build projected `{id, createdAt}` from a pending-only subquery, and treating
 * that as decided hides an ask the holder was pushed about.
 */
export function hasPendingFundingAsk(m: FamilyMember): boolean {
  return !!m.fundingRequest && (m.fundingRequest.status ?? 'pending') === 'pending';
}

export function FundingRequestCard({member, onDecided, style}: {
  member: FamilyMember;
  /** Re-read the roster; the row this card renders from is now stale. */
  onDecided: () => void | Promise<void>;
  style?: object;
}) {
  const [busy, setBusy] = useState(false);
  /**
   * N4 — a SYNCHRONOUS ref reset in `finally`, not the `busy` state. Both
   * confirm presses land in the same tick, before any re-render can disable
   * anything, and approving twice is not idempotent on a request row: the
   * second call returns a failure the holder cannot explain.
   */
  const busyRef = useRef(false);

  const run = async (op: () => Promise<unknown>) => {
    if (busyRef.current) {return;}
    busyRef.current = true;
    setBusy(true);
    try {
      await op();
      await onDecided();
    } catch (e) {
      // Every refusal here names a rule a retry cannot satisfy (an inactive
      // row, a second funding root, a cycle), so "Please try again" would be a
      // loop the holder cannot exit.
      Alert.alert('Could not update funding', fundMembersRefusalMessage(e) ?? 'Please try again.');
      await Promise.resolve(onDecided()).catch(() => {});
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const confirmAllow = () => {
    Alert.alert(
      'Allow this?',
      `${member.name}’s own members would have their bookings paid from YOUR credits, capped by `
      + `${member.name}’s spend limit — so your exposure does not grow, but more people can use it. `
      + 'You can stop it at any time.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Allow', onPress: () => { void run(() => familyApi.approveFundMembers(member.id)); }},
      ],
    );
  };

  const confirmDecline = () => {
    Alert.alert(
      'Decline the request?',
      `${member.name}’s members will keep paying from ${member.name}’s own wallet. They can ask again.`,
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Decline', style: 'destructive',
          onPress: () => { void run(() => familyApi.declineFundMembers(member.id)); }},
      ],
    );
  };

  return (
    <View style={[s.card, style]} testID={`funding-ask-${member.id}`}>
      <Text style={s.body}>
        {`${member.name} wants their members to spend your allowance. Their bookings would be `
         + `paid from your credits, capped by ${member.name}’s own spend limit.`}
      </Text>
      <View style={s.actions}>
        <TouchableOpacity
          style={[s.btn, s.btnGhost]}
          disabled={busy}
          onPress={confirmDecline}
          accessibilityRole="button"
          accessibilityState={{disabled: busy}}
          accessibilityLabel={`Decline ${member.name}’s funding request`}>
          <Text style={s.btnGhostText}>Decline</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.btn, s.btnPrimary]}
          disabled={busy}
          onPress={confirmAllow}
          accessibilityRole="button"
          accessibilityState={{disabled: busy}}
          accessibilityLabel={`Allow ${member.name}’s members to spend your allowance`}>
          <Text style={s.btnPrimaryText}>Allow</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  // Amber, like the credit-request card: the other thing on these surfaces
  // that is waiting on the holder to decide.
  card: {
    gap: 10, padding: 13, borderRadius: 14,
    backgroundColor: 'rgba(245,199,107,0.06)',
    borderWidth: 1, borderColor: 'rgba(245,199,107,0.28)',
  },
  body: {color: T.textDim, fontSize: 12, lineHeight: 17},
  actions: {flexDirection: 'row', gap: 8, alignSelf: 'flex-end'},
  // 44 dp — these two SPEND money, so they get a full touch target rather than
  // the 36 dp the surrounding roster chrome uses.
  btn: {
    minHeight: 44, paddingHorizontal: 14, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  btnGhost:      {backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: T.hair2},
  btnGhostText:  {color: T.textDim, fontSize: 12.5, fontWeight: '700'},
  btnPrimary:    {backgroundColor: T.accentDeep},
  btnPrimaryText:{color: '#FFFFFF', fontSize: 12.5, fontWeight: '700'},
});
