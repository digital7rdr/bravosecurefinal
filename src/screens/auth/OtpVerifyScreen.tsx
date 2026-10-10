import React, {useState, useRef, useEffect} from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Animated,
  TextInput,
  Linking,
} from 'react-native';
import axios from 'axios';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Svg, {Path, Rect, Circle} from 'react-native-svg';
import * as Clipboard from 'expo-clipboard';
import {scaleTextStyles} from '@utils/scaling';
import {useAuthStore} from '@store/authStore';
import type {AuthScreenProps} from '@navigation/types';
import {goBackOnce} from '@navigation/tapGuard';
import {QrCode} from '@components/QrCode';

type Props = AuthScreenProps<'OtpVerify'>;

const OTP_LENGTH = 6;
// TotpChallengeService.check(): a backup code is exactly 8 alphanumerics (case-insensitive).
const BACKUP_CODE_RE = /^[A-Za-z0-9]{8}$/;

/**
 * Turn an /auth/verify failure into something a person can act on. Nest
 * sends either `{message: 'otp_expired'}` (string code) or
 * `{error: 'otp_invalid', attemptsLeft}` (object body) — both land here as
 * an AxiosError whose own `.message` is just "Request failed with status
 * code 400", which is what this screen used to show.
 */
export function describeVerifyError(e: unknown, totp: boolean): string {
  const generic = totp ? 'That code didn\'t work. Check your authenticator app and try again.' : 'Invalid code. Please try again.';
  if (!axios.isAxiosError(e)) {return e instanceof Error && e.message ? e.message : generic;}
  if (!e.response) {return 'No connection. Check your network and try again.';}
  const body = e.response.data as {message?: string | string[]; error?: string; attemptsLeft?: number} | undefined;
  // Nest's string form is {statusCode, message: 'otp_expired', error: 'Bad Request'};
  // its object form is {error: 'otp_invalid', attemptsLeft}. Take whichever
  // field actually looks like a snake_case code.
  const candidates = [body?.error, Array.isArray(body?.message) ? body?.message[0] : body?.message];
  const code = candidates.find((c): c is string => typeof c === 'string' && /^[a-z0-9_]+$/.test(c)) ?? '';
  const left = typeof body?.attemptsLeft === 'number' ? ` ${body.attemptsLeft} ${body.attemptsLeft === 1 ? 'attempt' : 'attempts'} left.` : '';
  switch (code) {
    case 'otp_invalid':        return generic + left;
    case 'otp_expired':        return 'This sign-in has expired. Go back and sign in again.';
    case 'otp_already_used':
    case 'no_pending_otp':
    case 'challenge_required': return 'This sign-in is no longer valid. Go back and sign in again.';
    case 'otp_max_attempts':   return 'Too many attempts. Go back and sign in again.';
    case 'totp_not_setup':     return 'Authenticator not set up yet. Go back, sign in again and finish the setup.';
    case 'totp_locked':        return 'Too many wrong codes — this account is temporarily locked. Try again later.';
    case 'user_not_found':     return 'This account is no longer available.';
    default:
      if (e.response.status === 429) {return 'Too many attempts. Wait a moment and try again.';}
      if (e.response.status >= 500)  {return 'The server is unavailable right now. Try again shortly.';}
      return generic;
  }
}

// ── Design tokens (Bravo handoff — obsidian / platinum-cobalt) ──────────
// Why: same tokens as the sibling Login / OTPVerification screens so the
// login OTP step is visually indistinguishable from the signup one.
const T = {
  bg:         '#0A1F3F',
  text:       '#FFFFFF',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  textFaint:  'rgba(180,188,204,0.28)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#1E88FF',
  accentDeep: '#166ED1',
  accentGlow: 'rgba(30,136,255,0.35)',
  danger:     '#FF8B8B',
} as const;

