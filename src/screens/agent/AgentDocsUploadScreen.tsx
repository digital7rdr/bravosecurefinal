/**
 * 06 / 09 — Document Upload
 *
 * 6 document slots (3 REQ, 3 OPT). Each row shows file icon, title,
 * req/opt badge, and a DONE or UPLOAD state badge.
 */
import React, {useEffect, useState} from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StatusBar, StyleSheet, BackHandler,
  Modal, Image, Linking, useWindowDimensions,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import * as DocumentPicker from 'expo-document-picker';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {Colors} from '@theme/colors';
import {BravoFont} from '@theme/bravo';
import {NavHeader, CTAButton, BRAND} from './_shared';
import {agentApi} from '@services/api';
import {extractMsg, prevStepFor} from './agentFlowHelpers';
import {scaleTextStyles} from '@utils/scaling';
import {fmtDateUtc} from '@utils/datetime';
import {useAuthStore} from '@store/authStore';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

type DocState = 'done' | 'upload';
type DocSlot  = 'sia' | 'passport' | 'insurance' | 'dbs' | 'firstaid' | 'cv';
interface DocRow {
  key: DocSlot; icon: string; title: string; req: 'REQ' | 'OPT'; state: DocState;
  fileUrl: string | null; uploadedAt: string | null; reviewedAt: string | null;
}

