import React, {useCallback, useEffect, useRef, useState} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, StatusBar, ScrollView, ActivityIndicator} from 'react-native';
import {CameraView, useCameraPermissions, type BarcodeScanningResult} from 'expo-camera';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import {Alert} from '@utils/alert';
import {Colors} from '@theme/index';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {
  approveLinkFromQr, listLinkedDevices, unlinkDevice, onLinkedDevicesChange,
  type LinkedDeviceView,
} from '@/modules/messenger/link/linkEngine';
import {parseLinkQr} from '@bravo/messenger-core/link/linkProtocol';

/**
 * Linked devices (2026-10-12) — use the messenger in a browser, mirrored from
 * this phone. The browser (web.bravosecure.cloud or the ops console) shows a
 * QR code; scanning it here links that browser to this phone. Chats, contacts
 * and new messages then appear in the browser, and what you send there goes
 * out from this phone. Messages stay end-to-end encrypted: the link key only
 * exists in the QR code, this phone and that browser.
 */
export default function LinkedDevicesScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const [devices, setDevices] = useState<LinkedDeviceView[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [perm, requestPerm] = useCameraPermissions();
  const handled = useRef(false);

  const load = useCallback(async () => {
    try {
      setLoadErr(null);
      setDevices(await listLinkedDevices());
    } catch (e) {
      setLoadErr(humanize((e as Error).message));
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));
  useEffect(() => onLinkedDevicesChange(() => { void load(); }), [load]);

  const startScan = useCallback(async () => {
    if (!perm?.granted) {
      const res = await requestPerm();
      if (!res.granted) {
        Alert.alert('Camera needed', 'Allow camera access to scan the code shown in your browser.');
        return;
      }
    }
    handled.current = false;
    setScanning(true);
  }, [perm, requestPerm]);

  const onScanned = useCallback((r: BarcodeScanningResult) => {
    if (handled.current) {return;}
    if (!parseLinkQr(r.data)) {return;} // not our code — keep scanning
    handled.current = true;
    setScanning(false);
    Alert.alert(
      'Link this browser?',
      'Your chats and contacts will appear in that browser, and messages you send there will go out from this phone. Only link a computer you trust.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Link',
          onPress: async () => {
            setBusy(true);
            try {
              const {label} = await approveLinkFromQr(r.data);
              Alert.alert('Linked', `${label} now mirrors this phone. Keep this phone connected to the internet so the browser stays up to date.`);
              await load();
            } catch (e) {
              Alert.alert('Could not link', humanize((e as Error).message));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }, [load]);

  const confirmUnlink = useCallback((d: LinkedDeviceView) => {
    Alert.alert('Log out this browser?', `${d.label} will stop showing your chats.`, [
      {text: 'Cancel', style: 'cancel'},
      {
        text: 'Log out', style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try { await unlinkDevice(d.linkId); await load(); }
          catch (e) { Alert.alert('Could not log out', humanize((e as Error).message)); }
          finally { setBusy(false); }
        },
      },
    ]);
  }, [load]);

  if (scanning) {
    return (
      <View style={[styles.root, {paddingTop: insets.top}]}>
        <StatusBar barStyle="light-content" backgroundColor="#000" />
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => setScanning(false)} activeOpacity={0.7}>
            <Icon name="close" size={20} color="#FFFFFF" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Scan code</Text>
        </View>
        <View style={styles.cameraWrap}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{barcodeTypes: ['qr']}}
            onBarcodeScanned={onScanned}
          />
          <View pointerEvents="none" style={styles.frame} />
        </View>
        <Text style={[styles.hint, {paddingBottom: insets.bottom + 24}]}>
          Point your phone at the QR code in the browser&apos;s Messenger.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7} hitSlop={{top: 6, bottom: 6, left: 6, right: 6}}>
          <Icon name="arrow-left" size={20} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Linked devices</Text>
      </View>
      <ScrollView contentContainerStyle={{paddingBottom: insets.bottom + 40}}>
        <View style={styles.intro}>
          <Icon name="monitor-cellphone" size={40} color="#1E88FF" />
          <Text style={styles.introText}>
            Use Bravo Messenger in a browser. Open Messenger on web.bravosecure.cloud (or the ops console) and scan the code it shows.
          </Text>
        </View>
        <TouchableOpacity style={styles.linkBtn} onPress={startScan} disabled={busy} activeOpacity={0.8}>
          {busy ? <ActivityIndicator color="#FFFFFF" /> : <Icon name="qrcode-scan" size={18} color="#FFFFFF" />}
          <Text style={styles.linkBtnText}>Link a browser</Text>
        </TouchableOpacity>

        <Text style={styles.sectionLabel}>Linked browsers</Text>
        {loadErr ? <Text style={styles.empty}>{loadErr}</Text> : null}
        {devices === null && !loadErr ? <ActivityIndicator style={{marginTop: 12}} color="#1E88FF" /> : null}
        {devices && devices.length === 0 ? <Text style={styles.empty}>No browsers are linked.</Text> : null}
        {devices?.map(d => (
          <View key={d.linkId} style={styles.row}>
            <View style={styles.iconWrap}><Icon name="web" size={20} color="#1E88FF" /></View>
            <View style={{flex: 1}}>
              <Text style={styles.rowTitle}>{d.label}</Text>
              <Text style={styles.rowHint}>
                Active {ago(d.lastSeenAt)}{d.mirrored ? '' : ' · linked from another phone, link it again here'}
              </Text>
            </View>
            <TouchableOpacity onPress={() => confirmUnlink(d)} disabled={busy} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
              <Text style={styles.unlink}>Log out</Text>
            </TouchableOpacity>
          </View>
        ))}
        <Text style={styles.footnote}>
          Messages stay end-to-end encrypted. The browser works through this phone, so keep the phone connected to the internet.
        </Text>
      </ScrollView>
    </View>
  );
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) {return 'just now';}
  const m = Math.round(s / 60);
  if (m < 90) {return `${m} min ago`;}
  const h = Math.round(m / 60);
  if (h < 36) {return `${h} h ago`;}
  return `${Math.round(h / 24)} days ago`;
}

