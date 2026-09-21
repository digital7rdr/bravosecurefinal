/**
 * PG-C5 — the Calls log must not draw an outgoing unanswered call as a missed
 * (inbound, red) call. Pure mapping + a source scan that the screen uses it.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {callLogDirection, callLogOutcomeLabel} from '../ui/callLogDirection';

describe('PG-C5 — callLogDirection', () => {
  it('outgoing unanswered keeps the OUTGOING arrow and says "Not answered"', () => {
    const meta = {direction: 'outgoing' as const, outcome: 'declined'};
    expect(callLogDirection(meta)).toBe('out');
    expect(callLogOutcomeLabel(meta)).toBe('Not answered');
  });

  it('incoming unanswered is the one true "missed" call', () => {
    for (const outcome of ['missed', 'declined']) {
      const meta = {direction: 'incoming' as const, outcome};
      expect(callLogDirection(meta)).toBe('missed');
      expect(callLogOutcomeLabel(meta)).toBe('Missed');
    }
  });

  it('answered calls keep their direction and show a duration (null label)', () => {
    expect(callLogDirection({direction: 'incoming', outcome: 'answered'})).toBe('in');
    expect(callLogDirection({direction: 'outgoing', outcome: 'answered'})).toBe('out');
    expect(callLogOutcomeLabel({direction: 'outgoing', outcome: 'answered'})).toBeNull();
    expect(callLogOutcomeLabel({direction: 'outgoing', outcome: 'failed'})).toBeNull();
  });

  it('CallsLogScreen maps through the helper, not an inline fold of outcome into direction', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'screens', 'messenger', 'CallsLogScreen.tsx'), 'utf8')
      .replace(/\r\n/g, '\n');
    expect(src).toMatch(/const direction: CallLog\['direction'\] = callLogDirection\(meta\)/);
    expect(src).toMatch(/const outcomeLabel = callLogOutcomeLabel\(/);
    expect(src).not.toMatch(/meta\.outcome === 'missed' \|\| meta\.outcome === 'declined' \? 'missed'/);
  });
});
