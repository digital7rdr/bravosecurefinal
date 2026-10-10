/**
 * Shared profile-photo picker used by every "set my avatar" surface
 * (individual ProfileScreen, CPO "Me" tab, service-provider/agent profile).
 *
 * One code path so all roles behave identically: pick (library or camera) →
 * native square crop (allowsEditing + aspect 1:1) → downscale to a ~256 px JPEG
 * data URI (avatarDataUri.ts) → persist it via `setAvatar` (PATCH /auth/me).
 * Removing clears `avatar_url`. 2026-10-11: replaced the Supabase Storage upload,
 * whose signing edge function never existed on the fresh install.
 */
import {useCallback, useState} from 'react';
import {Alert} from '@utils/alert';
import * as ImagePicker from 'expo-image-picker';
import {useAuthStore} from '@store/authStore';
import {toAvatarDataUri} from './avatarDataUri';

const CROP_OPTS = {
  allowsEditing: true,
  aspect: [1, 1] as [number, number],
  // Full quality out of the cropper; avatarDataUri does the one lossy step.
  quality: 1,
} as const;

export interface AvatarPicker {
  busy: boolean;
  hasPhoto: boolean;
  pickFromLibrary: () => Promise<void>;
  takePhoto: () => Promise<void>;
  removePhoto: () => Promise<void>;
}

export function useAvatarPicker(): AvatarPicker {
  const userId = useAuthStore(s => s.user?.id);
  const hasPhoto = useAuthStore(s => !!s.user?.avatar_url);
  const setAvatar = useAuthStore(s => s.setAvatar);
  const [busy, setBusy] = useState(false);

  const applyAsset = useCallback(
    async (asset: ImagePicker.ImagePickerAsset) => {
      if (!asset.uri || !userId) {return;}
      setBusy(true);
      try {
        await setAvatar(await toAvatarDataUri(asset.uri));
      } catch (e) {
        // Name the cause (status / code) so a failure is diagnosable from a
        // screenshot — the generic text hid the missing edge function for weeks.
        const err = e as {response?: {status?: number; data?: {message?: unknown}}; message?: string};
        const status = err?.response?.status;
        const code = typeof err?.response?.data?.message === 'string' ? err.response.data.message : err?.message;
        console.warn('[avatar] save failed', status ?? 'no-response', code);
        Alert.alert('Could not update photo', `Please try again.${status ? `\n\n(Server: ${status}${code ? ` · ${code}` : ''})` : code ? `\n\n(${code})` : ''}`);
      } finally {
        setBusy(false);
      }
    },
    [userId, setAvatar],
  );

  const pickFromLibrary = useCallback(async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Allow photo access to set a profile picture.');
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({mediaTypes: ['images'], ...CROP_OPTS});
    if (!res.canceled && res.assets[0]) {await applyAsset(res.assets[0]);}
  }, [applyAsset]);

  const takePhoto = useCallback(async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Allow camera access to take a profile picture.');
      return;
    }
    const res = await ImagePicker.launchCameraAsync({cameraType: ImagePicker.CameraType.front, ...CROP_OPTS});
    if (!res.canceled && res.assets[0]) {await applyAsset(res.assets[0]);}
  }, [applyAsset]);

  const removePhoto = useCallback(async () => {
    setBusy(true);
    try {
      await setAvatar(null);
    } catch {
      Alert.alert('Could not remove photo', 'Please try again.');
    } finally {
      setBusy(false);
    }
  }, [setAvatar]);

  return {busy, hasPhoto, pickFromLibrary, takePhoto, removePhoto};
}
