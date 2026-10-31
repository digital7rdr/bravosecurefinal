/**
 * Sign-in & Privacy for the agent / agency app (owner 2026-10-31: the drawer's
 * "Sign-in & Privacy" and "Help & Support" did nothing).
 *
 * The same controls the client app has under Profile → Sign-in & Privacy,
 * plus the two an officer needs most:
 *   - Biometric Lock (shared hook, same setting the app lock reads);
 *   - Two-factor sign-in status (enforced for every account, nothing to set);
 *   - Change password (POST /auth/me/password — the server signs out every
 *     session on success, so the app signs out and asks for the new one);
 *   - Linked devices (browsers linked to this phone's messenger).
 */
import React, {useCallback, useState} from 'react';
import {View, Text, TextInput, StyleSheet, TouchableOpacity, StatusBar, ScrollView, ActivityIndicator, Linking} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import type {AgentStackParamList} from '@navigation/types';
import {Colors} from '@theme/colors';
import {BravoFont} from '@theme/bravo';
import {Alert} from '@utils/alert';
import {scaleTextStyles} from '@utils/scaling';
import {authApi} from '@services/api';
import {useAuthStore} from '@store/authStore';
import {useBiometricLock} from '@hooks/useBiometricLock';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {goBackOnce} from '@navigation/tapGuard';
import {NavHeader} from './_shared';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

/** Bravo Secure's support form (bravo-secure.com). */
export const SUPPORT_URL = 'https://bravo-secure.com/request-support';

/** Open the support form; say where it is when the phone cannot open links. */
export function openSupport(): void {
  Linking.openURL(SUPPORT_URL).catch(() => {
    Alert.alert('Help & Support', `Open ${SUPPORT_URL} in your browser to contact Bravo Secure support.`);
  });
}

/** What a refused password change means, in words. */
export function passwordErrorText(e: unknown): string {
  const msg = String((e as {response?: {data?: {message?: unknown}}})?.response?.data?.message ?? (e as Error)?.message ?? '');
  if (/current_password_invalid/.test(msg)) {return 'Your current password is not correct.';}
  if (/password_too_weak|too short|weak/i.test(msg)) {return 'Choose a longer password: at least 8 characters.';}
  if (/Network Error|timeout/i.test(msg)) {return 'No connection. Check your internet and try again.';}
  return 'Your password was not changed. Please try again.';
}

function Row({icon, label, sub, right, onPress}: {
  icon: React.ComponentProps<typeof Icon>['name']; label: string; sub?: string; right?: React.ReactNode; onPress?: () => void;
}) {
  const body = (
    <View style={s.row}>
      <Icon name={icon} size={20} color={Colors.primary} />
      <View style={{flex: 1, minWidth: 0}}>
        <Text style={s.rowLabel}>{label}</Text>
        {sub ? <Text style={s.rowSub}>{sub}</Text> : null}
      </View>
      {right ?? (onPress ? <Icon name="chevron-right" size={20} color={Colors.textMuted} /> : null)}
    </View>
  );
  return onPress
    ? <TouchableOpacity activeOpacity={0.75} onPress={onPress} accessibilityRole="button">{body}</TouchableOpacity>
    : body;
}

