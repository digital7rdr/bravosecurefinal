'use client';

/** IA-17 — the one status chip. Never render a raw enum string again. */

import {pillClass, statusMeta} from '@/lib/status';

export type StatusDomain =
  | 'booking' | 'mission' | 'job' | 'agent' | 'proApplication'
  | 'escrow' | 'protection' | 'proRequest';

export function StatusPill({
  domain, value, dot = true,
}: {domain: StatusDomain; value: string | null | undefined; dot?: boolean}) {
  const meta = statusMeta(domain, value);
  return (
    <span className={pillClass(meta.tone)} title={meta.hint}>
      {dot && <span aria-hidden="true">●</span>} {meta.label}
    </span>
  );
}
