/**
 * B-838 — the kind mapping moved out of `FilesScreen.tsx`.
 *
 * `bucketFor` + `iconFor` now delegate to `@/modules/messenger/ui/mediaKind`
 * so the search hit rows and this screen cannot disagree about what a PDF
 * looks like. That is a REFACTOR, and the only thing that proves a refactor:
 * the rendered rows still carry the exact glyphs they carried before.
 *
 * `mediaKindParity.test.ts` pins the mapping itself; this pins that FilesScreen
 * is still wired to it, per bucket, through the real `rows` memo.
 */
import React from 'react';
import {render} from '@testing-library/react-native';

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
jest.mock('react-native-image-picker', () => ({launchImageLibrary: jest.fn(), launchCamera: jest.fn()}));
jest.mock('expo-document-picker', () => ({getDocumentAsync: jest.fn()}));
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({
    navigate: jest.fn(), goBack: jest.fn(), isFocused: () => true,
    addListener: () => () => undefined,
  }),
  useFocusEffect: () => undefined,
}));
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0})}));
jest.mock('expo-linear-gradient', () => ({LinearGradient: 'LinearGradient'}));
jest.mock('expo-sharing', () => ({isAvailableAsync: jest.fn(async () => false), shareAsync: jest.fn()}));
jest.mock('react-native-svg', () => ({__esModule: true, default: 'Svg', Rect: 'Rect'}));
jest.mock('@components/Halo', () => ({Halo: () => null}));
jest.mock('@/modules/messenger/ui/AmbientBg', () => ({AmbientBg: 'AmbientBg'}));
jest.mock('@/modules/messenger/ui/AttachmentFileViewer', () => ({AttachmentFileViewer: () => null}));
jest.mock('@/modules/messenger/media', () => ({readUriBytes: jest.fn(), resolveAttachmentFileUri: jest.fn()}));
jest.mock('@utils/haptics', () => ({haptics: {
  tap: jest.fn(), select: jest.fn(), impact: jest.fn(), heavy: jest.fn(),
}}));
jest.mock('@navigation/tapGuard', () => ({goBackOnce: jest.fn()}));
jest.mock('@navigation/openPricing', () => ({openPricing: jest.fn()}));
jest.mock('@store/entitlements', () => ({
  useEntitlements: () => ({isOrgAffiliated: true, hasCloudVault: true}),
  showTierUpgradePrompt: jest.fn(),
}));
jest.mock('@/modules/messenger/vault', () => ({
  openVault: jest.fn(), moveBytesToVault: jest.fn(), findVaultRow: jest.fn(() => null),
  vaultHydrated: () => true,
  vaultPersistApi: () => undefined,
  useVaultStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({files: [], removeFile: jest.fn(), unlockedUntil: Date.now() + 5 * 60_000}),
    {getState: () => ({files: [], isUnlocked: () => true, hasPin: () => true})},
  ),
  isDepartmentConversation: () => false,
}));
jest.mock('@/modules/messenger/vault/useCompanyShelf', () => ({
  useCompanyConversationIds: () => new Set<string>(),
}));
jest.mock('@screens/deptchat/_obsidian', () => ({
  ...jest.requireActual('@screens/deptchat/_obsidian'),
  // OUTSIDE the workspace shell: the personal browser, full scope, so one row
  // per bucket reaches the list.
  useInDepartmentalShell: () => false,
}));

const mockBase = {
  conversation_id: 'conv-dm', sender_id: 'u2', content: '',
  created_at: '2026-09-10T10:00:00.000Z', is_encrypted: true,
  media_key: 'k', media_iv: 'i',
};
const mockRows = [
  {...mockBase, id: 'm-pdf',   type: 'file',  media_object_key: 'o1', media_mime: 'application/pdf', media_meta: {name: 'Contract-Q3.pdf', sizeBytes: 10}},
  {...mockBase, id: 'm-doc',   type: 'file',  media_object_key: 'o2', media_mime: 'application/zip', media_meta: {name: 'Archive.zip', sizeBytes: 10}},
  {...mockBase, id: 'm-img',   type: 'image', media_object_key: 'o3', media_mime: 'image/jpeg',      media_meta: {name: 'IMG_1.jpg', sizeBytes: 10}},
  {...mockBase, id: 'm-vid',   type: 'video', media_object_key: 'o4', media_mime: 'video/mp4',       media_meta: {name: 'Walk.mp4', sizeBytes: 10}},
  {...mockBase, id: 'm-voice', type: 'audio', media_object_key: 'o5', media_mime: 'audio/mp4',       media_meta: {sizeBytes: 10}},
];

jest.mock('@/modules/messenger/store', () => ({
  useMessengerStore: (sel: (s: unknown) => unknown) => sel({
    conversations: {'conv-dm': {id: 'conv-dm', name: 'Alice'}},
    messages: {},
    deptConversationIds: {},
    removeMessage: jest.fn(),
  }),
  selectMediaMessages: () => mockRows,
}));

import FilesScreen from '../FilesScreen';

describe('B-838 — FilesScreen still draws the same glyph for every bucket', () => {
  it('one row per bucket, each with the icon it had before the mapping moved', async () => {
    const u = render(<FilesScreen />);
    await u.findByText('Contract-Q3.pdf');
    // `iconFor` was the only place these five names appeared in the file, so a
    // count of one each is the whole mapping exercised end to end.
    for (const name of [
      'file-pdf-box',          // the docs bucket's special case
      'file-document-outline', // every other document
      'image-outline',
      'video-outline',
      'microphone-outline',    // a recorded voice note
    ]) {
      expect(u.UNSAFE_getAllByProps({name})).toHaveLength(1);
    }
  });
});
