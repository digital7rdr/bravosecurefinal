/**
 * PG-M5 — a retracted caption-less photo must repaint.
 *
 * `applyDeleteForEveryone` sets `deleted_for_all`, blanks `content` and flips
 * `type` to 'text'. A caption-less photo already had `content === ''`, so the
 * old comparator (id/status/content/expires_at/reactions/reply_to) saw NO
 * change and `React.memo` kept the photo on screen after "Delete for
 * everyone". The comparator now lives in `ui/bubbleMemo.ts` so this pin runs
 * against the real function; a source scan proves ChatScreen still uses it.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import type {LocalMessage} from '../store/types';
import {bubblePropsEqual, type BubbleMemoProps} from '../ui/bubbleMemo';

function msg(over: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id: 'm1', conversation_id: 'c1', sender_id: 'self', type: 'image', content: '',
    status: 'sent', is_encrypted: true, created_at: '2026-09-02T10:00:00.000Z',
    peer: {userId: 'u2', deviceId: 1}, media_object_key: 'obj-1', media_mime: 'image/jpeg',
    ...over,
  } as LocalMessage;
}

function props(m: LocalMessage, over: Partial<BubbleMemoProps> = {}): BubbleMemoProps {
  return {msg: m, isFirstInGroup: true, isLastInGroup: true, highlighted: false, ...over};
}

describe('PG-M5 — bubblePropsEqual', () => {
  it('a caption-less photo retracted by delete-for-everyone is NOT equal (must repaint)', () => {
    const before = msg();
    const after  = msg({deleted_for_all: true, content: '', type: 'text', media_object_key: undefined});
    expect(before.content).toBe(after.content);            // the trap: content unchanged
    expect(bubblePropsEqual(props(before), props(after))).toBe(false);
  });

  it('an edit with a byte-identical body still repaints (the "edited" tag)', () => {
    const before = msg({type: 'text', content: 'hi'});
    const after  = msg({type: 'text', content: 'hi', edited_at: 1});
    expect(bubblePropsEqual(props(before), props(after))).toBe(false);
  });

  it('an unchanged row with fresh callback props IS equal (the perf half survives)', () => {
    const m = msg();
    expect(bubblePropsEqual(props(m), props(m))).toBe(true);
  });

  it('status / reactions / reply / grouping flips still repaint', () => {
    const m = msg();
    expect(bubblePropsEqual(props(m), props(msg({status: 'delivered'})))).toBe(false);
    expect(bubblePropsEqual(props(m), props(msg({reactions: {self: '👍'} as never})))).toBe(false);
    expect(bubblePropsEqual(props(m), props(m, {isLastInGroup: false}))).toBe(false);
    expect(bubblePropsEqual(props(m, {album: []}), props(m, {album: []}))).toBe(false); // by reference
  });

  it('ChatScreen memoises MessageBubble with this comparator and no inline copy', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'screens', 'messenger', 'ChatScreen.tsx'), 'utf8')
      .replace(/\r\n/g, '\n');
    expect(src).toMatch(/React\.memo\(MessageBubbleImpl,\s*bubblePropsEqual\)/);
    expect(src).toMatch(/import \{bubblePropsEqual\} from '@\/modules\/messenger\/ui\/bubbleMemo'/);
    // The inline comparator is gone — a second copy would drift exactly the way
    // this one did.
    expect(src).not.toMatch(/prev\.msg\.reply_to_msg_id === next\.msg\.reply_to_msg_id/);
  });
});