// ── Glyphs (same paths as OTPVerificationScreen) ────────────────────────
function IcBack({c}: {c: string}) {
  return (
    <Svg width={9} height={15} viewBox="0 0 9 15" fill="none">
      <Path d="M8 1L1.5 7.5 8 14" stroke={c} strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
function IcLockTile({c}: {c: string}) {
  return (
    <Svg width={26} height={26} viewBox="0 0 24 24" fill="none">
      <Rect x={4.5} y={10} width={15} height={11} rx={2.6} stroke={c} strokeWidth={1.7} />
      <Path d="M8 10V7a4 4 0 0 1 8 0v3" stroke={c} strokeWidth={1.7} strokeLinecap="round" />
      <Circle cx={12} cy={15.4} r={1.6} fill={c} />
    </Svg>
  );
}
function IcCheck({c}: {c: string}) {
  return (
    <Svg width={19} height={19} viewBox="0 0 24 24" fill="none">
      <Path d="M5 12.5l4.5 4.5L19 7.5" stroke={c} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
function IcPaste({c}: {c: string}) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
      <Rect x={6} y={4} width={12} height={16} rx={2.2} stroke={c} strokeWidth={1.6} />
      <Path d="M9 4.2V3.4A1.4 1.4 0 0 1 10.4 2h3.2A1.4 1.4 0 0 1 15 3.4v.8" stroke={c} strokeWidth={1.6} />
      <Path d="M9 11h6M9 14.5h4" stroke={c} strokeWidth={1.6} strokeLinecap="round" />
    </Svg>
  );
}
function IcBackspace({c}: {c: string}) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
      <Path d="M9 5.5h10a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H9L3 12l6-6.5Z" stroke={c} strokeWidth={1.6} strokeLinejoin="round" />
      <Path d="M11 9.5l4 5M15 9.5l-4 5" stroke={c} strokeWidth={1.6} strokeLinecap="round" />
    </Svg>
  );
}
function IcCopy({c}: {c: string}) {
  return (
    <Svg width={15} height={15} viewBox="0 0 24 24" fill="none">
      <Rect x={8} y={8} width={12} height={12} rx={2.2} stroke={c} strokeWidth={1.7} />
      <Path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" stroke={c} strokeWidth={1.7} strokeLinecap="round" />
    </Svg>
  );
}
function IcAlert({c}: {c: string}) {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={9} stroke={c} strokeWidth={1.6} />
      <Path d="M12 7.5v5.5M12 16.2v.3" stroke={c} strokeWidth={1.8} strokeLinecap="round" />
    </Svg>
  );
}

// ── OTP cell — edge-lit, glowing ring + blinking caret when active ──────
function OtpCell({value, active, caret}: {value: string; active: boolean; caret: Animated.Value}) {
  const filled = value !== '';
  return (
    <View style={[s.cell, filled && s.cellFilled, active && s.cellActive]}>
      {filled && (
        <LinearGradient
          colors={['rgba(22,28,44,0.9)', 'rgba(14,19,30,0.85)']}
          start={{x: 0.5, y: 0}}
          end={{x: 0.5, y: 1}}
          style={StyleSheet.absoluteFill}
        />
      )}
      {filled ? (
        <Text style={s.cellDigit}>{value}</Text>
      ) : active ? (
        <Animated.View style={[s.cellCaret, {opacity: caret}]} />
      ) : (
        <View style={s.cellDot} />
      )}
    </View>
  );
}

// ── Keypad key — dark glass, cobalt press state ─────────────────────────
function Key({label, icon, onPress, accessibilityLabel}: {
  label?: string;
  icon?: React.ReactNode;
  onPress: () => void;
  accessibilityLabel: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({pressed}) => [s.key, pressed && s.keyDown]}>
      {icon ?? <Text style={s.keyText}>{label}</Text>}
    </Pressable>
  );
}

/**
 * IDN-12/28 — LOGIN second step. Reached only when /auth/login did NOT
 * return a devOtpCode. Verifies via the same verifyOtp store action the
 * staging auto-verify path uses.
 *
 * Three modes, from route.params.secondFactor (set by LoginScreen from the
 * /auth/login response):
 *   - 'sms'        legacy / staging — a Twilio code was texted to phoneHint.
 *   - 'totp'       production (AUTH_SECOND_FACTOR=totp) — a 6-digit code
 *                  from the authenticator app, or an 8-char backup code.
 *   - 'totp_enrol' first authenticator sign-in — `enrol` carries the
 *                  otpauth URI / seed / backup codes, shown ONCE above the
 *                  code entry; the code typed from the freshly added
 *                  authenticator completes enrolment on the server.
 * TOTP verifies carry `challengeId`, which binds this step to the password
 * step (a leaked user id plus a live code is not a login).
 *
 * No Resend here: auth-service has no login-OTP resend endpoint —
 * re-submitting credentials on the login screen issues a fresh code /
 * challenge, which is what the "Back to sign in" link is for.
 */