const IMAGE_EXT = /\.(jpe?g|png|webp|heic)$/i;
const urlPath = (u: string) => u.split(/[?#]/)[0];
const isImageUrl = (u: string) => IMAGE_EXT.test(urlPath(u));
const fileNameOf = (u: string) => {
  const last = urlPath(u).split('/').pop() ?? '';
  try { return decodeURIComponent(last); } catch { return last; }
};

const META: Record<DocSlot, {icon: string; title: string; req: 'REQ' | 'OPT'}> = {
  sia:       {icon: 'certificate-outline',           title: 'Security License / CPO Profile',   req: 'REQ'},
  passport:  {icon: 'card-account-details-outline',  title: 'Passport / National ID',           req: 'REQ'},
  insurance: {icon: 'file-document-outline',         title: 'Professional Indemnity Insurance', req: 'REQ'},
  dbs:       {icon: 'account-search-outline',        title: 'Police Clearance / DBS Enhanced',  req: 'REQ'},
  firstaid:  {icon: 'medical-bag',                   title: 'First Aid Certificate',            req: 'OPT'},
  cv:        {icon: 'file-document-multiple-outline',title: 'Professional CV / Résumé',         req: 'OPT'},
};

const EMPTY_DOCS: DocRow[] = (Object.keys(META) as DocSlot[]).map(k => ({
  key: k, icon: META[k].icon, title: META[k].title, req: META[k].req, state: 'upload',
  fileUrl: null, uploadedAt: null, reviewedAt: null,
}));

export default function AgentDocsUploadScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const signOut = useAuthStore(s => s.signOut);
  const {height: winHeight} = useWindowDimensions();
  const [docs, setDocs] = useState<DocRow[]>(EMPTY_DOCS);
  const [busy, setBusy] = useState<DocSlot | 'submit' | null>(null);
  const [sheet, setSheet] = useState<DocSlot | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  // NAV N4 — a `disabled={busy}` alone loses the second half of a double tap;
  // the guard has to be synchronous and reset in `finally`.
  const mutatingRef = React.useRef(false);

  const [agentStatus, setAgentStatus] = useState<string | null>(null);

  // Pull real upload state from the server.
  const refresh = async () => {
    try {
      const {data} = await agentApi.getMe();
      setAgentStatus(data.agent.status);
      // Already submitted? This screen must not re-appear as a second
      // "submitted"-looking page (the ping-pong the CPO hit). The review is
      // terminal until ops decides, so land straight on the approval screen.
      const st = data.agent.status;
      if (st === 'SUBMITTED' || st === 'UNDER_REVIEW') {
        navigation.replace('AgentAdminApproval');
        return;
      }
      setDocs(EMPTY_DOCS.map(d => {
        const server = data.documents.find(x => x.slot === d.key);
        return {
          ...d,
          state: server?.state === 'done' ? 'done' : 'upload',
          fileUrl: server?.file_url ?? null,
          uploadedAt: server?.uploaded_at ?? null,
          reviewedAt: server?.reviewed_at ?? null,
        };
      }));
    } catch { /* keep defaults */ }
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { setPreviewFailed(false); setPreviewLoaded(false); }, [sheet]);

  const done = docs.filter(d => d.state === 'done').length;
  const total = docs.length;
  const requiredDone = docs.filter(d => d.req === 'REQ' && d.state === 'done').length;
  const requiredTotal = docs.filter(d => d.req === 'REQ').length;
  const canSubmit = requiredDone === requiredTotal;
  // Once submitted / under review, don't show the submit button — just
  // let the agent update individual docs and go back to approval.
  const alreadySubmitted = agentStatus === 'SUBMITTED' || agentStatus === 'UNDER_REVIEW' ||
    agentStatus === 'APPROVED' || agentStatus === 'ACTIVE';

  const openDoc = docs.find(d => d.key === sheet) ?? null;
  const docsLocked = agentStatus === 'APPROVED' || agentStatus === 'ACTIVE';

  const pickFile = () => DocumentPicker.getDocumentAsync({
    type: ['image/*', 'application/pdf'],
    copyToCacheDirectory: true,
  });

  const handleUpload = async (slot: DocSlot) => {
    if (busy) {return;}
    // B-823 — an uploaded slot is no longer a dead end: show what's on file so
    // the agent can check it, replace it, or take it back.
    if (docs.find(d => d.key === slot)?.state === 'done') {setSheet(slot); return;}
    setBusy(slot);
    try {
      const res = await pickFile();
      if (res.canceled || !res.assets?.[0]) {return;}
      const file = res.assets[0];
      // Push the file bytes to the auth-service so it lands on disk and
      // gets a real URL the ops-console can render.
      const fileUrl = await agentApi.uploadFile({
        uri:  file.uri,
        name: file.name ?? `${slot}-${Date.now()}`,
        type: file.mimeType ?? 'application/octet-stream',
      });
      await agentApi.uploadDoc({
        slot,
        title: META[slot].title,   // always the human label, not the raw filename
        file_url: fileUrl,
      });
      await refresh();
    } catch (e) {
      Alert.alert('Upload failed', extractMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const removalMsg = (e: unknown) => {
    const msg = extractMsg(e);
    return msg.includes('document_locked')
      ? 'This document has been verified. Contact Bravo ops to replace it.'
      : msg;
  };

  const doRemove = async (slot: DocSlot) => {
    setBusy(slot);
    try {
      await agentApi.deleteDoc(slot);
      await refresh();
      setSheet(null);
    } catch (e) {
      Alert.alert('Could not remove', removalMsg(e));
    } finally {
      mutatingRef.current = false;
      setBusy(null);
    }
  };

  const onRemove = () => {
    if (!openDoc || mutatingRef.current) {return;}
    mutatingRef.current = true;
    const slot = openDoc.key;
    Alert.alert(
      'Remove this document?',
      'You can upload a new one afterwards.',
      [
        {text: 'Cancel', style: 'cancel', onPress: () => { mutatingRef.current = false; }},
        {text: 'Remove', style: 'destructive', onPress: () => { void doRemove(slot); }},
      ],
      {onDismiss: () => { mutatingRef.current = false; }},
    );
  };

  // Pick FIRST so a cancelled picker leaves the slot exactly as it was; only a
  // chosen file is worth emptying the slot for.
  const doReplace = async (slot: DocSlot) => {
    setBusy(slot);
    let removed = false;
    try {
      const res = await pickFile();
      if (res.canceled || !res.assets?.[0]) {return;}
      const file = res.assets[0];
      await agentApi.deleteDoc(slot);
      removed = true;
      const fileUrl = await agentApi.uploadFile({
        uri:  file.uri,
        name: file.name ?? `${slot}-${Date.now()}`,
        type: file.mimeType ?? 'application/octet-stream',
      });
      await agentApi.uploadDoc({slot, title: META[slot].title, file_url: fileUrl});
      await refresh();
    } catch (e) {
      if (removed) {
        Alert.alert('Upload failed', 'The slot is now empty — upload again.');
        await refresh();
      } else {
        Alert.alert('Could not replace', removalMsg(e));
      }
    } finally {
      mutatingRef.current = false;
      setBusy(null);
    }
  };

  const onReplace = () => {
    if (!openDoc || mutatingRef.current) {return;}
    mutatingRef.current = true;
    const slot = openDoc.key;
    setSheet(null);
    void doReplace(slot);
  };

  const openFile = (url: string) => {
    void Linking.openURL(url).catch(() => {
      Alert.alert('Could not open', 'No app on this device can open this file.');
    });
  };

  const onSubmit = async () => {
    if (!canSubmit || busy) {return;}
    setBusy('submit');
    try {
      await agentApi.submit();
      navigation.navigate('AgentAdminApproval');
    } catch (e) {
      Alert.alert('Could not submit', extractMsg(e));
    } finally {
      setBusy(null);
    }
  };

  // B-98a — resume/KYC entry replaces the route, leaving nothing to pop, and
  // goBack() is then a silent release no-op (the dead 3/4 chevron). Fall back
  // to the linear previous step; replace keeps the resume stack shallow.
  //
  // B-199 — but this screen is the FIRST (and only initial) route of
  // CpoOnboardingNavigator for a managed CPO, where the linear previous step
  // (AgentAvailability) is NOT registered — so `replace('AgentAvailability')`
  // was a silent no-op and the chevron looked dead. When the fallback target
  // isn't a real route in THIS stack, the only meaningful "back" is out of
  // onboarding entirely: sign out to the login screen (the same terminal-exit
  // pattern AgentRejectedScreen uses). In the agency wizard the target IS
  // registered, so that path is unchanged.
  const handleBack = () => {
    if (navigation.canGoBack()) {navigation.goBack(); return;}
    const prev = prevStepFor('AgentDocsUpload');
    const routeNames = navigation.getState()?.routeNames ?? [];
    if (prev && routeNames.includes(prev)) {
      // Why the cast: this stack's typed replace() demands a params arg even
      // for param-less routes; the runtime accepts the single-arg form.
      (navigation as unknown as {replace: (name: string) => void}).replace(prev);
      return;
    }
    Alert.alert(
      'Leave verification?',
      "You'll be signed out. Your uploaded documents are saved — sign in again to continue.",
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Sign out', style: 'destructive', onPress: () => { void signOut(); }},
      ],
    );
  };

  // B-98a — hardware back mirrors the header chevron (all three affordances
  // agree: button, gesture, hardware key). Focus-scoped so covered screens
  // don't intercept.
  // NAV-07 (2026-08-26 audit) — read through a ref, matching
  // AgentRegistrationWizardScreen: the []-deps callback froze the FIRST
  // render's handleBack behind a suppressed lint rule.
  const handleBackRef = React.useRef(handleBack);
  handleBackRef.current = handleBack;
  // B-823 — with the document sheet open, back closes the sheet. Without this
  // a back press behind the Modal reaches handleBack and offers to sign out.
  const sheetRef = React.useRef(sheet);
  sheetRef.current = sheet;
  useFocusEffect(React.useCallback(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (sheetRef.current) {setSheet(null); return true;}
      handleBackRef.current();
      return true;
    });
    return () => sub.remove();
  }, []));


  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />
      <NavHeader title="Document Upload" onBack={handleBack} />

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}>

        <View style={s.tickerRow}>
          <View>
            <Text style={s.tickerLabel}>Compliance Pack</Text>
            <Text style={s.tickerSub}>3 required · 3 optional</Text>
          </View>
          <Text style={s.tickerNum}>
            {done}
            <Text style={s.tickerDen}>/{total}</Text>
          </Text>
        </View>

        {docs.map(d => {
          const isDone = d.state === 'done';
          const isBusy = busy === d.key;
          // B-823 — the chevron is the VISUAL half of the row's own
          // "view or replace" label, so it stays out of the a11y tree.
          // Why a line comment: `'image/*'` above opens an unterminated `/*`
          // for cpoOnboardingBack's stripper — a block comment here erases
          // the rest of the file for that scan.
          return (
            <TouchableOpacity
              key={d.key}
              testID={`agent-doc-row-${d.key}`}
              accessibilityRole="button"
              accessibilityLabel={
                isDone ? `${d.title}, uploaded — view or replace` : `${d.title}, tap to upload`
              }
              onPress={() => { void handleUpload(d.key); }}
              disabled={isBusy}
              activeOpacity={0.85}
              style={[s.row, isDone && s.rowDone]}>
              <View style={[s.ic, isDone && s.icDone]}>
                <Icon
                  name={d.icon as React.ComponentProps<typeof Icon>['name']}
                  size={14}
                  color={isDone ? Colors.primary : Colors.textSecondary}
                />
              </View>
              <View style={s.body}>
                <View style={s.titleRow}>
                  <Text style={s.title} numberOfLines={1}>{d.title}</Text>
                  <View style={[s.reqBadge, d.req === 'REQ' ? s.reqNeed : s.reqOpt]}>
                    <Text style={[s.reqText, d.req === 'REQ' ? s.reqTextNeed : s.reqTextOpt]}>
                      {d.req}
                    </Text>
                  </View>
                </View>
              </View>
              <View style={[s.state, isDone ? s.stateOk : s.stateUp]}>
                <Text style={[s.stateText, isDone ? s.stateTextOk : s.stateTextUp]}>
                  {isBusy ? '…' : isDone ? 'DONE' : 'UPLOAD'}
                </Text>
              </View>
              {isDone ? (
                <Icon
                  testID={`agent-doc-chevron-${d.key}`}
                  importantForAccessibility="no"
                  name="chevron-right"
                  size={16}
                  color={Colors.textMuted}
                />
              ) : null}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {alreadySubmitted ? (
        <CTAButton
          label="← Back to Approval Status"
          onPress={() => navigation.navigate('AgentAdminApproval')}
          variant="primary"
        />
      ) : (
        <CTAButton
          label={
            busy === 'submit' ? 'Submitting…' :
            canSubmit          ? 'Submit for Admin Review' :
            `${requiredDone}/${requiredTotal} required · finish uploading`
          }
          onPress={() => { void onSubmit(); }}
          variant={canSubmit && busy !== 'submit' ? 'primary' : 'disabled'}
        />
      )}

      <Modal
        visible={!!openDoc}
        transparent
        animationType="slide"
        onRequestClose={() => setSheet(null)}>
        <TouchableOpacity
          style={sh.backdrop}
          activeOpacity={1}
          accessibilityRole="button"
          accessibilityLabel="Close document"
          onPress={() => setSheet(null)}
        />
        {openDoc ? (
          <View testID="agent-doc-sheet" style={[sh.sheet, {paddingBottom: insets.bottom + 12}]}>
            <View style={sh.grabber} />
            <Text style={sh.sheetTitle} numberOfLines={2}>{openDoc.title}</Text>
            <Text style={sh.meta}>{`Uploaded ${fmtDateUtc(openDoc.uploadedAt)}`}</Text>
            {openDoc.reviewedAt ? <Text style={sh.reviewed}>Reviewed by Bravo ops</Text> : null}

            {!openDoc.fileUrl ? (
              <Text style={sh.fallback}>No file on record for this slot.</Text>
            ) : isImageUrl(openDoc.fileUrl) && !previewFailed ? (
              <View style={[sh.previewBox, {height: Math.round(winHeight * 0.45)}]}>
                {previewLoaded ? null : <Text style={sh.fallback}>Loading…</Text>}
                <Image
                  testID="agent-doc-preview-image"
                  source={{uri: openDoc.fileUrl}}
                  resizeMode="contain"
                  onLoadEnd={() => setPreviewLoaded(true)}
                  onError={() => setPreviewFailed(true)}
                  style={sh.previewImage}
                />
              </View>
            ) : (
              <View style={sh.fileCard}>
                <Icon name="file-document-outline" size={22} color={Colors.textSecondary} />
                <Text style={sh.fileName} numberOfLines={2}>{fileNameOf(openDoc.fileUrl)}</Text>
              </View>
            )}

            {openDoc.fileUrl && previewFailed ? (
              <Text style={sh.fallback}>Preview unavailable — open the file instead</Text>
            ) : null}

            {openDoc.fileUrl && (!isImageUrl(openDoc.fileUrl) || previewFailed) ? (
              <TouchableOpacity
                testID="agent-doc-open"
                style={sh.action}
                activeOpacity={0.85}
                accessibilityRole="button"
                onPress={() => openFile(openDoc.fileUrl as string)}>
                <Text style={sh.actionText}>Open document</Text>
              </TouchableOpacity>
            ) : null}

            {docsLocked ? (
              <Text style={sh.lockNote}>Verified documents are changed through Bravo ops.</Text>
            ) : (
              <>
                <TouchableOpacity
                  testID="agent-doc-replace"
                  style={sh.action}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  onPress={onReplace}>
                  <Text style={sh.actionText}>Replace document</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  testID="agent-doc-remove"
                  style={[sh.action, sh.actionDanger]}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  onPress={onRemove}>
                  <Text style={[sh.actionText, sh.actionTextDanger]}>Remove</Text>
                </TouchableOpacity>
              </>
            )}

            <TouchableOpacity
              style={sh.action}
              activeOpacity={0.85}
              accessibilityRole="button"
              onPress={() => setSheet(null)}>
              <Text style={sh.actionText}>Close</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </Modal>
    </View>
  );
}


const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},
  scroll: {padding: 14, paddingBottom: 24, gap: 8},

  tickerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  tickerLabel: {
    fontFamily: BravoFont.bold, fontSize: 11, letterSpacing: 1.5,
    color: Colors.textMuted, textTransform: 'uppercase',
  },
  tickerSub: {fontSize: 10, color: Colors.textMuted, marginTop: 3},
  tickerNum: {
    fontFamily: BravoFont.extraBold, fontSize: 22, letterSpacing: -0.5,
    color: BRAND.acc,
  },
  tickerDen: {color: Colors.textMuted, fontSize: 14, fontWeight: '500'},

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 11, borderRadius: 10,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  rowDone: {
    borderColor: Colors.primary,
    backgroundColor: 'rgba(30,136,255,0.06)',
  },
  ic: {
    width: 30, height: 30, borderRadius: 7,
    backgroundColor: Colors.surfaceOverlay,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    alignItems: 'center', justifyContent: 'center',
  },
  icDone: {borderColor: Colors.primary},
  body: {flex: 1, minWidth: 0},
  titleRow: {flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap'},
  title: {fontFamily: BravoFont.bold, fontSize: 11.5, color: Colors.textPrimary, flexShrink: 1},

  reqBadge: {paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3, borderWidth: 1},
  reqNeed: {
    backgroundColor: 'rgba(213,0,0,0.1)', borderColor: 'rgba(213,0,0,0.3)',
  },
  reqOpt: {backgroundColor: Colors.surfaceOverlay, borderColor: Colors.surfaceBorder},
  reqText: {fontFamily: BravoFont.extraBold, fontSize: 8, letterSpacing: 0.5},
  reqTextNeed: {color: BRAND.err},
  reqTextOpt:  {color: Colors.textMuted},

  state: {paddingHorizontal: 8, paddingVertical: 4, borderRadius: 5, borderWidth: 1},
  stateOk: {
    backgroundColor: 'rgba(0,200,83,0.12)', borderColor: 'rgba(0,200,83,0.3)',
  },
  stateUp: {
    backgroundColor: Colors.surfaceOverlay, borderColor: Colors.borderDefault,
  },
  stateText: {fontFamily: BravoFont.extraBold, fontSize: 9, letterSpacing: 0.8},
  stateTextOk: {color: BRAND.ok},
  stateTextUp: {color: Colors.textSecondary},
}));

const sh = StyleSheet.create(scaleTextStyles({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)'},
  sheet: {
    backgroundColor: Colors.background,
    borderTopLeftRadius: 16, borderTopRightRadius: 16,
    borderTopWidth: 1, borderColor: Colors.surfaceBorder,
    paddingHorizontal: 16, paddingTop: 10, gap: 8,
  },
  grabber: {
    alignSelf: 'center', width: 36, height: 4, borderRadius: 2,
    backgroundColor: Colors.borderDefault, marginBottom: 4,
  },
  sheetTitle: {fontFamily: BravoFont.bold, fontSize: 14, color: Colors.textPrimary},
  meta: {fontSize: 11, color: Colors.textMuted, letterSpacing: 0.2},
  reviewed: {fontSize: 10.5, color: BRAND.ok, letterSpacing: 0.2},

  previewBox: {
    borderRadius: 10, overflow: 'hidden',
    backgroundColor: Colors.surfaceOverlay,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    alignItems: 'center', justifyContent: 'center',
  },
  previewImage: {...StyleSheet.absoluteFillObject},
  fallback: {fontSize: 11, color: Colors.textMuted, textAlign: 'center', paddingVertical: 6},

  fileCard: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 12, borderRadius: 10,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  fileName: {flex: 1, fontSize: 12, color: Colors.textPrimary},

  action: {
    minHeight: 48, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
  },
  actionDanger: {borderColor: 'rgba(213,0,0,0.4)'},
  actionText: {fontFamily: BravoFont.semiBold, fontSize: 12.5, color: Colors.textPrimary},
  actionTextDanger: {color: BRAND.err},
  lockNote: {
    fontSize: 11.5, color: Colors.textSecondary, textAlign: 'center',
    paddingVertical: 12, lineHeight: 17,
  },
}));
