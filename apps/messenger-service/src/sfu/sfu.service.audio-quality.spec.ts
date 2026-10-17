import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ConfigService} from '@nestjs/config';
import {SfuService} from './sfu.service';
import type {SfuWorkerPool} from './sfuWorkerPool';

/**
 * 2026-10-17 — owner after the first working group call: "the quality of the
 * sound was bad". Server half of the fix:
 *   1. video producers throttle forwarded keyframe requests (a resume storm
 *      made the sender burst keyframes on the uplink its audio shares);
 *   2. audio producers are untouched (no delay option on audio);
 *   3. the router's advertised Opus default no longer asks for DTX.
 */
describe('SFU audio quality', () => {
  function seeded() {
    const svc = new SfuService({} as unknown as SfuWorkerPool, {get: () => undefined} as unknown as ConfigService);
    const produce: jest.Mock = jest.fn(async (_opts: unknown) => ({id: "prod-1", on: jest.fn()}));
    const sendTransport = {id: 'send-1', produce};
    (svc as unknown as {participants: Map<string, unknown>}).participants.set('tag-1', {
      tag: 'tag-1', roomId: 'room-1', producers: new Map(), sendTransport, recvTransport: {id: 'recv-1'},
    });
    (svc as unknown as {broadcastToRoom: unknown}).broadcastToRoom = jest.fn();
    return {svc, produce};
  }

  it('video producers ask for at most one keyframe per second', async () => {
    const {svc, produce} = seeded();
    await svc.produce('tag-1', 'send-1', 'video', {codecs: [], encodings: []} as never);
    expect(produce).toHaveBeenCalledWith(expect.objectContaining({kind: 'video', keyFrameRequestDelay: 1000}));
  });

  it('audio producers carry no keyframe option', async () => {
    const {svc, produce} = seeded();
    await svc.produce('tag-1', 'send-1', 'audio', {codecs: [], encodings: []} as never);
    const arg = (produce.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(arg.kind).toBe('audio');
    expect(arg).not.toHaveProperty('keyFrameRequestDelay');
  });

  it('the router Opus default does not request DTX', () => {
    const src = readFileSync(join(__dirname, 'sfuWorkerPool.ts'), 'utf8');
    expect(src).toMatch(/'usedtx':\s*0,/);
    expect(src).toMatch(/'useinbandfec':\s*1,/);
  });
});
