import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, TextInput, ScrollView, Share, ActivityIndicator, Platform,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {Alert} from '@utils/alert';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {haptics} from '@utils/haptics';
import {orgApi, type ProviderInvite} from '@services/api';
import FitLine from '@components/ui/FitLine';

/**
 * B-812 — the provider MINTS the code an officer types into "Join your
 * provider". Until 2026-09-06 nothing in the product could create one: the
 * redeem screen existed, the table existed, and the only way to issue a code
 * was SQL by hand.
 *
 * Shape: mint (role · optional call sign · expiry) → the code, big, with COPY
 * and SHARE (the share text tells the officer exactly where to type it) →
 * the org's open / used / revoked codes below, each open one revocable.
 * Every mutating press is guarded by a synchronous ref (NAV loop N-rules) so
 * a double tap cannot mint two codes or revoke twice.
 */
const D = {
  bg: '#0A1F3F', card: '#122747', text: '#FFFFFF', dim: 'rgba(229,233,242,0.62)', mute: 'rgba(180,188,204,0.45)',
  hair: 'rgba(255,255,255,0.08)', accent: '#1E88FF', accentSoft: '#3BA6FF', signal: '#4ADE80', amber: '#F5C76B', alert: '#FF5D5D',
  fSans: 'Manrope_500Medium', fSemi: 'Manrope_600SemiBold', fBold: 'Manrope_700Bold',
};
const TTL_OPTIONS = [1, 7, 30] as const;

export function buildInviteShareText(p: {code: string; company: string | null; expiresAt: string | null; role: 'cpo' | 'manager'}): string {
  const who = p.company ? `${p.company}` : 'your provider';
  const until = p.expiresAt ? ` It expires ${new Date(p.expiresAt).toLocaleDateString()}.` : '';
  const as = p.role === 'manager' ? ' as a manager' : '';
  return `You're invited to join ${who} on Bravo Secure${as}.\n\nOpen the Bravo Secure app → I'm an Agent → Join your provider → enter this code:\n\n${p.code}\n\nThe code is single use.${until}`;
}

