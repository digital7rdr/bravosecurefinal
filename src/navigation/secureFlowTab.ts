/**
 * Secure LITE flow footer (PDF-2 "Secure Services Streamlined", client feedback
 * 2026-08-22 "Wrong Nav Bar").
 *
 * Wave 5d put the 4-tab Secure bar (Home · Book · Summary · Messenger) on the
 * `SecureShell` route only. Every DEEPER booking route — the consolidated Secure
 * Transfer / Executive Protection dashboards, the location picker, the credit
 * paywall, the post-confirm Summary surfaces — is a pushed screen in
 * `BookingNavigator`, where the ROOT footer (MESSENGER · PROFILE) came back. The
 * client photographed exactly that under "Confirm Booking". The spec is explicit:
 * "the bottom navigation highlights Booking throughout data entry" and "Summary"
 * on the summary screen.
 *
 * This module is the DECISION, kept pure so it is unit-testable: given the
 * product, the focused root tab, the focused nested booking route (+ its params)
 * and whether the LITE shell is actually mounted beneath, which Secure tab (if
 * any) the root footer should render as the Secure flow bar. The root
 * `CustomTabBar` in MainNavigator consumes it — the bar itself stays a single
 * renderer (no fourth tab-bar component, the B-245 inset contract holds).
 *
 * WHY "SHELL MOUNTED" IS AN INPUT (review round 1, both reviewers): a flow-bar
 * press navigates INTO `SecureShell`. React Navigation's NAVIGATE pops back to a
 * route that already exists in the stack — but PUSHES it when it does not. A PRO
 * retainer client's stack is `[BookingHome, ProDashboard, …]` (no shell), and a
 * LITE deep-link seed can be `[BookingHome, X]`; on those stacks the same press
 * would push the LITE shell ON TOP of a Pro stack. So the bar renders only when
 * a press would be a POP: the shell is beneath the focused route.
 */
import type {SecureShellTabParamList} from './types';

export type SecureFlowTab = keyof SecureShellTabParamList;

/** Founder order, same as the SecureTabNavigator declaration. */
export const SECURE_FLOW_ORDER: readonly SecureFlowTab[] = ['Home', 'Book', 'Summary', 'Messenger'];

/**
 * BookingNavigator route → the Secure tab that must be lit while it is focused.
 *
 * ── PRO TILES CARRY THE PRO BAR — founder, 2026-09-11 (B-857) ────────────────
 *
 * This used to say the opposite: "Pro routes are deliberately absent — they keep
 * the root MESSENGER · PROFILE footer (the client's own Pro dashboard mock shows
 * that footer)". The founder reversed it with the Linked Members screenshot:
 * _"the footer is changed, it should be the same as the dashboard footer. not
 * only linked member — check all the menu."_ Every screen a Pro dashboard TILE
 * opens is part of the Pro shell as far as the user is concerned, so it shows
 * the shell's Home · Book · Summary · Messenger bar with Home lit.
 *
 * Two things did NOT change, and re-deriving either is a regression:
 *
 *  · The Pro APPLICATION flow (`SecureProApply`, `SecureProIntro`,
 *    `SecureProProposal`, `SecureProPayment`) stays OFF this map. It is not
 *    reached from a tile, it holds its fields in local state, and a footer that
 *    pops it is the B-393 class.
 *  · Profile-hosted routes (`IndividualProfile`, `Credits`, …) keep PROFILE via
 *    `PROFILE_HOSTED_ROUTES`, which takes precedence in `secureFlowTabFor`.
 *    `Credits` is the shared wallet, reached from Profile as well as the
 *    Billing tile — one hosting, and Profile's is the older one.
 *
 * `ActivityCenter` (Home), `ZoneMap` (Book) and `BookingHistory` (Summary) were
 * ALREADY on this map at their own tabs; the Pro tiles that open them inherit
 * those, and re-pointing them at Home would break the LITE flow bar.
 */
