/**
 * Human-facing labels for the platform `users.role` DB enum.
 *
 * Why (Audit RS-15): the stored values are internal (`individual`,
 * `service_provider`) but operators read them as Client / Provider. The
 * users list mapped `individual`->'Client' inline while the user-detail
 * and finance screens rendered the raw string, so the same account read
 * as three different roles. Route every role render through here.
 * Keep in sync with the role chips on the users list and the backend
 * `users.role` enum.
 */
const ROLE_LABELS: Record<string, string> = {
  individual: 'Client',
  service_provider: 'Provider',
  agent: 'Agent',
};

export function roleLabel(role: string | null | undefined): string {
  if (!role) return '—';
  return ROLE_LABELS[role] ?? role.replace(/_/g, ' ');
}

// SK-10 — one label for the booking `service` value. The bookings detail
// special-cased executive_protection inline while the live page rendered
// the raw enum; both route through here now.
const SERVICE_LABELS: Record<string, string> = {
  executive_protection: 'Executive Protection',
};

export function bookingServiceLabel(service: string | null | undefined): string {
  if (!service) return '—';
  return SERVICE_LABELS[service] ?? service.replace(/_/g, ' ');
}

/**
 * B-794 — a name a human can act on, from whatever the client reported.
 *
 * Brand and model are independent nullables (iOS reports a brand and no model;
 * a session predating the capture has neither), so this degrades one step at a
 * time and only falls back to the platform word when there is genuinely nothing
 * else. It never invents a name — an un-reported device reads as its platform,
 * which is exactly as much as the server knows.
 */
export function deviceLabel(d: {
  platform: string | null; device_model: string | null; device_brand: string | null;
}): string {
  const brand = d.device_brand?.trim();
  const model = d.device_model?.trim();
  // A model that already carries its brand ("Google Pixel 7a") must not become
  // "Google Google Pixel 7a".
  if (brand && model) {
    return model.toLowerCase().startsWith(brand.toLowerCase()) ? model : `${brand} ${model}`;
  }
  if (model) return model;
  if (d.platform === 'web') return 'Web browser';
  if (brand) return `${brand} ${d.platform === 'ios' ? 'iPhone / iPad' : 'device'}`;
  return d.platform ? d.platform.charAt(0).toUpperCase() + d.platform.slice(1) : 'Unknown device';
}

