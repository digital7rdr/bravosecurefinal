/**
 * "My Bookings" — the pushed booking-history screen.
 *
 * Every existing door already points here (profile drawer, Profile, Dashboard,
 * Home's "View All", and since B-786 the Pro dashboard's "Activity & Reports"
 * tile), and each passes `initial: false` so BookingHome is seeded beneath it
 * (the cold-stack-seed rule, BB-*). Those call sites are therefore left alone.
 *
 * B-786 — the screen itself is now a thin frame around `BookingHistoryList`,
 * the SAME component the Secure shell's Summary tab renders. It used to own a
 * second, thinner row model whose date formatter ran in UTC (B-786b) and which
 * showed no time of day, no payment state, no receipt and no rating.
 */
import React from 'react';
import {View, StyleSheet, StatusBar} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useNavigation} from '@react-navigation/native';
import {UI} from '@components/ui/tokens';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {goBackOnce} from '@navigation/tapGuard';
import {BookingHistoryList} from './BookingHistoryList';

export default function BookingHistoryScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg} />
      <AmbientBg />
      <BookingHistoryList
        title="My Bookings"
        onBack={() => goBackOnce(navigation)}
        paddingTop={insets.top + 14}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: UI.bg},
});
