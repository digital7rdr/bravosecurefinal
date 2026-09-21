/**
 * IA-17 — ONE status vocabulary for the whole console.
 *
 * Before this module the same enum was labelled and coloured independently on
 * five pages (bookings, dispatch-inspector, jobs, agents, pro-applications), so
 * DISPATCHING was "info" in one table and "warn" in another and a new server
 * status silently rendered as a raw SCREAMING_SNAKE string. `status.test.ts`
 * asserts every value of every union below has an entry here.
 *
 * `tone` maps to the `.pill-*` classes in globals.css:
 *   ok · warn · err · info · act · live
 */

import type {
  AgentStatus, BookingStatus, JobStatus, MissionStatus, ProApplicationStatus,
} from './api';

export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'act' | 'live' | 'muted';

export interface StatusMeta {
  label: string;
  tone: Tone;
  /** Shown as the chip's help text and in the section landings' queue rows. */
  hint?: string;
}

const title = (s: string) => s.replace(/_/g, ' ');

/* ── Bookings (Lite + Executive share the FSM) ───────────────────────── */

export const BOOKING_STATUS: Record<BookingStatus, StatusMeta> = {
  DRAFT:           {label: 'Draft',           tone: 'muted', hint: 'Never submitted by the client'},
  PENDING_OPS:     {label: 'Pending Ops',     tone: 'warn',  hint: 'Waiting for an operator decision'},
  OPS_APPROVED:    {label: 'Ops Approved',    tone: 'info',  hint: 'Approved — published to the job feed'},
  PAYMENT_PENDING: {label: 'Payment Pending', tone: 'warn',  hint: 'Awaiting the client’s payment'},
  DISPATCHING:     {label: 'Dispatching',     tone: 'info',  hint: 'Auto-dispatch is offering it to agencies'},
  NO_PROVIDER:     {label: 'No Provider',     tone: 'warn',  hint: 'Auto-dispatch found nobody — needs a human'},
  AGENCY_NO_SHOW:  {label: 'Agency No-Show',  tone: 'err',   hint: 'Accepted then failed to arrive'},
  CONFIRMED:       {label: 'Confirmed',       tone: 'ok',    hint: 'Crew assigned, not started'},
  LIVE:            {label: 'Live',            tone: 'live',  hint: 'Mission in progress'},
  COMPLETED:       {label: 'Completed',       tone: 'ok'},
  CANCELLED:       {label: 'Cancelled',       tone: 'err'},
};

/** The statuses that mean "an operator has to do something". Drives the section
 *  landings' work queues and the rail badges. */
export const BOOKING_NEEDS_OPS: BookingStatus[] = ['PENDING_OPS', 'NO_PROVIDER', 'AGENCY_NO_SHOW'];

export const MISSION_STATUS: Record<MissionStatus, StatusMeta> = {
  // 2026-09-04 — crew named by the agency, nobody has moved ("Accepted is not Dispatched").
  CREWED:     {label: 'Crewed',     tone: 'warn', hint: 'Crew assigned, not yet dispatched'},
  DISPATCHED: {label: 'Dispatched', tone: 'info', hint: 'Team moving toward the client, not yet at pickup'},
  PICKUP:     {label: 'At Pickup',  tone: 'info'},
  LIVE:       {label: 'Live',       tone: 'live'},
  SOS:        {label: 'SOS',        tone: 'err',  hint: 'Emergency raised on this mission'},
  COMPLETED:  {label: 'Completed',  tone: 'ok'},
  ABORTED:    {label: 'Aborted',    tone: 'err'},
};

export const JOB_STATUS: Record<JobStatus, StatusMeta> = {
  PUBLISHED:  {label: 'Published',  tone: 'warn', hint: 'Open on the agent feed for applications'},
  REVIEW:     {label: 'In Review',  tone: 'warn', hint: 'Applicants shortlisted, awaiting assignment'},
  ASSIGNED:   {label: 'Assigned',   tone: 'info'},
  DISPATCHED: {label: 'Dispatched', tone: 'ok'},
  CANCELLED:  {label: 'Cancelled',  tone: 'err'},
};

export const AGENT_STATUS: Record<AgentStatus, StatusMeta> = {
  DRAFT:            {label: 'Draft',            tone: 'muted'},
  PROFILE_COMPLETE: {label: 'Profile Complete', tone: 'muted'},
  KYC_PENDING:      {label: 'KYC Pending',      tone: 'warn'},
  DOCS_PENDING:     {label: 'Docs Pending',     tone: 'warn'},
  SUBMITTED:        {label: 'Submitted',        tone: 'warn',  hint: 'Waiting on review'},
  UNDER_REVIEW:     {label: 'Under Review',     tone: 'warn'},
  APPROVED:         {label: 'Approved',         tone: 'info'},
  REJECTED:         {label: 'Rejected',         tone: 'err'},
  ACTIVE:           {label: 'Active',           tone: 'ok'},
};

