/**
 * 2026-10-31 (owner) — redeems the "Enter with Code" choice made on the
 * pre-auth plan screen (store/pendingJoin), on the first signed-in mount:
 *
 *   - Agent (Secure Services): the provider's roster code is redeemed
 *     (POST /org/invites/redeem); /auth/me is re-read, so the app routes the
 *     new officer into the agent / CPO flow.
 *   - Enterprise User (Workspace): Messenger opens on the Join Workspace
 *     screen with the code filled in (that screen checks it and joins).
 *
 * A code that is refused does not strand the person: a small sheet says why
 * and lets them correct and retry it, or skip.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Modal, View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator} from 'react-native';
import {useAuthStore} from '@store/authStore';
import {pendingJoin, normalizeJoinCode, type PendingJoin} from '@store/pendingJoin';
import {orgInviteApi} from '@services/api';
import {extractMsg} from '@screens/agent/agentFlowHelpers';
import {scaleTextStyles} from '@utils/scaling';

async function openJoinWorkspace(code: string): Promise<boolean> {
  const {waitForShellReady} = require('@navigation/deepLinkReady') as typeof import('@navigation/deepLinkReady');
  if (!(await waitForShellReady({lane: 'messenger'}))) {return false;}
  const {navigationRef} = require('@navigation/navigationRef') as typeof import('@navigation/navigationRef');
  try {
    (navigationRef as unknown as {navigate: (n: string, p?: unknown) => void}).navigate('Main', {
      screen: 'MessengerTab', params: {screen: 'JoinWorkspace', initial: false, params: {code}},
    });
    return true;
  } catch {
    return false;
  }
}

export function PendingJoinHost() {
  const userId = useAuthStore(s => s.user?.id ?? null);
  const [failed, setFailed] = useState<{join: PendingJoin; message: string} | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const ran = useRef<string | null>(null);

  const redeemAgent = useCallback(async (join: PendingJoin): Promise<void> => {
    try {
      await orgInviteApi.redeem(join.code);
      await pendingJoin.clear();
      setFailed(null);
      await useAuthStore.getState().completeAuth().catch(() => undefined);
    } catch (e) {
      setCode(join.code);
      setFailed({join, message: extractMsg(e)});
    }
  }, []);

  useEffect(() => {
    if (!userId || ran.current === userId) {return;}
    ran.current = userId;
    void (async () => {
      const join = await pendingJoin.get();
      if (!join) {return;}
      if (join.kind === 'agent') {
        await redeemAgent(join);
        return;
      }
      if (await openJoinWorkspace(join.code)) {await pendingJoin.clear();}
    })();
  }, [userId, redeemAgent]);

  if (!failed) {return null;}
  const retry = async () => {
    const c = normalizeJoinCode(code);
    if (!c || busy) {return;}
    setBusy(true);
    await pendingJoin.set({kind: failed.join.kind, code: c});
    await redeemAgent({kind: failed.join.kind, code: c});
    setBusy(false);
  };
  const skip = () => { void pendingJoin.clear(); setFailed(null); };

  return (
    <Modal transparent visible animationType="fade" onRequestClose={skip}>
      <View style={s.backdrop}>
        <View style={s.sheet}>
          <Text style={s.title}>Could not join your provider</Text>
          <Text style={s.msg}>{failed.message}</Text>
          <Text style={s.label}>INVITATION CODE</Text>
          <TextInput
            style={s.input}
            value={code}
            onChangeText={t => setCode(normalizeJoinCode(t))}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={32}
            editable={!busy}
            accessibilityLabel="Provider invitation code"
          />
          <TouchableOpacity style={[s.btn, (!code || busy) && {opacity: 0.5}]} onPress={() => { void retry(); }} disabled={!code || busy}
            accessibilityRole="button">
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>TRY AGAIN</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={s.skip} onPress={skip} accessibilityRole="button">
            <Text style={s.skipText}>Not now</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 22},
  sheet: {borderRadius: 18, padding: 20, backgroundColor: '#0F2547', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)'},
  title: {color: '#FFFFFF', fontSize: 17, fontWeight: '700'},
  msg: {color: 'rgba(229,233,242,0.75)', fontSize: 13, lineHeight: 19, marginTop: 8},
  label: {color: 'rgba(180,188,204,0.6)', fontSize: 10, fontWeight: '700', letterSpacing: 1.6, marginTop: 16, marginBottom: 6},
  input: {
    height: 50, borderRadius: 12, paddingHorizontal: 14, color: '#FFFFFF', fontSize: 16, fontWeight: '700', letterSpacing: 2,
    borderWidth: 1, borderColor: 'rgba(30,136,255,0.45)', backgroundColor: 'rgba(255,255,255,0.04)',
  },
  btn: {marginTop: 16, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1E88FF'},
  btnText: {color: '#FFFFFF', fontSize: 13.5, fontWeight: '800', letterSpacing: 1.4},
  skip: {alignItems: 'center', paddingVertical: 12},
  skipText: {color: 'rgba(229,233,242,0.7)', fontSize: 13},
}));
