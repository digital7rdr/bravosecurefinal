/**
 * Messenger → Contacts tab (2026-10-23).
 *
 * Owner: "keep chats and contacts — individual contacts that can be synced
 * from the phone or added manually". Signal-style:
 *  - ADDED BY YOU — contacts typed in here (name + number), kept on this phone
 *    only (keystore), mirrored to linked browsers; editable and removable.
 *    A number not on Bravo yet stays listed with an Invite button.
 *  - FROM YOUR PHONE — address-book contacts who are on Bravo.
 * Tap a contact to message them; the phone icon calls. The header also holds
 * "Join group" (scan a group QR code / paste an invite link).
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, SectionList, Modal, ActivityIndicator, Share,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import {Colors} from '@theme/index';
import {Alert} from '@utils/alert';
import {scaleTextStyles} from '@utils/scaling';
import {useKeyboardOverlap} from '@hooks/useKeyboardLayout';
import {useAuthStore} from '@store/authStore';
import {UsersHttpClient} from '@bravo/messenger-core';
import {API_BASE_URL} from '@utils/constants';
import {tokenStore} from '@services/api';
import {useDiscoveredContacts} from '@/modules/messenger/contacts/useDiscoveredContacts';
import {filterContacts} from '@/modules/messenger/contacts/contactSearch';
import {
  upsertManualContact, removeManualContact, refreshManualContacts, ContactInputError, CONTACT_NAME_MAX,
  type ManualContact,
} from '@/modules/messenger/contacts/manualContacts';
import {useManualContacts} from '@/modules/messenger/contacts/useManualContacts';
import {useMessengerStore, resolveDirectConversationIdFromState} from '@/modules/messenger/store';
import {launchCall} from '@/modules/messenger/webrtc/launchCall';
import {openDirectChat} from './openDirectChat';
import {avatarColorFor} from './avatarColors';
import {JoinGroupSheet} from './GroupInviteSheets';

interface Row {
  key:       string;
  name:      string;
  phoneE164: string;
  userId:    string | null;
  manual:    ManualContact | null;
  /** For filterContacts. */
  localName: string;
  displayName: string;
}

const BLUE = '#1E88FF';

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase() || '#';
}

