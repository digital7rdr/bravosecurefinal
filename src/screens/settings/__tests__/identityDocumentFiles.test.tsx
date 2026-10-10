/**
 * 2026-10-10 regression — picking the BACK photo deleted the FRONT photo's
 * file. The "discard on leave" cleanup was keyed on [front?.uri, back?.uri],
 * so React ran it (with the previous URIs) on every pick. The thumbnail still
 * rendered, submit could not read the file, and every two-photo National ID
 * upload died with "No response from the server". These tests pin that the
 * picked files survive until submit/unmount and reach the upload intact.
 */
import React from 'react';
import {render, fireEvent, waitFor, act} from '@testing-library/react-native';

const mockDelete = jest.fn((_uri: string, _o?: unknown) => Promise.resolve());
const mockSubmit = jest.fn((_dto: unknown) => Promise.resolve({data: {status: 'submitted', required: true, doc_type: 'national_id', submitted_at: '2026-10-10T00:00:00Z', has_back: true}}));
let mockShrinkN = 0;
let mockCaptureN = 0;

jest.mock('expo-file-system/legacy', () => ({deleteAsync: (u: string, o?: unknown) => mockDelete(u, o)}));
jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn(async () => ({uri: `file:///cache/shrunk-${++mockShrinkN}.jpg`, width: 1600, height: 1000})),
  SaveFormat: {JPEG: 'jpeg'},
}));
jest.mock('expo-image-picker', () => ({
  CameraType: {back: 'back'},
  requestCameraPermissionsAsync: jest.fn(async () => ({granted: true})),
  requestMediaLibraryPermissionsAsync: jest.fn(async () => ({granted: true})),
  launchCameraAsync: jest.fn(async () => ({canceled: false, assets: [{uri: `file:///cache/capture-${++mockCaptureN}.jpg`}]})),
  launchImageLibraryAsync: jest.fn(async () => ({canceled: false, assets: [{uri: `file:///cache/capture-${++mockCaptureN}.jpg`}]})),
}));
jest.mock('@services/api', () => ({
  identityApi: {
    status: jest.fn(() => Promise.resolve({data: {status: 'missing', required: true, doc_type: null, submitted_at: null, has_back: false}})),
    submit: (dto: unknown) => mockSubmit(dto),
  },
}));
jest.mock('@store/authStore', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({user: {identity_document_status: 'missing'}, markIdentitySubmitted: jest.fn()}),
}));
// The screen's Alert wrapper: "Take photo" is pressed for every choose() prompt.
jest.mock('@utils/alert', () => ({
  Alert: {alert: jest.fn((_t: string, _m: string, buttons?: Array<{text: string; onPress?: () => void}>) => {
    buttons?.find(b => b.text === 'Take photo')?.onPress?.();
  })},
}));
jest.mock('@react-navigation/native', () => ({useNavigation: () => ({goBack: jest.fn(), canGoBack: () => true})}));
jest.mock('@navigation/tapGuard', () => ({goBackOnce: jest.fn()}));
jest.mock('@hooks/useBottomInset', () => ({useBottomInset: () => ({bottomPad: (n: number) => n, bottom: 0})}));
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0})}));
jest.mock('expo-linear-gradient', () => ({LinearGradient: 'LinearGradient'}));
jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'Icon');

import IdentityDocumentScreen from '@screens/settings/IdentityDocumentScreen';

beforeEach(() => { jest.clearAllMocks(); mockShrinkN = 0; mockCaptureN = 0; });

async function pickBoth(ui: ReturnType<typeof render>) {
  await act(async () => { fireEvent.press(ui.getByTestId('identity-tile-front')); });
  await waitFor(() => expect(ui.getByLabelText('Front of document, captured')).toBeTruthy());
  await act(async () => { fireEvent.press(ui.getByTestId('identity-tile-back')); });
  await waitFor(() => expect(ui.getByLabelText('Back of document, captured')).toBeTruthy());
}

it('picking the back photo does NOT delete the front photo (only the full-size captures go)', async () => {
  const ui = render(<IdentityDocumentScreen />);
  await pickBoth(ui);
  const deleted = mockDelete.mock.calls.map(c => c[0]);
  expect(deleted).not.toContain('file:///cache/shrunk-1.jpg');   // front, shrunk
  expect(deleted).not.toContain('file:///cache/shrunk-2.jpg');   // back, shrunk
  expect(deleted).toEqual(expect.arrayContaining(['file:///cache/capture-1.jpg', 'file:///cache/capture-2.jpg']));
});

it('submit sends both picked files', async () => {
  const ui = render(<IdentityDocumentScreen />);
  await pickBoth(ui);
  await act(async () => { fireEvent.press(ui.getByTestId('identity-submit')); });
  await waitFor(() => expect(mockSubmit).toHaveBeenCalled());
  expect(mockSubmit).toHaveBeenCalledWith({docType: 'national_id', frontUri: 'file:///cache/shrunk-1.jpg', backUri: 'file:///cache/shrunk-2.jpg'});
  // At the moment of upload, neither file had been deleted.
  const deletedBeforeSubmit = mockDelete.mock.invocationCallOrder
    .filter((order, i) => order < mockSubmit.mock.invocationCallOrder[0] && String(mockDelete.mock.calls[i][0]).includes('shrunk'));
  expect(deletedBeforeSubmit).toHaveLength(0);
});

it('a retake of the front deletes only the replaced front copy, never the back', async () => {
  const ui = render(<IdentityDocumentScreen />);
  await pickBoth(ui);
  mockDelete.mockClear();
  await act(async () => { fireEvent.press(ui.getByTestId('identity-tile-front')); });
  await waitFor(() => expect(mockDelete).toHaveBeenCalled());
  const deleted = mockDelete.mock.calls.map(c => c[0]);
  expect(deleted).toContain('file:///cache/shrunk-1.jpg');       // the replaced front
  expect(deleted).not.toContain('file:///cache/shrunk-2.jpg');   // the back survives
});

it('leaving the screen discards whatever was picked but not sent', async () => {
  const ui = render(<IdentityDocumentScreen />);
  await pickBoth(ui);
  mockDelete.mockClear();
  ui.unmount();
  const deleted = mockDelete.mock.calls.map(c => c[0]);
  expect(deleted).toEqual(expect.arrayContaining(['file:///cache/shrunk-1.jpg', 'file:///cache/shrunk-2.jpg']));
});
