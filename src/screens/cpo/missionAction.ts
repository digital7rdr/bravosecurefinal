/**
 * missionAction (BUILD_RUNBOOK Step 21) — the pure selector for the ONE context-aware
 * mission button. Lead-only: a non-lead never gets an advance action (they ride along, read-
 * only, with chat + SOS). Maps the mission FSM state to the single next transition:
 *   CREWED     → Dispatch team     (agentApi.missionDispatch, CREWED→DISPATCHED, deliberate confirm)
 *   DISPATCHED → Arrived at pickup (agentApi.missionPickup,  DISPATCHED→PICKUP)
 *   PICKUP     → Client received   (agentApi.missionGoLive,  PICKUP→LIVE, deliberate confirm)
 *   LIVE       → Client Dropped Off(agentApi.missionComplete, LIVE→COMPLETED, deliberate confirm)
 *   SOS / COMPLETED / ABORTED / anything else → none
 * Pure → trivially unit-tested; the field screen renders exactly one button from this.
 *
 * The wording is the founder's, from the August 2026 device-feedback deck and the
 * 2026-09-04 lifecycle brief: "Accepted is not Dispatched", and the billable service
 * window starts ONLY when the officer confirms the client is RECEIVED — not at booking,
 * acceptance, dispatch, or any app clock. A driver confirming that a person is with
 * them should read the sentence they are attesting to.
 *
 * `confirm` on Dispatch and on Client received is required, not cosmetic: Dispatch
 * tells the client "team dispatched"; PICKUP→LIVE stamps live_at (client_received_at),
 * which drives billing, the proof gate, the pre-LIVE full-refund boundary and the
 * executive check-in schedule. The deck asks for "a deliberate tap and confirmation
 * to prevent accidental activation".
 */
export type MissionAction = 'dispatch' | 'start' | 'go-live' | 'finish' | 'none';

/**
 * E2E-45 — what KIND of detail the officer is advancing.
 *
 * The three labels above are vehicle-transport wording ("Client Picked Up",
 * "Confirm the client is in the vehicle", "Client Dropped Off"). An Executive
 * Protection block with no transport leg never picks anyone up and never drops
 * anyone off — ops renders it "On-site detail (no dropoff)" — so the officer was
 * asked to attest to something that did not happen, on the tap that stamps
 * `live_at` and, at the other end, releases payment.
 *
 * 'transport' stays the DEFAULT so every existing call site (and the Secure
 * Transfer lane, which is the overwhelming majority) is untouched.
 */
export type MissionShape = 'transport' | 'on_site';

export interface MissionActionView {
  action: MissionAction;
  label: string;
  /** Require a deliberate swipe-to-confirm (Finish ends the mission + opens settlement). */
  confirm: boolean;
}

export function missionAction(status: string | null | undefined, isLead: boolean): MissionAction {
  if (!isLead) {return 'none';}
  switch ((status ?? '').toUpperCase()) {
    case 'CREWED':     return 'dispatch';
    case 'DISPATCHED': return 'start';
    case 'PICKUP':     return 'go-live';
    case 'LIVE':       return 'finish';
    default:           return 'none'; // SOS / COMPLETED / ABORTED — no lead advance
  }
}

export interface MissionActionConfirm {
  title: string;
  body: string;
  cta: string;
  destructive: boolean;
}

/**
 * The confirmation sheet for an action whose view has `confirm: true`. Lives here
 * so the CPO Mission tab and the driver's live tracker put the SAME sentence in
 * front of the officer — the wording is what they are attesting to, and two
 * screens owning two copies is how that drifts.
 */
export function missionActionConfirm(
  action: MissionAction, shape: MissionShape = 'transport',
): MissionActionConfirm | null {
  const onSite = shape === 'on_site';
  switch (action) {
    case 'dispatch':
      return {
        title: 'Dispatch the team?',
        body: 'Confirm your team is now moving toward the client. The client will be told the team is dispatched.',
        cta: 'Dispatch team',
        destructive: false,
      };
    case 'go-live':
      return onSite
        ? {
          title: 'Start protection?',
          body: 'Confirm you are on site with the principal. This starts the protection block and the billable time, tells the Bravo Control System, and starts the hourly check-in clock.',
          cta: 'Start Protection',
          destructive: false,
        }
        : {
          title: 'Client received?',
          body: 'Confirm the client is in the vehicle. This starts the protection service and the billable time, tells the Bravo Control System, and switches navigation to the drop-off.',
          cta: 'Client received',
          destructive: false,
        };
    case 'finish':
      return onSite
        ? {
          title: 'End protection?',
          body: 'This ends the detail and releases payment to your agency. Only confirm once the block is complete and the principal is stood down.',
          cta: 'End Protection',
          destructive: true,
        }
        : {
          title: 'Client dropped off?',
          body: 'This ends the detail and releases payment to your agency. Only confirm once the principal is safely handed over.',
          cta: 'Client Dropped Off',
          destructive: true,
        };
    default:
      return null;
  }
}

export function missionActionView(
  status: string | null | undefined, isLead: boolean, shape: MissionShape = 'transport',
): MissionActionView {
  const action = missionAction(status, isLead);
  const onSite = shape === 'on_site';
  switch (action) {
    case 'dispatch': return {action, label: 'Dispatch team', confirm: true};
    case 'start': return {action, label: onSite ? 'Arrived on site' : 'Arrived at pickup', confirm: false};
    case 'go-live': return {action, label: onSite ? 'Start Protection' : 'Client received', confirm: true};
    case 'finish': return {action, label: onSite ? 'End Protection' : 'Client Dropped Off', confirm: true};
    default: return {action, label: '', confirm: false};
  }
}

/**
 * E2E-06 — is the lead-initiated "client did not show" report available?
 *
 * Lead-only and PICKUP-only: the officer must be at the pickup point with the
 * mission not yet live. The server owns the grace period from `pickup_time` and
 * refuses with a typed error before it elapses — this gate only decides whether
 * the door is on screen at all.
 */
export function canReportClientNoShow(status: string | null | undefined, isLead: boolean): boolean {
  return isLead && (status ?? '').toUpperCase() === 'PICKUP';
}
