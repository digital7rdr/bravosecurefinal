/**
 * B-843/D5 — "Pay from": which account this booking is charged to.
 *
 * A person may be an active member under any number of root accounts, so the
 * payer is a choice. This is the ONE component for it, mounted on every screen
 * that commits to Bravo Credits.
 *
 * Two rules it exists to keep:
 *  · An ineligible root is LISTED but not selectable. Hiding it would leave the
 *    member wondering where their plan went; letting them tap it would aim a
 *    charge at an account the server is about to refuse.
 *  · It is STATE ONLY — no network, no mutation. The nav runbook's synchronous
 *    money guard belongs to the Continue/Pay button that follows it (N4), and
 *    adding a second guard here would only make the radio feel laggy.
 */
import React from 'react';
import {View, Text, StyleSheet, TouchableOpacity} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {buildPayerChoices, SELF_PAYER_KEY, type PayerMembershipInput} from './payerOptions';

const T = {
  text:      '#FFFFFF',
  textDim:   'rgba(229,233,242,0.62)',
  textMute:  'rgba(180,188,204,0.45)',
  hair:      'rgba(255,255,255,0.09)',
  accent:    '#1E88FF',
  accentSoft:'#3BA6FF',
  card:      'rgba(18,22,30,0.85)',
  rowOn:     'rgba(91,141,239,0.12)',
} as const;

export interface PayerSelectorProps {
  /** The signed-in member's own user id — what "My wallet" sends. */
  selfUserId: string;
  selfBalance: number;
  memberships: PayerMembershipInput[];
  /** The chosen payer's user id, or null/undefined while unchosen. */
  value: string | null | undefined;
  onChange: (holderId: string) => void;
}

export function PayerSelector({
  selfUserId, selfBalance, memberships, value, onChange,
}: PayerSelectorProps) {
  // No memberships means no question to ask: the member's own wallet is the
  // only payer, and a one-row radio is noise on a money screen.
  if (!memberships || memberships.length === 0) {return null;}
  const choices = buildPayerChoices({selfUserId, selfBalance, memberships});

  return (
    // P3-14 — one radiogroup, so a screen reader announces "1 of 3" rather
    // than three unrelated radios.
    <View style={s.card} testID="payer-selector" accessibilityRole="radiogroup">
      <View style={s.headRow}>
        <Icon name="wallet-outline" size={15} color={T.accentSoft} />
        <Text style={s.head}>PAY FROM</Text>
      </View>
      {choices.map(c => {
        const selected = !!c.holderId && value === c.holderId;
        return (
          <TouchableOpacity
            key={c.key}
            testID={`payer-choice-${c.key === SELF_PAYER_KEY ? 'self' : c.holderId}`}
            style={[s.row, selected && s.rowOn, c.disabled && s.rowOff]}
            activeOpacity={c.disabled ? 1 : 0.8}
            disabled={c.disabled}
            onPress={() => { if (!c.disabled) {onChange(c.holderId);} }}
            accessibilityRole="radio"
            accessibilityState={{selected, disabled: c.disabled}}
            accessibilityLabel={`Pay from ${c.label} — ${c.sublabel}`}>
            <Icon
              name={selected ? 'radiobox-marked' : 'radiobox-blank'}
              size={18}
              color={c.disabled ? T.textMute : selected ? T.accent : T.textDim}
            />
            <View style={s.rowText}>
              <Text style={[s.rowLabel, c.disabled && s.dim]} numberOfLines={1}>{c.label}</Text>
              {/* P3-14 — two lines: "1,200 BC left" clips on one at fontScale
                  1.3 on a 320 dp screen, hiding the number being decided on. */}
              <Text style={[s.rowSub, c.disabled && s.dim]} numberOfLines={2}>{c.sublabel}</Text>
            </View>
          </TouchableOpacity>
        );
      })}
      {!value && choices.length > 2 && (
        <Text style={s.hint}>Choose which account pays for this booking.</Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    padding: 14, borderRadius: 16, gap: 6,
    backgroundColor: T.card, borderWidth: 1, borderColor: T.hair,
  },
  headRow: {flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 2},
  head:    {color: T.textMute, fontSize: 10.5, fontWeight: '800', letterSpacing: 1.2},

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    // P3-14 — a MINIMUM, with vertical padding, so a wrapped sublabel grows the
    // row instead of being clipped by a fixed height.
    minHeight: 48, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 12,
    borderWidth: 1, borderColor: 'transparent',
  },
  rowOn:  {backgroundColor: T.rowOn, borderColor: 'rgba(91,141,239,0.35)'},
  rowOff: {opacity: 0.55},
  rowText:  {flex: 1, minWidth: 0},
  rowLabel: {color: T.text, fontSize: 14, fontWeight: '700'},
  rowSub:   {color: T.textDim, fontSize: 12, fontWeight: '600', marginTop: 1},
  dim:      {color: T.textMute},

  hint: {color: T.accentSoft, fontSize: 12, fontWeight: '600', marginTop: 2},
});
