/**
 * B-727 — swiping in the VAULT viewer pages to the next / previous photo.
 *
 * Client, 2026-09-02: "in vault i can see the image are being store there. i
 * can see picture by clicking one image but when i do left or right swipe it
 * does not show the next or previous image."
 *
 * Nothing was broken. The paging machinery has existed since B-287 and works in
 * chat — `ZoomableImage` recognises the gesture, animates the slide, and calls
 * `onSwipe`. The vault simply never passed one, which `FileViewer`'s own prop
 * doc admitted outright ("the vault and files viewers pass nothing"). So the
 * gesture was recognised and then discarded, which is indistinguishable from a
 * dead swipe.
 *
 * WHY A SOURCE SCAN. `VaultScreen` is an RN screen wired to expo-local-auth,
 * the image picker, navigation and the vault store; the node project cannot
 * mount it, and the swipe itself runs through native Animated values that no
 * node test can drive (the same reason `imageAlbums.test.ts` pins B-293/B-295
 * by scan). The pure part of the decision — the walk and the no-wrap rule — is
 * NOT re-derived here: `stepViewer` now calls the already-tested `stepVisual`,
 * and this file pins that it does.
 *
 * Traps this file is written against, all three from CLAUDE.md:
 *   - comments are STRIPPED first, or the prose above would satisfy every
 *     assertion by itself,
 *   - the source is CRLF, so nothing is `\n`-anchored — whitespace is collapsed
 *     instead,
 *   - assertions anchor at the DECISION SITE (inside the `<FileViewer` tag,
 *     inside `stepViewer`'s body), never "this token exists somewhere".
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/** Comment-stripped, whitespace-collapsed source. */
function loadNormalised(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/\s+/g, ' ');
}

const vaultSrc = loadNormalised('src', 'screens', 'messenger', 'VaultScreen.tsx');
const viewerSrc = loadNormalised('src', 'modules', 'messenger', 'ui', 'FileViewer.tsx');

/** The text of the single `<FileViewer ... />` element in VaultScreen. */
function fileViewerTag(): string {
  const at = vaultSrc.indexOf('<FileViewer');
  expect(at).toBeGreaterThan(-1);
  const end = vaultSrc.indexOf('/>', at);
  expect(end).toBeGreaterThan(at);
  return vaultSrc.slice(at, end + 2);
}

/** The body of `stepViewer`, from its declaration to the next declaration. */
function stepViewerBody(): string {
  const at = vaultSrc.indexOf('const stepViewer =');
  expect(at).toBeGreaterThan(-1);
  return vaultSrc.slice(at, at + 900);
}

describe('B-727 — the vault viewer is wired for paging at all', () => {
  it('THE BUG: VaultScreen hands FileViewer an onSwipe', () => {
    // This is the whole defect. Before the fix the tag carried exactly three
    // props — file, onClose, allowVaultActions — and no onSwipe, so every
    // recognised swipe reached `onSwipe?.()` on an undefined callback.
    expect(fileViewerTag()).toContain('onSwipe={stepViewer}');
  });

  it('FileViewer still forwards onSwipe into the image branch', () => {
    // The other half of the wire. If this regresses, VaultScreen can pass a
    // perfectly good callback into a component that drops it.
    const at = viewerSrc.indexOf('<ZoomableImage');
    expect(at).toBeGreaterThan(-1);
    expect(viewerSrc.slice(at, viewerSrc.indexOf('/>', at))).toContain('onSwipe={onSwipe}');
  });
});

