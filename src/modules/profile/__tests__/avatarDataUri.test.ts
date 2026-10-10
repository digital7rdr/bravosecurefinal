/**
 * 2026-10-11 — profile photos are saved as a downscaled JPEG data URI via
 * PATCH /auth/me (the Storage upload depended on an edge function that never
 * existed on the fresh install). Pins: the output is a JPEG data URI under the
 * server cap, it steps down until it fits, and the picker hook persists it
 * through setAvatar — no Storage, no edge function.
 */
const mockManipulate = jest.fn();
jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: (...a: unknown[]) => mockManipulate(...a),
  SaveFormat: {JPEG: 'jpeg'},
}));

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {AVATAR_MAX_CHARS, toAvatarDataUri} from '@/modules/profile/avatarDataUri';

beforeEach(() => mockManipulate.mockReset());

it('returns a 256 px JPEG data URI when it fits', async () => {
  mockManipulate.mockResolvedValueOnce({base64: 'QUJD', width: 256, height: 256});
  await expect(toAvatarDataUri('file:///crop.jpg')).resolves.toBe('data:image/jpeg;base64,QUJD');
  expect(mockManipulate).toHaveBeenCalledWith('file:///crop.jpg', [{resize: {width: 256}}], {compress: 0.7, format: 'jpeg', base64: true});
});

it('steps down size/quality until it is under the server cap', async () => {
  const big = 'A'.repeat(AVATAR_MAX_CHARS);
  mockManipulate
    .mockResolvedValueOnce({base64: big})
    .mockResolvedValueOnce({base64: big})
    .mockResolvedValueOnce({base64: 'small'});
  await expect(toAvatarDataUri('file:///x.jpg')).resolves.toBe('data:image/jpeg;base64,small');
  expect(mockManipulate.mock.calls.map(c => [(c[1] as Array<{resize: {width: number}}>)[0].resize.width, (c[2] as {compress: number}).compress]))
    .toEqual([[256, 0.7], [256, 0.5], [192, 0.5]]);
});

it('throws avatar_too_large only when nothing fits', async () => {
  mockManipulate.mockResolvedValue({base64: 'A'.repeat(AVATAR_MAX_CHARS)});
  await expect(toAvatarDataUri('file:///x.jpg')).rejects.toThrow('avatar_too_large');
});

it('the cap stays below UpdateProfileDto @MaxLength(200_000)', () => {
  const dto = readFileSync(join(__dirname, '../../../../apps/auth-service/src/auth/dto/update-profile.dto.ts'), 'utf8');
  expect(dto).toMatch(/@MaxLength\(200_000\)\s+avatar_url/);
  expect(AVATAR_MAX_CHARS).toBeLessThan(200_000);
});

it('the picker persists via setAvatar and no longer touches Storage / the edge function', () => {
  const hook = readFileSync(join(__dirname, '..', 'useAvatarPicker.ts'), 'utf8');
  expect(hook).toMatch(/await setAvatar\(await toAvatarDataUri\(asset\.uri\)\)/);
  expect(hook).not.toMatch(/uploadAvatar|avatar-upload-url|supabase/);
  const svc = readFileSync(join(__dirname, '../../../services/supabase.ts'), 'utf8');
  expect(svc).not.toMatch(/avatar-upload-url|uploadToSignedUrl/);
});
