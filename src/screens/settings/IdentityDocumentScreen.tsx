/**
 * Identity verification (B-867) — the ID / passport every individual account
 * submits: on registration (gate mode, hosted by the root navigator right
 * after the permissions gate, skippable), and from Profile → Identity
 * verification (stack mode) for anyone who skipped it. A Secure booking
 * cannot start until it is on file — the server refuses, and every booking
 * entry routes here (identityGate.ts).
 *
 * The photo never stays on the device and is never shown back here: the
 * server seals it and only Bravo operations can open it (audited). After a
 * submit the screen shows the FACT (type + date), not the image.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, Image, ActivityIndicator,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import {useNavigation} from '@react-navigation/native';
import {Alert} from '@utils/alert';
import {useAuthStore} from '@store/authStore';
import {identityApi, type IdentityDocType, type IdentityDocumentFacts} from '@services/api';
import {UI} from '@components/ui/tokens';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {useBottomInset} from '@hooks/useBottomInset';

type Props = {
  /** Gate mode (registration): no back chevron, "Do this later" is offered,
   *  and a successful submit or a skip hands control back to the root. */
  onDone?: () => void;
};

type Side = 'front' | 'back';
type Picked = {uri: string; width: number; height: number};

const DOC_TYPES: Array<{key: IdentityDocType; label: string; icon: React.ComponentProps<typeof Icon>['name']; hint: string}> = [
  {key: 'national_id', label: 'National ID', icon: 'card-account-details-outline', hint: 'Front, plus the back if it carries details'},
  {key: 'passport', label: 'Passport', icon: 'passport', hint: 'The photo page only'},
];

// Upload budget: the server refuses > 4 MB per side and sniffs the bytes. A
// 1600 px JPEG at 0.8 is ~300-600 KB and every field on a card stays legible.
const MAX_EDGE = 1600;
const QUALITY = 0.8;

async function shrink(uri: string): Promise<Picked> {
  const out = await ImageManipulator.manipulateAsync(
    uri, [{resize: {width: MAX_EDGE}}], {compress: QUALITY, format: ImageManipulator.SaveFormat.JPEG},
  );
  return {uri: out.uri, width: out.width, height: out.height};
}

/** The capture and its shrunk copy both land in the app cache; "nothing is
 *  kept on this phone" is only true once they are gone. Best-effort. */
async function discard(...uris: Array<string | null | undefined>): Promise<void> {
  await Promise.all(uris.filter((u): u is string => !!u).map(u =>
    FileSystem.deleteAsync(u, {idempotent: true}).catch(() => undefined)));
}

function docLabel(t: IdentityDocType | null | undefined): string {
  return t === 'passport' ? 'Passport' : t === 'national_id' ? 'National ID' : 'Document';
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) {return '';}
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {return '';}
  return d.toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'});
}

