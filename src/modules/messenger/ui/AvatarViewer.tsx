/**
 * Founder 2026-08-01 — full-screen profile-photo viewer. Tapping an avatar
 * (chat-list row, Chat Info header) opens the picture edge-to-edge so the
 * person — or text inside the photo — can actually be identified. View-only:
 * tap anywhere (or the X) to close.
 */
import React, {useEffect, useState} from 'react';
import {View, Text, StyleSheet, Modal, Pressable, Image, TouchableOpacity} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';

export interface AvatarViewTarget {
  uri:  string;
  name: string;
}

/** Initials for the fallback face — the same shape the row's avatar uses. */
function initialsOf(name: string): string {
  return (
    name.split(/[\s@._-]+/).filter(Boolean).map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase()
    || '?'
  );
}

export function AvatarViewer({target, onClose}: {
  target:  AvatarViewTarget | null;
  onClose: () => void;
}) {
  /**
   * B-855 critic round — an avatar URL is a PLAIN public URL and can 403 or 404
   * (a rotated bucket, a deleted file). This used to render an `<Image>` that
   * silently failed, i.e. a full-screen black rectangle with a name under it,
   * which reads as a crash. Now a failure shows the person's initials and a
   * Retry — the `attempt` counter is in the source key so RN cannot serve the
   * failed URL from its own cache.
   *
   * Hooks ABOVE the null guard: React requires the same hooks on every render,
   * and the guard used to be the first statement in the body.
   */
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const uri = target?.uri ?? '';
  // A different photo starts clean — otherwise one broken avatar poisons the
  // viewer for every later one in the same session.
  useEffect(() => { setFailed(false); setAttempt(0); }, [uri]);

  if (!target) {return null;}
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.root} onPress={onClose} accessibilityLabel="Close photo">
        {failed ? (
          <View style={styles.fallback} testID="avatar-viewer-fallback">
            <View style={styles.fallbackFace}>
              <Text style={styles.fallbackInitials}>{initialsOf(target.name)}</Text>
            </View>
            <Text style={styles.fallbackText}>This photo could not be loaded.</Text>
            <TouchableOpacity
              style={styles.retry}
              onPress={() => { setFailed(false); setAttempt(n => n + 1); }}
              accessibilityRole="button"
              accessibilityLabel="Retry loading the photo"
              testID="avatar-viewer-retry">
              <Icon name="refresh" size={15} color="#F2F4F8" />
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <Image
            /**
             * The cache-buster is added ONLY on a retry. Appending it on the
             * first render would rewrite the URL every existing caller passes —
             * and a signed URL whose signature covers the query string breaks
             * the moment you add a parameter to it. First attempt: byte-identical
             * to what this component has always requested.
             */
            source={{uri: attempt === 0
              ? target.uri
              : `${target.uri}${target.uri.includes('?') ? '&' : '?'}_r=${attempt}`}}
            style={styles.photo}
            resizeMode="contain"
            onError={() => setFailed(true)}
            testID="avatar-viewer-image"
          />
        )}
        <View style={styles.captionWrap} pointerEvents="none">
          <Text style={styles.caption} numberOfLines={1}>{target.name}</Text>
        </View>
        <TouchableOpacity
          style={styles.close}
          onPress={onClose}
          hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
          accessibilityRole="button"
          accessibilityLabel="Close">
          <Icon name="close" size={20} color="#F2F4F8" />
        </TouchableOpacity>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: 'rgba(0,0,0,0.96)', alignItems: 'center', justifyContent: 'center'},
  photo: {width: '100%', height: '78%'},
  fallback: {alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 32},
  fallbackFace: {
    width: 104, height: 104, borderRadius: 52, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
  },
  fallbackInitials: {color: '#F2F4F8', fontSize: 34, fontWeight: '700', letterSpacing: 0.5},
  fallbackText: {color: 'rgba(242,244,248,0.7)', fontSize: 13.5, textAlign: 'center'},
  retry: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    paddingVertical: 8, paddingHorizontal: 16, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.10)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
  },
  retryText: {color: '#F2F4F8', fontSize: 13.5, fontWeight: '600'},
  captionWrap: {position: 'absolute', bottom: 48, left: 24, right: 24, alignItems: 'center'},
  caption: {color: '#F2F4F8', fontSize: 15, fontWeight: '700', letterSpacing: -0.2},
  close: {
    position: 'absolute', top: 54, right: 20, width: 36, height: 36, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
  },
});