export function InviteOfficerModal({
  visible, company, canInviteManager, onClose, onChanged,
}: {
  visible: boolean;
  company: string | null;
  /** Only the owner may mint a MANAGER invite (mirrors the promote rule). */
  canInviteManager: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const {bottomPad} = useKeyboardLayout();
  const [role, setRole] = useState<'cpo' | 'manager'>('cpo');
  const [callSign, setCallSign] = useState('');
  const [ttl, setTtl] = useState<(typeof TTL_OPTIONS)[number]>(7);
  const [minted, setMinted] = useState<{code: string; expires_at: string; member_role: 'cpo' | 'manager'} | null>(null);
  const [invites, setInvites] = useState<ProviderInvite[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<'mint' | string | null>(null);
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const {data} = await orgApi.listInvites();
      setInvites(data);
      setLoadErr(null);
    } catch (e) {
      setLoadErr((e as Error).message || 'Could not load invitations.');
    }
  }, []);

  useEffect(() => {
    if (!visible) {return;}
    setMinted(null); setCallSign(''); setRole('cpo'); setTtl(7);
    void load();
  }, [visible, load]);

  const mint = async () => {
    if (busyRef.current) {return;}
    busyRef.current = true; setBusy('mint');
    try {
      const {data} = await orgApi.mintInvite({member_role: role, call_sign: callSign.trim() || undefined, expires_in_days: ttl});
      haptics.tap();
      setMinted({code: data.code, expires_at: data.expires_at, member_role: data.member_role});
      onChanged?.();
      void load();
    } catch (e) {
      Alert.alert('Could not create the invitation', (e as Error).message || 'Try again.');
    } finally {
      busyRef.current = false; setBusy(null);
    }
  };

  const revoke = (code: string) => {
    Alert.alert('Revoke this invitation?', `${code} will stop working immediately. This cannot be undone.`, [
      {text: 'Keep', style: 'cancel'},
      {text: 'Revoke', style: 'destructive', onPress: () => { void (async () => {
        if (busyRef.current) {return;}
        busyRef.current = true; setBusy(code);
        try {
          await orgApi.revokeInvite(code);
          if (minted?.code === code) {setMinted(null);}
          onChanged?.();
          await load();
        } catch (e) {
          Alert.alert('Could not revoke', (e as Error).message || 'Try again.');
        } finally {
          busyRef.current = false; setBusy(null);
        }
      })(); }},
    ]);
  };

  const copy = async (code: string) => {
    try { await Clipboard.setStringAsync(code); haptics.select(); Alert.alert('Copied', `${code} is on your clipboard.`); }
    catch { Alert.alert('Copy failed', 'Long-press the code to select it.'); }
  };

  const share = async (code: string, expiresAt: string | null, r: 'cpo' | 'manager') => {
    try {
      await Share.share({message: buildInviteShareText({code, company, expiresAt, role: r})});
    } catch { /* user dismissed the sheet */ }
  };

  const open = (invites ?? []).filter(i => i.status === 'open');
  const closed = (invites ?? []).filter(i => i.status !== 'open');

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={[s.root, {paddingTop: insets.top + 8}]}>
        <View style={s.header}>
          <TouchableOpacity onPress={onClose} style={s.iconBtn} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
            accessibilityRole="button" accessibilityLabel="Close">
            <Icon name="chevron-down" size={24} color={D.text} />
          </TouchableOpacity>
          <View style={s.accentBar} />
          <Text style={s.title}>INVITE OFFICER</Text>
        </View>

        <ScrollView contentContainerStyle={{padding: 20, paddingBottom: bottomPad(24), gap: 14}} keyboardShouldPersistTaps="handled">
          <Text style={s.lead}>
            An officer joins your roster by entering a code in the app (I'm an Agent → Join your provider).
            Each code works once. You can revoke it any time before it is used.
          </Text>

          {/* ── Mint ── */}
          <View style={s.card}>
            <Text style={s.label}>JOINS AS</Text>
            <View style={s.row}>
              {(['cpo', 'manager'] as const).map(r => {
                const disabled = r === 'manager' && !canInviteManager;
                const on = role === r;
                return (
                  <TouchableOpacity key={r} disabled={disabled} onPress={() => setRole(r)} activeOpacity={0.8}
                    accessibilityRole="button" accessibilityState={{selected: on, disabled}}
                    style={[s.chip, on && s.chipOn, disabled && {opacity: 0.35}]}>
                    <Text style={[s.chipText, on && s.chipTextOn]}>{r === 'cpo' ? 'CPO' : 'MANAGER'}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {!canInviteManager && <Text style={s.hint}>Only the account owner can invite a manager.</Text>}

            <Text style={[s.label, {marginTop: 14}]}>CALL SIGN (OPTIONAL)</Text>
            <TextInput
              value={callSign}
              onChangeText={setCallSign}
              placeholder="e.g. RANGER-7"
              placeholderTextColor={D.mute}
              autoCapitalize="characters"
              maxLength={24}
              style={s.input}
              accessibilityLabel="Call sign"
            />

            <Text style={[s.label, {marginTop: 14}]}>EXPIRES IN</Text>
            <View style={s.row}>
              {TTL_OPTIONS.map(d => {
                const on = ttl === d;
                return (
                  <TouchableOpacity key={d} onPress={() => setTtl(d)} activeOpacity={0.8}
                    accessibilityRole="button" accessibilityState={{selected: on}}
                    style={[s.chip, on && s.chipOn]}>
                    <Text style={[s.chipText, on && s.chipTextOn]}>{d === 1 ? '24 H' : `${d} DAYS`}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <TouchableOpacity onPress={() => { void mint(); }} disabled={busy === 'mint'} activeOpacity={0.85}
              accessibilityRole="button" accessibilityLabel="Create invitation code"
              style={[s.cta, busy === 'mint' && {opacity: 0.6}]}>
              {busy === 'mint' ? <ActivityIndicator color="#fff" /> : <Icon name="key-plus" size={18} color="#fff" />}
              <Text style={s.ctaText}>{busy === 'mint' ? 'CREATING…' : 'CREATE INVITATION CODE'}</Text>
            </TouchableOpacity>
          </View>

          {/* ── The code just minted ── */}
          {minted && (
            <View style={[s.card, {borderColor: 'rgba(30,136,255,0.45)'}]}>
              <Text style={s.label}>NEW INVITATION · {minted.member_role === 'manager' ? 'MANAGER' : 'CPO'}</Text>
              {/* B-657 — FitLine, never the native shrink pair: a 12-char code at
                  30 px / 4 px tracking overflows a 320-dp card. */}
              <View accessible accessibilityLabel={`Invitation code ${minted.code.split('').join(' ')}`}>
                <FitLine style={s.code} text={minted.code} />
              </View>
              <Text style={s.hint}>Single use · expires {new Date(minted.expires_at).toLocaleDateString()}</Text>
              <View style={[s.row, {marginTop: 12}]}>
                <TouchableOpacity onPress={() => { void copy(minted.code); }} style={s.secondary} activeOpacity={0.8} accessibilityRole="button">
                  <Icon name="content-copy" size={16} color={D.accentSoft} /><Text style={s.secondaryText}>COPY</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => { void share(minted.code, minted.expires_at, minted.member_role); }} style={s.secondary} activeOpacity={0.8} accessibilityRole="button">
                  <Icon name={Platform.OS === 'ios' ? 'export-variant' : 'share-variant'} size={16} color={D.accentSoft} /><Text style={s.secondaryText}>SHARE</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* ── Existing codes ── */}
          <View style={s.card}>
            <Text style={s.label}>OPEN INVITATIONS · {open.length}</Text>
            {loadErr && <Text style={[s.hint, {color: D.alert}]}>{loadErr}</Text>}
            {invites === null && !loadErr && <ActivityIndicator color={D.accent} style={{marginVertical: 12}} />}
            {invites !== null && open.length === 0 && <Text style={s.hint}>No open invitations. Create one above.</Text>}
            {open.map(i => (
              <View key={i.code} style={s.inviteRow}>
                <View style={{flex: 1, minWidth: 0}}>
                  <Text selectable style={s.inviteCode}>{i.code}</Text>
                  <Text style={s.hint} numberOfLines={1}>
                    {i.member_role === 'manager' ? 'Manager' : 'CPO'}{i.call_sign ? ` · ${i.call_sign}` : ''}
                    {i.expires_at ? ` · expires ${new Date(i.expires_at).toLocaleDateString()}` : ''}
                  </Text>
                </View>
                <TouchableOpacity onPress={() => { void share(i.code, i.expires_at, i.member_role === 'manager' ? 'manager' : 'cpo'); }} style={s.iconBtn} hitSlop={{top: 6, bottom: 6, left: 6, right: 6}}
                  accessibilityRole="button" accessibilityLabel={`Share ${i.code}`}>
                  <Icon name="share-variant" size={18} color={D.accentSoft} />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => revoke(i.code)} disabled={busy === i.code} style={s.iconBtn} hitSlop={{top: 6, bottom: 6, left: 6, right: 6}}
                  accessibilityRole="button" accessibilityLabel={`Revoke ${i.code}`}>
                  {busy === i.code ? <ActivityIndicator color={D.alert} /> : <Icon name="close-circle-outline" size={20} color={D.alert} />}
                </TouchableOpacity>
              </View>
            ))}
            {closed.length > 0 && (
              <>
                <Text style={[s.label, {marginTop: 14}]}>USED · REVOKED · EXPIRED</Text>
                {closed.slice(0, 20).map(i => (
                  <View key={i.code} style={s.inviteRow}>
                    <View style={{flex: 1, minWidth: 0}}>
                      <Text style={[s.inviteCode, {color: D.mute}]}>{i.code}</Text>
                      <Text style={s.hint} numberOfLines={1}>
                        {i.status === 'redeemed' ? `Joined${i.redeemed_by_name ? ` · ${i.redeemed_by_name}` : ''}` : i.status === 'revoked' ? 'Revoked' : 'Expired'}
                      </Text>
                    </View>
                    <Icon name={i.status === 'redeemed' ? 'check-circle-outline' : 'minus-circle-outline'} size={18}
                      color={i.status === 'redeemed' ? D.signal : D.mute} />
                  </View>
                ))}
              </>
            )}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: D.bg},
  header: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 12, gap: 10},
  iconBtn: {width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.05)'},
  accentBar: {width: 3, height: 18, borderRadius: 2, backgroundColor: D.accent},
  title: {fontFamily: D.fBold, fontSize: 15, letterSpacing: 2, color: D.text},
  lead: {fontFamily: D.fSans, fontSize: 13.5, lineHeight: 20, color: D.dim},
  card: {backgroundColor: D.card, borderRadius: 14, borderWidth: 1, borderColor: D.hair, padding: 16},
  label: {fontFamily: D.fSemi, fontSize: 10.5, letterSpacing: 1.4, color: D.mute, marginBottom: 8},
  row: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  chip: {paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10, borderWidth: 1, borderColor: D.hair, backgroundColor: 'rgba(255,255,255,0.03)', minHeight: 40, justifyContent: 'center'},
  chipOn: {borderColor: D.accent, backgroundColor: 'rgba(30,136,255,0.16)'},
  chipText: {fontFamily: D.fSemi, fontSize: 12, letterSpacing: 1, color: D.dim},
  chipTextOn: {color: D.text},
  hint: {fontFamily: D.fSans, fontSize: 12, color: D.mute, marginTop: 6},
  input: {borderWidth: 1, borderColor: D.hair, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, color: D.text, fontFamily: D.fSemi, fontSize: 15, letterSpacing: 1.2, backgroundColor: 'rgba(255,255,255,0.03)'},
  cta: {marginTop: 18, minHeight: 50, borderRadius: 12, backgroundColor: D.accent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8},
  ctaText: {fontFamily: D.fBold, fontSize: 13, letterSpacing: 1.6, color: '#fff'},
  code: {fontFamily: D.fBold, fontSize: 30, letterSpacing: 4, color: D.text, marginTop: 4},
  secondary: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(30,136,255,0.4)'},
  secondaryText: {fontFamily: D.fSemi, fontSize: 12, letterSpacing: 1.2, color: D.accentSoft},
  inviteRow: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 10, borderTopWidth: 1, borderTopColor: D.hair},
  inviteCode: {fontFamily: D.fBold, fontSize: 15, letterSpacing: 2, color: D.text},
});