function Tile({side, picked, busy, disabled, onPress}: {
  side: Side; picked: Picked | null; busy: boolean; disabled: boolean; onPress: (side: Side) => void;
}) {
  return (
    <TouchableOpacity
      style={[s.tile, picked && s.tileFilled]}
      onPress={() => onPress(side)}
      disabled={disabled}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={`${side === 'front' ? 'Front' : 'Back'} of document${picked ? ', captured' : ''}`}
      testID={`identity-tile-${side}`}>
      {picked ? (
        <Image source={{uri: picked.uri}} style={s.tileImg} resizeMode="cover" />
      ) : (
        <View style={s.tileEmpty}>
          {busy ? <ActivityIndicator color={UI.accentSoft} /> : <Icon name="camera-plus-outline" size={26} color={UI.accentSoft} />}
          <Text style={s.tileLabel}>{side === 'front' ? 'Front side' : 'Back side'}</Text>
          <Text style={s.tileHint}>{side === 'back' ? 'Optional' : 'Tap to add a photo'}</Text>
        </View>
      )}
      {picked ? (
        <View style={s.tileRetake}>
          <Icon name="camera-retake-outline" size={14} color={UI.text} />
          <Text style={s.tileRetakeText}>Retake</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

export default function IdentityDocumentScreen({onDone}: Props) {
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const navigation = useNavigation();
  const gateMode = !!onDone;

  const storeStatus = useAuthStore(s => s.user?.identity_document_status);
  const markIdentitySubmitted = useAuthStore(s => s.markIdentitySubmitted);

  const [facts, setFacts] = useState<IdentityDocumentFacts | null>(null);
  const [docType, setDocType] = useState<IdentityDocType>('national_id');
  const [front, setFront] = useState<Picked | null>(null);
  const [back, setBack] = useState<Picked | null>(null);
  const [picking, setPicking] = useState<Side | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // "Replace document" opens the form over an already-submitted state.
  const [replacing, setReplacing] = useState(false);
  // N4 — a synchronous guard for the money-adjacent submit (a double-tap
  // under a lagging JS thread must not upload twice), reset in `finally`.
  const submitRef = useRef(false);

  // Refresh the fact from the server (the store snapshot can be stale — an
  // older app build, or a submit from another device) and heal the store.
  useEffect(() => {
    let alive = true;
    identityApi.status().then(({data}) => {
      if (!alive) {return;}
      setFacts(data);
      if (data.status === 'submitted' && storeStatus !== 'submitted') {markIdentitySubmitted();}
    }).catch(() => undefined);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitted = (facts?.status ?? storeStatus) === 'submitted';
  const showForm = !submitted || replacing;
  const wantsBack = docType === 'national_id';
  const canSubmit = !!front && !submitting;

  const pick = useCallback(async (side: Side, source: 'camera' | 'library') => {
    if (picking) {return;}
    setPicking(side);
    try {
      let res: ImagePicker.ImagePickerResult;
      if (source === 'camera') {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          Alert.alert('Camera needed', 'Allow camera access to photograph your document.');
          return;
        }
        res = await ImagePicker.launchCameraAsync({cameraType: ImagePicker.CameraType.back, quality: 1});
      } else {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          Alert.alert('Photos needed', 'Allow photo access to choose a picture of your document.');
          return;
        }
        res = await ImagePicker.launchImageLibraryAsync({mediaTypes: ['images'], quality: 1});
      }
      if (res.canceled || !res.assets[0]) {return;}
      const shrunk = await shrink(res.assets[0].uri);
      // The full-size capture is not needed once the 1600 px copy exists; a
      // retake also drops the previous shrunk copy.
      void discard(res.assets[0].uri, side === 'front' ? front?.uri : back?.uri);
      if (side === 'front') {setFront(shrunk);} else {setBack(shrunk);}
    } catch {
      Alert.alert('Could not read the photo', 'Please try again.');
    } finally {
      setPicking(null);
    }
  }, [picking, front?.uri, back?.uri]);

  // Whatever was picked but never sent goes with the screen.
  useEffect(() => () => { void discard(front?.uri, back?.uri); }, [front?.uri, back?.uri]);

  const choose = useCallback((side: Side) => {
    Alert.alert(
      side === 'front' ? 'Front of document' : 'Back of document',
      'Photograph it flat, in good light, with all four corners visible.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Choose from library', onPress: () => { void pick(side, 'library'); }},
        {text: 'Take photo', onPress: () => { void pick(side, 'camera'); }},
      ],
    );
  }, [pick]);

  const submit = useCallback(async () => {
    if (submitRef.current || !front) {return;}
    submitRef.current = true;
    setSubmitting(true);
    try {
      const {data} = await identityApi.submit({
        docType,
        frontUri: front.uri,
        backUri: wantsBack ? back?.uri ?? null : null,
      });
      setFacts(data);
      markIdentitySubmitted();
      setReplacing(false);
      void discard(front.uri, back?.uri);
      setFront(null);
      setBack(null);
      if (onDone) {
        onDone();
        return;
      }
      Alert.alert('Identity submitted', `Your ${docLabel(docType).toLowerCase()} is on file. You can now book Secure services.`);
    } catch (e) {
      const err = e as {response?: {status?: number; data?: {message?: unknown}}};
      const body = err?.response?.data;
      const raw = typeof body?.message === 'string' ? body.message : '';
      const msg =
        // 413 = multer's own size cap fired before the service could name a side.
        raw.endsWith('_too_large') || err?.response?.status === 413 ? 'That photo is too large. Take it again a little further from the document.' :
        raw.endsWith('_not_an_image') ? 'That file is not a photo. Choose a JPEG or PNG image.' :
        'Could not upload your document. Check your connection and try again.';
      Alert.alert('Upload failed', msg);
    } finally {
      submitRef.current = false;
      setSubmitting(false);
    }
  }, [front, back, docType, wantsBack, onDone, markIdentitySubmitted]);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg} />
      <View pointerEvents="none" style={s.ambient} />

      <View style={s.header}>
        {gateMode ? (
          <View style={s.headerMark}>
            <Icon name="shield-check-outline" size={20} color={UI.accentSoft} />
          </View>
        ) : (
          <TouchableOpacity
            style={s.back}
            onPress={() => goBackOnce(navigation)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
            <Icon name="chevron-left" size={20} color={UI.text} />
          </TouchableOpacity>
        )}
        <View style={{flex: 1, minWidth: 0}}>
          <Text style={s.headerTitle}>Identity verification</Text>
          <Text style={s.headerSub} numberOfLines={1}>ID OR PASSPORT · REQUIRED TO BOOK</Text>
        </View>
      </View>

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: 140, gap: 16}}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">

        {submitted ? (
          <View style={s.doneCard} testID="identity-submitted-card">
            <View style={s.doneIcon}>
              <Icon name="check-decagram" size={22} color={UI.signal} />
            </View>
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={s.doneTitle}>Document on file</Text>
              <Text style={s.doneSub}>
                {docLabel(facts?.doc_type)}
                {facts?.submitted_at ? ` · submitted ${fmtDate(facts.submitted_at)}` : ''}
              </Text>
              <Text style={s.doneNote}>Secure bookings are open for this account.</Text>
            </View>
            {!replacing ? (
              <TouchableOpacity style={s.replaceBtn} onPress={() => setReplacing(true)} activeOpacity={0.8} accessibilityRole="button">
                <Text style={s.replaceText}>Replace</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : (
          <View style={s.introCard}>
            <Text style={s.introTitle}>Verify who is booking</Text>
            <Text style={s.introBody}>
              Every Bravo Secure client submits a government ID or passport once. It lets our operations team
              confirm the person a protection team is meeting — and it unlocks Secure bookings on this account.
            </Text>
          </View>
        )}

        {showForm ? (
          <>
            <Text style={s.sectionLabel}>DOCUMENT TYPE</Text>
            <View style={s.chips}>
              {DOC_TYPES.map(t => {
                const on = t.key === docType;
                return (
                  <TouchableOpacity
                    key={t.key}
                    style={[s.chip, on && s.chipOn]}
                    onPress={() => { setDocType(t.key); if (t.key === 'passport') {setBack(null);} }}
                    activeOpacity={0.85}
                    accessibilityRole="radio"
                    accessibilityState={{selected: on}}
                    testID={`identity-type-${t.key}`}>
                    <Icon name={t.icon} size={18} color={on ? UI.accentSoft : UI.textMute} />
                    <View style={{flex: 1, minWidth: 0}}>
                      <Text style={[s.chipLabel, on && s.chipLabelOn]}>{t.label}</Text>
                      <Text style={s.chipHint} numberOfLines={2}>{t.hint}</Text>
                    </View>
                    <View style={[s.radio, on && s.radioOn]}>{on ? <View style={s.radioDot} /> : null}</View>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={s.sectionLabel}>PHOTOS</Text>
            <View style={s.tiles}>
              <Tile side="front" picked={front} busy={picking === 'front'} disabled={!!picking || submitting} onPress={choose} />
              {wantsBack ? <Tile side="back" picked={back} busy={picking === 'back'} disabled={!!picking || submitting} onPress={choose} /> : null}
            </View>

            <View style={s.note}>
              <Icon name="lock-outline" size={13} color={UI.textMute} style={{marginTop: 2}} />
              <Text style={s.noteText}>
                Sealed on Bravo's servers and opened only by Bravo operations to verify a booking. Nothing is
                kept on this phone, and it is never shared with a protection team.
              </Text>
            </View>
          </>
        ) : null}
      </ScrollView>

      <LinearGradient
        colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
        locations={[0, 0.5]}
        style={[s.ctaWrap, {paddingBottom: bottomPad(12)}]}>
        {showForm ? (
          <TouchableOpacity
            activeOpacity={0.9}
            onPress={() => { void submit(); }}
            disabled={!canSubmit}
            accessibilityRole="button"
            accessibilityState={{disabled: !canSubmit}}
            testID="identity-submit">
            <LinearGradient
              colors={['#6E9BF5', UI.accent, UI.accentDeep]}
              locations={[0, 0.55, 1]}
              start={{x: 0, y: 0}}
              end={{x: 0, y: 1}}
              style={[s.cta, !canSubmit && s.ctaDisabled]}>
              {submitting ? <ActivityIndicator color="#fff" /> : (
                <>
                  <Text style={s.ctaText}>{submitted ? 'Replace document' : 'Submit for verification'}</Text>
                  <Icon name="shield-check" size={19} color="#fff" importantForAccessibility="no" />
                </>
              )}
            </LinearGradient>
          </TouchableOpacity>
        ) : gateMode ? (
          <TouchableOpacity activeOpacity={0.9} onPress={onDone} accessibilityRole="button">
            <LinearGradient colors={['#6E9BF5', UI.accent, UI.accentDeep]} style={s.cta}>
              <Text style={s.ctaText}>Continue</Text>
              <Icon name="arrow-right" size={19} color="#fff" importantForAccessibility="no" />
            </LinearGradient>
          </TouchableOpacity>
        ) : null}
        {gateMode && !submitted ? (
          <TouchableOpacity onPress={onDone} activeOpacity={0.7} style={s.skip} accessibilityRole="button" testID="identity-skip">
            <Text style={s.skipText}>Do this later — bookings stay locked until then</Text>
          </TouchableOpacity>
        ) : null}
        {!gateMode && replacing ? (
          <TouchableOpacity onPress={() => { setReplacing(false); setFront(null); setBack(null); }} activeOpacity={0.7} style={s.skip} accessibilityRole="button">
            <Text style={s.skipText}>Keep the document on file</Text>
          </TouchableOpacity>
        ) : null}
      </LinearGradient>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: UI.bg, overflow: 'hidden'},
  ambient: {
    position: 'absolute', top: -100, alignSelf: 'center',
    width: 460, height: 280, borderRadius: 230, backgroundColor: 'rgba(91,141,239,0.07)',
  },
  header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12},
  back: {width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: UI.surface, borderWidth: 1, borderColor: UI.hair},
  headerMark: {width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)'},
  headerTitle: {fontFamily: UI.fSemi, fontSize: 17, color: UI.text, letterSpacing: -0.2},
  headerSub: {fontFamily: UI.fSans, fontSize: 10.5, letterSpacing: 1.2, color: UI.textMute, marginTop: 2},

  introCard: {borderRadius: 16, borderWidth: 1, borderColor: UI.hair, backgroundColor: UI.surface, padding: 16, gap: 6},
  introTitle: {fontFamily: UI.fSemi, fontSize: 15, color: UI.text},
  introBody: {fontFamily: UI.fSans, fontSize: 13, lineHeight: 19, color: UI.textDim},

  doneCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 16, borderWidth: 1, borderColor: 'rgba(74,222,128,0.28)', backgroundColor: 'rgba(20,36,30,0.72)', padding: 14,
  },
  doneIcon: {width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(74,222,128,0.12)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.3)'},
  doneTitle: {fontFamily: UI.fSemi, fontSize: 14.5, color: UI.text},
  doneSub: {fontFamily: UI.fSans, fontSize: 12, color: UI.textDim, marginTop: 2},
  doneNote: {fontFamily: UI.fSans, fontSize: 11.5, color: UI.signal, marginTop: 4},
  replaceBtn: {paddingHorizontal: 12, paddingVertical: 8, borderRadius: 100, backgroundColor: 'rgba(91,141,239,0.08)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.34)'},
  replaceText: {fontFamily: UI.fSemi, fontSize: 12, color: UI.accentSoft},

  sectionLabel: {fontFamily: UI.fBold, fontSize: 10.5, letterSpacing: 1.2, color: UI.textMute, marginLeft: 4, marginTop: 4},
  chips: {gap: 10},
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 16, borderWidth: 1, borderColor: UI.hair, backgroundColor: UI.surface, padding: 14,
  },
  chipOn: {borderColor: 'rgba(91,141,239,0.55)', backgroundColor: 'rgba(91,141,239,0.08)'},
  chipLabel: {fontFamily: UI.fSemi, fontSize: 14, color: UI.textDim},
  chipLabelOn: {color: UI.text},
  chipHint: {fontFamily: UI.fSans, fontSize: 11.5, color: UI.textMute, marginTop: 2},
  radio: {width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center'},
  radioOn: {borderColor: UI.accent, backgroundColor: UI.accent},
  radioDot: {width: 7, height: 7, borderRadius: 4, backgroundColor: '#fff'},

  tiles: {flexDirection: 'row', gap: 12},
  tile: {
    // aspectRatio for the usual case; the minHeight floor keeps icon + label +
    // hint inside the tile at 320 dp and fontScale 1.3 (two tiles ≈ 134 dp wide).
    flex: 1, minWidth: 0, aspectRatio: 1.35, minHeight: 132, borderRadius: 16, overflow: 'hidden',
    borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(91,141,239,0.4)', backgroundColor: 'rgba(91,141,239,0.05)',
  },
  tileFilled: {borderStyle: 'solid', borderColor: 'rgba(74,222,128,0.4)'},
  tileImg: {width: '100%', height: '100%'},
  tileEmpty: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, padding: 10},
  tileLabel: {fontFamily: UI.fSemi, fontSize: 13, color: UI.text},
  tileHint: {fontFamily: UI.fSans, fontSize: 11, color: UI.textMute, textAlign: 'center'},
  tileRetake: {
    position: 'absolute', right: 8, bottom: 8, flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 9, paddingVertical: 5, borderRadius: 100, backgroundColor: 'rgba(7,9,13,0.78)', borderWidth: 1, borderColor: UI.hair,
  },
  tileRetakeText: {fontFamily: UI.fSemi, fontSize: 11, color: UI.text},

  note: {flexDirection: 'row', gap: 8, paddingHorizontal: 4},
  noteText: {flex: 1, fontFamily: UI.fSans, fontSize: 11.5, lineHeight: 16, color: UI.textMute},

  ctaWrap: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 28, gap: 10},
  cta: {height: 54, borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8},
  ctaDisabled: {opacity: 0.4},
  ctaText: {fontFamily: UI.fBold, fontSize: 15, color: '#fff', letterSpacing: 0.2},
  skip: {alignSelf: 'center', paddingVertical: 6, paddingHorizontal: 12},
  skipText: {fontFamily: UI.fSans, fontSize: 12.5, color: UI.textMute, textAlign: 'center'},
}));
