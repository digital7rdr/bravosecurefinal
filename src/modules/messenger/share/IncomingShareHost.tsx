/**
 * "Share to Bravo" (2026-10-13) — when another app shares a screenshot, photo,
 * file or text to Bravo, this sheet asks "Send to…" (the same people + groups
 * list the in-chat Forward uses) and opens that chat with the items in its
 * review tray, so the user can add a caption and send. Android only; mounted
 * once at the navigation root while signed in.
 *
 * The picker (ChatScreen's ForwardList) is required LAZILY: the chat screen's
 * module graph is large, and this host renders nothing until a share arrives.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {AppState, Modal, Platform, Pressable, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {navigationRef} from '@navigation/navigationRef';
import {navigateToMessengerScreen} from '@navigation/messengerDeepLink';
import {useMessengerStore} from '../store/messengerStore';
import {takePendingShare, onShareIntent, discardShareFiles, describeShare, type IncomingShare} from './incomingShare';

type ForwardListType = (p: {currentConvId: string; onPick: (id: string) => void; header?: React.ReactElement | null; listMaxHeight?: number | null}) => React.JSX.Element;

export function IncomingShareHost(): React.JSX.Element | null {
  const [share, setShare] = useState<IncomingShare | null>(null);

  const check = useCallback(async () => {
    const s = await takePendingShare();
    if (s) {setShare(s);}
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') {return undefined;}
    void check();
    const off = onShareIntent(() => { void check(); });
    const sub = AppState.addEventListener('change', st => { if (st === 'active') {void check();} });
    return () => { off(); sub.remove(); };
  }, [check]);

  const cancel = useCallback(() => {
    setShare(null);
    void discardShareFiles();
  }, []);

  const pick = useCallback((conversationId: string) => {
    const s = share;
    setShare(null);
    if (!s) {return;}
    const conv = useMessengerStore.getState().conversations[conversationId];
    const ok = navigateToMessengerScreen(navigationRef as never, 'Chat', {
      conversationId,
      name:    conv?.name ?? '',
      isGroup: conv?.type === 'group',
      ...(s.items.length ? {sharedAssets: s.items} : {}),
      ...(s.text ? {draft: s.text} : {}),
    }, {initial: false});
    if (!ok) {void discardShareFiles();}
  }, [share]);

  if (!share) {return null;}
  const {ForwardList} = require('@screens/messenger/ChatScreen') as {ForwardList: ForwardListType};

  return (
    <Modal visible transparent animationType="slide" onRequestClose={cancel}>
      <Pressable style={styles.backdrop} onPress={cancel}>
        <Pressable style={styles.sheet}>
          <Text style={styles.title}>Send to…</Text>
          <Text style={styles.sub}>{describeShare(share)} · end-to-end encrypted</Text>
          <ForwardList currentConvId="" onPick={pick} listMaxHeight={420} />
          <TouchableOpacity style={styles.cancel} onPress={cancel} activeOpacity={0.7} accessibilityRole="button">
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end'},
  sheet: {backgroundColor: '#0B1A33', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 16, paddingBottom: 24, maxHeight: '80%'},
  title: {color: '#FFFFFF', fontSize: 16, fontWeight: '800', paddingHorizontal: 20},
  sub: {color: 'rgba(229,233,242,0.62)', fontSize: 12, paddingHorizontal: 20, marginTop: 4, marginBottom: 8},
  cancel: {marginTop: 8, marginHorizontal: 20, paddingVertical: 12, alignItems: 'center', borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.06)'},
  cancelText: {color: '#FFFFFF', fontSize: 14, fontWeight: '700'},
});