function humanize(code: string): string {
  switch (code) {
    case 'not_a_link_code':  return 'That is not a Bravo link code.';
    case 'link_not_found':   return 'This code has expired or belongs to another account. Reload the browser page and scan the new code.';
    case 'too_many_links':   return 'You can link up to 4 browsers. Log out one first.';
    case 'cannot_link_self': return 'This code cannot be used here.';
    default:                 return code.startsWith('http_') || code === 'Network request failed'
      ? 'Could not reach the server. Check your connection and try again.'
      : code;
  }
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},
  header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)'},
  backBtn: {width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {flex: 1, color: '#FFFFFF', fontSize: 13, fontWeight: '800', letterSpacing: 3, textTransform: 'uppercase'},
  intro: {alignItems: 'center', paddingHorizontal: 28, paddingTop: 28, gap: 14},
  introText: {color: 'rgba(229,233,242,0.75)', fontSize: 13, textAlign: 'center', lineHeight: 19},
  linkBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginHorizontal: 16, marginTop: 22, paddingVertical: 13, borderRadius: 12, backgroundColor: '#1E88FF'},
  linkBtnText: {color: '#FFFFFF', fontSize: 14, fontWeight: '800'},
  sectionLabel: {color: 'rgba(180,188,204,0.45)', fontSize: 9, fontWeight: '800', letterSpacing: 3, textTransform: 'uppercase', paddingHorizontal: 16, paddingTop: 26, paddingBottom: 8},
  row: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.06)'},
  iconWrap: {width: 36, height: 36, borderRadius: 10, backgroundColor: 'rgba(30,136,255,0.12)', borderWidth: 1, borderColor: 'rgba(30,136,255,0.3)', alignItems: 'center', justifyContent: 'center'},
  rowTitle: {color: '#FFFFFF', fontSize: 13, fontWeight: '700'},
  rowHint: {color: 'rgba(229,233,242,0.62)', fontSize: 10.5, marginTop: 2},
  unlink: {color: '#FF6B6B', fontSize: 12, fontWeight: '800'},
  empty: {color: 'rgba(229,233,242,0.55)', fontSize: 12, paddingHorizontal: 16, paddingVertical: 8},
  footnote: {color: 'rgba(229,233,242,0.45)', fontSize: 11, paddingHorizontal: 16, paddingTop: 22, lineHeight: 16},
  cameraWrap: {flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center'},
  frame: {width: 240, height: 240, borderRadius: 18, borderWidth: 3, borderColor: '#1E88FF'},
  hint: {color: '#FFFFFF', fontSize: 13, textAlign: 'center', paddingHorizontal: 28, paddingTop: 18, backgroundColor: '#000'},
}));
