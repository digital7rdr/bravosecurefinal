import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, AppState,
  TouchableOpacity, StatusBar, Modal, Pressable, Image, Vibration,
} from 'react-native';
import {Alert} from '@utils/alert';
/**
 * Brand-kit action palette — keep these in sync with `--color-action-*`
 * tokens in Bravo Kit v4. Pressed-state uses `pressed` (not an opacity
 * knockdown) so the button feels tactile on both Android and iOS.
 */
const ACTION = {
  default:  '#1E88FF',
  hover:    '#3BA6FF',
  pressed:  '#166ED1',
  disabled: 'rgba(255,255,255,0.09)',
};
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {launchImageLibrary, launchCamera} from 'react-native-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import {Colors} from '@theme/index';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import {useVaultStore, vaultHydrated, vaultPersistApi, moveBytesToVault, openVaultFileUri, type VaultFile} from '@/modules/messenger/vault';
import {useCompanyShelf} from '@/modules/messenger/vault/useCompanyShelf';
import {WorkspaceChoiceGate, useNeedsWorkspaceChoice} from '@screens/deptchat/WorkspaceChoiceGate';
import {useEntitlements, showTierUpgradePrompt} from '@store/entitlements';
import {openPricing} from '@navigation/openPricing';
import {readUriBytes, resolveAttachmentFileUri, MediaTooLargeError} from '@/modules/messenger/media';
import type {CompanyFile} from '@/modules/messenger/vault/companyShelf';
import {haptics} from '@utils/haptics';
import {FileViewer, type ViewableFile} from '@/modules/messenger/ui/FileViewer';
// B-727 — the SAME stepper the chat viewer pages with, so "next / previous"
// means one thing app-wide (and the no-wrap rule stays in one tested place).
import {stepVisual} from '@/modules/messenger/ui/imageAlbums';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {AlbumBar, MoveToAlbumSheet, NameAlbumModal, type AlbumFilter} from './albumUi';
import {itemsInAlbum, albumCounts, type Album} from '@/modules/messenger/fileAlbums/fileAlbums';

const TABS = ['All', 'Images', 'Documents', 'Audio'] as const;
type Tab = typeof TABS[number];

/** Scope v2 Phase 4 — "two shelves in the same cupboard … never mixed". */
const SHELVES = ['Personal', 'Company'] as const;
type Shelf = typeof SHELVES[number];

/**
 * Pick a category from a vault file's mime type — drives which section
 * it lands in (Images / Documents / Audio) without relying on file
 * extensions the server may strip.
 */
function categorize(mime: string): 'image' | 'audio' | 'doc' {
  if (mime.startsWith('image/')) {return 'image';}
  if (mime.startsWith('audio/')) {return 'audio';}
  return 'doc';
}

/**
 * B-458 — split the image list into rows of three. Rows (rather than
 * `flexWrap`) because the tile styles are `flex: 1` with a 33% cap: wrapping a
 * flex-basis-0 row never breaks, so the tiles would just shrink forever.
 */
function chunkOf3<T>(items: readonly T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += 3) {rows.push(items.slice(i, i + 3));}
  return rows;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) {return `${bytes} B`;}
  if (bytes < 1024 * 1024) {return `${(bytes / 1024).toFixed(1)} KB`;}
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function humanDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString([], {day: '2-digit', month: 'short'}).toUpperCase();
}

/** `name` is the Icon's own union, not `string`: the loose type made every
 *  call site a TS2322 that sat in the baseline, and adding a fourth call site
 *  silently spent more of that headroom. */
type IconName = React.ComponentProps<typeof Icon>['name'];

function docIconFor(mime: string): {name: IconName; color: string; bg: string} {
  // Images and video first: they are the most common channel attachment, and
  // without these branches every photo on the Company shelf rendered as a
  // generic grey "file" row.
  if (mime.startsWith('image/')) {return {name: 'image', color: '#A78BFA', bg: 'rgba(167,139,250,0.12)'};}
  if (mime.startsWith('video/')) {return {name: 'video', color: '#60A5FA', bg: 'rgba(96,165,250,0.12)'};}
  if (mime.includes('pdf')) {return {name: 'file-pdf-box', color: '#f87171', bg: 'rgba(248,113,113,0.12)'};}
  if (mime.includes('spreadsheet') || mime.includes('excel')) {return {name: 'file-table', color: '#4ade80', bg: 'rgba(74,222,128,0.12)'};}
  if (mime.includes('word') || mime.includes('document')) {return {name: 'file-document', color: '#60A5FA', bg: 'rgba(96,165,250,0.12)'};}
  if (mime.startsWith('audio/')) {return {name: 'music-note', color: '#A78BFA', bg: 'rgba(167,139,250,0.12)'};}
  return {name: 'file', color: 'rgba(229,233,242,0.62)', bg: 'rgba(180,199,224,0.12)'};
}

