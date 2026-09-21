import {useAuthStore} from '@store/authStore';
import {useActiveWorkspace} from '@store/activeWorkspace';

/**
 * Channels vs2 item 4 — "my shifts" and "my reports" are CROSS-ORG, and say so.
 *
 * ── THE DECISION THIS IMPLEMENTS (founder, 2026-08-12) ───────────────────────
 *
 * Four screens show a person their OWN records: My Attendance, today's shift,
 * My Incidents, and the clock-out button. Every other list in the product is
 * scoped to the organisation being viewed, and so is every write — but these
 * four filter on the person alone, so once somebody belongs to two companies
 * they see both companies' rows under whichever company's branding they happen
 * to be standing in.
 *
 * Scoping them was the tidy answer and it was rejected, for one reason: the
 * workspace context is NOT persisted. It is gone after every restart, every
 * drawer entry, and everywhere in the officer shell (which has no hub at all).
 * A list scoped against a context that is usually absent silently becomes "some
 * of my shifts" — and a missing attendance record is a far worse failure than a
 * confusing extra row.
 *
 * ⚠️ ONE CLAUSE OF THAT PREMISE HAS SINCE CHANGED (vs2 edge A1/A2, 2026-08-13).
 * A notification tap no longer leaves the context null: `adoptOrgContextFromWake`
 * sets it when a wake names an organisation the user belongs to. Two of the four
 * entry paths above are still context-free, so the DECISION stands — but do not
 * quote "every notification tap" as evidence for it again, and note that these
 * four self-reads are precisely the screens that stay unscoped while the writes
 * beside them (clock-in, incident submit) now follow an adopted context.
 *
 * So: keep the data, name the owner. Revisit when the context is persistent and
 * reliable on every entry path, at which point scoping becomes the better end
 * state. Full reasoning and the alternatives considered:
 * `docs/planning/SELF_READ_ORG_SCOPING_BRIEF.md`.
 *
 * ── THAT REVISIT HAPPENED, FOR ONE SHELL (B-856, founder 2026-09-11) ─────────
 *
 * _"attendance should show their own channel attendance. if a member belongs to
 * 2 workspaces his attendance should be shown in their individual channel."_
 *
 * Inside the DEPARTMENTAL shell the premise above has ended: since B-848 every
 * entry into that surface carries a workspace context (a single affiliation is
 * auto-resolved; several open the hub). So those screens send `X-Org-Context`,
 * the server scopes the read, and the labels come OFF — a repeated company name
 * on a list that can only hold one company is noise.
 *
 * The premise has NOT ended for the OFFICER shells (`agent/AttendanceScreen`,
 * `AgentDashboardScreen`, `cpo/OnDutyHomeScreen`). They have no hub and no way
 * to clear a context that is sticky forever once set, so an agency officer who
 * once opened a customer's workspace would find their own agency shift missing
 * and check-in disabled. Those screens pass `{crossOrg: true}`, keep the
 * cross-org read, and keep the labels — unchanged, deliberately.
 *
 * The labels are keyed on the RESPONSE as well as the request: a server that
 * has not been deployed yet ignores the header and answers cross-org anyway, and
 * an unlabelled merged list is the worse failure. See `useShowOrgLabels`.
 *
 * ── WHY THIS IS ONE FUNCTION AND NOT FIVE INLINE CHECKS ──────────────────────
 *
 * Five screens render these rows. Five copies of "should I show a company name"
 * is this repo's most common bug shape — one behaviour, N copies, and copy N+1
 * drifts. A unit test cannot see the fifth copy; there is only ever one here.
 */

/**
 * How many organisations this person can hold records in.
 *
 * `workspaces` covers memberships and an owned workspace. `org` covers the
 * agency side, which never appears in `workspaces` — an agency roster is not an
 * enterable workspace tile — and is exactly the other half of the consultant:
 * an officer at an agency who is also an employee of a company.
 */
function orgCount(user: {
  id?: string;
  workspaces?: ReadonlyArray<{org_id: string}>;
  org?: {id: string} | null;
  managed_org?: {id: string} | null;
  owns_agency?: boolean;
} | null | undefined): number {
  if (!user) {return 0;}
  const ids = new Set<string>();
  // Workspace memberships and an owned workspace.
  for (const w of user.workspaces ?? []) {ids.add(w.org_id);}
  // The discriminator's PRIMARY org — one arm of a four-way COALESCE, so it
  // names at most one thing and is often the agency side.
  if (user.org?.id) {ids.add(user.org.id);}
  /**
   * …and the two agency facts `workspaces` structurally cannot carry.
   *
   * `WORKSPACE_AFFILIATIONS_SQL` INNER JOINs `org_workspaces`, so an agency
   * membership is excluded by construction — correct for the hub (an agency
   * roster is not an enterable tile) and wrong for counting. Without these two,
   * a manager of two agencies, or a company agent who joined someone's
   * workspace, both counted as ONE organisation and saw no labels — the B-417
   * mistake of inferring an agency identity from a proxy instead of the fact
   * that exists for it.
   *
   * `owns_agency` means the caller's own user id IS their org, the convention
   * used everywhere in this codebase.
   */
  if (user.owns_agency === true && user.id) {ids.add(user.id);}
  if (user.managed_org?.id) {ids.add(user.managed_org.id);}
  return ids.size;
}

