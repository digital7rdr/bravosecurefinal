/**
 * Words for the Bravo Web App: booking stages (the app's vocabulary, from
 * screens/booking/customerStage.ts), error codes and small formatters.
 */
import type {Booking} from './api';

export type Stage =
  | 'draft' | 'awaiting_approval' | 'scheduled' | 'payment_pending' | 'finding_provider'
  | 'provider_accepted' | 'team_assigned' | 'team_dispatched' | 'team_arrived'
  | 'service_started' | 'sos' | 'completed' | 'cancelled' | 'no_provider' | 'agency_no_show';

export const STAGE: Record<Stage, {label: string; headline: string; open: boolean; tone: 'ok' | 'warn' | 'err' | 'info' | 'muted' | 'live'}> = {
  draft:             {label: 'Draft',             headline: 'Draft', open: true, tone: 'muted'},
  awaiting_approval: {label: 'Awaiting approval', headline: 'Bravo Secure is reviewing your booking', open: true, tone: 'warn'},
  scheduled:         {label: 'Scheduled',         headline: 'Scheduled', open: true, tone: 'info'},
  payment_pending:   {label: 'Payment due',       headline: 'Approved: pay with your credits to confirm', open: true, tone: 'warn'},
  finding_provider:  {label: 'Finding provider',  headline: 'Finding a secure service provider', open: true, tone: 'info'},
  provider_accepted: {label: 'Provider accepted', headline: 'A provider accepted your mission', open: true, tone: 'info'},
  team_assigned:     {label: 'Team assigned',     headline: 'Team assigned, not yet dispatched', open: true, tone: 'info'},
  team_dispatched:   {label: 'Team dispatched',   headline: 'Team dispatched', open: true, tone: 'live'},
  team_arrived:      {label: 'Team arrived',      headline: 'Team arrived at pick-up', open: true, tone: 'live'},
  service_started:   {label: 'Service started',   headline: 'Protection service started', open: true, tone: 'live'},
  sos:               {label: 'SOS',               headline: 'SOS active', open: true, tone: 'err'},
  completed:         {label: 'Completed',         headline: 'Service completed', open: false, tone: 'ok'},
  cancelled:         {label: 'Cancelled',         headline: 'Booking cancelled', open: false, tone: 'muted'},
  no_provider:       {label: 'No provider',       headline: 'No provider was available', open: false, tone: 'muted'},
  agency_no_show:    {label: 'Refunded',          headline: 'The provider did not crew the job; you were refunded', open: false, tone: 'muted'},
};

/** Mirror of the server's customerStageFor, used only when `stage` is absent. */
export function stageOf(b: Pick<Booking, 'status' | 'mission_status' | 'booking_mode' | 'stage'>): Stage {
  if (b.stage && b.stage in STAGE) return b.stage as Stage;
  const s = (b.status ?? '').toUpperCase();
  const m = (b.mission_status ?? '').toUpperCase();
  if (s === 'COMPLETED') return 'completed';
  if (s === 'CANCELLED') return 'cancelled';
  if (s === 'NO_PROVIDER') return 'no_provider';
  if (s === 'AGENCY_NO_SHOW') return 'agency_no_show';
  if (m === 'SOS') return 'sos';
  if (m === 'COMPLETED') return 'completed';
  if (m === 'LIVE' || s === 'LIVE') return 'service_started';
  if (m === 'PICKUP') return 'team_arrived';
  if (m === 'DISPATCHED') return 'team_dispatched';
  if (m === 'CREWED') return 'team_assigned';
  if (s === 'CONFIRMED') return 'provider_accepted';
  if (s === 'DISPATCHING') return 'finding_provider';
  if (s === 'PAYMENT_PENDING') return 'payment_pending';
  if (s === 'OPS_APPROVED') return b.booking_mode === 'later' ? 'scheduled' : 'finding_provider';
  if (s === 'PENDING_OPS') return 'awaiting_approval';
  return 'draft';
}

/**
 * The HQ-approved flow asks the client to pay once approved. Never on an auto
 * booking: its credits are held when a provider accepts.
 */
export function needsPayment(b: Pick<Booking, 'status' | 'dispatch_mode'>): boolean {
  return b.dispatch_mode !== 'auto' && (b.status === 'OPS_APPROVED' || b.status === 'PAYMENT_PENDING');
}

/** Cancellable while nobody is on the way yet (the server has the final say). */
export function canCancel(b: Pick<Booking, 'status' | 'mission_status'>): boolean {
  if (!['PENDING_OPS', 'OPS_APPROVED', 'PAYMENT_PENDING', 'DISPATCHING', 'CONFIRMED'].includes(b.status)) return false;
  const m = (b.mission_status ?? '').toUpperCase();
  return m === '' || m === 'CREWED';
}

export const TASKS: Array<{id: string; label: string}> = [
  {id: 'close_protection', label: 'Close protection'},
  {id: 'event_security', label: 'Event security'},
  {id: 'site_protection', label: 'Site protection'},
  {id: 'residential_watch', label: 'Residential watch'},
  {id: 'asset_protection', label: 'Asset protection'},
  {id: 'other', label: 'Other'},
];

export const EXEC_ADD_ONS = ['female_cpo', 'recon', 'medical', 'comms'];
export const EXEC_HOURS = [3, 6, 9, 12, 15, 18, 21, 24];

export function serviceName(service: string): string {
  return service === 'executive_protection' ? 'Executive protection' : 'Secure transfer (Lite)';
}

export function whenLong(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', {weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'});
}

/** Server refusal codes → a sentence a client can act on. */
export function webErrorText(e: unknown): string {
  const body = (e as {body?: {message?: string | string[]; error?: string; code?: string}})?.body;
  const raw = (Array.isArray(body?.message) ? body?.message[0] : body?.message) ?? body?.code ?? body?.error ?? (e as Error)?.message ?? '';
  const code = body?.code ?? body?.error ?? raw;
  const map: Record<string, string> = {
    insufficient_credits: 'Your Bravo credits are not enough for this booking. Top up in the Bravo Secure app, then try again.',
    PAYER_CHOICE_REQUIRED: 'Your account pays through more than one family plan. Choose who pays in the Bravo Secure app for this booking.',
    identity_document_required: 'Add your ID or passport (Account page) before your first booking.',
    module_disabled: 'This service is not available on your account.',
    active_booking_exists: 'You already have a booking in progress. Finish or cancel it first.',
    pickup_outside_region: 'The pick-up point is outside the selected area. Pick a point inside it or change the area.',
    consent_required: 'Please accept the location sharing and terms below.',
    auto_dispatch_disabled: 'Booking is briefly unavailable. Try again in a moment.',
    csrf_token_invalid: 'Your session is out of date. Reload the page and try again.',
    booking_not_found: 'This booking could not be found.',
    no_provider_yet: 'No provider has accepted yet.',
  };
  if (map[code]) return map[code];
  if (map[raw]) return map[raw];
  if (/lead.?time|too_soon|start_time/i.test(raw)) return 'Choose a start at least 3 hours from now.';
  if (raw.startsWith('exec_')) return `Check the Executive details: ${raw.replace(/^exec_/, '').replace(/_/g, ' ')}.`;
  if ((e as {status?: number})?.status === 429) return 'Too many attempts. Wait a minute and try again.';
  if (e instanceof TypeError) return 'Cannot reach Bravo Secure. Check your connection and try again.';
  return raw ? raw.replace(/_/g, ' ') : 'Something went wrong. Try again.';
}