export function ContactsBody({bottomPad = 0, onExit, exitLabel}: {
  bottomPad?: number;
  onExit?: () => void;
  exitLabel?: string;
}): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<MessengerStackParamList>>();
  const keyboardOverlap = useKeyboardOverlap();
  const me = useAuthStore(s => s.user);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{id: string | null; name: string; phone: string} | null>(null);
  const [saveToPhone, setSaveToPhone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [joinOpen, setJoinOpen] = useState(false);

  const usersClient = useMemo(() => new UsersHttpClient({
    baseUrl: API_BASE_URL,
    getToken: () => tokenStore.get(),
    refreshToken: () => require('@/services/api').refreshAccessTokenShared() as Promise<void>,
  }), []);
  const lookup = useCallback((phones: string[]) => usersClient.lookup(phones), [usersClient]);

  const manual = useManualContacts();
  const {permission, loading, matches, refresh} = useDiscoveredContacts({
    users: usersClient, ownPhoneE164: me?.phone_e164 ?? null, enabled: true,
  });

  // People join Bravo after being saved: look the saved numbers up again.
  useEffect(() => { void refreshManualContacts(lookup); }, [lookup]);

  const sections = useMemo(() => {
    const manualRows: Row[] = manual.map(m => ({
      key: `m:${m.id}`, name: m.name, phoneE164: m.phoneE164, userId: m.userId, manual: m,
      localName: m.name, displayName: m.name,
    })).sort((a, b) => a.name.localeCompare(b.name));
    const manualUsers = new Set(manual.map(m => m.userId).filter(Boolean));
    const phoneRows: Row[] = matches.filter(d => !manualUsers.has(d.userId)).map(d => ({
      key: `p:${d.userId}`, name: d.localName || d.displayName, phoneE164: d.phoneE164, userId: d.userId, manual: null,
      localName: d.localName, displayName: d.displayName,
    }));
    const out: Array<{title: string; data: Row[]}> = [];
    const a = filterContacts(manualRows, query);
    const b = filterContacts(phoneRows, query);
    if (a.length) {out.push({title: `Added by you · ${a.length}`, data: a});}
    if (b.length) {out.push({title: `From your phone · ${b.length}`, data: b});}
    return out;
  }, [manual, matches, query]);

  const openChat = useCallback((r: Row) => {
    if (!r.userId) {return;}
    openDirectChat(navigation, {userId: r.userId, name: r.name});
  }, [navigation]);

  const call = useCallback((r: Row) => {
    if (!r.userId) {return;}
    const st = useMessengerStore.getState();
    const conversationId = resolveDirectConversationIdFromState(st, r.userId);
    if (!st.conversations[conversationId]) {
      st.upsertConversation({
        id: conversationId, type: 'direct', name: r.name, name_source: r.manual ? 'custom' : 'contact',
        participants: [me?.id ?? 'self', r.userId], unread_count: 0, is_muted: false,
        created_at: new Date().toISOString(), peer: {userId: r.userId, deviceId: 1}, session_state: 'fresh',
      });
    }
    launchCall(navigation as never, {conversationId, callType: 'voice'});
  }, [navigation, me?.id]);

  const invite = useCallback(async (r: Row) => {
    const inviter = me?.full_name ? `${me.full_name} ` : '';
    try {
      await Share.share({message: `${inviter}invited you to Bravo Secure — private, end-to-end encrypted messaging & calls. Get the app: https://bravosecure.com/get`});
    } catch { /* dismissed */ }
    void r;
  }, [me?.full_name]);

  const manage = useCallback((r: Row) => {
    const m = r.manual;
    if (!m) {return;}
    Alert.alert(m.name, m.phoneE164, [
      {text: 'Edit', onPress: () => { setFormErr(null); setSaveToPhone(false); setEditing({id: m.id, name: m.name, phone: m.phoneE164}); }},
      {text: 'Remove', style: 'destructive', onPress: () => {
        Alert.alert('Remove contact?', `${m.name} is removed from your Bravo contacts. Your chats with them stay.`, [
          {text: 'Cancel', style: 'cancel'},
          {text: 'Remove', style: 'destructive', onPress: () => { void removeManualContact(m.id); }},
        ]);
      }},
      {text: 'Cancel', style: 'cancel'},
    ]);
  }, []);

  const save = useCallback(async () => {
    if (!editing || busy) {return;}
    setBusy(true); setFormErr(null);
    try {
      const prev = editing.id ? manual.find(x => x.id === editing.id) : null;
      // Changing the number of an existing entry replaces it.
      const saved = await upsertManualContact({name: editing.name, phone: editing.phone}, {ownPhoneE164: me?.phone_e164 ?? null, lookup});
      if (prev && prev.id !== saved.id) {await removeManualContact(prev.id);}
      if (saveToPhone) {
        try {
          // Lazy: expo-contacts is native and only needed for this one action.
          const {presentSaveContact} = require('@/modules/messenger/contacts/savedContacts') as typeof import('@/modules/messenger/contacts/savedContacts');
          await presentSaveContact({displayName: saved.name, phoneE164: saved.phoneE164});
        } catch { /* optional */ }
      }
      setEditing(null);
      if (!saved.userId) {
        Alert.alert('Saved', `${saved.name} is not on Bravo yet. You can invite them, and they appear here as soon as they join.`);
      }
    } catch (e) {
      setFormErr(e instanceof ContactInputError ? e.message : 'Could not save the contact. Try again.');
    } finally {
      setBusy(false);
    }
  }, [editing, busy, manual, me?.phone_e164, lookup, saveToPhone]);

  const renderItem = useCallback(({item: r}: {item: Row}) => (
    <TouchableOpacity
      style={styles.row}
      activeOpacity={0.75}
      onPress={() => (r.userId ? openChat(r) : r.manual ? manage(r) : undefined)}
      onLongPress={() => manage(r)}
      accessibilityRole="button"
      accessibilityLabel={r.userId ? `Message ${r.name}` : `${r.name}, not on Bravo yet`}>
      <View style={[styles.avatar, {backgroundColor: avatarColorFor(r.userId ?? r.phoneE164)}]}>
        <Text style={styles.avatarText}>{initials(r.name)}</Text>
      </View>
      <View style={{flex: 1, minWidth: 0}}>
        <Text style={styles.name} numberOfLines={1}>{r.name}</Text>
        <Text style={styles.sub} numberOfLines={1}>{r.userId ? r.phoneE164 : `${r.phoneE164} · not on Bravo yet`}</Text>
      </View>
      {r.userId ? (
        <TouchableOpacity onPress={() => call(r)} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}} accessibilityLabel={`Call ${r.name}`}>
          <Icon name="phone-outline" size={20} color={BLUE} />
        </TouchableOpacity>
      ) : (
        <TouchableOpacity onPress={() => { void invite(r); }} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}} accessibilityLabel={`Invite ${r.name} to Bravo`}>
          <Text style={styles.invite}>Invite</Text>
        </TouchableOpacity>
      )}
      {r.manual && (
        <TouchableOpacity onPress={() => manage(r)} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}} accessibilityLabel={`Edit ${r.name}`} style={{marginLeft: 14}}>
          <Icon name="dots-vertical" size={20} color="rgba(180,188,204,0.6)" />
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  ), [openChat, manage, call, invite]);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        {onExit && (
          <TouchableOpacity onPress={onExit} hitSlop={{top: 8, left: 8, right: 8, bottom: 8}} accessibilityRole="button" accessibilityLabel={exitLabel ?? 'Back'} style={{paddingRight: 12}}>
            <Icon name="arrow-left" size={20} color="#FFFFFF" />
          </TouchableOpacity>
        )}
        <Text style={[styles.headerTitle, {flex: 1}]}>Contacts</Text>
        <TouchableOpacity onPress={() => setJoinOpen(true)} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}} accessibilityRole="button" accessibilityLabel="Join a group with a link or QR code" style={styles.headerBtn}>
          <Icon name="qrcode-scan" size={20} color="#FFFFFF" />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => { setFormErr(null); setSaveToPhone(false); setEditing({id: null, name: '', phone: ''}); }} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}} accessibilityRole="button" accessibilityLabel="Add a contact" style={styles.headerBtn}>
          <Icon name="account-plus-outline" size={22} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      <View style={styles.searchWrap}>
        <Icon name="magnify" size={18} color="rgba(180,188,204,0.55)" />
        <TextInput style={styles.search} value={query} onChangeText={setQuery} placeholder="Search name or number"
          placeholderTextColor="rgba(180,188,204,0.45)" autoCorrect={false} />
      </View>

      {permission === 'denied' && (
        <TouchableOpacity style={styles.permCard} onPress={() => { void refresh(); }} activeOpacity={0.8}>
          <Icon name="contacts-outline" size={18} color={BLUE} />
          <Text style={styles.permText}>Allow access to your contacts to see who is on Bravo. You can still add contacts by hand.</Text>
        </TouchableOpacity>
      )}

      <SectionList
        style={{flex: 1}}
        sections={sections}
        keyExtractor={r => r.key}
        renderItem={renderItem}
        renderSectionHeader={({section}) => <Text style={styles.section}>{section.title}</Text>}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{paddingBottom: insets.bottom + 24 + bottomPad}}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={loading ? <ActivityIndicator style={{marginTop: 40}} color={BLUE} /> : (
          <View style={styles.empty}>
            <Icon name="account-multiple-outline" size={44} color="rgba(180,188,204,0.45)" />
            <Text style={styles.emptyTitle}>{query ? 'No match' : 'No contacts yet'}</Text>
            <Text style={styles.emptyHint}>
              {query ? 'Try another name or number.' : 'Add someone with the + button, or allow contacts to see who from your phone is on Bravo.'}
            </Text>
          </View>
        )}
      />

      <Modal visible={!!editing} transparent animationType="fade" onRequestClose={() => setEditing(null)}>
        <View style={[styles.overlay, {paddingBottom: keyboardOverlap}]}>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{editing?.id ? 'Edit contact' : 'New contact'}</Text>
            <Text style={styles.cardSub}>Saved on this phone and shown in your linked browsers. Bravo does not upload your contacts.</Text>
            <TextInput style={styles.input} value={editing?.name ?? ''} onChangeText={t => setEditing(e => (e ? {...e, name: t} : e))}
              placeholder="Name" placeholderTextColor="rgba(180,188,204,0.45)" maxLength={CONTACT_NAME_MAX} autoFocus />
            <TextInput style={styles.input} value={editing?.phone ?? ''} onChangeText={t => setEditing(e => (e ? {...e, phone: t} : e))}
              placeholder="+971 50 123 4567" placeholderTextColor="rgba(180,188,204,0.45)" keyboardType="phone-pad"
              returnKeyType="done" onSubmitEditing={() => { void save(); }} />
            <TouchableOpacity style={styles.check} onPress={() => setSaveToPhone(v => !v)} activeOpacity={0.8} accessibilityRole="checkbox" accessibilityState={{checked: saveToPhone}}>
              <Icon name={saveToPhone ? 'checkbox-marked' : 'checkbox-blank-outline'} size={20} color={BLUE} />
              <Text style={styles.checkText}>Also save to my phone&apos;s contacts</Text>
            </TouchableOpacity>
            {formErr ? <Text style={styles.err}>{formErr}</Text> : null}
            <View style={styles.cardRow}>
              <TouchableOpacity style={styles.cancel} onPress={() => setEditing(null)} activeOpacity={0.8}>
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.saveBtn, busy && {opacity: 0.5}]} onPress={() => { void save(); }} disabled={busy} activeOpacity={0.85}>
                {busy ? <ActivityIndicator color="#FFF" /> : <Text style={styles.saveText}>Save</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {joinOpen && <JoinGroupSheet onClose={() => setJoinOpen(false)} />}
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1},
  header: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)'},
  headerTitle: {fontSize: 17, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 3, color: '#FFFFFF'},
  headerBtn: {marginLeft: 18},
  searchWrap: {flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginTop: 12, marginBottom: 4, paddingHorizontal: 12, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.06)'},
  search: {flex: 1, color: '#FFFFFF', fontSize: 13.5, paddingVertical: 9},
  permCard: {flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 16, marginTop: 10, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(30,136,255,0.3)', backgroundColor: 'rgba(30,136,255,0.08)'},
  permText: {flex: 1, color: 'rgba(229,233,242,0.8)', fontSize: 12, lineHeight: 17},
  section: {fontSize: 9, fontWeight: '800', letterSpacing: 3, textTransform: 'uppercase', color: 'rgba(180,188,204,0.45)', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8},
  row: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)'},
  avatar: {width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center'},
  avatarText: {color: '#FFF', fontSize: 13, fontWeight: '700'},
  name: {color: '#FFFFFF', fontSize: 14, fontWeight: '700'},
  sub: {color: 'rgba(229,233,242,0.6)', fontSize: 11.5, marginTop: 2},
  invite: {color: BLUE, fontSize: 12.5, fontWeight: '800'},
  empty: {alignItems: 'center', paddingVertical: 64, paddingHorizontal: 32, gap: 10},
  emptyTitle: {color: '#FFFFFF', fontSize: 14, fontWeight: '700', marginTop: 6},
  emptyHint: {color: 'rgba(229,233,242,0.62)', fontSize: 11.5, textAlign: 'center', lineHeight: 16, maxWidth: 300},
  overlay: {flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', alignItems: 'center', justifyContent: 'center', padding: 20},
  card: {width: '100%', maxWidth: 380, borderRadius: 18, backgroundColor: Colors.background, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', padding: 20},
  cardTitle: {color: '#FFFFFF', fontSize: 16, fontWeight: '800'},
  cardSub: {color: 'rgba(229,233,242,0.65)', fontSize: 12, lineHeight: 17, marginTop: 6, marginBottom: 6},
  input: {marginTop: 10, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', color: '#FFFFFF', paddingHorizontal: 12, paddingVertical: 10, fontSize: 14},
  check: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14},
  checkText: {color: 'rgba(229,233,242,0.85)', fontSize: 12.5},
  err: {color: '#FF6B6B', fontSize: 12, marginTop: 10},
  cardRow: {flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 18},
  cancel: {paddingVertical: 10, paddingHorizontal: 16},
  cancelText: {color: 'rgba(229,233,242,0.8)', fontSize: 13.5, fontWeight: '700'},
  saveBtn: {minWidth: 90, alignItems: 'center', paddingVertical: 10, paddingHorizontal: 18, borderRadius: 10, backgroundColor: BLUE},
  saveText: {color: '#FFFFFF', fontSize: 13.5, fontWeight: '800'},
}));
