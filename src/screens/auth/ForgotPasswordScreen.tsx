/**
 * Forgot password (mobile, 2026-10-16).
 *
 * Tester report: "Forgot Password not working — Mobile App — Bug." The
 * "Forgot password?" line on the sign-in screen was plain text with no action,
 * so tapping it did nothing. The server reset flow already existed for the
 * home site (POST /auth/password/reset/start → /complete, PasswordResetService);
 * this screen is the app's door to the same flow, with the same rules:
 *
 *   1. The person types their mobile number (with country code) or email. The
 *      answer is the same whether or not an account matched, so the screen
 *      cannot be used to find out who has an account.
 *   2. The 6-digit code from the text or email, plus the new password.
 *   3. Only if the account has an authenticator: a code from that app. A reset
 *      by text or email alone never gets round an authenticator.
 *
 * On success the server signs the account out everywhere; the person goes
 * back to Sign In with the new password.
 */
import React, {useEffect, useRef, useState} from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import type {AuthScreenProps} from '@navigation/types';
import {useKeyboardOverlap} from '@hooks/useKeyboardLayout';
import {authApi} from '@services/api';
import {goBackOnce} from '@navigation/tapGuard';
import {parseLoginIdentifier} from './LoginScreen';
import {resetErrorText, resetIdentifierProblem, newPasswordProblem, MIN_RESET_PASSWORD} from './forgotPassword';

type Props = AuthScreenProps<'ForgotPassword'>;
type Step = 'identify' | 'reset' | 'done';

const T = {
  bg:       '#0A1F3F',
  text:     '#FFFFFF',
  textDim:  'rgba(229,233,242,0.62)',
  textMute: 'rgba(180,188,204,0.45)',
  hair2:    'rgba(255,255,255,0.09)',
  field:    'rgba(255,255,255,0.04)',
  accent:   '#1E88FF',
  accentDeep: '#166ED1',
  signal:   '#4ADE80',
  danger:   '#FF8B8B',
} as const;