describe('B-727 — what the swipe is allowed to reach', () => {
  it('pages the FILTERED list the grid drew, never the raw vault', () => {
    // `images` is `inAlbum` filtered to images — it already carries the album
    // filter AND the active tab. Paging `files` instead would walk straight out
    // of the folder the user opened, surfacing photos the screen behind the
    // viewer is deliberately hiding.
    const body = stepViewerBody();
    expect(body).toContain('images.map(f => f.objectKey)');
    expect(body).not.toMatch(/\bfiles\.map\(/);
    expect(body).not.toMatch(/\binAlbum\b/);
  });

  it('pages the COMPANY shelf within its own visible list', () => {
    // The two shelves are separate spaces by founder decision; a swipe must not
    // cross from a company file into the personal vault or vice versa.
    const body = stepViewerBody();
    expect(body).toContain('visibleCompanyFiles.filter');
    expect(body).toContain('categorize(f.mimeType) === \'image\'');
  });

  it('walks through stepVisual, so it cannot wrap', () => {
    // Reuse, not re-derivation: wrapping the last photo round to the first makes
    // it impossible to feel where the set ends, and that rule is already tested
    // once in imageAlbums.test.ts. A hand-rolled `list[at + direction]` here
    // would be a second, untested copy of it.
    expect(stepViewerBody()).toContain('stepVisual(');
    expect(vaultSrc).toContain('stepVisual');
    // And the import has to be real, not a leftover.
    expect(vaultSrc).toMatch(/import \{ ?stepVisual ?\} from '@\/modules\/messenger\/ui\/imageAlbums'/);
  });

  it('anchors paging on objectKey, not the viewer file id', () => {
    // A COMPANY row puts its messageId in `ViewableFile.id`, while both shelf
    // lists key on objectKey — so anchoring on the file id would make the
    // company viewer unable to find itself in its own list, and every swipe
    // there would silently no-op.
    expect(stepViewerBody()).toContain('viewerKey');
    expect(vaultSrc).toContain('setViewerKey(f.objectKey)');
  });
});

describe('B-727 — a page turn cannot corrupt the viewer', () => {
  it('fences every async open against a newer one', () => {
    // A vault photo is fetched (mint -> presigned download -> AES decrypt), so
    // an open can land LATE. Without the fence a slow first photo would yank
    // the viewer back after the user had already paged on, or re-open the
    // viewer after they closed it.
    const opens = vaultSrc.split('setBusyKey(');
    // Both openers (personal + company) take a generation and re-check it.
    expect(vaultSrc).toContain('const gen = (viewerGenRef.current += 1)');
    expect(vaultSrc.match(/if \(gen !== viewerGenRef\.current\) \{return;\}/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(3);
    expect(opens.length).toBeGreaterThan(1);
  });

  it('closing the viewer invalidates an open still in flight', () => {
    const at = vaultSrc.indexOf('const closeViewer =');
    expect(at).toBeGreaterThan(-1);
    const body = vaultSrc.slice(at, at + 300);
    // The bump must come FIRST — clearing state and then bumping leaves a
    // window where a landing open re-populates the viewer the user just closed.
    expect(body.indexOf('viewerGenRef.current += 1'))
      .toBeLessThan(body.indexOf('setViewerFile(null)'));
    expect(body).toContain('setViewerKey(null)');
  });

  it('reuses an already-decrypted uri instead of re-minting', () => {
    // Swiping BACK must not pay for a second MFA mint + download of bytes the
    // user is already looking at. Reusing a cached temp uri issues no new
    // download URL, so the per-file vault MFA gate is untouched.
    expect(vaultSrc).toContain('uriCacheRef.current.get(f.objectKey)');
    expect(vaultSrc).toContain('uriCacheRef.current.set(f.objectKey');
  });

  it('does NOT weaken the vault MFA ceremony', () => {
    // Stop condition. Paging still goes through openVaultFileUri for any photo
    // it has not already decrypted; it must never reach past it to the client.
    expect(vaultSrc).toContain('openVaultFileUri(f)');
    expect(vaultSrc).not.toContain('mfaProof');
    expect(vaultSrc).not.toContain('downloadAndDecrypt');
  });
});

describe('B-727 — the busy cue cannot become the next bug', () => {
  it('the overlay never captures touches', () => {
    // It sits OVER the photo. An overlay that took touches would swallow the
    // very next swipe and reproduce the exact report this fix answers.
    const at = viewerSrc.indexOf('styles.busyOverlay');
    expect(at).toBeGreaterThan(-1);
    expect(viewerSrc.slice(at - 60, at + 120)).toContain('pointerEvents="none"');
  });

  it('the current photo stays mounted while the next one loads', () => {
    // Replacing the image with a spinner would drop the gesture surface
    // mid-page — the shape of the blank-viewer dead end B-295 root-caused.
    const at = viewerSrc.indexOf('{busy && (');
    expect(at).toBeGreaterThan(-1);
    // The image branch renders on `file`, never on `!busy`.
    const imgAt = viewerSrc.indexOf('kind === \'image\'');
    expect(imgAt).toBeGreaterThan(-1);
    expect(viewerSrc.slice(imgAt - 40, imgAt + 40)).not.toContain('busy');
  });
});