/** What a scoped caller tells this hook about the read it just made. */
export interface OrgLabelScope {
  /**
   * Did THIS screen send `X-Org-Context`? True only on the Departmental shell
   * (B-856). The officer shells pass `{crossOrg: true}` to the API and leave
   * this false, which is what keeps their list — and their labels — as they are.
   */
  scoped: boolean;
  /**
   * The rows that came back. The request being scoped is not proof the RESPONSE
   * is: an undeployed server ignores the header and answers cross-org with a
   * 200. Pass the rows and a merged list still gets labelled.
   *
   * `org_user_id` is what the comparison KEYS on — it is on the wire for both
   * `ShiftSessionDto` and `IncidentReportDto`. `org_name` is only the fallback
   * for a row that lacks it, and it is a weak one: two organisations are allowed
   * to share a display name, and the first cut compared names alone, so a
   * genuinely cross-org list of two identically-named companies rendered with no
   * labels at all — the exact ambiguity the labels exist to remove.
   */
  rows?: ReadonlyArray<{org_user_id?: string | null; org_name?: string | null}> | null;
}

/**
 * Should a cross-org list label its rows?
 *
 * ONLY when the person actually belongs to more than one organisation. For the
 * overwhelming majority — one employer, one company — a repeated company name
 * on every row is pure noise, and noise on a list people read daily is a real
 * cost. The label has to earn its place by disambiguating something.
 *
 * B-856 — and only when the list can actually hold more than one. A read the
 * caller scoped to the active workspace, which came back naming only that
 * workspace, has nothing left to disambiguate. Both halves are required:
 * dropping the response check would hide the labels on a merged list the
 * moment a server lagged the app.
 */
export function useShowOrgLabels(scope?: OrgLabelScope): boolean {
  const multiOrg = useAuthStore(st => orgCount(st.user) > 1);
  const active = useActiveWorkspace(st => st.workspace);
  if (!multiOrg) {return false;}
  if (!scope?.scoped) {return true;}
  // A "scoped" caller with no context did not actually send the header — the
  // read is cross-org and must say so.
  if (!active) {return true;}
  const activeId = active.org_id;
  const activeName = active.name.trim();
  /**
   * Any row belonging to a DIFFERENT organisation means the scope did not take
   * (an old server), so the list is mixed and must be labelled.
   *
   * ID FIRST. Names are not identifiers — two workspaces may both be called
   * "Meridian", and comparing names alone silently declared that list
   * single-org and dropped every label. `org_name` stays as the fallback for a
   * row an older server sent without an id; a row with neither cannot be
   * labelled anyway, so it cannot make the list look mixed.
   */
  return (scope.rows ?? []).some(r => {
    const id = r?.org_user_id?.trim();
    if (id) {return id !== activeId;}
    const name = r?.org_name?.trim();
    return !!name && name !== activeName;
  });
}

/**
 * The label for one row, or null when it should not be shown.
 *
 * Null (not an empty string) for the single-org case and for a row an older
 * server sent without a name, so callers render nothing rather than an empty
 * chip with padding around it.
 */
export function orgLabelFor(
  row: {org_name?: string | null} | null | undefined,
  show: boolean,
): string | null {
  if (!show) {return null;}
  const name = row?.org_name?.trim();
  return name ? name : null;
}

/**
 * The clock-out confirmation line — always shown, single-org or not.
 *
 * Deliberately NOT gated on `useShowOrgLabels`. Ending a shift is a state
 * change, and the database permits only ONE open session per person across all
 * organisations, so from inside Acme this button can legitimately close a
 * Meridian shift. One body, one shift — the behaviour is right, but nothing on
 * screen said which shift was ending. Naming it costs a string and removes the
 * whole ambiguity, which is why it is unconditional where the list labels are
 * not.
 */
export function endShiftLabel(shift: {
  org_name?: string | null;
  site_label?: string | null;
} | null | undefined): string {
  const parts = [shift?.org_name?.trim(), shift?.site_label?.trim()].filter(Boolean);
  if (!parts.length) {return 'End shift';}
  /**
   * Bounded. The button is a fixed 56dp row with no `numberOfLines`, and both
   * halves are free text — a workspace name has only a not-blank CHECK and
   * `site_label` is bare TEXT. "End shift — Meridian Protective · Gate B" is
   * already wider than a 360dp screen affords at 16px bold, before font
   * scaling. Truncate here rather than at the one call site, so a second
   * caller cannot reintroduce the overflow.
   */
  const detail = parts.join(' · ');
  const clipped = detail.length > 28 ? `${detail.slice(0, 27).trimEnd()}…` : detail;
  return `End shift — ${clipped}`;
}
