import type {Booking} from '@/lib/web/api';
import {STAGE, stageOf} from '@/lib/web/labels';

export function StagePill({b}: {b: Booking}) {
  const s = STAGE[stageOf(b)];
  const cls = s.tone === 'ok' ? 'pill-ok' : s.tone === 'warn' ? 'pill-warn' : s.tone === 'err' ? 'pill-err'
    : s.tone === 'live' || s.tone === 'info' ? 'pill-act' : '';
  return <span className={`pill ${cls}`}>{s.label}</span>;
}
