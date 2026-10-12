import RedisMock from 'ioredis-mock';
import {LinkService} from './link.service';
import {checkLinkedDevice, LINK_SDID_BASE} from './link-policy';
import type {RedisService} from '../redis/redis.service';
import type {SocketHub} from '../gateway/socket-hub';
import type {PushService} from '../push/push.service';

describe('LinkService (linked devices)', () => {
  let redis: RedisService;
  let emits: Array<{userId: string; event: string; data: unknown}>;
  let wakes: string[];
  let svc: LinkService;

  const U = 'user-a';
  const PHONE = 'install-phone';
  const WEB = 'install-web';
  const item = (s: string) => `lnk1.${Buffer.from(s.padEnd(16, '.')).toString('base64url')}`;

  beforeEach(async () => {
    const client = new RedisMock();
    await client.flushall();
    redis = {client} as unknown as RedisService;
    emits = [];
    wakes = [];
    const hub = {emitToUser: (userId: string, event: string, data: unknown) => emits.push({userId, event, data})} as unknown as SocketHub;
    const push = {sendLinkWake: async (u: string) => { wakes.push(u); return 1; }} as unknown as PushService;
    svc = new LinkService(redis, hub, push);
  });

  async function link(): Promise<string> {
    const {linkId} = await svc.start(U, WEB, 'Chrome on Mac');
    await svc.approve(U, PHONE, linkId);
    return linkId;
  }

  it('start → approve activates the link and assigns a reserved device id', async () => {
    const {linkId} = await svc.start(U, WEB, 'Chrome');
    expect(LinkService.isLinkId(linkId)).toBe(true);
    expect(await svc.status(U, WEB, linkId)).toEqual({status: 'pending'});
    const rec = await svc.approve(U, PHONE, linkId);
    expect(rec.wsDeviceId).toBe(LINK_SDID_BASE);
    expect(await svc.status(U, WEB, linkId)).toEqual({status: 'active', wsDeviceId: LINK_SDID_BASE});
    expect(emits.some(e => e.event === 'link.approved')).toBe(true);
    expect((await svc.list(U)).map(r => r.linkId)).toEqual([linkId]);
  });

  it('a QR from another account cannot be approved (phishing) and is single-use', async () => {
    const {linkId} = await svc.start('user-b', WEB, 'x');
    await expect(svc.approve(U, PHONE, linkId)).rejects.toThrow('link_not_found');
    const mine = await svc.start(U, WEB, 'x');
    await svc.approve(U, PHONE, mine.linkId);
    await expect(svc.approve(U, PHONE, mine.linkId)).rejects.toThrow('link_not_found');
  });

  it('only the other side can read an inbox; items arrive in order and ack trims', async () => {
    const id = await link();
    await svc.send(U, PHONE, id, 'web', [item('a'), item('b')]);
    await expect(svc.send(U, WEB, id, 'web', [item('x')])).rejects.toThrow('not_link_party');
    await expect(svc.inbox(U, PHONE, id, 'web', 0, 50)).rejects.toThrow('not_link_party');
    const got = await svc.inbox(U, WEB, id, 'web', 0, 50);
    expect(got.items.map(i => i.data)).toEqual([item('a'), item('b')]);
    expect(got.items[0].seq).toBeLessThan(got.items[1].seq);
    await svc.ack(U, WEB, id, 'web', got.items[0].seq);
    const rest = await svc.inbox(U, WEB, id, 'web', 0, 50);
    expect(rest.items.map(i => i.data)).toEqual([item('b')]);
  });

  it('a browser message wakes the phone; a phone message does not push', async () => {
    const id = await link();
    await svc.send(U, PHONE, id, 'web', [item('to web')]);
    expect(wakes).toEqual([]);
    await svc.send(U, WEB, id, 'phone', [item('to phone')]);
    await new Promise(r => setImmediate(r));
    expect(wakes).toEqual([U]);
    const got = await svc.inbox(U, PHONE, id, 'phone', 0, 10);
    expect(got.items).toHaveLength(1);
  });

  it('another account cannot touch the link', async () => {
    const id = await link();
    await expect(svc.inbox('user-b', WEB, id, 'web', 0, 10)).rejects.toThrow('link_not_found');
    await expect(svc.revoke('user-b', id)).rejects.toThrow('link_not_found');
  });

  it('revoke clears the record, queues and the device mapping', async () => {
    const id = await link();
    await svc.send(U, PHONE, id, 'web', [item('a')]);
    await svc.revoke(U, id);
    expect(await svc.list(U)).toEqual([]);
    expect(await svc.status(U, WEB, id)).toEqual({status: 'expired'});
    await expect(svc.inbox(U, WEB, id, 'web', 0, 10)).rejects.toThrow('link_not_found');
    expect(await checkLinkedDevice(redis, U, WEB, 1)).toEqual({ok: true, linkId: null});
  });

  it('starting again from the same browser retires its old link', async () => {
    const id = await link();
    await svc.start(U, WEB, 'again');
    expect(await svc.list(U)).toEqual([]);
    expect(await svc.status(U, WEB, id)).toEqual({status: 'expired'});
  });

  it('caps active links per account and reuses freed device ids', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const {linkId} = await svc.start(U, `web-${i}`, 'b');
      ids.push((await svc.approve(U, PHONE, linkId)).linkId);
    }
    const extra = await svc.start(U, 'web-9', 'b');
    await expect(svc.approve(U, PHONE, extra.linkId)).rejects.toThrow('too_many_links');
    await svc.revoke(U, ids[1]);
    const again = await svc.start(U, 'web-8', 'b');
    expect((await svc.approve(U, PHONE, again.linkId)).wsDeviceId).toBe(LINK_SDID_BASE + 1);
  });

  describe('checkLinkedDevice', () => {
    it('phone and standalone web keep device 1', async () => {
      expect(await checkLinkedDevice(redis, U, PHONE, 1)).toEqual({ok: true, linkId: null});
    });
    it('a linked browser may only use its reserved id — never device 1', async () => {
      const id = await link();
      expect(await checkLinkedDevice(redis, U, WEB, LINK_SDID_BASE)).toEqual({ok: true, linkId: id});
      expect(await checkLinkedDevice(redis, U, WEB, 1)).toEqual({ok: false, reason: 'linked_device_restricted'});
      expect(await checkLinkedDevice(redis, U, WEB, 0)).toEqual({ok: true, linkId: id});
      expect(await checkLinkedDevice(redis, U, WEB, LINK_SDID_BASE + 1)).toEqual({ok: false, reason: 'device_not_linked'});
    });
    it('nobody else may claim a reserved id', async () => {
      await link();
      expect(await checkLinkedDevice(redis, U, PHONE, LINK_SDID_BASE)).toEqual({ok: false, reason: 'device_not_linked'});
      expect(await checkLinkedDevice(redis, 'user-b', WEB, LINK_SDID_BASE)).toEqual({ok: false, reason: 'device_not_linked'});
    });
  });
});