export default function AgentSignInPrivacyScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const {bottomPad} = useKeyboardLayout();
  const signOut = useAuthStore(st => st.signOut);
  const bio = useBiometricLock();

  const [pwOpen, setPwOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    if (busy) {return;}
    if (!current) { Alert.alert('Current password', 'Enter your current password.'); return; }
    if (next.length < 8) { Alert.alert('Password too short', 'Use at least 8 characters.'); return; }
    if (next !== confirm) { Alert.alert('Passwords don\'t match', 'Type the new password the same way twice.'); return; }
    if (next === current) { Alert.alert('Choose a different password', 'The new password must be different from the current one.'); return; }
    setBusy(true);
    try {
      await authApi.changePassword({currentPassword: current, newPassword: next});
      // The server ended every session, this one included.
      Alert.alert('Password changed', 'Sign in again with your new password.', [
        {text: 'Sign in', onPress: () => { void signOut(); }},
      ]);
    } catch (e) {
      Alert.alert('Could not change password', passwordErrorText(e));
    } finally {
      setBusy(false);
    }
  }, [busy, current, next, confirm, signOut]);

  const toggleStyle = (on: boolean) => [s.toggle, on ? s.toggleOn : s.toggleOff];

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />
      <NavHeader title="Sign-in & Privacy" onBack={() => goBackOnce(navigation)} />
      <ScrollView contentContainerStyle={{padding: 16, paddingBottom: bottomPad(24)}} keyboardShouldPersistTaps="handled">
        <Text style={s.section}>SIGN-IN</Text>
        <View style={s.card}>
          <Row
            icon="fingerprint"
            label="Biometric Lock"
            sub="Ask for your face or fingerprint when Bravo opens."
            right={
              <TouchableOpacity accessibilityRole="switch" accessibilityState={{checked: bio.on}} accessibilityLabel="Biometric Lock"
                onPress={() => { void bio.toggle(!bio.on); }} style={toggleStyle(bio.on)}>
                <View style={s.knob} />
              </TouchableOpacity>
            }
          />
          <View style={s.sep} />
          <Row icon="two-factor-authentication" label="Two-factor sign-in" sub="On for every account: a code is checked when you sign in."
            right={<Text style={s.onText}>ON</Text>} />
          <View style={s.sep} />
          <Row icon="form-textbox-password" label="Change password" onPress={() => setPwOpen(o => !o)}
            right={<Icon name={pwOpen ? 'chevron-up' : 'chevron-down'} size={20} color={Colors.textMuted} />} />
          {pwOpen && (
            <View style={s.form}>
              <TextInput style={s.input} value={current} onChangeText={setCurrent} placeholder="Current password"
                placeholderTextColor={Colors.textMuted} secureTextEntry autoCapitalize="none" editable={!busy}
                accessibilityLabel="Current password" />
              <TextInput style={s.input} value={next} onChangeText={setNext} placeholder="New password (8 characters or more)"
                placeholderTextColor={Colors.textMuted} secureTextEntry autoCapitalize="none" editable={!busy}
                accessibilityLabel="New password" />
              <TextInput style={s.input} value={confirm} onChangeText={setConfirm} placeholder="New password again"
                placeholderTextColor={Colors.textMuted} secureTextEntry autoCapitalize="none" editable={!busy}
                accessibilityLabel="New password again" />
              <Text style={s.note}>Changing your password signs you out on every device.</Text>
              <TouchableOpacity style={[s.btn, busy && {opacity: 0.6}]} disabled={busy} onPress={() => { void submit(); }}
                accessibilityRole="button">
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>CHANGE PASSWORD</Text>}
              </TouchableOpacity>
            </View>
          )}
          <View style={s.sep} />
          <Row icon="monitor-cellphone" label="Linked devices" sub="Browsers signed in to your messenger."
            onPress={() => navigation.navigate('LinkedDevices')} />
        </View>

        <Text style={s.section}>PRIVACY</Text>
        <View style={s.card}>
          <Row icon="lock-outline" label="End-to-end encryption" sub="Your messages and calls are encrypted on your phone. Bravo Secure cannot read them." />
          <View style={s.sep} />
          <Row icon="help-circle-outline" label="Privacy questions" sub="Contact Bravo Secure support." onPress={openSupport} />
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},
  section: {fontSize: 11, fontWeight: '700', letterSpacing: 1.6, color: Colors.textMuted, marginTop: 14, marginBottom: 8, marginLeft: 4},
  card: {borderRadius: 14, borderWidth: 1, borderColor: Colors.surfaceBorder, backgroundColor: Colors.surfaceElevated, overflow: 'hidden'},
  row: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 14},
  rowLabel: {fontFamily: BravoFont.bold, fontSize: 15, color: Colors.textPrimary},
  rowSub: {fontSize: 12, color: Colors.textSecondary, marginTop: 3, lineHeight: 17},
  sep: {height: 1, backgroundColor: Colors.surfaceBorder, marginLeft: 46},
  onText: {fontSize: 12, fontWeight: '800', letterSpacing: 1, color: '#4ADE80'},
  toggle: {width: 46, height: 26, borderRadius: 13, padding: 3, borderWidth: 1},
  toggleOn: {backgroundColor: Colors.primary, borderColor: 'rgba(255,255,255,0.2)', alignItems: 'flex-end'},
  toggleOff: {backgroundColor: 'rgba(255,255,255,0.1)', borderColor: Colors.surfaceBorder, alignItems: 'flex-start'},
  knob: {width: 18, height: 18, borderRadius: 9, backgroundColor: '#FFFFFF'},
  form: {paddingHorizontal: 14, paddingBottom: 14, gap: 10},
  input: {
    height: 48, borderRadius: 10, borderWidth: 1, borderColor: Colors.surfaceBorder, backgroundColor: Colors.background,
    paddingHorizontal: 12, fontSize: 15, color: Colors.textPrimary,
  },
  note: {fontSize: 11.5, color: Colors.textMuted, lineHeight: 16},
  btn: {height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.primary},
  btnText: {color: '#FFFFFF', fontSize: 13, fontWeight: '800', letterSpacing: 1.2},
}));