export const PRO_APPLICATION_STATUS: Record<ProApplicationStatus, StatusMeta> = {
  PENDING_PROPOSAL:   {label: 'New',            tone: 'warn', hint: 'Waiting for ops to write a proposal'},
  REVISION_REQUESTED: {label: 'Revision',       tone: 'warn', hint: 'Client asked for changes'},
  PROPOSAL_CREATED:   {label: 'Proposal Sent',  tone: 'info', hint: 'Waiting on the client'},
  ACCEPTED:           {label: 'Accepted',       tone: 'ok',   hint: 'Paid — assign the dedicated CPO'},
  ACTIVE:             {label: 'Active',         tone: 'live'},
  EXPIRED:            {label: 'Expired',        tone: 'warn'},
  REJECTED:           {label: 'Rejected',       tone: 'err'},
  CANCELLED:          {label: 'Cancelled',      tone: 'err'},
};

/** Escrow hold status — SK-03 verified against the escrow_hold_status enum. */
export type EscrowStatus =
  | 'HELD' | 'PENDING_RELEASE' | 'RELEASED' | 'REFUNDED' | 'PARTIAL' | 'DISPUTED';

export const ESCROW_STATUS: Record<EscrowStatus, StatusMeta> = {
  HELD:            {label: 'Held',            tone: 'info'},
  PENDING_RELEASE: {label: 'Pending Release', tone: 'warn'},
  RELEASED:        {label: 'Released',        tone: 'ok'},
  REFUNDED:        {label: 'Refunded',        tone: 'muted'},
  PARTIAL:         {label: 'Partial',         tone: 'warn'},
  DISPUTED:        {label: 'Disputed',        tone: 'err'},
};

/** Protection session FSM (PROTECTION_SESSIONS_SPEC §3). */
export type ProtectionSessionStatus =
  | 'REQUESTED' | 'ASSIGNED' | 'ACTIVE' | 'COMPLETED' | 'ABORTED';

export const PROTECTION_SESSION_STATUS: Record<ProtectionSessionStatus, StatusMeta> = {
  REQUESTED: {label: 'Requested', tone: 'warn', hint: 'No officer routed yet'},
  ASSIGNED:  {label: 'Assigned',  tone: 'info'},
  ACTIVE:    {label: 'Active',    tone: 'live'},
  COMPLETED: {label: 'Completed', tone: 'ok'},
  ABORTED:   {label: 'Aborted',   tone: 'err'},
};

/** Pro protection DATE requests (pro_mission_requests). */
export const PRO_REQUEST_STATUS: Record<string, StatusMeta> = {
  REQUESTED: {label: 'Requested', tone: 'warn', hint: 'Needs officers assigned'},
  SCHEDULED: {label: 'Scheduled', tone: 'ok'},
  DECLINED:  {label: 'Declined',  tone: 'err'},
  COMPLETED: {label: 'Completed', tone: 'muted'},
  // E2E-07 — added to the CHECK by 20260903100000_pro_mission_activation.sql:58
  // so ops can release a reserved date. `muted`, not `err`: a DECLINED request
  // was refused, whereas a CANCELLED one was a deliberate withdrawal by ops or
  // the client, not a failure to flag. Without an entry here the REGISTRY
  // fallback below finds BOOKING_STATUS.CANCELLED and paints it `err` — a wrong
  // tone with no error, which is why status.test.ts mirrors the server CHECK.
  CANCELLED: {label: 'Cancelled', tone: 'muted', hint: 'Reservation released; officers returned to the pool'},
};

/* ── Lookup ──────────────────────────────────────────────────────────── */

const REGISTRY: Record<string, StatusMeta> = {
  ...(BOOKING_STATUS as Record<string, StatusMeta>),
  ...(JOB_STATUS as Record<string, StatusMeta>),
  ...(AGENT_STATUS as Record<string, StatusMeta>),
  ...(PRO_APPLICATION_STATUS as Record<string, StatusMeta>),
};

/**
 * Resolve a status from a named domain, falling back to a title-cased raw value
 * so an enum the server grows before the console does still reads as words —
 * never as `undefined` (Audit PAGE-21: an unknown job status used to vanish
 * from every bucket).
 */
export function statusMeta(
  domain: 'booking' | 'mission' | 'job' | 'agent' | 'proApplication' | 'escrow' | 'protection' | 'proRequest',
  value: string | null | undefined,
): StatusMeta {
  if (!value) return {label: '—', tone: 'muted'};
  const table: Record<string, StatusMeta> =
      domain === 'booking'        ? BOOKING_STATUS
    : domain === 'mission'        ? MISSION_STATUS
    : domain === 'job'            ? JOB_STATUS
    : domain === 'agent'          ? AGENT_STATUS
    : domain === 'proApplication' ? PRO_APPLICATION_STATUS
    : domain === 'escrow'         ? ESCROW_STATUS
    : domain === 'protection'     ? PROTECTION_SESSION_STATUS
    :                               PRO_REQUEST_STATUS;
  return table[value] ?? REGISTRY[value] ?? {label: title(value), tone: 'muted'};
}

/** The `.pill` className for a tone. `muted` is the bare pill. */
export function pillClass(tone: Tone): string {
  return tone === 'muted' ? 'pill' : `pill pill-${tone}`;
}