export default function OtpVerifyScreen({navigation, route}: Props) {
  const {userId, phoneHint, challengeId, enrol} = route.params;
  const secondFactor = route.params.secondFactor ?? 'sms';
  const totp = secondFactor !== 'sms';
  const enrolling = secondFactor === 'totp_enrol' && !!enrol;
  const insets = useSafeAreaInsets();
  const [code, setCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);
  const [backupCode, setBackupCode] = useState('');
  const [copied, setCopied] = useState<'secret' | 'codes' | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const {verifyOtp, completeAuth, isLoading} = useAuthStore();

  const copy = async (what: 'secret' | 'codes') => {
    if (!enrol) {return;}
    await Clipboard.setStringAsync(what === 'secret' ? enrol.secret : enrol.backupCodes.join('\n'));
    setCopied(what);
    setTimeout(() => setCopied(c => (c === what ? null : c)), 1800);
  };
  const openAuthenticator = async () => {
    if (!enrol) {return;}
    try {
      await Linking.openURL(enrol.uri);
    } catch {
      setErrorMsg('No authenticator app could open the link. Add the key manually instead.');
    }
  };

  // Blinking caret — steps(1) on/off, like the mock's CSS keyframe
  const caret = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(caret, {toValue: 1, duration: 0, useNativeDriver: true}),
        Animated.delay(525),
        Animated.timing(caret, {toValue: 0, duration: 0, useNativeDriver: true}),
        Animated.delay(525),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [caret]);

  const press = (d: string) => {
    if (busy || isLoading) {return;}
    setErrorMsg(null);
    setCode(c => (c.length >= OTP_LENGTH ? c : c + d));
  };
  const backspace = () => {
    setErrorMsg(null);
    setCode(c => c.slice(0, -1));
  };
  const paste = async () => {
    const text = await Clipboard.getStringAsync();
    const found = (text.match(/\d/g) ?? []).join('').slice(0, OTP_LENGTH);
    if (found) {
      setErrorMsg(null);
      setCode(found);
    }
  };

  const submitCode = useBackup ? backupCode.trim().toUpperCase() : code;
  const isComplete = useBackup ? BACKUP_CODE_RE.test(submitCode) : code.length === OTP_LENGTH;

  const handleVerify = async () => {
    if (!isComplete || busy) {return;}
    setBusy(true);
    setErrorMsg(null);
    try {
      await verifyOtp(userId, submitCode, challengeId);
      await completeAuth();
      // RootNavigator swaps to Main once isAuthenticated flips.
    } catch (e: unknown) {
      // Surface the server's reason (wrong code / expired / too many
      // attempts) inline; clear the entry so the retry starts fresh.
      setErrorMsg(describeVerifyError(e, totp));
      setCode('');
      setBackupCode('');
    } finally {
      setBusy(false);
    }
  };

  const maskedPhone = phoneHint
    ? phoneHint.replace(/(\+\d{3})\d+(\d{4})/, '$1 ** *** $2')
    : null;
  const activeIdx = code.length;
  const verifying = isLoading || busy;
  const title = enrolling ? 'Set up your authenticator' : totp ? 'Authenticator code' : 'Two-factor check';

  return (
    <View style={s.root}>
      {/* Ambient obsidian + cobalt hero glow */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <LinearGradient
          colors={['rgba(30,136,255,0.16)', 'rgba(30,136,255,0)']}
          start={{x: 0.5, y: 0}}
          end={{x: 0.5, y: 1}}
          style={s.heroGlow}
        />
      </View>

      {/* ── Top bar: back to login ── */}
      <View style={[s.topRow, {marginTop: insets.top + 12}]}>
        <TouchableOpacity
          style={s.backBtn}
          onPress={() => goBackOnce(navigation)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Back to sign in">
          <IcBack c={T.text} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={s.flex}
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>

        {/* ── Title block ── */}
        <View style={s.lockTile}>
          <LinearGradient
            colors={['rgba(30,136,255,0.22)', 'rgba(22,110,209,0.05)']}
            start={{x: 0.2, y: 0}}
            end={{x: 0.8, y: 1}}
            style={StyleSheet.absoluteFill}
          />
          <IcLockTile c="#3BA6FF" />
        </View>
        <Text style={s.title}>{title}</Text>
        {totp ? (
          <Text style={s.subtitle}>
            {enrolling
              ? 'Add Bravo Secure to an authenticator app (Google Authenticator, Microsoft Authenticator, Authy…), then enter the 6-digit code it shows.'
              : useBackup
                ? 'Enter one of the backup codes you saved when you set up your authenticator.'
                : 'Enter the 6-digit code from your authenticator app.'}
          </Text>
        ) : (
          <Text style={s.subtitle}>
            Enter the {OTP_LENGTH}-digit code we sent to{' '}
            {maskedPhone
              ? <Text style={s.phone}>{maskedPhone}</Text>
              : 'your registered phone number'}
          </Text>
        )}

        {/* ── One-time enrolment card (first authenticator sign-in) ── */}
        {enrolling && enrol ? (
          <View style={s.enrolCard} testID="totp-enrol-card">
            <Text style={[s.enrolLabel, s.enrolLabelFirst]}>Scan with an authenticator app</Text>
            <QrCode value={enrol.uri} />
            <Text style={s.enrolHint}>Authenticator on another phone or tablet? Scan this code. On this phone, use the button below.</Text>
            <View style={s.enrolGap} />
            <TouchableOpacity style={s.enrolBtn} onPress={() => { void openAuthenticator(); }} activeOpacity={0.85} accessibilityRole="button">
              <Text style={s.enrolBtnText}>Open in authenticator app</Text>
            </TouchableOpacity>
            <Text style={s.enrolLabel}>Or add this key manually</Text>
            <View style={s.secretRow}>
              <Text style={s.secret} selectable>{enrol.secret.replace(/(.{4})/g, '$1 ').trim()}</Text>
              <TouchableOpacity style={s.copyBtn} onPress={() => { void copy('secret'); }} accessibilityRole="button" accessibilityLabel="Copy key">
                <IcCopy c={T.accent} />
                <Text style={s.copyText}>{copied === 'secret' ? 'Copied' : 'Copy'}</Text>
              </TouchableOpacity>
            </View>
            <Text style={s.enrolLabel}>Backup codes — shown only once, save them now</Text>
            <View style={s.codesGrid}>
              {enrol.backupCodes.map(c => <Text key={c} style={s.backupCode} selectable>{c}</Text>)}
            </View>
            <TouchableOpacity style={s.copyBtnWide} onPress={() => { void copy('codes'); }} accessibilityRole="button" accessibilityLabel="Copy backup codes">
              <IcCopy c={T.accent} />
              <Text style={s.copyText}>{copied === 'codes' ? 'Copied' : 'Copy backup codes'}</Text>
            </TouchableOpacity>
            <Text style={s.enrolHint}>Each backup code signs you in once if you lose the authenticator.</Text>
          </View>
        ) : null}

        {/* ── Code entry: 6 cells (SMS / authenticator) or backup-code field ── */}
        {useBackup ? (
          <TextInput
            testID="backup-code-input"
            style={s.backupInput}
            value={backupCode}
            onChangeText={t => { setErrorMsg(null); setBackupCode(t.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)); }}
            placeholder="Backup code"
            placeholderTextColor={T.textMute}
            autoCapitalize="characters"
            autoCorrect={false}
            autoFocus
            maxLength={8}
            returnKeyType="done"
            onSubmitEditing={() => { void handleVerify(); }}
          />
        ) : (
          <View style={s.otpRow}>
            {Array.from({length: OTP_LENGTH}).map((_, i) => (
              <OtpCell key={i} value={code[i] ?? ''} active={i === activeIdx} caret={caret} />
            ))}
          </View>
        )}

        {/* ── Server error (wrong / expired / attempts) ── */}
        {errorMsg ? (
          <View style={s.errorBox}>
            <IcAlert c={T.danger} />
            <Text style={s.errorText}>{errorMsg}</Text>
          </View>
        ) : null}

        {/* ── Backup-code toggle (enrolled authenticator only) ── */}
        {totp && !enrolling ? (
          <View style={s.resendRow}>
            <Text style={s.resendHint}>{useBackup ? 'Have your authenticator?' : 'Lost your authenticator?'}</Text>
            <TouchableOpacity
              onPress={() => { setErrorMsg(null); setCode(''); setBackupCode(''); setUseBackup(b => !b); }}
              activeOpacity={0.7}
              testID="toggle-backup-code">
              <Text style={s.resendActive}>{useBackup ? 'Use authenticator code' : 'Use a backup code'}</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {/* ── Back to sign in (re-signing in issues a fresh code / challenge) ── */}
        <View style={s.resendRow}>
          <Text style={s.resendHint}>{totp ? 'Something wrong?' : "Didn't get the code?"}</Text>
          <TouchableOpacity onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
            <Text style={s.resendActive}>Back to sign in</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* ── Verify button ── */}
      <View style={s.footer}>
        <TouchableOpacity
          activeOpacity={0.9}
          onPress={() => { void handleVerify(); }}
          disabled={!isComplete || verifying}
          style={[s.ctaWrap, isComplete && !verifying && s.ctaGlow]}>
          {isComplete ? (
            <LinearGradient
              colors={['#3BA6FF', T.accent, T.accentDeep]}
              start={{x: 0.5, y: 0}}
              end={{x: 0.5, y: 1}}
              style={s.cta}>
              {verifying ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <IcCheck c="#fff" />
                  <Text style={s.ctaText}>Verify & Sign In</Text>
                </>
              )}
            </LinearGradient>
          ) : (
            <View style={[s.cta, s.ctaIdle]}>
              <Text style={[s.ctaText, s.ctaTextIdle]}>Verify & Sign In</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>

      {/* ── Custom in-app numeric keypad (hidden while typing a backup code) ── */}
      {useBackup ? <View style={{height: insets.bottom + 12}} /> : (
      <View style={[s.keypad, {paddingBottom: insets.bottom + 22}]}>
        <LinearGradient
          colors={['rgba(10,31,63,0)', 'rgba(10,31,63,0.6)', 'rgba(9,11,16,0.92)']}
          locations={[0, 0.3, 1]}
          start={{x: 0.5, y: 0}}
          end={{x: 0.5, y: 1}}
          style={StyleSheet.absoluteFill}
        />
        {[['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']].map(row => (
          <View key={row[0]} style={s.keyRow}>
            {row.map(d => (
              <Key key={d} label={d} onPress={() => press(d)} accessibilityLabel={`Digit ${d}`} />
            ))}
          </View>
        ))}
        <View style={s.keyRow}>
          <Key icon={<IcPaste c={T.textMute} />} onPress={() => { void paste(); }} accessibilityLabel="Paste code" />
          <Key label="0" onPress={() => press('0')} accessibilityLabel="Digit 0" />
          <Key icon={<IcBackspace c={T.danger} />} onPress={backspace} accessibilityLabel="Delete digit" />
        </View>
      </View>
      )}
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: T.bg},
  flex: {flex: 1},
  heroGlow: {position: 'absolute', top: -110, left: '8%', right: '8%', height: 340, borderRadius: 500},

  // Top bar
  topRow: {flexDirection: 'row', alignItems: 'center', minHeight: 42, paddingHorizontal: 22},
  backBtn: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1, borderColor: T.hair2,
    alignItems: 'center', justifyContent: 'center',
  },

  content: {flexGrow: 1, paddingHorizontal: 22},

  // Title block
  lockTile: {
    width: 56, height: 56, borderRadius: 17, marginTop: 26, marginBottom: 20, marginLeft: 4,
    borderWidth: 1, borderColor: 'rgba(30,136,255,0.34)',
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    shadowColor: T.accent, shadowOffset: {width: 0, height: 10},
    shadowOpacity: 0.22, shadowRadius: 15, elevation: 8,
  },
  title: {fontSize: 32, fontWeight: '700', letterSpacing: -1, color: T.text, lineHeight: 34, paddingHorizontal: 4},
  subtitle: {fontSize: 14.5, color: T.textDim, marginTop: 12, letterSpacing: -0.1, lineHeight: 21, paddingHorizontal: 4},
  phone: {fontFamily: 'monospace', fontWeight: '600', color: T.text, letterSpacing: 0.2},

  // OTP cells
  otpRow: {flexDirection: 'row', gap: 9, marginTop: 28},
  cell: {
    flex: 1, minHeight: 64, borderRadius: 16, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.022)',
    borderWidth: 1.5, borderColor: T.hair2,
  },
  cellFilled: {borderColor: 'rgba(30,136,255,0.32)'},
  cellActive: {
    borderColor: T.accent,
    shadowColor: T.accent, shadowOffset: {width: 0, height: 4},
    shadowOpacity: 0.4, shadowRadius: 10, elevation: 6,
  },
  cellDigit: {fontSize: 27, fontWeight: '700', color: T.text, letterSpacing: -0.5},
  cellCaret: {width: 2, height: 28, borderRadius: 2, backgroundColor: T.accent},
  cellDot: {width: 7, height: 7, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.10)'},

  // Authenticator enrolment card (first TOTP sign-in)
  enrolCard: {
    marginTop: 22, borderRadius: 16, padding: 16,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1, borderColor: T.hair2,
  },
  enrolBtn: {
    height: 46, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(30,136,255,0.16)', borderWidth: 1, borderColor: 'rgba(30,136,255,0.4)',
  },
  enrolBtnText: {fontSize: 14.5, fontWeight: '700', color: '#3BA6FF', letterSpacing: 0.1},
  enrolLabel: {fontSize: 12, fontWeight: '600', color: T.textMute, marginTop: 16, marginBottom: 8, letterSpacing: 0.4, textTransform: 'uppercase'},
  secretRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  secret: {flex: 1, fontFamily: 'monospace', fontSize: 15, color: T.text, letterSpacing: 1},
  copyBtn: {flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 9, backgroundColor: 'rgba(30,136,255,0.10)'},
  copyBtnWide: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 10, paddingVertical: 9, borderRadius: 10, backgroundColor: 'rgba(30,136,255,0.10)'},
  copyText: {fontSize: 12.5, fontWeight: '700', color: T.accent},
  codesGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  backupCode: {fontFamily: 'monospace', fontSize: 14, color: T.text, letterSpacing: 0.8, width: '47%', paddingVertical: 6, paddingHorizontal: 8, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.04)', textAlign: 'center'},
  enrolHint: {fontSize: 12, color: T.textMute, marginTop: 10, lineHeight: 17},
  enrolLabelFirst: {marginTop: 0, textAlign: 'center'},
  enrolGap: {height: 14},

  // Backup-code text field (replaces the cells + keypad)
  backupInput: {
    marginTop: 28, minHeight: 60, borderRadius: 16, paddingHorizontal: 18,
    fontFamily: 'monospace', fontSize: 22, letterSpacing: 2, color: T.text,
    backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1.5, borderColor: T.accent,
  },

  // Error box — same pattern as LoginScreen
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16,
    backgroundColor: 'rgba(255,93,93,0.10)', borderRadius: 12,
    paddingVertical: 10, paddingHorizontal: 12,
    borderWidth: 1, borderColor: 'rgba(255,93,93,0.25)',
  },
  errorText: {flex: 1, fontSize: 13, color: T.danger, fontWeight: '500'},

  // Back-to-login row
  resendRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20, paddingHorizontal: 4},
  resendHint: {fontSize: 13, color: T.textMute, letterSpacing: -0.05},
  resendActive: {fontSize: 13.5, fontWeight: '700', color: T.accent, letterSpacing: 0.2},

  // Verify button
  footer: {paddingHorizontal: 22, paddingBottom: 16},
  // Why: shadow/elevation live on this OUTER wrapper, not on the
  // LinearGradient — Android elevation needs a solid-background host.
  ctaWrap: {borderRadius: 18, overflow: 'hidden'},
  ctaGlow: {
    shadowColor: T.accent, shadowOffset: {width: 0, height: 12},
    shadowOpacity: 0.35, shadowRadius: 19, elevation: 10,
  },
  cta: {
    height: 58, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  ctaIdle: {backgroundColor: 'rgba(255,255,255,0.04)', borderColor: T.hair2},
  ctaText: {fontSize: 16.5, fontWeight: '700', letterSpacing: 0.2, color: '#fff'},
  ctaTextIdle: {color: T.textMute},

  // Keypad
  keypad: {paddingHorizontal: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: T.hair},
  keyRow: {flexDirection: 'row', gap: 9, marginBottom: 9},
  key: {
    flex: 1, height: 56, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.035)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)',
  },
  keyDown: {backgroundColor: 'rgba(30,136,255,0.16)', borderWidth: 1.5, borderColor: T.accentGlow},
  keyText: {fontSize: 24, fontWeight: '600', color: T.text},
}));