export const SECURE_FLOW_TAB: Readonly<Record<string, SecureFlowTab>> = {
  // The Book-Now home as a focused STACK route (it is normally the shell's Home
  // tab). Reached this way only beneath a deep link, or as the PRO back target —
  // and for PRO the shell is not mounted, so the guard below yields null there.
  BookingHome: 'Home',
  // "Open existing areas" from Home (PDF-2 Home stage): the plans chooser and
  // its tier surfaces, the activity bell.
  SecureServices: 'Home',
  SecureLux: 'Home',
  Pricing: 'Home',
  TierPaywall: 'Home',
  ActivityCenter: 'Home',
  // B-857 — the Pro dashboard IS the shell's Home tab, so every surface one of
  // its tiles opens belongs to Home. (ActivityCenter above, ZoneMap under Book
  // and BookingHistory under Summary are also Pro-tile targets; they keep the
  // tab they already had, which is the tab the LITE flow needs.)
  SecureProMembers: 'Home',
  SecureProCalendar: 'Home',
  ProAssignedTeam: 'Home',
  SecureProMissions: 'Home',
  SecureProStatus: 'Home',
  ProLiveMission: 'Home',

  // ── Book: service choice + the one-dashboard-per-service flow ─────────────
  ServiceType: 'Book',
  CustomizeAddOns: 'Book',   // the Secure Transfer dashboard
  ExecReview: 'Book',        // the Executive Protection dashboard
  LocationPicker: 'Book',
  ZoneMap: 'Book',
  // Legacy wizard steps — still registered (deep links / stale stacks), so
  // they light Book rather than falling back to the root footer.
  BookingDateTime: 'Book',
  BaselinePackage: 'Book',
  AddOns: 'Book',
  ExecTask: 'Book',
  ExecTransport: 'Book',
  ExecTeam: 'Book',

  // ── Summary: everything the booking becomes after Confirm ─────────────────
  OpsRoomReview: 'Summary',
  BookingConfirmation: 'Summary',
  FindingDetail: 'Summary',
  NoDetail: 'Summary',
  AgencyAccepted: 'Summary',
  LiveTracking: 'Summary',
  SOSScreen: 'Summary',
  TripSummary: 'Summary',
  MissionComplete: 'Summary',
  Invoice: 'Summary',
  RateAgency: 'Summary',
  BookingHistory: 'Summary',  // "My Bookings" — the list of summaries
};

/**
 * `CreditPaywall` is ONE route with three doors, and only one of them is the
 * booking flow: the insufficient-credits detour off Confirm (`source:
 * 'booking-flow'`) lights Book; the retry-charge door off the Ops Room
 * (`'opsroom'`) stays in the Summary context; a wallet top-up from Profile
 * (`'wallet'`, or no source) is not the booking flow at all — root footer.
 */
function creditPaywallTab(params: Record<string, unknown> | null | undefined): SecureFlowTab | null {
  const source = params?.source;
  if (source === 'booking-flow') {return 'Book';}
  if (source === 'opsroom') {return 'Summary';}
  return null;
}

export interface SecureFlowInput {
  /** `useProductStore().activeProduct` — only the Secure product has this bar. */
  activeProduct: string | null | undefined;
  /** The focused ROOT tab route name. */
  focusedRouteName: string;
  /** The focused route INSIDE SecureTab (getFocusedRouteNameFromRoute), if any. */
  nestedRouteName: string | null | undefined;
  /** That focused route's params (for the routes whose door decides the tab). */
  nestedRouteParams?: Record<string, unknown> | null;
  /** True when the nested route is Profile-hosted — PROFILE wins, never this bar. */
  profileHosted: boolean;
  /**
   * True when `SecureShell` is in the SecureTab stack BENEATH the focused route,
   * so a press pops back to it. False (the PRO stack, a cold deep-link seed)
   * means the ordinary root footer — never a bar whose press would push a
   * second shell.
   */
  shellMounted: boolean;
}

/**
 * Which Secure tab to light — or null, meaning "render the ordinary root
 * footer". Null is the safe default for every route not in the map, so a new
 * booking route falls back to the pre-existing behaviour, never to a blank bar.
 */
export function secureFlowTabFor(input: SecureFlowInput): SecureFlowTab | null {
  if (input.activeProduct !== 'secure') {return null;}
  if (input.focusedRouteName !== 'SecureTab') {return null;}
  if (input.profileHosted) {return null;}
  if (!input.shellMounted) {return null;}
  if (!input.nestedRouteName) {return null;}
  if (input.nestedRouteName === 'CreditPaywall') {return creditPaywallTab(input.nestedRouteParams);}
  return SECURE_FLOW_TAB[input.nestedRouteName] ?? null;
}

/**
 * Routes where a flow-bar Home/Summary press pops a surface holding state the
 * store does NOT carry (local picker time, a half-placed pin, a search in
 * flight) — the same "Leave this screen?" confirmation the drawer's Switch
 * Dashboard uses before it truncates a stack (B-393 class). Summary surfaces
 * and the plain chooser hold nothing unsaved, so they pop silently, like the
 * root SECURE tab always has.
 */
export const SECURE_FLOW_CONFIRM_LEAVE: ReadonlySet<string> = new Set([
  'CustomizeAddOns', 'ExecReview', 'LocationPicker', 'ServiceType', 'ZoneMap',
  'BookingDateTime', 'BaselinePackage', 'AddOns',
  'ExecTask', 'ExecTransport', 'ExecTeam',
  /**
   * B-857 critic round — the Pro tile targets are DELIBERATELY ABSENT.
   *
   * The first cut added `SecureProMembers`, `SecureProCalendar` and
   * `ProLiveMission` here "because they hold unsaved input". But this set is
   * ROUTE-keyed, not field-keyed: membership makes EVERY flow-bar press off
   * that route raise the booking confirm. So merely reading Linked Members and
   * tapping Book asked "Going to Book closes the booking screens you have open"
   * — a warning about booking screens that were never open, on a screen with
   * nothing to lose. The prompt has to earn its place: these three are entered
   * to READ, and the wizard routes above are entered to FILL IN.
   */
]);