/** Coarse relative age. Precision beyond a day is noise for a session list. */
export function since(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never';
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return 'never';
  if (ms < 0) return 'just now';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * B-836 — an ops paste (spreadsheet column, WhatsApp list, CSV cell) into the
 * list of numbers the batch-add route is asked about.
 *
 * It repairs, it does not validate: the server's `^\+\d{6,15}$` is the gate, so
 * a token this cannot repair comes back VERBATIM and the card echoes the
 * operator's own line beside `invalid_phone`. Silently dropping a line the
 * operator pasted is the failure mode worth avoiding — they would never learn
 * which name was skipped.
 */
// Why: `+` starts a new number but a space does not — "+971 50 123 4567" is one
// entry and "+971… +880…" is two, so whitespace alone cannot be the separator.
const PHONE_HARD_SEPARATORS = /[\n\r,;]+/;
const PHONE_STRIP = /[\s().-]/g;
const PHONE_ISH = /^[+\d\s().-]+$/;

export function splitPhones(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const segment of String(text ?? '').split(PHONE_HARD_SEPARATORS)) {
    for (const raw of segment.split(/(?=\+)/)) {
      const token = raw.trim();
      if (!token) continue;
      let value = token;
      // Only repair something already shaped like a number. Stripping dots out
      // of "bob@example.com" would hand the operator back a mangled echo of a
      // line they need to recognise.
      if (PHONE_ISH.test(token)) {
        value = token.replace(PHONE_STRIP, '');
        if (value.startsWith('00')) value = `+${value.slice(2)}`;
      }
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/** The server's own gate, mirrored so the card can flag a line before sending it. */
export const E164_RE = /^\+\d{6,15}$/;

/**
 * E2E-48 — what the approve toast should actually say, decided from the
 * server's own report rather than a guess.
 *
 * The toast asserted "Booking approved and published to the job feed" on every
 * path. On the auto lane the server publishes nothing at all — it hands the
 * booking to the offer cascade (ops.service.ts:750-754) — so half the time the
 * copy sent the operator to watch a feed the booking would never appear on.
 *
 * The fourth case is the one worth the whole helper: `dispatch_path:'job_feed'`
 * with `job_published:false` means the approval COMMITTED but the feed publish
 * threw (ops.service.ts:761-805 deliberately does not roll the approval back).
 * The booking is approved and invisible to every agent, and the operator must
 * go dispatch it by hand. That is an ERROR toast, and the old `job: null`
 * response could not distinguish it from a healthy auto approval.
 *
 * Evidence order: `dispatch_path` (explicit) → `job_published` (explicit but
 * ambiguous alone) → the booking row the browser holds (pre-approval, so
 * weakest). When nothing is known it says only what is certainly true.
 *
 * Shape kept structural rather than importing `ApproveBookingResult`: this
 * module is dependency-free on purpose (lib/api.ts pulls in SWR and Next).
 */
export interface ApprovalOutcome {
  kind: 'ok' | 'err';
  text: string;
}

const APPROVED_AUTO_NOW: ApprovalOutcome = {
  kind: 'ok',
  text: 'Booking approved. Auto-dispatch is offering it to agencies now.',
};
const APPROVED_AUTO_LATER: ApprovalOutcome = {
  kind: 'ok',
  text: 'Booking approved and scheduled. Auto-dispatch will search for a crew near the pickup time.',
};
const APPROVED_PUBLISHED: ApprovalOutcome = {
  kind: 'ok',
  text: 'Booking approved and published to the job feed.',
};
const APPROVED_PUBLISH_FAILED: ApprovalOutcome = {
  kind: 'err',
  text: 'Booking approved, but publishing to the job feed FAILED — no agent can see it. Dispatch it manually.',
};
const APPROVED_UNKNOWN: ApprovalOutcome = {kind: 'ok', text: 'Booking approved.'};

export function approvalOutcome(
  res: {job_published?: boolean | null; dispatch_path?: string | null} | null | undefined,
  bookingDispatchMode: string | null | undefined,
): ApprovalOutcome {
  const path = res?.dispatch_path;
  const published = res?.job_published;

  if (path === 'auto_dispatch') return APPROVED_AUTO_NOW;
  if (path === 'auto_scheduled') return APPROVED_AUTO_LATER;
  if (path === 'job_feed') {
    return published === false ? APPROVED_PUBLISH_FAILED : APPROVED_PUBLISHED;
  }

  // No `dispatch_path` — an older server. `job_published:true` is still
  // unambiguous; `false` is not (auto lane, or a failed publish), so fall
  // through to the booking's own lane to break the tie.
  if (published === true) return APPROVED_PUBLISHED;
  if (bookingDispatchMode === 'auto') return APPROVED_AUTO_NOW;
  // A manual booking that reported `job_published:false` really did fail.
  if (published === false && bookingDispatchMode !== undefined) return APPROVED_PUBLISH_FAILED;
  if (bookingDispatchMode === undefined) return APPROVED_UNKNOWN;
  return APPROVED_PUBLISHED;
}

/**
 * E2E-04 — the two refusals `POST /ops/bookings/:id/approve` can return,
 * mirroring `OpsService.APPROVE_START_PASSED` / `APPROVE_LEAD_TOO_SHORT`
 * (ops.service.ts:618-619).
 *
 * Only the lead one is overridable (`ApproveBookingDto.approve_late`).
 * Approving a block that has ALREADY STARTED would hold escrow and start the
 * hourly clock for time the client has lost, so the console must never offer a
 * retry for it — reject-and-refund is the ops action there.
 */
export const APPROVE_START_PASSED = 'booking_start_time_passed';
export const APPROVE_LEAD_TOO_SHORT = 'booking_insufficient_lead_time';

export interface ApproveRefusal {
  code: typeof APPROVE_START_PASSED | typeof APPROVE_LEAD_TOO_SHORT;
  message: string;
  start_time?: string;
  /** Lead refusal only — the service's own ops-editable floor, never hardcoded here. */
  lead_hours?: number;
  earliest_start?: string;
}

/**
 * Narrow a thrown error to one of those two refusals, or null.
 *
 * The check is STRUCTURAL rather than `instanceof ApiError` for two reasons:
 * it keeps this module dependency-free (lib/api.ts pulls in SWR and Next, and
 * the node test project cannot import it), and it does not depend on class
 * identity surviving a bundle boundary. The narrowing is deliberately strict —
 * anything else (a 409, a network failure, a code this console has not been
 * taught) returns null and is handled as an ordinary error. A future refusal
 * that fell through into this path would hand the operator an "approve anyway"
 * button for a rule `approve_late` does not override.
 */
export function approveRefusalOf(e: unknown): ApproveRefusal | null {
  const body = (e as {body?: unknown} | null | undefined)?.body;
  if (!body || typeof body !== 'object') return null;
  const b = body as Partial<ApproveRefusal>;
  if (b.code !== APPROVE_START_PASSED && b.code !== APPROVE_LEAD_TOO_SHORT) return null;
  const fallback = (e as {message?: unknown} | null | undefined)?.message;
  return {
    code: b.code,
    message: typeof b.message === 'string' ? b.message
      : typeof fallback === 'string' ? fallback
      : 'The server refused this approval.',
    start_time: typeof b.start_time === 'string' ? b.start_time : undefined,
    lead_hours: typeof b.lead_hours === 'number' ? b.lead_hours : undefined,
    earliest_start: typeof b.earliest_start === 'string' ? b.earliest_start : undefined,
  };
}
