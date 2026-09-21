/**
 * PG-N4 / PG-N4r (2026-09-02) — a trailing chat wake must survive a process
 * restart.
 *
 * The trailing wake is an in-process `setTimeout`; its one-per-window NX
 * marker is burned when the timer is armed AND carries only a 2 s TTL — so a
 * marker-keyed boot sweep found nothing after exactly the crash it targeted
 * (a NestJS restart outlives 2 s; critic round). The scheduler therefore also
 * writes a durable INTENT key (JSON of the wake's opts, EX 60) that the
 * firing timer deletes; anything still present at boot is a wake a dead
 * process owed, replayed with its ORIGINAL opts.
 *
 * Same harness as push-chat-wake.spec (module-mocked firebase-admin so the
 * real send branch runs against ioredis-mock).
 */

jest.mock('firebase-admin', () => ({
  apps: [],
  credential: {cert: jest.fn()},
  initializeApp: jest.fn(),
  messaging: jest.fn(),
}));

import {Test} from '@nestjs/testing';
import {ConfigModule} from '@nestjs/config';
import RedisMock from 'ioredis-mock';
import * as admin from 'firebase-admin';
import {RedisService} from '../redis/redis.service';
import {PushService} from './push.service';
import configuration from '../config/configuration';

async function setup(mock: InstanceType<typeof RedisMock>): Promise<PushService> {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({isGlobal: true, load: [configuration]})],
    providers: [
      RedisService,
      PushService,
      {provide: 'IORedisClient', useValue: mock},
    ],
  }).compile();
  const redis = moduleRef.get(RedisService);
  Object.defineProperty(redis, 'client', {value: mock, configurable: true});
  return new PushService(redis);
}

type Swept = {sweepOrphanedTrailingWakes: () => Promise<number>};
const swept = (p: PushService): Swept => p as unknown as Swept;

describe('PushService — PG-N4r orphaned trailing-wake intents', () => {
  let mock: InstanceType<typeof RedisMock>;
  let push: PushService;
  let sendEachForMulticast: jest.Mock;

  beforeEach(async () => {
    mock = new RedisMock();
    push = await setup(mock);
    sendEachForMulticast = jest.fn().mockResolvedValue({successCount: 1, responses: [{success: true}]});
    (admin.messaging as unknown as jest.Mock).mockReturnValue({sendEachForMulticast, sendEach: jest.fn()});
    (push as unknown as {fcmReady: boolean}).fcmReady = true;
    await push.registerDeviceToken({
      userId: 'u1', deviceId: 'd1', platform: 'android', token: 'tok-1', updatedAt: Date.now(),
    });
  });

  afterEach(async () => {
    push.onModuleDestroy();
    await mock.flushall();
    await mock.quit();
  });

  it('replays an intent a dead process left behind — with its ORIGINAL opts — and releases both keys', async () => {
    await mock.set(
      'push-chat-trailing-intent:u1:sender-a',
      JSON.stringify({senderUserId: 'sender-a', conversationId: 'c-9', sentAtMs: 123}),
      'EX', 60,
    );
    await mock.set('push-chat-trailing:u1:sender-a', '1', 'EX', 2); // possibly-stale marker
    const n = await swept(push).sweepOrphanedTrailingWakes();
    expect(n).toBe(1);
    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
    const arg = sendEachForMulticast.mock.calls[0][0] as {tokens: string[]; data: Record<string, string>};
    expect(arg.tokens).toEqual(['tok-1']);
    expect(arg.data.kind).toBe('msg-wake');
    expect(arg.data.senderUserId).toBe('sender-a');
    expect(arg.data.conversationId).toBe('c-9');   // survived — a key-derived rebuild would drop it
    expect(arg.data.sentAtMs).toBe('123');
    expect(await mock.get('push-chat-trailing-intent:u1:sender-a')).toBeNull();
    expect(await mock.get('push-chat-trailing:u1:sender-a')).toBeNull();
  });

  it('a clean keyspace replays nothing; a recipient with no tokens is released without stopping the sweep', async () => {
    expect(await swept(push).sweepOrphanedTrailingWakes()).toBe(0);
    expect(sendEachForMulticast).not.toHaveBeenCalled();

    await mock.set('push-chat-trailing-intent:nobody:sender-a', JSON.stringify({senderUserId: 'sender-a'}), 'EX', 60);
    await mock.set('push-chat-trailing-intent:u1:sender-b', JSON.stringify({senderUserId: 'sender-b'}), 'EX', 60);
    const n = await swept(push).sweepOrphanedTrailingWakes();
    expect(n).toBe(2);
    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
    expect(await mock.get('push-chat-trailing-intent:nobody:sender-a')).toBeNull();
  });

  it('scheduling a trailing wake persists the intent alongside the in-process timer', async () => {
    // First send = leading wake (goes out); second lands inside the debounce
    // window and arms the trailing timer + the durable intent.
    await push.sendChatWake('u1', {senderUserId: 'sender-a'});
    await push.sendChatWake('u1', {senderUserId: 'sender-a', conversationId: 'c-9'});
    await new Promise(r => setTimeout(r, 30));
    const raw = await mock.get('push-chat-trailing-intent:u1:sender-a');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).conversationId).toBe('c-9');
    // afterEach's onModuleDestroy cancels the timer without firing — exactly
    // the rolling-deploy shape whose intent the NEXT boot replays.
  });
});
