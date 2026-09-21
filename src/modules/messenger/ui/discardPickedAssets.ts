import {deleteEphemeralSource} from '@/modules/messenger/media';
import type {PickedAsset} from './pickedAssets';

/**
 * B-149 for the pre-send tray: an asset the APP created (a camera capture, a
 * voice note — `ephemeralSource`) that the user discards from the tray must
 * not outlive the decision. The send path deletes the plaintext after it is
 * encrypted; this is the other exit. Library picks are never touched (the
 * flag is never set on them — unlinking one would delete the user's photo).
 * Best-effort: a missing file is not an error.
 */
export async function discardPickedAssets(assets: ReadonlyArray<PickedAsset>): Promise<void> {
  for (const a of assets) {
    if (!a.ephemeralSource) {continue;}
    try { await deleteEphemeralSource(a.uri); } catch { /* already gone */ }
  }
}
