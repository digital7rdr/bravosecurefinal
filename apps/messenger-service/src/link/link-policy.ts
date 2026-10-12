import type {RedisService} from '../redis/redis.service';

/**
 * Linked devices (2026-10-12) — "use the messenger in a browser, mirrored from
 * the phone". The phone stays the account's only Signal device (device 1). A
 * linked browser never runs Signal with peers: the phone forwards transcripts
 * to it and relays what it sends, over a private channel whose key the browser
 * hands to the phone in a QR code (the server only ever stores ciphertext).
 *
 * Each linked browser gets its own socket / relay device id from a reserved
 * range so it can hold a live socket WITHOUT taking device 1's socket slot
 * ("superseded") or draining device 1's envelope queue — the two bugs that
 * made opening the web messenger on a phone user's account steal the phone's
 * messages.
 */
export const LINK_SDID_BASE = 100;
export const LINK_MAX_ACTIVE = 4;

/** Redis key: (user, auth install id) → `${linkId}|${wsDeviceId}` for an ACTIVE link. */
export function linkInstallKey(userId: string, installId: string): string {
  return `lnk:inst:${userId}:${installId}`;
}

export type LinkDeviceVerdict =
  | {ok: true; linkId: string | null}
  | {ok: false; reason: 'device_not_linked' | 'linked_device_restricted'};

/**
 * Enforced on every relay HTTP request and every socket handshake:
 *  - a device id in the linked range must belong to THIS install's active link;
 *  - an install that is a linked browser may not act as a Signal device
 *    (ids below the range), so it can never pull or ack the phone's queue.
 * `signalDeviceId` 0 means "no device header" (link-management routes only).
 */
export async function checkLinkedDevice(
  redis: RedisService,
  userId: string,
  installId: string,
  signalDeviceId: number,
): Promise<LinkDeviceVerdict> {
  const raw = await redis.client.get(linkInstallKey(userId, installId));
  const [linkId, ws] = raw ? raw.split('|') : [null, null];
  const wsDeviceId = ws ? Number(ws) : NaN;
  if (signalDeviceId >= LINK_SDID_BASE) {
    if (!linkId || wsDeviceId !== signalDeviceId) return {ok: false, reason: 'device_not_linked'};
    return {ok: true, linkId};
  }
  if (linkId && signalDeviceId > 0) return {ok: false, reason: 'linked_device_restricted'};
  return {ok: true, linkId: linkId ?? null};
}
