/**
 * "How Bravo Credits work" (2026-10-14).
 *
 * Tester report: "No reference to Bravo Credits in setup. Bravo must explain the
 * function and exchange rate per country, BC = 1 euro." Shown ONCE after sign-up
 * (CreditsIntroScreen, a root gate) and any time from Wallet ("How credits
 * work"). States the peg from the live board (eurPerBcLabelFor — never a
 * literal, B-798) and what 1 BC is worth in each region's currency, from
 * GET /bookings/credit-rates (display-only rates ops keep per region), falling
 * back to the compiled indicative rates offline.
 */
import React, {useEffect, useMemo, useState} from 'react';
import {View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {BravoFont} from '@/theme/bravo';
import {walletApi, preferencesApi, type CreditRatesDto} from '@services/api';
import {useAuthStore} from '@store/authStore';
import {eurPerBcLabelFor} from '@screens/booking/servicePricingOverrides';
import {FALLBACK_CREDIT_RATES, regionForUser, flagFor, formatLocal, countryName, sortRatesFor} from './creditRates';

const T = {
  text:     '#FFFFFF',
  textDim:  'rgba(229,233,242,0.62)',
  textMute: 'rgba(180,188,204,0.45)',
  hair:     'rgba(255,255,255,0.08)',
  accent:   '#1E88FF',
  card:     'rgba(18,22,30,0.85)',
  gold:     '#E2C893',
} as const;

export function useCreditRates(): {data: CreditRatesDto; loading: boolean; region: string | null} {
  const [data, setData] = useState<CreditRatesDto | null>(null);
  const [homeRegion, setHomeRegion] = useState<string | null>(null);
  const phone = useAuthStore(s => s.user?.phone_e164 ?? null);
  useEffect(() => {
    let live = true;
    walletApi.creditRates()
      .then(r => { if (live && r.data?.rates?.length) {setData(r.data);} })
      .catch(() => undefined)
      .finally(() => { if (live) {setData(d => d ?? FALLBACK_CREDIT_RATES);} });
    preferencesApi.get()
      .then(r => { if (live) {setHomeRegion(r.data?.homeRegion ?? null);} })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  return {data: data ?? FALLBACK_CREDIT_RATES, loading: data === null, region: regionForUser(homeRegion, phone)};
}

const USES: ReadonlyArray<{icon: React.ComponentProps<typeof Icon>['name']; title: string; text: string}> = [
  {icon: 'shield-car', title: 'What credits pay for',
    text: 'Every Bravo service is priced in Bravo Credits (BC): Secure Transfer, Close and Executive Protection bookings, add-ons and Secure Pro plans.'},
  {icon: 'credit-card-plus-outline', title: 'How you get credits',
    text: 'Top up in Wallet with your card. Your card is charged in euro, so a 500 BC top-up is a €500 card payment.'},
  {icon: 'lock-clock', title: 'When credits are used',
    text: 'Each booking shows its price in BC before you confirm. The credits are held from your balance when you book and paid out when the service is completed; cancellations follow the booking\'s cancellation terms.'},
];

export function CreditsExplainer({onDone, doneLabel = 'Got it'}: {onDone: () => void; doneLabel?: string}): React.JSX.Element {
  const {data, loading, region} = useCreditRates();
  const rows = useMemo(() => sortRatesFor(data.rates, region), [data, region]);

  return (
    <ScrollView contentContainerStyle={styles.wrap} showsVerticalScrollIndicator={false}>
      <View style={styles.hero}>
        <View style={styles.heroIcon}><Icon name="alpha-b-circle-outline" size={34} color={T.accent} /></View>
        <Text style={styles.title}>How Bravo Credits work</Text>
        <View style={styles.pegPill}>
          <Text style={styles.pegText}>{eurPerBcLabelFor(data.eurPerBc)}</Text>
        </View>
        <Text style={styles.sub}>Bravo Credits are the one currency of the app, in every country.</Text>
      </View>

      {USES.map(u => (
        <View key={u.title} style={styles.useRow}>
          <Icon name={u.icon} size={20} color={T.accent} style={{marginTop: 1}} />
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={styles.useTitle}>{u.title}</Text>
            <Text style={styles.useText}>{u.text}</Text>
          </View>
        </View>
      ))}

      <Text style={styles.section}>What 1 BC is worth in your country</Text>
      <View style={styles.table}>
        {loading && <ActivityIndicator color={T.accent} style={{marginVertical: 10}} />}
        {rows.map((r, i) => {
          const mine = r.region === region;
          return (
            <View key={r.region} style={[styles.rateRow, i > 0 && styles.rateRowBorder, mine && styles.rateRowMine]}
              accessibilityLabel={`${countryName(r)}: 1 Bravo Credit is about ${formatLocal(r.localPerBc)} ${r.currency}`}>
              <Text style={styles.flag}>{flagFor(r.region)}</Text>
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={styles.country} numberOfLines={1}>{countryName(r)}{mine ? '  ·  You' : ''}</Text>
                <Text style={styles.hundred}>100 BC ≈ {formatLocal(r.localPerBc * 100)} {r.currency}</Text>
              </View>
              <Text style={styles.rate}>≈ {formatLocal(r.localPerBc)} {r.currency}</Text>
            </View>
          );
        })}
      </View>
      <Text style={styles.foot}>
        Indicative rates, updated by Bravo. Your card is always charged in euro: your bank converts at its own
        rate on the day and may add a fee.
      </Text>

      <TouchableOpacity style={styles.btn} onPress={onDone} activeOpacity={0.85} accessibilityRole="button">
        <Text style={styles.btnText}>{doneLabel}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: {paddingHorizontal: 20, paddingTop: 12, paddingBottom: 32, gap: 12},
  hero: {alignItems: 'center', gap: 8, paddingVertical: 8},
  heroIcon: {width: 60, height: 60, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(30,136,255,0.12)', borderWidth: 1, borderColor: 'rgba(30,136,255,0.3)'},
  title: {fontFamily: BravoFont.bold, fontSize: 20, color: T.text, textAlign: 'center'},
  pegPill: {paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999, backgroundColor: 'rgba(226,200,147,0.12)', borderWidth: 1, borderColor: 'rgba(226,200,147,0.4)'},
  pegText: {fontFamily: BravoFont.bold, fontSize: 15, color: T.gold, letterSpacing: 0.3},
  sub: {fontFamily: BravoFont.regular, fontSize: 13, color: T.textDim, textAlign: 'center'},
  useRow: {flexDirection: 'row', gap: 12, padding: 14, borderRadius: 14, backgroundColor: T.card, borderWidth: 1, borderColor: T.hair},
  useTitle: {fontFamily: BravoFont.bold, fontSize: 13, color: T.text, marginBottom: 3},
  useText: {fontFamily: BravoFont.regular, fontSize: 12.5, lineHeight: 18, color: T.textDim},
  section: {fontFamily: BravoFont.bold, fontSize: 11, letterSpacing: 1.6, textTransform: 'uppercase', color: T.textMute, marginTop: 8},
  table: {borderRadius: 14, backgroundColor: T.card, borderWidth: 1, borderColor: T.hair, overflow: 'hidden'},
  rateRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12},
  rateRowBorder: {borderTopWidth: 1, borderTopColor: T.hair},
  rateRowMine: {backgroundColor: 'rgba(30,136,255,0.10)'},
  flag: {fontSize: 22},
  country: {fontFamily: BravoFont.bold, fontSize: 13, color: T.text},
  hundred: {fontFamily: BravoFont.regular, fontSize: 11.5, color: T.textMute, marginTop: 2},
  rate: {fontFamily: BravoFont.bold, fontSize: 14, color: T.text},
  foot: {fontFamily: BravoFont.regular, fontSize: 11.5, lineHeight: 17, color: T.textMute},
  btn: {marginTop: 8, paddingVertical: 14, borderRadius: 14, alignItems: 'center', backgroundColor: T.accent},
  btnText: {fontFamily: BravoFont.bold, fontSize: 15, color: '#FFFFFF'},
});