export default function ForgotPasswordScreen({navigation, route}: Props) {
  const insets = useSafeAreaInsets();
  const keyboardOverlap = useKeyboardOverlap();
  const [step, setStep] = useState<Step>('identify');
  const [identifier, setIdentifier] = useState(route.params?.identifier ?? '');
  const [resetId, setResetId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [needTotp, setNeedTotp] = useState(false);
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // 2026-10-30 (owner: "password reset does not work") — with texts not set
  // up, a code reaches a PHONE number only when the account's email is
  // confirmed; most aren't, so the reset silently sent nothing. Ask for the
  // email address instead whenever the server says texts are off.
  const [emailOnly, setEmailOnly] = useState(false);
  const codeRef = useRef<TextInput>(null);

  // Tell the person up front when Bravo has no way to send a code yet,
  // instead of letting them fill the form first.
  useEffect(() => {
    let live = true;
    authApi.passwordResetStatus()
      .then(r => {
        if (!live) {return;}
        if (r.available === false) {setUnavailable(true);}
        if (r.sms === false && r.email === true) {setEmailOnly(true);}
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);

  const sendCode = async () => {
    const problem = resetIdentifierProblem(identifier);
    if (problem) {setError(problem); return;}
    if (emailOnly && !identifier.includes('@')) {
      setError('Text messages are not available yet, so the code comes by email. Type the email address on your account.');
      return;
    }
    const parsed = parseLoginIdentifier(identifier);
    const value = parsed && 'email' in parsed ? parsed.email : parsed?.phoneE164 ?? identifier.trim();
    setBusy(true); setError(null);
    try {
      const r = await authApi.passwordResetStart(value);
      setResetId(r.resetId);
      setCode(''); setNeedTotp(false); setTotp('');
      setStep('reset');
      setTimeout(() => codeRef.current?.focus(), 250);
    } catch (e) {
      setError(resetErrorText(e));
      if ((e as {response?: {status?: number}})?.response?.status === 503) {setUnavailable(true);}
    } finally {
      setBusy(false);
    }
  };

  const complete = async () => {
    if (!resetId) {setStep('identify'); return;}
    if (!/^\d{4,8}$/.test(code.trim())) {setError('Type the code from the text or email.'); return;}
    const pwProblem = newPasswordProblem(pw, pw2);
    if (pwProblem) {setError(pwProblem); return;}
    if (needTotp && !/^[A-Za-z0-9 -]{6,12}$/.test(totp.trim())) {setError('Type the code your authenticator app shows now, or a backup code.'); return;}
    setBusy(true); setError(null);
    try {
      const r = await authApi.passwordResetComplete({
        resetId, code: code.trim(), newPassword: pw, ...(needTotp ? {totpCode: totp.trim()} : {}),
      });
      if (r.done) {
        setStep('done');
      } else if (r.needTotp) {
        setNeedTotp(true);
        setError(null);
      }
    } catch (e) {
      const err = (e as {response?: {data?: {error?: string}}})?.response?.data?.error;
      // A spent or locked reset cannot be retried: send them back to step 1.
      if (err === 'reset_expired' || err === 'reset_locked' || err === 'reset_needs_admin') {
        setResetId(null);
        setStep('identify');
      }
      setError(resetErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const title = step === 'identify' ? 'Reset your password'
    : step === 'reset' ? 'Choose a new password' : 'Password changed';
  const subtitle = step === 'identify'
    ? (emailOnly
      ? 'Type the email address on your Bravo Secure account. We will email you a 6-digit code.'
      : 'Type the mobile number or email on your Bravo Secure account. We will send you a 6-digit code.')
    : step === 'reset'
      ? `If ${identifier.trim()} belongs to an account, a code is on its way. Codes last 15 minutes.`
      : 'You are signed out on every device. Sign in with your new password.';

  return (
    <View style={styles.root}>
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <LinearGradient colors={['rgba(30,136,255,0.16)', 'rgba(30,136,255,0)']}
          start={{x: 0.5, y: 0}} end={{x: 0.5, y: 1}} style={styles.heroGlow} />
      </View>
      <View style={[styles.flex, {paddingBottom: keyboardOverlap}]}>
        <ScrollView style={styles.flex} contentContainerStyle={styles.scrollBody}
          keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} bounces={false}>
          <View style={[styles.body, {paddingTop: insets.top + 20, paddingBottom: insets.bottom + 24}]}>
            <TouchableOpacity onPress={() => goBackOnce(navigation)} style={styles.back} accessibilityRole="button"
              accessibilityLabel="Back to sign in" hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
              <Icon name="chevron-left" size={26} color={T.textDim} />
              <Text style={styles.backText}>Sign in</Text>
            </TouchableOpacity>

            <View style={styles.header}>
              <View style={[styles.badge, step === 'done' && styles.badgeOk]}>
                <Icon name={step === 'done' ? 'check-circle-outline' : 'lock-reset'} size={30}
                  color={step === 'done' ? T.signal : T.accent} />
              </View>
              <Text style={styles.eyebrow}>Forgot password</Text>
              <Text style={styles.title}>{title}</Text>
              <Text style={styles.subtitle}>{subtitle}</Text>
            </View>

            {unavailable && step === 'identify' && (
              <View style={styles.infoBox}>
                <Icon name="information-outline" size={18} color={T.textDim} />
                <Text style={styles.infoText}>
                  Password reset is not switched on yet. Contact Bravo Secure support to reset your password.
                </Text>
              </View>
            )}

            <View style={styles.form}>
              {step === 'identify' && (
                <>
                  <Input label={emailOnly ? 'Email address' : 'Mobile number or email'} value={identifier} onChangeText={t => { setIdentifier(t); setError(null); }}
                    keyboardType="email-address" autoComplete="username" textContentType="username"
                    placeholder={emailOnly ? 'you@company.com' : '+971 50 123 4567 or you@company.com'} onSubmitEditing={() => { void sendCode(); }}
                    returnKeyType="send" />
                  <Cta label="Send code" busy={busy} disabled={busy || unavailable || !identifier.trim()} onPress={() => { void sendCode(); }} />
                </>
              )}

              {step === 'reset' && (
                <>
                  <Input label="Code" value={code} inputRef={codeRef} onChangeText={t => { setCode(t.replace(/\D/g, '').slice(0, 8)); setError(null); }}
                    keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" placeholder="6-digit code" />
                  <Input label={`New password (at least ${MIN_RESET_PASSWORD} characters)`} value={pw}
                    onChangeText={t => { setPw(t); setError(null); }} secureTextEntry={!showPw}
                    autoComplete="password-new" textContentType="newPassword" placeholder="New password"
                    trailing={(
                      <TouchableOpacity onPress={() => setShowPw(v => !v)} accessibilityRole="button"
                        accessibilityLabel={showPw ? 'Hide password' : 'Show password'} hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
                        <Icon name={showPw ? 'eye-off-outline' : 'eye-outline'} size={20} color={T.textMute} />
                      </TouchableOpacity>
                    )} />
                  <Input label="Repeat new password" value={pw2} onChangeText={t => { setPw2(t); setError(null); }}
                    secureTextEntry={!showPw} autoComplete="password-new" textContentType="newPassword" placeholder="Repeat new password" />
                  {needTotp && (
                    <Input label="Authenticator code" value={totp} onChangeText={t => { setTotp(t); setError(null); }}
                      autoCapitalize="none" autoComplete="one-time-code" placeholder="Code from your authenticator app" />
                  )}
                  {needTotp && (
                    <Text style={styles.hint}>This account has an authenticator, so its code is needed too.</Text>
                  )}
                  <Cta label={needTotp ? 'Confirm and change password' : 'Change password'} busy={busy}
                    disabled={busy || !code || !pw || !pw2} onPress={() => { void complete(); }} />
                  <TouchableOpacity onPress={() => { void sendCode(); }} disabled={busy} style={styles.linkBtn} accessibilityRole="button">
                    <Text style={styles.link}>Send a new code</Text>
                  </TouchableOpacity>
                </>
              )}

              {step === 'done' && (
                <Cta label="Back to sign in" busy={false} disabled={false} onPress={() => navigation.navigate('Login')} />
              )}

              {error ? (
                <View style={styles.errorBox} accessibilityLiveRegion="polite">
                  <Icon name="alert-circle-outline" size={16} color={T.danger} />
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              ) : null}
            </View>
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

function Input({label, inputRef, trailing, ...rest}: React.ComponentProps<typeof TextInput> & {
  label: string; inputRef?: React.Ref<TextInput>; trailing?: React.ReactNode;
}) {
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.field}>
        <TextInput ref={inputRef} style={styles.input} placeholderTextColor={T.textMute}
          autoCapitalize="none" autoCorrect={false} {...rest} />
        {trailing}
      </View>
    </View>
  );
}

function Cta({label, busy, disabled, onPress}: {label: string; busy: boolean; disabled: boolean; onPress: () => void}) {
  return (
    <TouchableOpacity activeOpacity={0.9} onPress={onPress} disabled={disabled} accessibilityRole="button"
      style={disabled && styles.ctaDisabled}>
      <LinearGradient colors={[T.accent, T.accentDeep]} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.cta}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.ctaText}>{label}</Text>}
      </LinearGradient>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: T.bg},
  flex: {flex: 1},
  scrollBody: {flexGrow: 1},
  heroGlow: {position: 'absolute', top: -100, left: '8%', right: '8%', height: 340, borderRadius: 500},
  body: {flexGrow: 1, paddingHorizontal: 26},
  back: {flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginLeft: -8},
  backText: {color: T.textDim, fontSize: 14, fontWeight: '600'},
  header: {alignItems: 'center', marginTop: 18},
  badge: {width: 64, height: 64, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(30,136,255,0.12)', borderWidth: 1, borderColor: 'rgba(30,136,255,0.3)'},
  badgeOk: {backgroundColor: 'rgba(74,222,128,0.10)', borderColor: 'rgba(74,222,128,0.35)'},
  eyebrow: {fontFamily: 'monospace', color: T.accent, fontSize: 12, fontWeight: '700', letterSpacing: 3,
    textTransform: 'uppercase', marginTop: 22, marginBottom: 10},
  title: {color: T.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.8, textAlign: 'center'},
  subtitle: {color: T.textDim, fontSize: 14, lineHeight: 20, marginTop: 10, textAlign: 'center'},
  infoBox: {flexDirection: 'row', gap: 10, marginTop: 22, padding: 12, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: T.hair2},
  infoText: {flex: 1, color: T.textDim, fontSize: 13, lineHeight: 18},
  form: {marginTop: 28, gap: 14},
  label: {color: T.textDim, fontSize: 12, fontWeight: '600', marginBottom: 6},
  field: {flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 14, borderRadius: 14,
    backgroundColor: T.field, borderWidth: 1, borderColor: T.hair2},
  input: {flex: 1, color: T.text, fontSize: 15.5, paddingVertical: 12},
  hint: {color: T.textMute, fontSize: 12.5, marginTop: -4},
  cta: {height: 54, borderRadius: 15, alignItems: 'center', justifyContent: 'center', marginTop: 6},
  ctaDisabled: {opacity: 0.55},
  ctaText: {color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.2},
  linkBtn: {alignSelf: 'center', paddingVertical: 6},
  link: {color: T.accent, fontSize: 13.5, fontWeight: '600'},
  errorBox: {flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: 12,
    backgroundColor: 'rgba(255,139,139,0.08)', borderWidth: 1, borderColor: 'rgba(255,139,139,0.3)'},
  errorText: {flex: 1, fontSize: 13, color: T.danger, fontWeight: '500'},
});
