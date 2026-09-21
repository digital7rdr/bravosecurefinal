import React, {useEffect, useState} from 'react';
import {ActivityIndicator, Image, Modal, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {attendanceApi} from '@services/api';
import {OB} from './_obsidian';
import {fmtTime} from './geo';

/**
 * The check-in face photo, for the responsible manager (founder, 2026-09-05).
 *
 * Fetched only when opened — every read is audited server-side and counted on
 * the row, so the modal never prefetches. Rendered from a data URL held in
 * component state and dropped on close; nothing is cached on disk. A purged
 * photo (review decided + shift done, or the hard TTL) reads as "no longer
 * available", not as an error.
 */
export function CheckInPhotoModal({sessionId, memberName, onClose}: {
  sessionId: string | null;
  memberName?: string | null;
  onClose: () => void;
}) {
  const {width} = useWindowDimensions();
  const [state, setState] = useState<{loading: boolean; dataUrl: string | null; capturedAt: string | null; error: string | null}>(
    {loading: false, dataUrl: null, capturedAt: null, error: null});

  useEffect(() => {
    if (!sessionId) {setState({loading: false, dataUrl: null, capturedAt: null, error: null}); return;}
    let alive = true;
    setState({loading: true, dataUrl: null, capturedAt: null, error: null});
    attendanceApi.sessionPhoto(sessionId)
      .then(r => { if (alive) {setState({loading: false, dataUrl: r.data.data_url, capturedAt: r.data.captured_at, error: null});} })
      .catch((e: unknown) => {
        if (!alive) {return;}
        const msg = (e as {response?: {status?: number; data?: {message?: string}}})?.response;
        const gone = msg?.status === 404;
        setState({loading: false, dataUrl: null, capturedAt: null,
          error: gone ? 'This photo is no longer available — it was deleted after the review was decided and the shift ended.'
                      : (msg?.data?.message ?? 'Could not load the photo. Try again.')});
      });
    return () => { alive = false; };
  }, [sessionId]);

  const side = Math.min(width - 48, 420);
  return (
    <Modal visible={sessionId !== null} transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <View style={[s.card, {width: side}]}>
          <View style={s.head}>
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={s.title} numberOfLines={1}>{memberName ?? 'Check-in photo'}</Text>
              <Text style={s.sub} numberOfLines={1}>
                {state.capturedAt ? `Captured ${fmtTime(state.capturedAt)}` : 'Check-in verification photo'}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}>
              <Icon name="close" size={22} color={OB.textDim} />
            </TouchableOpacity>
          </View>
          <View style={[s.frame, {height: side * 1.15}]}>
            {state.loading && <ActivityIndicator color={OB.accentSoft} />}
            {!state.loading && state.dataUrl && (
              <Image source={{uri: state.dataUrl}} style={s.img} resizeMode="cover" accessibilityLabel="Check-in face photo" />
            )}
            {!state.loading && !state.dataUrl && (
              <Text style={s.err}>{state.error ?? 'No photo.'}</Text>
            )}
          </View>
          <Text style={s.note}>Every view of a member&apos;s photo is recorded in the organisation audit log.</Text>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', alignItems: 'center', justifyContent: 'center', padding: 24},
  card: {borderRadius: 18, padding: 14, gap: 10, backgroundColor: '#0C1017', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)'},
  head: {flexDirection: 'row', alignItems: 'center', gap: 10},
  title: {color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 16, letterSpacing: -0.3},
  sub: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 10, letterSpacing: 0.6, marginTop: 2},
  frame: {borderRadius: 12, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.04)', alignItems: 'center', justifyContent: 'center'},
  img: {width: '100%', height: '100%'},
  err: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 12.5, textAlign: 'center', paddingHorizontal: 18, lineHeight: 18},
  note: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 10.5, lineHeight: 14},
}));
