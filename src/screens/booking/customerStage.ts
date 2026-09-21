/**
 * 2026-09-04 — the customer-facing lifecycle vocabulary, ONE place.
 *
 * The SERVER derives `booking.stage` (booking × mission × mode — see
 * customerStageFor in booking.service.ts) and the app renders copy from it.
 * `stageFor` re-derives the same stage locally ONLY when a response predates
 * the field (older server), so every surface still shows one story. The app
 * never decides "dispatched" on its own: "Team dispatched" appears only when
 * the mission is DISPATCHED — an explicit act the agency/lead performed — never
 * because the provider accepted or named a crew.
 *
 * Pure (no RN) so the booking Jest project pins it.
 */
export type CustomerStage =
  | 'draft'
  | 'awaiting_approval'
  | 'scheduled'
  | 'payment_pending'
  | 'finding_provider'
  | 'provider_accepted'
  | 'team_assigned'
  | 'team_dispatched'
  | 'team_arrived'
  | 'service_started'
  | 'sos'
  | 'completed'
  | 'cancelled'
  | 'no_provider'
  | 'agency_no_show';

const STAGES: ReadonlySet<string> = new Set<CustomerStage>([
  'draft', 'awaiting_approval', 'scheduled', 'payment_pending', 'finding_provider',
  'provider_accepted', 'team_assigned', 'team_dispatched', 'team_arrived',
  'service_started', 'sos', 'completed', 'cancelled', 'no_provider', 'agency_no_show',
]);

/** Mirror of the server's customerStageFor — used only when `stage` is absent. */
export function stageFor(b: {
  status?: string | null; mission_status?: string | null; booking_mode?: string | null; stage?: string | null;
}): CustomerStage {
  if (b.stage && STAGES.has(b.stage)) {return b.stage as CustomerStage;}
  const s = (b.status ?? '').toUpperCase();
  const m = (b.mission_status ?? '').toUpperCase();
  if (s === 'COMPLETED') {return 'completed';}
  if (s === 'CANCELLED') {return 'cancelled';}
  if (s === 'NO_PROVIDER') {return 'no_provider';}
  if (s === 'AGENCY_NO_SHOW') {return 'agency_no_show';}
  if (m === 'SOS') {return 'sos';}
  if (m === 'COMPLETED') {return 'completed';}
  if (m === 'LIVE') {return 'service_started';}
  if (m === 'PICKUP') {return 'team_arrived';}
  if (m === 'DISPATCHED') {return 'team_dispatched';}
  if (m === 'CREWED') {return 'team_assigned';}
  if (s === 'LIVE') {return 'service_started';}
  if (s === 'CONFIRMED') {return 'provider_accepted';}
  if (s === 'DISPATCHING') {return 'finding_provider';}
  if (s === 'PAYMENT_PENDING') {return 'payment_pending';}
  if (s === 'OPS_APPROVED') {return b.booking_mode === 'later' ? 'scheduled' : 'finding_provider';}
  if (s === 'PENDING_OPS') {return 'awaiting_approval';}
  return 'draft';
}

export interface StageCopy {
  /** Short chip / row label. */
  label: string;
  /** One-line headline for the tracker header. */
  headline: string;
  /** True while the booking is not finished. */
  open: boolean;
}

/** The founder's vocabulary (2026-09-04), verbatim where given. */
export const STAGE_COPY: Record<CustomerStage, StageCopy> = {
  draft:             {label: 'DRAFT',              headline: 'Draft',                       open: true},
  awaiting_approval: {label: 'AWAITING APPROVAL',  headline: 'Awaiting approval',           open: true},
  scheduled:         {label: 'SCHEDULED',          headline: 'Scheduled',                   open: true},
  payment_pending:   {label: 'PAYMENT DUE',        headline: 'Payment due',                 open: true},
  finding_provider:  {label: 'FINDING PROVIDER',   headline: 'Finding a secure service provider', open: true},
  provider_accepted: {label: 'PROVIDER ACCEPTED',  headline: 'Provider accepted your mission', open: true},
  team_assigned:     {label: 'TEAM ASSIGNED',      headline: 'Team assigned · not yet dispatched', open: true},
  team_dispatched:   {label: 'TEAM DISPATCHED',    headline: 'Team dispatched',             open: true},
  team_arrived:      {label: 'TEAM ARRIVED',       headline: 'Team arrived at pickup',      open: true},
  service_started:   {label: 'SERVICE STARTED',    headline: 'Protection service started',  open: true},
  sos:               {label: 'SOS',                headline: 'SOS active',                  open: true},
  completed:         {label: 'COMPLETED',          headline: 'Service completed',           open: false},
  cancelled:         {label: 'CANCELLED',          headline: 'Booking cancelled',           open: false},
  no_provider:       {label: 'NO PROVIDER',        headline: 'No provider available',       open: false},
  agency_no_show:    {label: 'REFUNDED · NO-SHOW', headline: 'Provider did not crew — refunded', open: false},
};

export function stageCopy(stage: CustomerStage): StageCopy {
  return STAGE_COPY[stage];
}

/** Stages at or past which the customer may be told "dispatched". */
const DISPATCHED_OR_LATER: ReadonlySet<CustomerStage> = new Set<CustomerStage>([
  'team_dispatched', 'team_arrived', 'service_started', 'sos',
]);

/** True ONLY once the team has actually been sent — never on accept or crew pick. */
export function isTeamDispatched(stage: CustomerStage): boolean {
  return DISPATCHED_OR_LATER.has(stage);
}

/** Format an ISO instant as HH:MMZ for the "client received 10:07Z" detail lines. */
export function fmtZ(iso: string | null | undefined): string | null {
  if (!iso) {return null;}
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {return null;}
  return `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}Z`;
}