export default function VaultScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<MessengerStackParamList>>();
  const [activeTab, setActiveTab] = useState<Tab>('All');
  const [shelfPref, setShelf] = useState<Shelf>('Personal');
  const companyFiles = useCompanyShelf();
  // B-848 — no workspace context and more than one enterable organisation: the
  // company shelf shows the picker instead of two companies' files in one list.
  const needsWorkspaceChoice = useNeedsWorkspaceChoice();
  const entitlements = useEntitlements();
  const isOrgAffiliated = entitlements.isOrgAffiliated;
  // B-716 — the tier gate reads the SAME derivation openVault's own gate uses
  // (`deriveEntitlements(...).hasCloudVault`), just through the hook this screen
  // already holds. Calling `entitlementGate.hasCloudVaultEntitlement()` directly
  // would `require('@store/authStore')` at focus time, and that module's own
  // docblock says exactly why that is avoided on this path: it drags
  // untransformed ESM into suites that mock the store seam instead.
  const hasCloudVault = entitlements.hasCloudVault;
  const hasCompanyShelf = isOrgAffiliated;
  // EFFECTIVE shelf. Losing org affiliation while the Company shelf is open
  // removed the switch but left the company branch rendering, with the header
  // still reading "Company Vault" and no route back to Personal. The company
  // list is gated on the shelf, so the shelf itself has to collapse.
  const shelf: Shelf = hasCompanyShelf ? shelfPref : 'Personal';
  const [uploadOpen, setUploadOpen] = useState(false);
  const [viewerFile, setViewerFile] = useState<ViewableFile | null>(null);
  const [viewerIsCompany, setViewerIsCompany] = useState(false);
  const files = useVaultStore(s => s.files);
  const removeFile = useVaultStore(s => s.removeFile);

  // Why: VAULT-24/32 — BiometricGate relocks the store on background,
  // but this screen stayed mounted showing files. Re-check the lock on
  // focus and on foreground transitions and `replace` with the lock
  // screen (matches openVault routing). Loop-safe: replace unmounts
  // this screen, and VaultLock only comes back after a real unlock.
  const unlockedUntil = useVaultStore(s => s.unlockedUntil);
  const gateRoutedRef = useRef(false);
  // B-716 — one tier route per gated episode, same rule as the lock's own
  // latch: focus and the AppState listener can both answer in one commit, and
  // two navigations stack.
  const tierRoutedRef = useRef(false);
  const guardLock = useCallback(() => {
    // Rehydration is ASYNC and `pinHash` reads null until it lands; deciding
    // in that window is how a real-PIN user gets routed into setup.
    if (!vaultHydrated()) {return;}
    // B-716 — the TIER gate, carried onto the screen itself.
    //
    // Until this screen became a tab ROOT (Departmental shell), every route in
    // was `openVault()`, whose FIRST branch is the Pro+ entitlement check —
    // "the single choke point for every vault navigation" (vault/navigation.ts).
    // A tab root has no such caller: the tab bar navigates straight here, so
    // without this the choke point is simply bypassed and a Lite member lands
    // on a vault where every action 403s and the storage-plans prompt they were
    // supposed to see never fires. The server still backstops the DATA at
    // action-token issuance, so this is a correctness-and-honesty gate, not a
    // secrecy one — which is exactly why it belongs beside the lock guard and
    // not in place of it.
    if (!hasCloudVault) {
      if (tierRoutedRef.current) {return;}
      tierRoutedRef.current = true;
      showTierUpgradePrompt('cloud-vault', {onViewPlans: openPricing});
      // Never leave the user staring at a gated screen. Inside the workspace
      // this IS the tab root, so there is nothing to go back to — hand them the
      // file browser that used to be the tab's landing. Everywhere else the
      // caller is openVault and going back is the honest undo.
      if (navigation.canGoBack()) {navigation.goBack();}
      else {navigation.replace('MessengerHome');}
      return;
    }
    tierRoutedRef.current = false;
    if (useVaultStore.getState().isUnlocked()) {
      gateRoutedRef.current = false;
      return;
    }
    // One route per lock episode — focus, AppState and the deadline effect can
    // all answer in the same commit, and two `replace` calls stack.
    if (gateRoutedRef.current) {return;}
    gateRoutedRef.current = true;
    navigation.replace('VaultLock');
    // B-716 — `hasCloudVault` is a dependency: a tier change while this screen
    // is mounted must re-arm the gate, not run against a stale closure.
  }, [navigation, hasCloudVault]);

  useFocusEffect(guardLock);

  useEffect(() => {
    const sub = AppState.addEventListener('change', st => {
      if (st === 'active' && navigation.isFocused()) {guardLock();}
    });
    return () => sub.remove();
  }, [guardLock, navigation]);

  useEffect(() => {
    // AppState alone cannot carry this: BiometricGate relocks AFTER an await
    // (a later tick than the background transition), `lock()` can be fired from
    // anywhere while this screen keeps focus, and the 5-minute window simply
    // expiring under a seated user fires no event at all.
    if (!navigation.isFocused()) {return;}
    guardLock();
    if (unlockedUntil === null) {return;}
    const ms = unlockedUntil - Date.now();
    if (ms <= 0) {return;}
    const t = setTimeout(() => { if (navigation.isFocused()) {guardLock();} }, ms + 50);
    return () => clearTimeout(t);
  }, [unlockedUntil, guardLock, navigation]);

  useEffect(() => {
    const p = vaultPersistApi();
    if (!p?.onFinishHydration || p.hasHydrated?.()) {return;}
    return p.onFinishHydration(() => { if (navigation.isFocused()) {guardLock();} });
  }, [guardLock, navigation]);

  // B-86 — one MFA-gated transfer at a time (proofs are single-use).
  const [busyKey, setBusyKey] = useState<string | null>(null);

  /**
   * B-727 — the swipe-paging anchor, and the two refs that make paging safe.
   *
   * `viewerKey` is the objectKey of the row on screen. It is tracked separately
   * because `viewerFile.id` cannot serve: a COMPANY row carries its messageId
   * there, so a paging lookup against the company list would never find itself.
   * Both shelf lists key on objectKey, so that is the anchor.
   *
   * `uriCache` holds temp uris this session has ALREADY decrypted. Reusing one
   * issues NO new download URL, so the per-file vault MFA gate is untouched —
   * it only stops a swipe back to the previous photo from paying for a second
   * mint + download of bytes the user is already looking at.
   *
   * `viewerGen` fences the async opens. A slow download that lands after the
   * user paged on — or closed the viewer — must never yank the photo out from
   * under them. Same identity-keyed-write rule the call registries follow: ask
   * "did a genuinely newer open claim the viewer?", never "is it still open?".
   */
  const [viewerKey, setViewerKey] = useState<string | null>(null);
  const uriCacheRef  = useRef(new Map<string, string>());
  const viewerGenRef = useRef(0);
  /**
   * The key of a PAGE TURN in flight, or null — deliberately NOT `busyKey`.
   *
   * `busyKey` is the screen's one-MFA-op-at-a-time latch and is also held for
   * the whole of an upload batch (`'upload'`) and for a remove. Driving the
   * viewer's spinner off it put a permanent overlay on a fully-loaded photo for
   * the length of an unrelated upload, and left the spinner claiming "loading"
   * while swipes were being dropped (adversarial review, 2026-09-02).
   */
  const [pagingKey, setPagingKey] = useState<string | null>(null);

  const closeViewer = () => {
    // Bump FIRST: an open still in flight must lose its claim on the viewer.
    viewerGenRef.current += 1;
    setViewerFile(null);
    setViewerIsCompany(false);
    setViewerKey(null);
  };

  const openInViewer = (f: VaultFile) => {
    // Legacy pre-B-86 rows kept a local plaintext uri — still viewable.
    const legacyUri = (f as unknown as {uri?: string}).uri;
    // B-727 — a photo already decrypted this session pages back instantly.
    const ready = legacyUri ?? uriCacheRef.current.get(f.objectKey);
    if (ready) {
      viewerGenRef.current += 1;
      setViewerIsCompany(false);
      setViewerKey(f.objectKey);
      setViewerFile({
        // B-86 — vaultSourceKey is LOAD-BEARING: the viewer's vault
        // actions match the index by this handle; without it "Move to
        // Vault" re-uploads a duplicate and Delete removes nothing.
        id: f.objectKey, vaultSourceKey: f.objectKey, name: f.name, uri: ready,
        mimeType: f.mimeType, size: f.size, createdAt: f.createdAt,
        // A personal vault row has no source conversation.
        conversationId: null,
      });
      return;
    }
    if (busyKey) {return;}
    // B-86 — real rows: biometric ceremony → single-use MFA action token
    // → presigned download → local AES decrypt → temp uri for the viewer.
    //
    // B-727: this runs per SWIPE too, and that is deliberate — a fresh action
    // token per download URL is the File Vault MFA gate (architecture stop
    // condition), so paging pays a round trip rather than weakening it. What it
    // does NOT pay is a fingerprint prompt: runLocalBiometric short-circuits
    // while the vault is unlocked (B-700), and guardLock makes this screen
    // unreachable locked.
    const gen = (viewerGenRef.current += 1);
    // The anchor moves to the DESTINATION now, not when the bytes land. It used
    // to lag: swipe A→B (in flight), then swipe back meaning "return to A", and
    // the walk ran from A — landing on the photo BEFORE A. The user ends up two
    // photos from where they think they are.
    const prevKey = viewerKey;
    setViewerIsCompany(false);
    setViewerKey(f.objectKey);
    setBusyKey(f.objectKey);
    setPagingKey(f.objectKey);
    void (async () => {
      try {
        const res = await openVaultFileUri(f);
        // Cache BEFORE the fence: these bytes are downloaded and decrypted and
        // already on disk. Discarding the uri because the user paged on would
        // make the next visit pay a fresh MFA proof + download for a file
        // `writeTempBytes` would then skip anyway (the path exists).
        if (res.ok) {uriCacheRef.current.set(f.objectKey, res.uri);}
        // A newer open (or a close) claimed the viewer while we were away.
        if (gen !== viewerGenRef.current) {return;}
        if (res.ok) {
          setViewerFile({
            id: f.objectKey, vaultSourceKey: f.objectKey, name: f.name, uri: res.uri,
            mimeType: f.mimeType, size: f.size, createdAt: f.createdAt,
            conversationId: null,
          });
        } else {
          // The page did not happen — put the anchor back, or the next swipe
          // walks from a photo that is not on screen.
          setViewerKey(prevKey);
          if (res.reason !== 'cancelled') {Alert.alert('Could not open', res.message);}
        }
      } finally {
        setBusyKey(null);
        setPagingKey(null);
      }
    })();
  };

  /**
   * Open a COMPANY file.
   *
   * Deliberately the ordinary attachment pipeline, NOT the vault one. These
   * are channel messages: the bytes live in media storage and the per-file AES
   * key came from the group-encrypted envelope, so `resolveAttachmentFileUri`
   * is the same path the chat bubble uses.
   *
   * ON MFA, honestly: the PDF calls company files "locked behind permissions
   * and MFA". The permissions are real and structural — only a channel member
   * holds the key. The MFA that applies is the VAULT UNLOCK guarding this whole
   * screen (guardLock above), not a fresh per-file proof: the vault's per-file
   * MFA is bound to VaultService download URLs, and these objects are not vault
   * objects. Adding a per-file prompt HERE while the identical bytes remain one
   * tap away in the channel thread would be ceremony, not a boundary — so the
   * gate is stated rather than faked. Routing channel media through the vault
   * MFA lane would be a change to the download-URL issuance flow, which is an
   * architecture stop-condition.
   */
  const openCompanyFile = (f: CompanyFile) => {
    // B-727 — same session cache as the personal shelf. These bytes never came
    // through the vault MFA lane at all (they are channel media), so there is
    // no gate to weaken here; it only avoids re-downloading on a swipe back.
    const ready = uriCacheRef.current.get(f.objectKey);
    if (ready) {
      viewerGenRef.current += 1;
      setViewerIsCompany(true);
      setViewerKey(f.objectKey);
      setViewerFile({
        id: f.messageId, name: f.name, uri: ready,
        mimeType: f.mimeType, size: f.size, createdAt: f.createdAt,
        conversationId: f.conversationId,
      });
      return;
    }
    if (busyKey) {return;}
    const gen = (viewerGenRef.current += 1);
    const prevKey = viewerKey;
    setViewerIsCompany(true);
    setViewerKey(f.objectKey);
    setBusyKey(f.objectKey);
    setPagingKey(f.objectKey);
    void (async () => {
      try {
        const uri = await resolveAttachmentFileUri({
          id: f.messageId,
          media_object_key: f.objectKey,
          media_key: f.keyB64,
          media_iv: f.ivB64,
          media_mime: f.mimeType,
          media_meta: {sizeBytes: f.size},
        });
        // Cached before the fence — see the note in openInViewer.
        uriCacheRef.current.set(f.objectKey, uri);
        if (gen !== viewerGenRef.current) {return;}
        setViewerFile({
          // No `vaultSourceKey`: this file is NOT in the personal vault. The
          // suppression that actually matters is allowVaultActions below.
          id: f.messageId, name: f.name, uri,
          mimeType: f.mimeType, size: f.size, createdAt: f.createdAt,
          // DEFENCE IN DEPTH. allowVaultActions hides the button; this makes the
          // vault itself refuse, so the shelf is not the only guard on the very
          // screen whose UI flag regressed in round 2.
          conversationId: f.conversationId,
        });
      } catch (e) {
        if (gen !== viewerGenRef.current) {return;}
        setViewerKey(prevKey);
        Alert.alert(
          'Could not open',
          // B-728 — an over-ceiling file has a real reason; do not bury it under
          // the generic connection copy, which invites a pointless retry.
          e instanceof MediaTooLargeError
            ? e.message
            : 'This file could not be downloaded. Check your connection and try again.',
        );
      } finally {
        setBusyKey(null);
        setPagingKey(null);
      }
    })();
  };

  // The company rows the ACTIVE TAB actually shows. Derived once so the empty
  // state, the count and the list can never disagree.
  const visibleCompanyFiles = companyFiles.filter(f => activeTab === 'All'
    || (activeTab === 'Images' && categorize(f.mimeType) === 'image')
    || (activeTab === 'Documents' && categorize(f.mimeType) === 'doc')
    || (activeTab === 'Audio' && categorize(f.mimeType) === 'audio'));

  // ---- Vault albums (founder 2026-08-08) --------------------------------
  // A SEPARATE space from the Files tab's albums, and deliberately stored in
  // vaultStore so `reset()` wipes the names with the files — see
  // `vaultAlbumReset.test.ts`.
  const albumState  = useVaultStore(s => s.albumState);
  const vaultAlbums = albumState.albums;
  const [albumFilter, setAlbumFilter] = useState<AlbumFilter>(undefined);
  const [namingAlbum, setNamingAlbum] = useState<{mode: 'create'} | {mode: 'rename'; album: Album} | null>(null);
  // B-716 — the objectKey of the file whose folder is being chosen, or null.
  // Mirrors FileViewer's `albumFor`; the sheet is the SAME presentational
  // component, fed this screen's own vault album state (never the Files space).
  const [albumFor, setAlbumFor] = useState<string | null>(null);

  const albumTotals = useMemo(
    () => albumCounts(albumState, files.map(f => f.objectKey)),
    [albumState, files],
  );

  // Applied BEFORE the type split, so the album a user opens filters Images,
  // Documents and Audio consistently rather than only the section they can see.
  const inAlbum = useMemo(() => {
    if (albumFilter === undefined) {return files;}
    const keep = new Set(itemsInAlbum(albumState, albumFilter, files.map(f => f.objectKey)));
    return files.filter(f => keep.has(f.objectKey));
  }, [files, albumFilter, albumState]);

  // A deleted album must not strand the shelf on an empty filter.
  useEffect(() => {
    if (typeof albumFilter === 'string' && !vaultAlbums.some(a => a.id === albumFilter)) {
      setAlbumFilter(undefined);
    }
  }, [vaultAlbums, albumFilter]);

  const images    = inAlbum.filter(f => categorize(f.mimeType) === 'image');
  const documents = inAlbum.filter(f => categorize(f.mimeType) === 'doc');
  const audios    = inAlbum.filter(f => categorize(f.mimeType) === 'audio');

  /**
   * B-727 — page to the adjacent PHOTO. The founder's chat gesture (B-287,
   * "when one image opens, if we swipe right or left we should see the next or
   * previous image") finally wired into the vault, which until now passed no
   * `onSwipe` at all: ZoomableImage recognised the gesture, animated the slide,
   * and then had nothing to call. It read as "swipe does nothing" because it
   * did nothing.
   *
   * Pages the list the user is ACTUALLY LOOKING AT — same shelf, same tab, same
   * album filter as the grid behind the viewer — so a swipe can never surface a
   * photo the screen itself is hiding (an album filter that the viewer ignored
   * would leak files out of the folder the user opened).
   *
   * Steps through `stepVisual` rather than re-deriving an index walk, so the
   * no-wrap rule lives in ONE tested place and "next / previous" means the same
   * thing here as in chat. Wrapping the last photo round to the first would make
   * it impossible to feel where the set ends; running off either end instead
   * leaves the snap-back animation as the "nothing further that way" cue, which
   * is exactly what B-295 kept unconditional for this purpose.
   *
   * Documents and audio are unreachable here by construction — FileViewer only
   * hands `onSwipe` to the image branch.
   */
  const stepViewer = (direction: -1 | 1) => {
    if (viewerKey === null) {return;}
    if (viewerIsCompany) {
      const list = visibleCompanyFiles.filter(f => categorize(f.mimeType) === 'image');
      const nextKey = stepVisual(list.map(f => f.objectKey), viewerKey, direction);
      const target = nextKey === null ? undefined : list.find(f => f.objectKey === nextKey);
      if (target) {openCompanyFile(target);}
      return;
    }
    const nextKey = stepVisual(images.map(f => f.objectKey), viewerKey, direction);
    const target = nextKey === null ? undefined : images.find(f => f.objectKey === nextKey);
    if (target) {openInViewer(target);}
  };

  // Why: audit S1 — the previous upload paths called addFile() with
  // keyB64:'' and ivB64:'' and a plaintext local uri. The "AES-256 · ACTIVE"
  // banner above suggested encryption was happening when nothing was
  // encrypted at all and nothing reached the vault backend. The pickers
  // stay functional so users can browse, but every upload entry point
  // shows an honest "not available yet" alert instead of writing a
  // pretend-encrypted row.
  // B-86 — direct vault uploads through the real pipeline (audit S1 stub
  // retired): read the picked bytes → biometric ceremony → single-use MFA
  // action token → VaultClient encrypt-and-upload → real key material in
  // the index. Fails CLOSED with an honest alert; vaultStore.addFile
  // refuses key-less rows (M-02) as defense in depth.
  // Issue 21 — upload ONE asset and RETURN the outcome instead of alerting.
  // A multi-file pick must report partial failures once, not fire N dialogs.
  type UploadOutcome = {ok: true} | {ok: false; cancelled?: boolean; tier?: boolean; message?: string};
  const uploadOneToVault = async (
    asset: {uri: string; name: string; mimeType: string},
    index: number,
  ): Promise<UploadOutcome> => {
    try {
      const bytes = await readUriBytes(asset.uri);
      const res = await moveBytesToVault({
        // Why the index: a batch picked in the same millisecond would otherwise
        // share one sourceKey and collapse into a single vault row.
        sourceKey: `local:${Date.now()}:${index}`,
        name:      asset.name,
        mimeType:  asset.mimeType,
        bytes,
        // A genuine local pick — camera or document picker. Stated, not
        // defaulted, so provenance is always a conscious answer.
        conversationId: null,
      });
      if (res.ok) {
        haptics.impact();
        return {ok: true};
      }
      // B-591 — a lapsed plan is a billing state; route it to the upgrade
      // prompt (once, at the caller) instead of quoting it in an alert.
      if (res.reason === 'tier') {return {ok: false, tier: true};}
      return res.reason === 'cancelled'
        ? {ok: false, cancelled: true}
        : {ok: false, message: res.message};
    } catch (e) {
      return {ok: false, message: e instanceof Error ? e.message : 'Could not read the file.'};
    }
  };

  const uploadToVault = async (asset: {uri: string; name: string; mimeType: string}) => {
    if (busyKey) {return;}
    setBusyKey('upload');
    try {
      const res = await uploadOneToVault(asset, 0);
      if (!res.ok && res.tier === true) {
        showTierUpgradePrompt('cloud-vault', {onViewPlans: openPricing});
      } else if (!res.ok && res.cancelled !== true) {
        Alert.alert('Not saved to vault', res.message ?? 'Upload failed');
      }
    } finally {
      setBusyKey(null);
    }
  };

  // Issue 21 — every selected file is its own encrypted upload. One failure
  // must NOT abort the rest, and nothing may be silently discarded: the summary
  // names each file that did not make it.
  const uploadManyToVault = async (assets: Array<{uri: string; name: string; mimeType: string}>) => {
    if (busyKey !== null || assets.length === 0) {return;}
    if (assets.length === 1) {
      await uploadToVault(assets[0]);
      return;
    }
    setBusyKey('upload');
    const failed: string[] = [];
    let saved = 0;
    let tierBlocked = false;
    try {
      for (const [i, asset] of assets.entries()) {
        const res = await uploadOneToVault(asset, i);
        if (res.ok) {
          saved += 1;
        } else if (res.tier === true) {
          // B-591 — tier fails every file identically: ONE upgrade ask, and
          // never another biometric ceremony for the rest of the batch.
          tierBlocked = true;
          break;
        } else if (res.cancelled !== true) {
          failed.push(asset.name);
        }
      }
    } finally {
      setBusyKey(null);
    }
    if (tierBlocked) {
      showTierUpgradePrompt('cloud-vault', {onViewPlans: openPricing});
      return;
    }
    if (failed.length > 0) {
      Alert.alert(
        saved > 0 ? 'Some files not saved' : 'Upload failed',
        `${saved} of ${assets.length} saved to your vault.\n\nNot saved:\n• ${failed.join('\n• ')}\n\nTry those again.`,
      );
    }
  };

  const pickImage = async () => {
    setUploadOpen(false);
    try {
      // Issue 21 — selectionLimit 0 means UNLIMITED. It was 1, and only
      // assets[0] was ever read, so picking three images saved one and
      // silently dropped the other two.
      const res = await launchImageLibrary({mediaType: 'photo', selectionLimit: 0, includeBase64: false});
      if (res.didCancel === true) {return;}
      const picked = (res.assets ?? []).filter(a => typeof a.uri === 'string' && a.uri.length > 0);
      if (picked.length === 0) {return;}
      await uploadManyToVault(picked.map((a, i) => ({
        uri:      a.uri as string,
        // Why the index: the fallback name must be unique per file or a batch
        // of un-named picks would land as N rows all called "photo.jpg".
        name:     a.fileName ?? `photo-${i + 1}.jpg`,
        mimeType: a.type ?? 'image/jpeg',
      })));
    } catch (e) {
      Alert.alert('Upload failed', e instanceof Error ? e.message : 'Could not open image picker');
    }
  };

  const captureImage = async () => {
    setUploadOpen(false);
    try {
      const res = await launchCamera({mediaType: 'photo', cameraType: 'back', saveToPhotos: false});
      const asset = res.assets?.[0];
      if (res.didCancel === true || !asset?.uri) {return;}
      await uploadToVault({
        uri:      asset.uri,
        name:     asset.fileName ?? `capture-${Date.now()}.jpg`,
        mimeType: asset.type ?? 'image/jpeg',
      });
    } catch (e) {
      Alert.alert('Camera failed', e instanceof Error ? e.message : 'Could not open camera');
    }
  };

  const pickDocument = async () => {
    setUploadOpen(false);
    try {
      // Issue 21 — the PDF's acceptance covers "ten and mixed file types", so
      // documents are multi-select too, not just photos.
      const res = await DocumentPicker.getDocumentAsync({
        type: '*/*', copyToCacheDirectory: true, multiple: true,
      });
      if (res.canceled) {return;}
      const picked = (res.assets ?? []).filter(a => typeof a.uri === 'string' && a.uri.length > 0);
      if (picked.length === 0) {return;}
      await uploadManyToVault(picked.map((a, i) => ({
        uri:      a.uri,
        name:     a.name ?? `document-${i + 1}`,
        mimeType: a.mimeType ?? 'application/octet-stream',
      })));
    } catch (e) {
      Alert.alert('Upload failed', e instanceof Error ? e.message : 'Could not open document picker');
    }
  };

  // B-716 — long-press was REMOVE-only, and that is why vault folders looked
  // broken: this screen could create, rename and filter them but had no way to
  // put an already-vaulted file INTO one. The only filing path in the app was
  // the one-shot sheet FileViewer opens straight after a fresh move
  // (`setAlbumFor(res.objectKey)` on the success branch), unreachable for a file
  // that is already in the vault. So a folder made here stayed empty forever.
  //
  // Offered from the existing long-press rather than a new selection mode: the
  // founder deferred vault multi-select on purpose (b2010dee) because long-press
  // here already means "remove from vault", so a selection layer risks deleting
  // files. A third button reuses the affordance that already exists and adds no
  // destructive surface. 'Remove' keeps `style: 'destructive'` and stays last.
  const confirmRemove = (f: VaultFile) => {
    Alert.alert(
      f.name,
      'Move this file into a folder, or remove it from your vault index.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Move to folder…', onPress: () => setAlbumFor(f.objectKey)},
        {text: 'Remove', style: 'destructive', onPress: () => removeFile(f.objectKey)},
      ],
    );
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity
            onPress={() => goBackOnce(navigation)}
            activeOpacity={0.7}
            hitSlop={{top: 8, left: 8, right: 8, bottom: 8}}
            style={{paddingRight: 8}}>
            <Icon name="arrow-left" size={20} color="#FFFFFF" />
          </TouchableOpacity>
          {/* Names the shelf actually on screen. A hard-coded "Personal
              Vault" over company files is the audit-S1 class this screen
              already warns about: chrome that asserts something the content
              contradicts. */}
          <Text style={styles.headerTitle}>{shelf === 'Company' ? 'Company Vault' : 'Personal Vault'}</Text>
        </View>
        {/* PERSONAL ONLY. Upload always writes to the personal vault, so on
            the Company shelf this button silently crossed the shelves — the
            fourth such path found in review. The empty-state CTA was already
            gated; this one was not. */}
        {shelf === 'Personal' && <Pressable
          accessibilityRole="button"
          accessibilityLabel="Upload file"
          onPress={() => { Vibration.vibrate(8); setUploadOpen(true); }}
          hitSlop={{top: 4, bottom: 4, left: 4, right: 4}}
          style={({pressed}) => [
            styles.uploadBtn,
            pressed && styles.uploadBtnPressed,
          ]}>
          <Icon name="upload" size={18} color="#FFF" />
        </Pressable>}
      </View>

      {/* B-86 — the real encrypt-and-upload pipeline is wired (per-file
          AES-256, MFA action token per operation). Busy state narrates
          the in-flight transfer; failures alert honestly (S1 class:
          this card must never overclaim). */}
      <View style={styles.encWrap}>
        <View style={styles.encCard}>
          <View style={styles.encLeft}>
            <View style={styles.encIcon}>
              <Icon
                name={busyKey ? 'shield-sync-outline' : 'shield-lock'}
                size={18}
                color={busyKey ? '#F59E0B' : '#4ADE80'}
              />
            </View>
            <View>
              <Text style={styles.encTitle}>
                {busyKey ? 'Securing file…' : 'AES-256 · per-file keys'}
              </Text>
              <Text style={styles.encSub}>
                {busyKey
                  // A company open is a DOWNLOAD + local decrypt, not an
                  // encrypt-and-upload; the card must not overclaim (S1).
                  ? (shelf === 'Company' ? 'Downloading and decrypting' : 'Encrypting and transferring')
                  : shelf === 'Company'
                    // Honest: company files are gated by CHANNEL MEMBERSHIP and
                    // the vault unlock, not by a per-file MFA proof. Claiming
                    // otherwise is exactly the overclaim audit S1 called out.
                    ? 'Shared in your department channels · members only'
                    : 'Every open and upload requires a fresh MFA proof'}
              </Text>
            </View>
          </View>
        </View>
      </View>

      {/* Scope v2 Phase 4 — the SHELF switch (A10 / M11B).
          "Two shelves in the same cupboard: personal files and company files,
          never mixed." Rendered only for someone who actually has a company
          shelf, so a personal account sees this screen exactly as before —
          the PDF forbids redesigning the Vault, and an always-present switch
          with one option would be a redesign for every existing user. */}
      {hasCompanyShelf && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll} contentContainerStyle={styles.tabs}>
          {SHELVES.map(s => (
            <TouchableOpacity
              key={s}
              style={styles.tab}
              onPress={() => setShelf(s)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`${s} files`}>
              <Text style={[styles.tabText, shelf === s && styles.tabTextActive]}>{s}</Text>
              {shelf === s && <View style={styles.tabUnderline} />}
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Tabs — horizontal scroll: at large fontScale the four labels exceed
          a 360dp row and the last tab used to be unreachable (B-680/FS-45). */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll} contentContainerStyle={styles.tabs}>
        {TABS.map(tab => (
          <TouchableOpacity key={tab} style={styles.tab} onPress={() => setActiveTab(tab)} activeOpacity={0.7}>
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>{tab}</Text>
            {activeTab === tab && <View style={styles.tabUnderline} />}
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 24}]}>

        {/* COMPANY SHELF — its own list, never concatenated with the personal
            one. A CompanyFile is a different type from a VaultFile precisely so
            that merging the two would be a type error rather than a quiet
            behaviour change. These files are decryptable only because the
            member holds the channel's group key, so the channel's permissions
            ARE the file's permissions — nothing here re-derives them. */}
        {/* B-848 — the company shelf is a CHANNEL-scoped list, so with no
            workspace context and two or more affiliations it is exactly the
            cross-organisation mix the client rejected: files from two
            companies' channels in one shelf under one "Company Vault" header.
            The SCREEN gates (A5) — `useCompanyShelf` has no auth store, and
            `armDeptConversationRegistry` beside it must stay deliberately
            unscoped or workspace B's files become vaultable. */}
        {shelf === 'Company' && needsWorkspaceChoice && <WorkspaceChoiceGate />}
        {shelf === 'Company' && !needsWorkspaceChoice && (
          // ONE derived list drives the empty state, the count AND the rows.
          // They were three separate reads: the header said "Company · 5" over
          // one row on the Images tab, and a tab with no matches rendered a
          // section header above an empty container with no empty state.
          visibleCompanyFiles.length === 0 ? (
            <View style={styles.emptyState}>
              <Icon name="office-building-outline" size={44} color="rgba(180,188,204,0.45)" />
              <Text style={styles.emptyText}>No company files yet</Text>
              {/* F14 / A10 — say the SCOPE out loud. This shelf is derived from
                  the caller's own channel membership (companyShelf.ts iterates
                  `listChannels`), so an ADMIN sees exactly what a member sees:
                  files from the channels they personally belong to, not the
                  organisation's evidence. The screen used to leave that
                  ambiguous under a header reading "Company Vault", which is the
                  audit-S1 overclaim class this file already warns about.
                  Widening it needs a server-side org-scoped listing AND a key
                  distribution decision — see the F14 note in
                  adminVaultScope.test.ts. */}
              <Text style={styles.emptyHint}>
                Files shared in the department channels you belong to appear here. This shelf
                follows your own channel membership — it is not an organisation-wide archive —
                and it stays separate from your personal vault.
              </Text>
            </View>
          ) : (
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Company · {visibleCompanyFiles.length}</Text>
              </View>
              <View style={styles.docList}>
                {visibleCompanyFiles.map(f => {
                  const iconConf = docIconFor(f.mimeType);
                  return (
                    <TouchableOpacity
                      key={f.objectKey}
                      style={styles.docRow}
                      activeOpacity={0.8}
                      accessibilityRole="button"
                      accessibilityLabel={`${f.name}, from ${f.channelName}`}
                      onPress={() => openCompanyFile(f)}>
                      <View style={[styles.docIcon, {backgroundColor: iconConf.bg}]}>
                        <Icon name={iconConf.name} size={18} color={iconConf.color} />
                      </View>
                      <View style={styles.docInfo}>
                        <Text style={styles.docName} numberOfLines={1}>{f.name}</Text>
                        {/* Provenance, not decoration: it is how a member can
                            tell which channel's permissions govern this file. */}
                        <Text style={styles.docMeta}>
                          {f.channelName}{f.size > 0 ? ` · ${humanSize(f.size)}` : ''}
                        </Text>
                      </View>
                      <View style={styles.docRight}>
                        <Text style={styles.docDate}>{humanDate(f.createdAt)}</Text>
                        <Icon name="download" size={18} color="rgba(180,188,204,0.45)" />
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          )
        )}

        {/* Vault albums — Personal shelf only. The Company shelf is scoped by
            channel membership on the server, so a local folder over it would
            imply an organisation the user does not control. */}
        {shelf === 'Personal' && files.length > 0 && (
          <AlbumBar
            albums={vaultAlbums}
            counts={albumTotals}
            total={files.length}
            active={albumFilter}
            onSelect={setAlbumFilter}
            onCreate={() => setNamingAlbum({mode: 'create'})}
            onManage={album => setNamingAlbum({mode: 'rename', album})}
          />
        )}

        {shelf === 'Personal' && files.length === 0 && (
          <View style={styles.emptyState}>
            <Icon name="shield-lock-outline" size={44} color="rgba(180,188,204,0.45)" />
            <Text style={styles.emptyText}>Your vault is empty</Text>
            <Text style={styles.emptyHint}>Tap the upload button to add your first encrypted file.</Text>
            <Pressable
              onPress={() => setUploadOpen(true)}
              style={({pressed}) => [
                styles.emptyCta,
                pressed && styles.emptyCtaPressed,
              ]}>
              <Icon name="plus" size={16} color="#FFF" />
              <Text style={styles.emptyCtaText}>Upload File</Text>
            </Pressable>
          </View>
        )}

        {shelf === 'Personal' && files.length > 0 && (activeTab === 'All' || activeTab === 'Images') && images.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Images · {images.length}</Text>
            </View>
            {/* B-458 — this used to be `images.slice(0, 3)` beside a "View all"
                style that was never rendered, so a vault with four images
                silently hid the rest with no way to reach them. Documents and
                audio below have always listed in full; images now match, laid
                out as rows of three so the tile styles are unchanged. */}
            <View style={styles.imageRows}>
              {chunkOf3(images).map(row => (
                <View key={row[0].objectKey} style={styles.imageGrid}>
                  {row.map(img => {
                    const uri = (img as unknown as {uri?: string}).uri;
                    return (
                      <TouchableOpacity
                        key={img.objectKey}
                        style={styles.imageCell}
                        activeOpacity={0.8}
                        onPress={() => openInViewer(img)}
                        onLongPress={() => confirmRemove(img)}>
                        <View style={styles.imageBox}>
                          {uri
                            ? <Image source={{uri}} style={styles.imageThumb} resizeMode="cover" />
                            : <Icon name="image" size={32} color="rgba(180,188,204,0.45)" />
                          }
                          <View style={styles.shieldBadge}>
                            <Icon name="shield" size={13} color="#FFF" />
                          </View>
                        </View>
                        <Text style={styles.imageName} numberOfLines={1}>{img.name}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ))}
            </View>
          </View>
        )}

        {shelf === 'Personal' && files.length > 0 && (activeTab === 'All' || activeTab === 'Documents') && documents.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Documents · {documents.length}</Text>
            </View>
            <View style={styles.docList}>
              {documents.map(doc => {
                const iconConf = docIconFor(doc.mimeType);
                return (
                  <TouchableOpacity
                    key={doc.objectKey}
                    style={styles.docRow}
                    activeOpacity={0.8}
                    onPress={() => openInViewer(doc)}
                    onLongPress={() => confirmRemove(doc)}>
                    <View style={[styles.docIcon, {backgroundColor: iconConf.bg}]}>
                      <Icon name={iconConf.name} size={18} color={iconConf.color} />
                    </View>
                    <View style={styles.docInfo}>
                      <Text style={styles.docName} numberOfLines={1}>{doc.name}</Text>
                      <Text style={styles.docMeta}>{humanSize(doc.size)}</Text>
                    </View>
                    <View style={styles.docRight}>
                      <Text style={styles.docDate}>{humanDate(doc.createdAt)}</Text>
                      <Icon name="download" size={18} color="rgba(180,188,204,0.45)" />
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}

        {shelf === 'Personal' && activeTab === 'Audio' && (
          audios.length === 0 ? (
            <View style={styles.emptyState}>
              <Icon name="microphone-off" size={40} color="rgba(180,188,204,0.45)" />
              <Text style={styles.emptyText}>No audio files</Text>
            </View>
          ) : (
            <View style={styles.docList}>
              {audios.map(a => {
                const iconConf = docIconFor(a.mimeType);
                return (
                  <TouchableOpacity key={a.objectKey} style={styles.docRow} activeOpacity={0.8} onPress={() => openInViewer(a)} onLongPress={() => confirmRemove(a)}>
                    <View style={[styles.docIcon, {backgroundColor: iconConf.bg}]}>
                      <Icon name={iconConf.name} size={18} color={iconConf.color} />
                    </View>
                    <View style={styles.docInfo}>
                      <Text style={styles.docName} numberOfLines={1}>{a.name}</Text>
                      <Text style={styles.docMeta}>{humanSize(a.size)}</Text>
                    </View>
                    <Text style={styles.docDate}>{humanDate(a.createdAt)}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )
        )}
      </ScrollView>

      {/* Upload sheet */}
      <Modal visible={uploadOpen} transparent animationType="fade" onRequestClose={() => setUploadOpen(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setUploadOpen(false)}>
          {/* A bottom sheet owes its own bottom inset: with a fixed pad its
              last row sits under the gesture pill / home indicator, where the
              touch target also competes with the system back-swipe. */}
          <Pressable style={[styles.sheet, {paddingBottom: 32 + insets.bottom}]} onPress={e => e.stopPropagation()}>
            <Text style={styles.sheetTitle}>Add to Vault</Text>
            <Text style={styles.sheetHint}>Files are encrypted with AES-256 before upload.</Text>
            <TouchableOpacity style={styles.sheetRow} onPress={() => { void captureImage(); }} activeOpacity={0.75}>
              <View style={[styles.sheetIcon, {backgroundColor: 'rgba(91,141,239,0.12)'}]}>
                <Icon name="camera-outline" size={20} color="#60A5FA" />
              </View>
              <Text style={styles.sheetRowText}>Camera</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.sheetRow} onPress={() => { void pickImage(); }} activeOpacity={0.75}>
              <View style={[styles.sheetIcon, {backgroundColor: 'rgba(167,139,250,0.12)'}]}>
                <Icon name="image-outline" size={20} color="#A78BFA" />
              </View>
              <Text style={styles.sheetRowText}>Photo from Library</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.sheetRow} onPress={() => { void pickDocument(); }} activeOpacity={0.75}>
              <View style={[styles.sheetIcon, {backgroundColor: 'rgba(74,222,128,0.12)'}]}>
                <Icon name="file-outline" size={20} color="#4ade80" />
              </View>
              <Text style={styles.sheetRowText}>Document</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.sheetCancel} onPress={() => setUploadOpen(false)} activeOpacity={0.75}>
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Shared image/audio/video viewer */}
      {/* The COMPANY shelf must not offer vault actions. Omitting
          `vaultSourceKey` is not enough — FileViewer falls back to
          `msg:<id>` — so "Move to Vault" would copy a company file into the
          personal shelf (breaking "never mixed", and putting a copy outside the
          channel's permission inheritance), and "Delete" would claim to remove
          a file it cannot touch. Tracked by WHICH SHELF opened the viewer, not
          by inspecting the file, so it cannot drift if the row shape changes. */}
      <FileViewer
        file={viewerFile}
        onClose={closeViewer}
        allowVaultActions={!viewerIsCompany}
        // B-727 — swipe to the next/previous photo. `busy` keeps the CURRENT
        // photo on screen under a spinner while the next one is minted and
        // decrypted: blanking the viewer would remove the gesture surface, which
        // is precisely the failure B-295 traced to a parked-off-screen image.
        onSwipe={stepViewer}
        busy={pagingKey !== null}
      />

      {/* Album name / rename. Local metadata only — it never touches ciphertext,
          the MFA gate, or a download URL. */}
      {/* B-716 — file an ALREADY-vaulted file into a folder. Hidden while the
          name modal is up: three stacked native Modals is the iOS
          "presentation in progress" trap, the same rule FileViewer follows. */}
      <MoveToAlbumSheet
        visible={albumFor !== null && namingAlbum === null}
        count={1}
        albums={vaultAlbums}
        onClose={() => setAlbumFor(null)}
        onPick={id => {
          if (albumFor) {
            // `null` is a real destination — it is how a file leaves a folder.
            const err = useVaultStore.getState().moveToVaultAlbum([albumFor], id);
            if (err) {
              Alert.alert('Not filed', 'That folder no longer exists — the file stays in your vault, unfiled.');
            }
          }
          setAlbumFor(null);
        }}
        onCreate={() => setNamingAlbum({mode: 'create'})}
      />

      <NameAlbumModal
        visible={namingAlbum !== null}
        title={namingAlbum?.mode === 'rename' ? 'Rename album' : 'New album'}
        initial={namingAlbum?.mode === 'rename' ? namingAlbum.album.name : ''}
        onClose={() => setNamingAlbum(null)}
        onSubmit={name => {
          if (namingAlbum?.mode === 'rename') {
            return useVaultStore.getState().renameVaultAlbum(namingAlbum.album.id, name);
          }
          const {id, error} = useVaultStore.getState().createVaultAlbum(name);
          if (error) {return error;}
          // B-716 — created FROM the move sheet: file the waiting file into it,
          // so "New folder" from that entry point does what it looks like it
          // does. Reached from the album bar instead there is no waiting file,
          // and this stays a plain create.
          if (albumFor && id) {
            const filed = useVaultStore.getState().moveToVaultAlbum([albumFor], id);
            if (filed) {return filed;}
            setAlbumFor(null);
          }
          setNamingAlbum(null);
          return null;
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex:1, backgroundColor:Colors.background},

  header: {flexDirection:'row', alignItems:'center', justifyContent:'space-between', paddingHorizontal:12, paddingTop:6, paddingBottom:8, borderBottomWidth:1, borderBottomColor:'rgba(91,141,239,0.1)'},
  headerLeft: {flexDirection:'row', alignItems:'center', gap:8},
  headerTitle: {color:'#FFFFFF', fontSize:16, fontWeight:'700'},
  uploadBtn: {width:36, height:36, borderRadius:10, backgroundColor:ACTION.default, alignItems:'center', justifyContent:'center', shadowColor: ACTION.default, shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: {width: 0, height: 4}, elevation: 4},
  uploadBtnPressed: {backgroundColor: ACTION.pressed, shadowOpacity: 0.55, transform: [{scale: 0.94}]},

  encWrap: {padding:12},
  encCard: {flexDirection:'row', alignItems:'center', justifyContent:'space-between', borderRadius:12, borderWidth:1, borderColor:'rgba(91,141,239,0.2)', backgroundColor:'rgba(91,141,239,0.07)', paddingHorizontal:12, paddingVertical:10},
  encLeft: {flexDirection:'row', alignItems:'center', gap:10},
  encIcon: {width:32, height:32, borderRadius:16, backgroundColor:'rgba(91,141,239,0.15)', alignItems:'center', justifyContent:'center'},
  encTitle: {color:'#FFFFFF', fontSize:12, fontWeight:'700'},
  encSub: {color:'rgba(229,233,242,0.62)', fontSize:10, marginTop:1},
  encBadgeActive: {flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 99, backgroundColor: 'rgba(74,222,128,0.12)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.3)'},
  encBadgeActiveText: {color: '#4ade80', fontSize: 9, fontWeight: '800', letterSpacing: 1.2},

  tabsScroll: {flexGrow:0, borderBottomWidth:1, borderBottomColor:'rgba(91,141,239,0.1)'},
  tabs: {flexDirection:'row', paddingHorizontal:12, gap:16},
  tab: {paddingVertical:8, paddingHorizontal:4, position:'relative'},
  tabText: {color:'rgba(180,188,204,0.45)', fontSize:12, fontWeight:'700'},
  tabTextActive: {color:'#1E88FF'},
  tabUnderline: {position:'absolute', bottom:0, left:0, right:0, height:2, backgroundColor:'#1E88FF', borderRadius:1},

  content: {paddingHorizontal:12, paddingTop:12},
  section: {marginBottom:20},
  sectionHeader: {flexDirection:'row', justifyContent:'space-between', alignItems:'center', marginBottom:8},
  sectionTitle: {color:'#FFFFFF', fontSize:14, fontWeight:'700'},
  // B-458 — a `viewAll` style used to live here for a "View all" link that was
  // never rendered. Every image is on screen now, so there is nothing to link to.

  imageRows: {gap:8},
  imageGrid: {flexDirection:'row', gap:8},
  imageCell: {flex:1, gap:4, maxWidth: '33%'},
  imageBox: {height:110, borderRadius:12, backgroundColor:'#122747', alignItems:'center', justifyContent:'center', position:'relative', overflow: 'hidden'},
  imageThumb: {width: '100%', height: '100%'},
  shieldBadge: {position:'absolute', top:6, right:6, width:24, height:24, borderRadius:12, backgroundColor:'rgba(91,141,239,0.9)', alignItems:'center', justifyContent:'center'},
  imageName: {color:'rgba(229,233,242,0.62)', fontSize:10, fontWeight:'500'},

  docList: {gap:8},
  docRow: {flexDirection:'row', alignItems:'center', gap:12, backgroundColor:'#122747', borderRadius:12, borderWidth:1, borderColor:'rgba(255,255,255,0.06)', padding:10},
  docIcon: {width:36, height:36, borderRadius:8, alignItems:'center', justifyContent:'center', flexShrink:0},
  docInfo: {flex:1, minWidth:0},
  docName: {color:'#FFFFFF', fontSize:12, fontWeight:'700'},
  docMeta: {color:'rgba(180,188,204,0.45)', fontSize:10, marginTop:2},
  docRight: {alignItems:'flex-end', gap:2},
  docDate: {color:'rgba(180,188,204,0.45)', fontSize:9, fontWeight:'500', textTransform:'uppercase'},

  emptyState: {flex:1, alignItems:'center', justifyContent:'center', paddingTop:60, gap:10, paddingHorizontal: 32},
  emptyText: {color:'rgba(229,233,242,0.62)', fontSize:14, fontWeight:'700', marginTop: 6},
  emptyHint: {color: 'rgba(180,188,204,0.45)', fontSize: 11, textAlign: 'center', lineHeight: 16},
  emptyCta: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 99, backgroundColor: ACTION.default, shadowColor: ACTION.default, shadowOpacity: 0.35, shadowRadius: 10, elevation: 4},
  emptyCtaPressed: {backgroundColor: ACTION.pressed, transform: [{scale: 0.97}]},
  emptyCtaText: {color: '#FFF', fontSize: 13, fontWeight: '800'},

  // Upload sheet
  sheetBackdrop: {flex: 1, backgroundColor: 'rgba(6,20,43,0.75)', justifyContent: 'flex-end'},
  sheet: {backgroundColor: '#0A1F3F', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingTop: 8, paddingBottom: 32, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.09)'},
  sheetTitle: {color: '#FFFFFF', fontSize: 16, fontWeight: '800', textAlign: 'center', marginTop: 12},
  sheetHint: {color: 'rgba(180,188,204,0.45)', fontSize: 11, textAlign: 'center', marginTop: 4, marginBottom: 12},
  sheetRow: {flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, paddingHorizontal: 12, borderRadius: 12, marginVertical: 2, backgroundColor: 'rgba(91,141,239,0.04)'},
  sheetIcon: {width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center'},
  sheetRowText: {color: '#FFFFFF', fontSize: 14, fontWeight: '700'},
  sheetCancel: {marginTop: 10, paddingVertical: 14, alignItems: 'center', borderRadius: 12, backgroundColor: 'rgba(180,199,224,0.06)'},
  sheetCancelText: {color: 'rgba(229,233,242,0.62)', fontSize: 13, fontWeight: '700'},
}));
