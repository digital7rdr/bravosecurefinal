/**
 * Group invite links / QR codes (2026-10-23) — the two sheets.
 *
 *  - `GroupInviteModal` (Group info, admins): the group's link as a QR code,
 *    copy / share, reset (old link stops working) and turn off.
 *  - `JoinGroupModal` (Contacts tab, Groups): scan a group QR code or paste a
 *    link; the group's admin gets a request and their phone adds you.
 *
 * Mechanics live in `@/modules/messenger/groups/groupInvites`.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Share,
} from 'react-native';
import {CameraView, useCameraPermissions, type BarcodeScanningResult} from 'expo-camera';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import * as Clipboard from 'expo-clipboard';
import {Alert} from '@utils/alert';
import {scaleTextStyles} from '@utils/scaling';
import {QrCode} from '@components/QrCode';
import {parseGroupInvite} from '@bravo/messenger-core/link/groupInvite';
import {
  getGroupInvite, issueGroupInvite, resetGroupInvite, revokeGroupInvite, requestToJoinGroup,
} from '@/modules/messenger/groups/groupInvites';

const BLUE = '#1E88FF';

export function GroupInviteModal({visible, groupId, groupName, onClose}: {
  visible: boolean;
  groupId: string;
  groupName: string;
  onClose: () => void;
}): React.JSX.Element {
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {return;}
    let live = true;
    setErr(null);
    void getGroupInvite(groupId).then(l => { if (live) {setLink(l);} }).catch(() => undefined);
    return () => { live = false; };
  }, [visible, groupId]);

  const run = useCallback(async (fn: () => Promise<string | null>) => {
    setBusy(true); setErr(null);
    try { setLink(await fn()); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, []);

  const share = useCallback(async () => {
    if (!link) {return;}
    try {
      await Share.share({message: `Join “${groupName}” on Bravo Secure. Open Bravo Messenger → Contacts → Join group, and paste this link:\n\n${link}`});
    } catch { /* dismissed */ }
  }, [link, groupName]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <Text style={styles.title}>Invite with a link</Text>
          <Text style={styles.sub}>
            Anyone with this link or QR code can ask to join “{groupName}”. Your phone adds them automatically, so only share it with people you trust.
          </Text>
          {link ? (
            <>
              <View style={{marginTop: 14}}><QrCode value={link} size={196} label={`QR code to join ${groupName}`} testID="group-invite-qr" /></View>
              <Text style={styles.link} numberOfLines={2} selectable>{link}</Text>
              <View style={styles.row}>
                <Btn icon="content-copy" label="Copy" onPress={() => { void Clipboard.setStringAsync(link); Alert.alert('Copied', 'The invite link is on your clipboard.'); }} />
                <Btn icon="share-variant" label="Share" onPress={() => { void share(); }} />
              </View>
              <View style={styles.row}>
                <Btn icon="refresh" label="Reset link" disabled={busy} onPress={() => {
                  Alert.alert('Reset the link?', 'The current link and QR code stop working.', [
                    {text: 'Cancel', style: 'cancel'},
                    {text: 'Reset', onPress: () => { void run(() => resetGroupInvite(groupId)); }},
                  ]);
                }} />
                <Btn icon="link-off" label="Turn off" danger disabled={busy} onPress={() => {
                  void run(async () => { await revokeGroupInvite(groupId); return null; });
                }} />
              </View>
            </>
          ) : (
            <TouchableOpacity style={styles.primary} disabled={busy} activeOpacity={0.85}
              onPress={() => { void run(() => issueGroupInvite(groupId)); }}>
              {busy ? <ActivityIndicator color="#FFF" /> : <Text style={styles.primaryText}>Create invite link</Text>}
            </TouchableOpacity>
          )}
          {err ? <Text style={styles.err}>{err}</Text> : null}
          <TouchableOpacity style={styles.close} onPress={onClose} activeOpacity={0.8}>
            <Text style={styles.closeText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

export function JoinGroupModal({visible, onClose}: {visible: boolean; onClose: () => void}): React.JSX.Element {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [perm, requestPerm] = useCameraPermissions();
  const handled = useRef(false);

  useEffect(() => { if (visible) {setText(''); setErr(null); setScanning(false);} }, [visible]);

  const join = useCallback(async (link: string) => {
    setBusy(true); setErr(null);
    try {
      const r = await requestToJoinGroup(link);
      onClose();
      Alert.alert(
        r.alreadyMember ? 'Already a member' : 'Request sent',
        r.alreadyMember
          ? `You are already in “${r.groupName || 'this group'}”.`
          : `The admin of “${r.groupName || 'the group'}” has your request. The group appears in your chats as soon as their phone adds you.`,
      );
    } catch (e) {
      setErr((e as Error).message || 'Could not send the request.');
    } finally {
      setBusy(false);
    }
  }, [onClose]);

  const startScan = useCallback(async () => {
    if (!perm?.granted) {
      const res = await requestPerm();
      if (!res.granted) {setErr('Allow camera access to scan a group QR code.'); return;}
    }
    handled.current = false;
    setScanning(true);
  }, [perm, requestPerm]);

  const onScanned = useCallback((r: BarcodeScanningResult) => {
    if (handled.current || !parseGroupInvite(r.data)) {return;}
    handled.current = true;
    setScanning(false);
    void join(r.data);
  }, [join]);

  return (
    <Modal visible={visible} transparent={!scanning} animationType="fade" onRequestClose={() => (scanning ? setScanning(false) : onClose())}>
      {scanning ? (
        <View style={styles.scanRoot}>
          <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{barcodeTypes: ['qr']}} onBarcodeScanned={onScanned} />
          <View pointerEvents="none" style={styles.frame} />
          <TouchableOpacity style={styles.scanClose} onPress={() => setScanning(false)} accessibilityLabel="Stop scanning">
            <Icon name="close" size={22} color="#FFF" />
          </TouchableOpacity>
          <Text style={styles.scanHint}>Point your camera at the group&apos;s QR code.</Text>
        </View>
      ) : (
        <View style={styles.overlay}>
          <View style={styles.card}>
            <Text style={styles.title}>Join a group</Text>
            <Text style={styles.sub}>Scan the group&apos;s QR code or paste the invite link someone shared with you.</Text>
            <TouchableOpacity style={[styles.primary, {marginTop: 14}]} onPress={() => { void startScan(); }} disabled={busy} activeOpacity={0.85}>
              <Icon name="qrcode-scan" size={18} color="#FFF" />
              <Text style={styles.primaryText}>Scan QR code</Text>
            </TouchableOpacity>
            <TextInput
              style={styles.input}
              value={text}
              onChangeText={t => { setText(t); setErr(null); }}
              placeholder="bravo-group:1:…"
              placeholderTextColor="rgba(180,188,204,0.45)"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.row}>
              <Btn icon="content-paste" label="Paste" onPress={() => { void Clipboard.getStringAsync().then(t => setText(t ?? '')); }} />
              <Btn icon="account-multiple-plus" label={busy ? 'Sending…' : 'Ask to join'} disabled={busy || !parseGroupInvite(text)}
                onPress={() => { void join(text); }} />
            </View>
            {err ? <Text style={styles.err}>{err}</Text> : null}
            <TouchableOpacity style={styles.close} onPress={onClose} activeOpacity={0.8}>
              <Text style={styles.closeText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </Modal>
  );
}

function Btn({icon, label, onPress, disabled, danger}: {
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <TouchableOpacity style={[styles.btn, disabled && {opacity: 0.45}]} onPress={onPress} disabled={disabled} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel={label}>
      <Icon name={icon} size={16} color={danger ? '#FF6B6B' : BLUE} />
      <Text style={[styles.btnText, danger && {color: '#FF6B6B'}]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  overlay: {flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', alignItems: 'center', justifyContent: 'center', padding: 20},
  card: {width: '100%', maxWidth: 380, borderRadius: 18, backgroundColor: '#0E2347', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', padding: 20},
  title: {color: '#FFFFFF', fontSize: 16, fontWeight: '800'},
  sub: {color: 'rgba(229,233,242,0.72)', fontSize: 12.5, lineHeight: 18, marginTop: 6},
  link: {color: 'rgba(229,233,242,0.62)', fontSize: 10.5, marginTop: 12, textAlign: 'center'},
  row: {flexDirection: 'row', gap: 10, marginTop: 12},
  btn: {flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(30,136,255,0.35)', backgroundColor: 'rgba(30,136,255,0.08)'},
  btnText: {color: BLUE, fontSize: 12.5, fontWeight: '800'},
  primary: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 16, paddingVertical: 12, borderRadius: 12, backgroundColor: BLUE},
  primaryText: {color: '#FFFFFF', fontSize: 14, fontWeight: '800'},
  input: {marginTop: 14, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', color: '#FFFFFF', paddingHorizontal: 12, paddingVertical: 10, fontSize: 13},
  err: {color: '#FF6B6B', fontSize: 12, marginTop: 10},
  close: {alignSelf: 'flex-end', marginTop: 16, paddingVertical: 6, paddingHorizontal: 4},
  closeText: {color: 'rgba(229,233,242,0.8)', fontSize: 13, fontWeight: '700'},
  scanRoot: {flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center'},
  frame: {width: 240, height: 240, borderRadius: 18, borderWidth: 3, borderColor: BLUE},
  scanClose: {position: 'absolute', top: 48, left: 20, width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center'},
  scanHint: {position: 'absolute', bottom: 60, color: '#FFFFFF', fontSize: 13, textAlign: 'center', paddingHorizontal: 28},
}));
