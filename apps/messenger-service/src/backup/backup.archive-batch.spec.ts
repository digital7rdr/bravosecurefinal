/**
 * Scale P0-1 — the sealed-envelope archive micro-batch.
 *
 * The relay calls archiveSealedEnvelope once PER ENVELOPE on the send hot
 * path; a group post of N members used to become N individual Supabase
 * upserts. Rows now buffer in-process and flush as ONE multi-row upsert
 * (100 rows / 8MB / 200ms, whichever first). This suite pins the contract:
 *   1. one flush = one upsert carrying every buffered row;
 *   2. the M-7 forgotten-tombstone still gates every row (batch MGET);
 *   3. a flush failure hands the WHOLE batch to the retry outbox;
 *   4. the row-count trigger flushes without waiting for the timer.
 */

import {Test} from '@nestjs/testing';
import {ConfigModule} from '@nestjs/config';
import RedisMock from 'ioredis-mock';
import {RedisService} from '../redis/redis.service';
import {BackupService} from './backup.service';
import configuration from '../config/configuration';

const OUTBOX = 'backup:archive-retry';

function input(envelopeId: string, recipient = 'bob') {
  return {
    recipientUserId: recipient,
    envelopeId,
    outerSealed: 'QUFBQQ==', // valid base64
    timestampMs: 1_700_000_000_000,
  };
}

async function setup(mock: InstanceType<typeof RedisMock>) {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({isGlobal: true, load: [configuration]})],
    providers: [RedisService, BackupService],
  })
    .overrideProvider(RedisService)
    .useValue({client: mock} as unknown as RedisService)
    .compile();
  return moduleRef.get(BackupService);
}

type UpsertCall = {rows: Array<Record<string, unknown>>; opts: unknown};

function fakeSupabase(result: {error: null | {message: string}}) {
  const upserts: UpsertCall[] = [];
  const client = {
    from: (table: string) => ({
      upsert: async (rows: Array<Record<string, unknown>>, opts: unknown) => {
        expect(table).toBe('sealed_envelope_archive');
        upserts.push({rows, opts});
        return result;
      },
    }),
  };
  return {client, upserts};
}

describe('Scale P0-1 — archive micro-batch flush', () => {
  let redis: InstanceType<typeof RedisMock>;
  let svc: BackupService;

  beforeEach(async () => {
    redis = new RedisMock();
    await redis.flushall();
    svc = await setup(redis);
  });

  it('buffers rows and flushes them as ONE multi-row upsert', async () => {
    const {client, upserts} = fakeSupabase({error: null});
    (svc as unknown as {client: unknown}).client = client;
    await svc.archiveSealedEnvelope(input('env-1'));
    await svc.archiveSealedEnvelope(input('env-2', 'carol'));
    // Nothing sent yet — rows are buffered awaiting the timer/size trigger.
    expect(upserts).toHaveLength(0);
    await svc.flushArchiveBuffer();
    expect(upserts).toHaveLength(1);
    expect(upserts[0].rows).toHaveLength(2);
    const ids = upserts[0].rows.map(r => r.envelope_id);
    expect(ids).toEqual(expect.arrayContaining(['env-1', 'env-2']));
    expect(upserts[0].opts).toMatchObject({onConflict: 'recipient_user_id,envelope_id'});
  });

  it('M-7 — a forgotten recipient is dropped from the batch, others still land', async () => {
    const {client, upserts} = fakeSupabase({error: null});
    (svc as unknown as {client: unknown}).client = client;
    await redis.set('backup:forgotten:bob', '1');
    await svc.archiveSealedEnvelope(input('env-1', 'bob'));
    await svc.archiveSealedEnvelope(input('env-2', 'carol'));
    await svc.flushArchiveBuffer();
    expect(upserts).toHaveLength(1);
    expect(upserts[0].rows.map(r => r.recipient_user_id)).toEqual(['carol']);
  });

  it('a flush failure hands the WHOLE batch to the retry outbox', async () => {
    const {client} = fakeSupabase({error: {message: 'connection reset'}});
    (svc as unknown as {client: unknown}).client = client;
    await svc.archiveSealedEnvelope(input('env-1'));
    await svc.archiveSealedEnvelope(input('env-2'));
    await svc.flushArchiveBuffer();
    expect(await redis.llen(OUTBOX)).toBe(2);
    const queued = await redis.lrange(OUTBOX, 0, -1);
    const parsed = queued.map(q => JSON.parse(q) as {envelopeId: string; attempts: number});
    expect(parsed.map(p => p.envelopeId)).toEqual(expect.arrayContaining(['env-1', 'env-2']));
    for (const p of parsed) expect(p.attempts).toBe(1);
  });

  it('a missing archive table drops the batch (a retry can never succeed)', async () => {
    const {client} = fakeSupabase({error: {message: 'relation "sealed_envelope_archive" does not exist'}});
    (svc as unknown as {client: unknown}).client = client;
    await svc.archiveSealedEnvelope(input('env-1'));
    await svc.flushArchiveBuffer();
    expect(await redis.llen(OUTBOX)).toBe(0);
  });

  it('the row-count trigger flushes immediately (no 200ms wait)', async () => {
    const {client, upserts} = fakeSupabase({error: null});
    (svc as unknown as {client: unknown}).client = client;
    for (let i = 0; i < 100; i++) {
      await svc.archiveSealedEnvelope(input(`env-${i}`));
    }
    expect(upserts).toHaveLength(1);
    expect(upserts[0].rows).toHaveLength(100);
  });

  it('duplicate (recipient, envelope) rows dedupe inside one flush (Postgres rejects a twice-affected conflict key)', async () => {
    const {client, upserts} = fakeSupabase({error: null});
    (svc as unknown as {client: unknown}).client = client;
    await svc.archiveSealedEnvelope(input('env-1'));
    await svc.archiveSealedEnvelope(input('env-1'));
    await svc.flushArchiveBuffer();
    expect(upserts[0].rows).toHaveLength(1);
  });
});
