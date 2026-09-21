# Booking Summary & History — product + technical spec (B-786)

> **Status:** P0 + P1 **IMPLEMENTED 2026-09-03** (same session, uncommitted; device pass and
> server deploy OWED). P2 still open — see §5. Nine defects found by adversarial review of
> the first cut are recorded in `sqa.md` B-786; read that table before changing this code.
> Original status line: SPEC ONLY — nothing implemented. Founder ask 2026-09-03 (screenshot of the
> Bravo Secure Pro home, account "Ranak", 1.0.289): _"the booking summary is not ok, no
> history coming. this should be very rich, like each booking with type, payment, time,
> category, all industry standard."_
>
> **Who reads this:** whoever implements the Summary tab rebuild. Every claim below about the
> current code is cited to a symbol so it can be re-grepped (line numbers go stale; symbols
> do not). Run `docs/runbooks/LITE_BOOKING_LOOP.md`, `docs/runbooks/NAV_RAPID_USE_LOOP.md` and
> `DESIGN_REVIEW_LOOP.md` when you build it — the trigger lists in those docs all fire here.

---

## 0. TL;DR

| What the founder sees                                                                    | Why                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Summary tab → "No active booking" every time                                             | `SecureSummaryScreen` renders ONE in-flight booking (via `findResumableBooking`) or an empty state. It has no list, no history, no link to the history screen.                                                                                                                                                           |
| No history anywhere obvious                                                              | A history screen exists (`BookingHistoryScreen`, LM-U8) but is reached only from the Lite Home "View All", the profile drawer "My Bookings" and the Dashboard. A **Pro-ACTIVE** client's Home tab is `ProDashboardScreen` (B-661), which has no "View All", so for the founder's account the list is a drawer-only door. |
| Pro tile "Activity & Reports — Bookings, logs & operational reports" → "No missions yet" | `ProActivityHistoryScreen` calls `agentApi.getMissionHistory()` = `GET /agents/me/missions`, whose SQL is `WHERE mc.agent_id = $1` on `mission_crew`. A client is never crew, so the list is structurally empty for every client.                                                                                        |
| Even the list that exists is thin                                                        | Row = ref · service · date · status chip · credits. No time, no pickup/dropoff, no payment method or payment state, no receipt link, no rating, no category, no grouping, no filters, no paging, and the date is formatted in **UTC** (`timeZone: 'UTC'`), so a 01:00 Gulf booking shows the previous day.               |

**Target:** the Summary tab becomes the client's **Bookings** surface — an overview strip
(active · upcoming · spend), a filterable, month-grouped history of every booking, and a
receipt-grade detail per booking (what, when, where, who, how much, how paid, what happened,
what you can do next). Industry reference: Uber/Bolt trip history + Airbnb "Trips" + a bank
statement's payment detail.

Ordered delivery: **P0** wire the list into the tab and fix the two dead/empty doors →
**P1** enrich the server DTO (payment, receipt, team, rating, timing) + filters + paging →
**P2** timeline, spend stats, Pro-plan / Virtual Bodyguard rows, receipt export.

---

## 1. Current state (evidence)

### 1.1 The Summary tab

- `src/navigation/SecureTabNavigator.tsx` — `Summary` → `SecureSummaryScreen`. The Home tab
  is tier-resolved (`SecureHomeTab`: `ProDashboardScreen` for an ACTIVE Pro application,
  `BookingHomeScreen` otherwise).
- `src/screens/booking/SecureSummaryScreen.tsx` — reads `useBookingStore.bookings`, picks
  `findResumableBooking(bookings)`, renders one card (`status.label`, service label,
  `rowCredits(b)` BC, "View mission") or the empty state ("No active booking … Book
  protection"). No list. No navigation to `BookingHistory`.
- `src/navigation/secureFlowTab.ts` — already maps `BookingHistory: 'Summary'` with the
  comment `"My Bookings" — the list of summaries`, i.e. the shell design intended Summary to
  be the list. The tab just never got it.

### 1.2 The history that exists

- `src/screens/booking/BookingHistoryScreen.tsx` (LM-U8). Row: `shortRef` (`BL-` + last 12
  of the uuid), `rowLabel` (service), `formatDate(start_time ?? created_at)`, status chip
  (`describeStatus`), `rowCredits` (`total_price ?? total_eur ?? estimated_price`). Tap →
  `resumeTargetFor` (in-flight) or `TripSummary`.
  - Reached from: `BookingHomeScreen` "View All" (`navigateOnce(navigation, 'BookingHistory')`),
    `ProfileDrawerModal` "My Bookings", `ProfileScreen` "My Bookings", `DashboardScreen`.
  - Defects: `formatDate` passes `timeZone: 'UTC'` (wrong day for evening/early bookings in
    UTC+4/+6 zones); no time of day; count header is `bookings.length` (page length, see
    §1.4); no filters / grouping / paging; no payment or receipt data because the DTO has none.
- `src/screens/pro/TripHistoryScreen.tsx` — a richer client/agent trip list (filters,
  "ongoing first") that is **registered in `BookingNavigator` but never navigated to** (no
  `navigate('TripHistory'…)` outside `src/navigation`). Dead route.
- `src/screens/pro/ProActivityHistoryScreen.tsx` — the Pro tile's target. Crew-scoped
  endpoint (see §0), so a client always gets `[]` → "No missions yet". Its copy even says
  "Your completed missions will appear here", which is the agent's wording.
- `src/screens/booking/TripSummaryScreen.tsx` — the per-booking detail. Fetches
  `bookingApi.getById`, `assignmentApi.getTeam`, `bookingApi.getEscrow`. Sections: ORDER
  (Pickup / Dropoff / Duration / CPOs / Vehicle / Add-ons / Payment / Total), ROUTE
  (Started / Ended), ASSIGNED TEAM, NOTES, escrow card (PAYMENT ON HOLD → "Confirm and release
  payment", PAYMENT UNDER REVIEW), "Report a problem" (dispute categories), "Rate the agency",
  and the F1 **Invoice** door (`navigate('Invoice')`). This is the right skeleton for the
  detail; it needs the payment/receipt/timeline blocks in §3.6.
- `src/screens/booking/InvoiceScreen.tsx` (F1) — numbered, line-itemised `client_receipt`
  (COMPLETED) or `credit_note` (refunded terminal), served by
  `GET /bookings/:id/invoice` (`invoice.service.ts`, idempotent per `(booking_id, kind)`).
  Reachable **only** through TripSummary.
- `src/screens/wallet/CreditsScreen.tsx` — the ledger tab renders `tx.description || tx.type`;
  the server writes `description = "Booking <full uuid>"` for a booking debit, so the ledger
  shows a raw UUID and nothing links back to the booking.

### 1.3 What the wire carries vs. what the database holds

`GET /bookings` → `booking.service.ts` `list()` → `toClientBooking()` (one row per
`lite_bookings` row) + one batched `missions` query that adds **only** `mission_status`.

| Client gets today (`ClientBooking`)                                                                                                                                                                                                                                                                                       | Stored but NOT returned (`lite_bookings` + relations)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id, status, service, region, region_label, booking_mode, dispatch_mode, start_time, duration_hours, pickup{address,lat,lng}, dropoff, passengers, cpo_count, vehicle_count, driver_only, add_ons[], total_eur, total_aed, payment_method, notes, created_at, conversation_id, task_type, exec_transport, mission_status` | **Booking:** `confirmed_at`, `updated_at`, `payment_captured`, `payer_user_id` (family owner paid), `pricing_breakdown` (quote line items), `rating`, `rating_tags`, `armed_required`, `female_required`, `requirements`, `dispatch_started_at`, `dispatch_settled_at`, `crew_deadline_at`, `arrival_deadline_at`, `not_my_guard_at`, `invoice_pdf_url`, `referral_code`. **Mission** (`missions`): `short_code`, `started_at`, `pickup_at`, `live_at`, `ended_at`, `end_reason`, `route_distance_m`, `route_duration_s`, `vehicle_model/plate/armour`, `risk_level`. **Crew** (`mission_crew`): `role LEAD/CP/DRIVER/RESERVE`, `call_sign`, `is_lead`, `accepted_at`, `checked_in_at`. **Money** (`escrow_holds`): `gross_credits`, `status HELD/PENDING_RELEASE/RELEASED/REFUNDED/PARTIAL/DISPUTED`, `basis full_release/partial/refund/pro_rata/clawback`, `to_client_credits`, `to_provider_credits`, `platform_fee_credits`, `release_eligible_at`, `review_required`, `settled_at`. **Ledger** (`wallet_transactions`, `booking_id` set): `type payment/escrow_hold/escrow_refund/escrow_release/refund`, `amount_credits`, `status`, `created_at`, `actor_user_id`, `feature='booking'`. **Receipt** (`invoices`): `invoice_number`, `kind`, `issued_at`, `total_credits`. **Dispute** (`booking_disputes`): `category`, `status`, `decided_at`, split. **Timeline** (`lite_booking_audit`): `from_status → to_status`, `actor_role`, `metadata.reason`, `created_at` — written on every FSM transition (`BookingService.audit`, `agent.service.ts`, `mission-lead.service.ts`). |

Everything a "rich" row or receipt needs already exists in Postgres. The gap is a DTO and a
screen, not a data model.

### 1.4 Server list contract today

```sql
SELECT * FROM lite_bookings
 WHERE client_id = $1 AND ($2::text IS NULL OR status::text = $2)
 ORDER BY created_at DESC LIMIT 50 OFFSET $3
```

- `page` is accepted (clamped, B-388b) but the mobile client never sends it; `status` is
  allow-listed (`enumParamCast.spec.ts`). No date range, no service, no payment filter.
- `total` is `rows.length` — the page size, not the true count — so no client can render
  "n bookings" or know whether a next page exists.
- Ordered by `created_at`, not by `pickup_time`; an upcoming 'later' booking made a week ago
  sinks below a 'now' booking made yesterday.
- Owner scoping is `client_id` only. A family member's booking paid from the owner's wallet
  (`payer_user_id`) is visible to the member (correct) and NOT to the owner in this list
  (the owner has `familyApi` per-member spend instead).

### 1.5 Adjacent "histories" a Pro client has

| Source                             | Table / API                                                    | What it is                                                                                                                                        | Shown today                                         |
| ---------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Lite on-demand bookings            | `lite_bookings` / `GET /bookings`                              | Secure Transfer, Executive Protection (with `task_type`), Recon Team, Emergency Extraction; paid per booking                                      | `BookingHistoryScreen` (drawer only for Pro)        |
| Pro plan booking requests          | `pro_plan_missions` / `secureProApi.missions(appId)`           | Multi-date protection requests inside the plan period; `REQUESTED/SCHEDULED/DECLINED/COMPLETED`; no per-row charge                                | `SecureProMissionsScreen` ("Booking Requests" tile) |
| Pro plan itself (previous periods) | `pro_applications` / `secureProApi.me().history`               | Each plan period with `total_credits`, `coverage_start/end`, `covered_until`; debited once at activation (`feature='secure_pro_plan'` ledger row) | `SecureProStatus` / previous plans                  |
| Virtual Bodyguard sessions         | `protection_sessions` / `protectionApi.history(limit, before)` | On-demand live-tracking sessions with a CPO; `REQUESTED/ACTIVE/ENDING/COMPLETED/ABORTED`, `sos_active`                                            | `ProtectionHistoryScreen` (VBG module)              |
| Wallet ledger                      | `wallet_transactions` / `walletApi.getTransactions`            | Every credit movement, `booking_id` on booking rows                                                                                               | `CreditsScreen` ledger tab (raw descriptions)       |

---

## 2. What "industry standard" means here (benchmark)

Distilled from Uber / Bolt / Careem trip history, Airbnb Trips, Amazon Orders, Stripe/Revolut
statements. These are the behaviours users expect without being told:

1. **Three buckets, one screen.** Active / Upcoming / Past are visually separated; the active
   one is pinned at the top with a live status, upcoming are chronological ascending, past
   are descending and grouped by month.
2. **A row answers five questions at a glance:** what (service + category), when (date AND
   time, local, with duration), where (pickup → drop-off, or "protection only"), status (one
   canonical chip), how much (amount with sign, and how it was paid).
3. **Money is never ambiguous.** Paid / on hold / released / refunded / partially refunded /
   under review are distinct states with the amount that actually moved, not the quote.
4. **Every completed row has a receipt** (number, line items, tax line, payment method,
   transaction reference, issued date) and a way to get it out (share/export).
5. **Every row has a timeline** (requested → approved → dispatched → arrived → started →
   completed, with who/when) — the "what happened" audit trail, in the user's language.
6. **Filters that match how people search:** by status bucket, by service, by date range, by
   payment state. Search by reference. Everything defaults to "All".
7. **Totals that mean something:** count and spend for the visible filter; "this month" and
   "all time"; for a plan customer, plan used vs plan total.
8. **Actions live on the row/detail:** rebook, rate, report a problem, get receipt, cancel
   (when the state allows), contact support.
9. **States are designed, not accidental:** skeleton while loading, pull-to-refresh, cursor
   paging with "load more", per-filter empty copy, error with retry, offline shows the last
   cached page with a banner, partial failures degrade a block (not the screen).
10. **Accessible and dense at the same time:** 48 dp targets, composed accessibility labels
    per row, fontScale 1.3 survives (FitLine on chips), no horizontal overflow at 320 dp.

---

## 3. Target experience

### 3.1 Information architecture (Summary tab)

```
┌──────────────────────────────────────────────┐
│ BRAVO SECURE                    [Filter ⚲]   │
│ Bookings                                     │
│                                              │
│ ┌ Active ─────────────────────────────────┐  │  ← only when one exists (findResumableBooking)
│ │ ● PROTECTION ACTIVE · Secure Transfer   │  │    tap = resume (existing resumeTargetFor)
│ │ Today 6:30 PM · 4 h · BL-7F3A…          │  │
│ │ Marina → DIFC · Lead: Falcon-2 ▸        │  │
│ └─────────────────────────────────────────┘  │
│ ┌ stats strip ────────────────────────────┐  │
│ │ 12 bookings · 2 upcoming · 4,120 BC/30d │  │  ← Pro: + "Plan 4,000 BC · covered to 03 Nov"
│ └─────────────────────────────────────────┘  │
│ [All] [Upcoming] [Completed] [Cancelled]     │  ← segmented; "Cancelled" = cancelled + refunded + no-detail
│                                              │
│ UPCOMING                                     │
│ ┌──────────────────────────────────────────┐ │
│ │ ▣ Executive Protection · Event Security  │ │
│ │ Sat 06 Sep · 7:00 PM – 11:00 PM (4 h)    │ │
│ │ Atlantis, The Palm · 2 CPO · 1 vehicle   │ │
│ │ ● SCHEDULED           1,240 BC · Credits │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ SEPTEMBER 2026 · 3 bookings · 2,980 BC       │
│ ┌──────────────────────────────────────────┐ │
│ │ ▣ Secure Transfer                        │ │
│ │ Tue 02 Sep · 6:30 PM · 4 h               │ │
│ │ Marina → DIFC · 1 CPO                    │ │
│ │ ● COMPLETED · PAID    980 BC · Credits   │ │
│ │ ★★★★★  · Receipt #BS-000123              │ │
│ └──────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────┐ │
│ │ ▣ Secure Transfer                        │ │
│ │ Mon 01 Sep · 9:00 AM · 2 h               │ │
│ │ ● CANCELLED · REFUNDED   −480 BC         │ │
│ └──────────────────────────────────────────┘ │
│ AUGUST 2026 · …                              │
│                        [Load more]           │
└──────────────────────────────────────────────┘
```

- The Active card is the current `SecureSummaryScreen` card, kept as-is (its resume
  semantics — no auto-yank, tap to open — are deliberate, B-405/LB17). Everything below it is
  new.
- The list is a single `FlatList` with section headers (month groups) — not a `ScrollView` of
  cards — so 200+ bookings stay smooth (see the lag notes in `CLAUDE.md`: UI-thread mounting
  is the measured cost, so windowing matters).
- `BookingHistoryScreen` is **absorbed** by the tab (the drawer / Home "View All" / Dashboard
  doors navigate to `SecureTab → Summary` instead). The `secureFlowTab` mapping already
  treats it as the Summary context. `TripHistoryScreen` (dead route) is deleted.
- The Pro "Activity & Reports" tile targets the same surface (the tile copy "Bookings, logs &
  operational reports" is exactly this). `ProActivityHistoryScreen` is retired or re-pointed.

### 3.2 Row anatomy — every booking, every time

| Slot       | Content                                                                                                                                                           | Source (P1 DTO, §4)                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Icon       | Service glyph (shield-car / shield-account / radar / run-fast); category ring colour (Lite cobalt, Pro plan indigo, VBG green)                                    | `service`, `category`                                                                    |
| Title      | Service label; Executive adds the task type (`execTaskLabel(task_type)`): "Executive Protection · Event Security"                                                 | `service`, `task_type`                                                                   |
| When       | `Tue 02 Sep · 6:30 PM · 4 h`. Upcoming rows show the range (`7:00 – 11:00 PM`). Relative prefix when within 48 h ("Today", "Tomorrow"). Local time, **never UTC** | `start_time`, `duration_hours`, `region_label` (for a zone that differs from the device) |
| Where      | `Pickup → Drop-off` (short place names via `pickup.label ?? address` first segment) or "Protection only" / "Site: <address>" for executive; add `+ transfer leg`  | `pickup`, `dropoff`, `exec_transport`                                                    |
| Team       | `1 CPO · 1 vehicle` (+ "driver only", "armed", "female CPO" chips when true)                                                                                      | `cpo_count`, `vehicle_count`, `driver_only`, `requirements`                              |
| Status     | ONE chip from the canonical table in §3.4 (booking × mission × escrow)                                                                                            | `status`, `mission_status`, `payment.escrow_status`                                      |
| Amount     | `980 BC` right-aligned; refunds negative `−480 BC`; partial: `980 BC · 300 refunded`; secondary `≈ AED 3,600` optional (see §8 Q2)                                | `payment.charged_credits`, `payment.refunded_credits`, `total_aed`                       |
| Paid with  | `Credits` / `Card •• 4242` / `Corporate` / `Plan` — and `Paid by <owner>` for a family member's booking                                                           | `payment.method`, `payment.payer`                                                        |
| Extras     | ★ rating (own), `Receipt #…` when issued, ⚑ "Under review" when a dispute is open                                                                                 | `rating`, `receipt`, `dispute`                                                           |
| Reference  | `BL-XXXXXXXXXXXX` (existing `shortRef`) — keep; it is what support asks for. Mission `short_code` shown in the detail                                             | `id`, `mission.short_code`                                                               |
| a11y label | "Secure Transfer, Tuesday 2 September 6:30 PM, 4 hours, Marina to DIFC, completed and paid, 980 credits, rated 5 stars"                                           | composed                                                                                 |

### 3.3 Category taxonomy

"Category" in the founder's words = which product produced the row. Phase 1 renders Lite
bookings only but the type is designed for the union from day one.

| `category` | `kind`                 | Backing row               | Id prefix | Money model                                    | Statuses                                                                     |
| ---------- | ---------------------- | ------------------------- | --------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| `lite`     | `secure_transfer`      | `lite_bookings`           | `BL-`     | Per booking; escrow (auto) or pay-with-credits | `lite_booking_status` × `mission_status`                                     |
| `lite`     | `executive_protection` | `lite_bookings.task_type` | `BL-`     | Per booking (per-unit block pricing)           | same                                                                         |
| `lite`     | `recon_team`           | `lite_bookings`           | `BL-`     | Per booking                                    | same                                                                         |
| `lite`     | `emergency_extraction` | `lite_bookings`           | `BL-`     | Per booking                                    | same                                                                         |
| `pro_plan` | `plan_mission`         | `pro_plan_missions`       | `PM-`     | Included in plan (no charge row)               | `REQUESTED / SCHEDULED / DECLINED / COMPLETED`                               |
| `pro_plan` | `plan_period`          | `pro_applications`        | `PP-`     | One debit at activation (`total_credits`)      | `ACTIVE / EXPIRED / CANCELLED` (+ pre-activation states hidden from history) |
| `vbg`      | `protection_session`   | `protection_sessions`     | `VB-`     | Included in plan                               | `REQUESTED / ACTIVE / ENDING / COMPLETED / ABORTED`, `sos_active`            |

Executive task types (`EXEC_TASK_TYPES`): Site Protection, Event Security, Close Protection
(Escort), Residential Watch, Asset Protection, Other.

### 3.4 Canonical status vocabulary (the ONE chip)

Rendered by a single pure function `describeBookingRow(status, mission_status, escrow_status,
booking_mode, start_time)` — extend `bookingStatus.ts`, do not fork it. The existing
`describeStatus` colours stay; the labels below are the user-facing words.

| booking `status`   | `mission_status`  | escrow `status`          | Chip (label · colour)                              | Bucket                                          |
| ------------------ | ----------------- | ------------------------ | -------------------------------------------------- | ----------------------------------------------- |
| `DISPATCHING`      | —                 | —                        | SEARCHING · cobalt                                 | Active                                          |
| `PENDING_OPS`      | —                 | —                        | AWAITING APPROVAL · amber                          | Active (or Upcoming when `isUpcomingScheduled`) |
| `OPS_APPROVED`     | —                 | —                        | APPROVED · green (legacy: PAYMENT DUE)             | Active / Upcoming                               |
| `PAYMENT_PENDING`  | —                 | —                        | PAYMENT DUE · blue                                 | Active                                          |
| `CONFIRMED`        | null / `ASSIGNED` | HELD                     | SCHEDULED · blue (upcoming) / CREW ASSIGNED · blue | Upcoming / Active                               |
| `CONFIRMED`        | `DISPATCHED`      | HELD                     | EN ROUTE · cobalt                                  | Active                                          |
| `CONFIRMED`        | `PICKUP`          | HELD                     | ARRIVED · cobalt                                   | Active                                          |
| `CONFIRMED`/`LIVE` | `LIVE`            | HELD                     | PROTECTION ACTIVE · green                          | Active                                          |
| any                | `SOS`             | any                      | SOS · red                                          | Active                                          |
| `COMPLETED`        | `COMPLETED`       | HELD / PENDING_RELEASE   | COMPLETED · PAYMENT ON HOLD · slate                | Past                                            |
| `COMPLETED`        | `COMPLETED`       | RELEASED                 | COMPLETED · PAID · slate                           | Past                                            |
| `COMPLETED`        | `COMPLETED`       | PARTIAL                  | COMPLETED · PARTLY REFUNDED · slate                | Past                                            |
| `COMPLETED`        | any               | DISPUTED                 | UNDER REVIEW · amber                               | Past                                            |
| `COMPLETED`        | any               | (legacy, no hold)        | COMPLETED · PAID · slate                           | Past                                            |
| `CANCELLED`        | any               | REFUNDED / ledger refund | CANCELLED · REFUNDED · red-soft                    | Cancelled                                       |
| `CANCELLED`        | any               | none                     | CANCELLED · red-soft                               | Cancelled                                       |
| `NO_PROVIDER`      | —                 | —                        | NO DETAIL AVAILABLE · amber (not charged)          | Cancelled                                       |
| `AGENCY_NO_SHOW`   | any               | REFUNDED                 | REFUNDED · AGENCY NO-SHOW · amber                  | Cancelled                                       |
| `DRAFT`            | —                 | —                        | hidden from history (never submitted)              | —                                               |

Rules: a live `mission_status` beats the (lagging) booking status — same precedence as
`resumeTargetFor`; the money word comes from escrow, never from `payment_captured` alone
(that flag is legacy pay-with-credits only); `isUpcomingScheduled` decides Upcoming vs
Active for parked 'later' rows (B-405 contract — do not re-derive it).

### 3.5 Payment vocabulary

| Field                 | Meaning                                                                                                   | Derivation                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------- |
| `method`              | `bravo_credits` / `card` / `corporate` / `plan`                                                           | `lite_bookings.payment_method`; Pro rows = `plan`                                                                                  |
| `payer`               | `self` / `family_owner`                                                                                   | `payer_user_id IS NOT NULL AND payer_user_id <> client_id`; label from the owner's display name via `familyApi` (never the id)     |
| `quoted_credits`      | What was quoted at submit                                                                                 | `total_eur` (the BC figure the app already shows) — with `pricing_breakdown` lines for the detail                                  |
| `charged_credits`     | What actually left the wallet                                                                             | `escrow_holds.gross_credits` if a hold exists, else the `payment` ledger row `                                                     | amount_credits | `, else 0 |
| `refunded_credits`    | What came back                                                                                            | sum of `refund` + `escrow_refund` ledger rows for the booking (or `escrow_holds.to_client_credits` when settled)                   |
| `escrow_status/basis` | Where the money is                                                                                        | `escrow_holds.status`, `basis`, `release_eligible_at`, `review_required`                                                           |
| `state` (display)     | `due` / `paid` / `held` / `released` / `refunded` / `partially_refunded` / `under_review` / `not_charged` | pure function of the above; drives the chip's money word and the detail's Payment block                                            |
| `ledger[]`            | The movements, newest first: `{type, amount_credits, created_at, id}`                                     | `wallet_transactions WHERE booking_id = $1 AND user_id = <payer>`; ids are the "transaction reference" a bank statement would show |
| `receipt`             | `{invoice_number, kind, issued_at, total_credits}` or `null`                                              | `invoices` row(s) for the booking; the detail's "View receipt" opens `InvoiceScreen`; list shows the number                        |

Amount rendering: BC is the primary unit everywhere (`creditMath` peg 1 fiat = 1 BC). The
list shows the charged amount; a refund row shows the refund as a negative; partial shows
both. `total_aed` is available for a secondary "≈ AED" line (founder decision, §8 Q2).

### 3.6 Detail (drill-down) — extend `TripSummaryScreen`, do not fork it

Keep ORDER / ROUTE / ASSIGNED TEAM / NOTES / escrow card / dispute / rate / invoice. Add:

1. **Header:** service + task type, canonical chip, `BL-` reference, mission `short_code`,
   category badge, "Booked on <created_at>", "Confirmed on <confirmed_at>".
2. **When & where:** date, start – end (local, 12 h, with the region label), duration, pickup
   / drop-off with the map thumbnail the LiveTracking screen already draws (static, no live
   feed), transfer leg for executive.
3. **Payment block:** method (+ `•• last4` from `SavedCardDto` when card), payer, quoted vs
   charged, escrow state with `release_eligible_at` countdown ("auto-releases in 2 d"),
   refund lines, ledger list with transaction ids, receipt number + "View receipt" + "Share
   receipt" (P2: PDF via `invoice_pdf_url`).
4. **Timeline:** rendered from `lite_booking_audit` + mission timestamps, mapped to user
   language: Requested → Approved by ops → Searching for a team → Team assigned (Falcon-2
   lead) → En route → Arrived (identity verified ✓) → Protection started → Completed → Payment
   released. Each with time; actor shown as role only (You / Bravo Control / Agency / System).
5. **Team:** existing ASSIGNED TEAM (call signs, roles, lead) + vehicle model/plate/armour
   when the mission carries them.
6. **Your rating:** stars + tags if rated; the "Rate the agency" CTA otherwise (COMPLETED only).
7. **Actions row:** Rebook (seeds the draft from this booking → `ServiceType` dashboard),
   Report a problem (existing dispute), Receipt, Cancel (only while `resumeTargetFor` says
   in-flight and the server allows), Help (support chat / hotline).

### 3.7 Filters, sorting, grouping, paging

- **Segments:** All · Upcoming · Completed · Cancelled (buckets from §3.4). Active is not a
  segment — it is the pinned card.
- **Filter sheet:** Service (multi), Date range (presets: 30 d / 90 d / this year / custom),
  Payment state (paid / on hold / refunded / under review), Category (P2: Lite / Pro plan /
  Virtual Bodyguard). Applied filters render as removable chips under the segments. A
  reference search (`BL-…`) is a P2 text field.
- **Sort:** Upcoming ascending by `start_time`; past descending by `start_time` (not
  `created_at`). Server-side; the client never re-sorts a page.
- **Grouping:** month headers with `count · sum(charged − refunded)` for the month.
- **Paging:** cursor (`before=<start_time,id>`, `limit=30`) with "Load more" + automatic
  `onEndReached`; the true `total` for the active filter comes back on every page.
- **Refresh:** pull-to-refresh; focus refetch deduped (`useFocusEffect` + the dedupe rule from
  `NAV_RAPID_USE_LOOP.md` N-series); realtime nudge when a booking's status changes (the
  existing store polling already updates `bookings` — the history slice subscribes to the
  same invalidation).

### 3.8 States

| State             | Behaviour                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading (first)   | Skeleton rows (3) + skeleton stats strip; never a full-screen spinner                                                                                |
| Loading (more)    | Footer spinner; "Load more" disabled with a synchronous ref guard (money-adjacent rule from the nav loop — no double fetch on a double tap)          |
| Empty (no filter) | "No bookings yet" + "Book protection" CTA (existing empty state copy is fine)                                                                        |
| Empty (filtered)  | "No <segment> bookings" + "Clear filters"                                                                                                            |
| Error             | Inline card with the server message (Issue 25: rendered verbatim, already sanitised by `creditErrors`) + Retry                                       |
| Offline           | Last cached page renders with an "Offline — showing saved bookings" banner; cache via `@store/debouncedJsonStorage` (never bare `createJSONStorage`) |
| Partial           | Payment/receipt enrichment failed → the row shows the quote and "Payment details unavailable"; the detail's Payment block gets its own retry         |

### 3.9 Time and locale rules

- Always device-local, 12-hour (`formatBookingTime` in `bookingSummaryRows.ts` is the existing
  rule — reuse it; delete the UTC formatter in `BookingHistoryScreen`).
- Append the zone label when the booking's `region_code` differs from the device zone
  ("6:30 PM GST").
- Relative words only within 48 h ("Today", "Tomorrow", "Yesterday"); otherwise `Tue 02 Sep`.
- Month headers in the device locale (`toLocaleDateString(undefined, {month:'long', year:'numeric'})`).

### 3.10 Navigation & rapid-use contract (from `NAV_RAPID_USE_LOOP.md`)

- Row press → `navigateOnce` (hot forward press). Back → `goBackOnce`. Hardware back on the
  tab stays `firstRoute` (Home), as the shell already declares.
- The detail is pushed in `BookingNavigator` (bubbles up exactly as `BookingHistoryScreen`
  does today) so every existing deep link keeps resolving.
- Filter sheet is a `<Modal>` (raw inset correct there — see the `bottomInsetContract` B-784
  note); the list's bottom padding comes from `useBottomInset().contentBottom`, never
  `insets.bottom + N` under the tab bar (B-245).
- Any button that spends or mutates (Cancel, Confirm & release, Submit dispute) keeps its
  synchronous ref guard reset in `finally`.

### 3.11 Accessibility & responsiveness

- 48 dp minimum for rows and chips; composed `accessibilityLabel` per row (see §3.2).
- fontScale 1.3: chips via `FitLine`, amounts `numberOfLines={1}` with `adjustsFontSizeToFit`,
  two-line titles allowed; 320 dp: the amount column collapses under the title, never a
  horizontal scroll.
- Colour is never the only carrier of status (the chip has the word).
- Obsidian `#07090D` / cobalt `#5B8DEF`, 8-pt grid, Manrope — G8 no-deviation gate.

---

## 4. Data & API design

### 4.1 `GET /bookings/history` (new, additive — `GET /bookings` stays byte-identical)

Keeping `GET /bookings` untouched protects the Home resume logic, the pollers and
`booking.list.spec.ts`. The history endpoint is a separate read model.

```
GET /bookings/history?bucket=all|upcoming|past|cancelled
                     &service=secure_transfer,executive_protection
                     &from=2026-06-01&to=2026-09-30
                     &payment=paid|held|refunded|under_review
                     &limit=30&before=<cursor>
→ {
    total: number,                          // true count for this filter
    next_cursor: string | null,
    summary: {                              // for the stats strip (bucket=all only)
      count_all, count_upcoming, count_active,
      spent_30d_credits, spent_all_credits, refunded_all_credits
    },
    bookings: HistoryBooking[]
  }
```

`HistoryBooking` = `ClientBooking` (unchanged fields) **plus**:

```ts
category: 'lite';                                   // P2: 'pro_plan' | 'vbg'
reference: string;                                  // 'BL-…' computed server-side (one truth)
confirmed_at: string | null;
mission: {
  short_code: string; status: string;
  started_at: string | null; pickup_at: string | null; live_at: string | null;
  ended_at: string | null; end_reason: string | null;
  route_distance_m: number | null; route_duration_s: number | null;
  lead: {call_sign: string; display_name: string | null} | null;
  crew_count: number;
  vehicle: {model: string | null; plate: string | null; armour: string | null} | null;
} | null;
payment: {
  method: 'bravo_credits' | 'card' | 'corporate';
  payer: 'self' | 'family_owner';
  quoted_credits: number; charged_credits: number; refunded_credits: number;
  state: 'due'|'paid'|'held'|'released'|'refunded'|'partially_refunded'|'under_review'|'not_charged';
  escrow: {status: string; basis: string | null; release_eligible_at: string | null; review_required: boolean} | null;
  ledger: Array<{id: string; type: string; amount_credits: number; created_at: string}>;
};
receipt: {invoice_number: string; kind: 'client_receipt'|'credit_note'; issued_at: string; total_credits: number} | null;
rating: {stars: number; tags: string[]} | null;            // rating_remarks NEVER returned
dispute: {status: string; category: string; created_at: string} | null;
requirements: {armed: boolean; female: boolean; driver_only: boolean};
```

The detail (`GET /bookings/:id`) additionally gains `timeline[]` (from `lite_booking_audit`

- mission timestamps, allow-listed `metadata.reason` only, `actor_role` only — never
  `actor_id`) and `pricing_breakdown` lines.

**Query shape (no N+1):** one `lite_bookings` page query keyed on `client_id` with the
filter predicates and a keyset cursor on `(pickup_time, id)`, then FIVE batched `= ANY($ids)`
queries — missions (`DISTINCT ON (booking_id)` with the existing non-ABORTED-first ordering),
crew lead, escrow, ledger, invoices, ratings/disputes come off the booking row itself. Add a
composite index `lite_bookings (client_id, pickup_time DESC, id)` (the 50k-scale index
migration `20260902090000_scale_indexes_50k.sql` is the pattern; check it before adding).

**Owner scoping:** `client_id = $1` always. The ledger sub-query uses the booking's
`payer_user_id ?? client_id` so a family member sees the movements that paid for THEIR
booking without seeing the owner's other transactions (rows are filtered by `booking_id`
first). Amounts only; never the owner's balance.

**Privacy allow-list (do not widen without the architecture doc):** crew `call_sign` +
`display_name` (already exposed by `getVerifyCode` / `getTeam`), vehicle model/plate (already
exposed to Pro clients by Issue 30), no coordinates in the list (pickup/dropoff addresses
only — the row's map thumbnail is detail-only), no `rating_remarks`, no `internal_notes`, no
`ops_note` text beyond what `SecureProMissions` already shows, no actor ids in the timeline.

### 4.2 Client

- `src/services/api.ts`: `bookingApi.history(params)` + the `HistoryBooking` /
  `HistoryPage` types; `bookingApi.getById` type gains `timeline`.
- `src/store/bookingHistoryStore.ts` (new, persisted with `@store/debouncedJsonStorage`):
  `{pages, cursor, total, summary, filters, status: idle|loading|more|error, error}` with
  `load(reset?)`, `loadMore()`, `setFilters()`, `invalidate()`. Keeps `useBookingStore.bookings`
  untouched (that list drives Home resume, B-405 upcoming cards, the LB17 one-mission slot —
  none of which may change).
- `src/screens/booking/bookingStatus.ts`: add `describeBookingRow(...)` (§3.4) and
  `bucketFor(...)`; keep `describeStatus` for the existing callers.
- `src/screens/booking/bookingHistoryRows.ts` (new, RN-free so the `booking` Jest project runs
  it): row view-model builder — title, when, where, team chips, amount strings, a11y label,
  month key. Mirrors the `bookingSummaryRows.ts` honesty rules (render only fields the row
  carries; never default).
- `src/screens/booking/SecureSummaryScreen.tsx`: becomes the composed surface (Active card +
  stats + segments + sectioned list). `BookingHistoryScreen.tsx` is deleted after its doors
  are re-pointed; `TripHistoryScreen.tsx` and `ProActivityHistoryScreen.tsx` are deleted, and
  the Pro dashboard `reports` tile targets `SecureTab → Summary`.
- `src/screens/booking/TripSummaryScreen.tsx`: Payment block, Timeline, Actions row (§3.6).

### 4.3 Pro-plan and Virtual Bodyguard rows (P2)

Two options; recommendation first.

1. **Server union (recommended):** `GET /me/activity` returning the same `HistoryBooking`
   envelope with `category` set, built from three read models (`lite_bookings`,
   `pro_plan_missions` + `pro_applications`, `protection_sessions`) UNION'd on a common
   `(occurred_at, id)` cursor. One list, one cursor, one `total`. Pro rows carry
   `payment.method = 'plan'` and `charged_credits = 0` with a "Included in plan" word; the
   plan period row itself carries the activation debit.
2. Client-side merge of three endpoints — rejected: three cursors cannot page a merged list
   correctly, and the stats strip would be wrong.

Until P2 ships, the Summary tab shows a "Plan" strip for Pro clients (plan total, covered
until, requests count) that links to `SecureProMissions`, and a "Virtual Bodyguard sessions"
link to `ProtectionHistory` — visible, honest, not merged.

### 4.4 Receipt export (P2)

`invoices.pdf_url` + `lite_bookings.invoice_pdf_url` exist and are never written. A
server-side PDF (same line items as `InvoiceDto`) uploaded to the existing S3-compatible
store, served through a short-lived signed URL; "Share receipt" uses the OS share sheet.
Never through the File Vault MFA gate (it is a receipt, not vault content) — but confirm
with the architecture doc before wiring any download-URL issuance (CLAUDE.md stop condition).

---

## 5. Delivery plan

### P0 — make the tab honest (1 session, client only)

| #   | Change                                                                                                                                                                                   | Files                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1 | Render the full booking list under the Active card in the Summary tab (existing `bookings`, month-grouped, bucket segments computed client-side from §3.4)                               | `SecureSummaryScreen.tsx`, `bookingStatus.ts`, new `bookingHistoryRows.ts`                                                                                                      |
| 0.2 | Fix the UTC date formatter; add time of day and duration to the row                                                                                                                      | `bookingHistoryRows.ts` (reuse `formatBookingTime`)                                                                                                                             |
| 0.3 | Re-point the Pro "Activity & Reports" tile and the three `BookingHistory` doors to `SecureTab → Summary`; delete `TripHistoryScreen`, `ProActivityHistoryScreen`, `BookingHistoryScreen` | `ProDashboardScreen.tsx`, `ProfileDrawerModal.tsx`, `ProfileScreen.tsx`, `DashboardScreen.tsx`, `BookingHomeScreen.tsx`, `BookingNavigator.tsx`, `types.ts`, `secureFlowTab.ts` |
| 0.4 | Ledger rows in `CreditsScreen` show "Booking BL-… · Secure Transfer" and deep-link to the detail (client-side lookup by `booking_id` against the store)                                  | `CreditsScreen.tsx`                                                                                                                                                             |

P0 ships on the current DTO: rows will show quote amount + `payment_method` but not escrow
state or receipts. That is stated on the row as "Quoted" until P1 lands.

### P1 — the rich row (server + client)

| #   | Change                                                                                         | Files                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1.1 | `GET /bookings/history` per §4.1 with filters, cursor, true `total`, `summary`                 | `booking.controller.ts`, `booking.service.ts` (or a new `booking-history.service.ts`), `dto/`, migration for the index |
| 1.2 | `GET /bookings/:id` gains `timeline`, `pricing_breakdown`, `payment`, `receipt`, `rating`      | `booking.service.ts`, `invoice.service.ts`                                                                             |
| 1.3 | Client store + API + row/detail rendering of payment state, receipt number, rating, team, lead | `api.ts`, `bookingHistoryStore.ts`, `SecureSummaryScreen.tsx`, `TripSummaryScreen.tsx`                                 |
| 1.4 | Filter sheet, stats strip, paging, offline cache                                               | `SecureSummaryScreen.tsx`, `bookingHistoryStore.ts`                                                                    |

### P2 — union, timeline UX, export

Pro-plan + VBG rows (§4.3), timeline rendering (§3.6.4), reference search, receipt PDF
export (§4.4), "Rebook" seeding the draft.

---

## 6. Tests and gates (a bug is not fixed until a test would catch it coming back)

| Pin (new)                            | Guards                                                                                                                                                                                                              | Project        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `bookingHistoryRows.test.ts`         | row builder: local-time formatting (a 01:00 GST booking is dated the same day — RED on the current UTC formatter), duration/range words, "Protection only", amount signs, a11y label composition, month key         | `booking`      |
| `bookingRowStatus.test.ts`           | the §3.4 matrix — every (status × mission × escrow) cell, mission precedence, `isUpcomingScheduled` bucket                                                                                                          | `booking`      |
| `secureSummaryList.test.tsx`         | Active card still pinned and still non-auto-navigating; sectioned list renders; segments filter; "Load more" ref-guarded; empty/error/filtered-empty copy                                                           | `app`          |
| `summaryDoorsWiring.test.ts`         | source scan: the Pro `reports` tile, drawer, profile, dashboard and Home "View All" all route to `SecureTab`/`Summary`; no `agentApi.getMissionHistory` in a client screen; no `timeZone: 'UTC'` in booking screens | `app`          |
| `booking.history.spec.ts` (service)  | filter allow-lists, cursor round-trip, true `total`, owner scoping (a foreign `client_id` never returns), `rating_remarks`/`actor_id` never serialised, batched queries (spy: ≤ 6 queries per page)                 | `auth-service` |
| `booking.timeline.spec.ts` (service) | audit rows map to the user vocabulary; unknown reasons fall back to the status word; actor is role-only                                                                                                             | `auth-service` |
| `bottomInsetContract` (extend)       | the new list's bottom padding is `contentBottom(...)`; the filter sheet is a `<Modal>`                                                                                                                              | `app`          |
| `navBackContract` (existing pins)    | row press via `navigateOnce`, back via `goBackOnce`; no `useEffect` BackHandler                                                                                                                                     | `app`          |

Gates to run before calling any phase done: `npm run typecheck` (baseline 47),
`npx jest --selectProjects booking`, `npx jest --selectProjects app --testPathPattern
"screens/booking|navigation"`, the auth-service suite, then the `LITE_BOOKING_LOOP.md` §7
sign-off (client lane: book → cancel → resume → notification → team code → money deducted
accurately — the history row must agree with the wallet to the credit) and the
`NAV_RAPID_USE_LOOP.md` §7 sign-off. Device pass on the Redmi + one BlueStacks account with
≥ 20 bookings across every status (seed with the QA accounts in `sqa.md` §Device & Identity).

SQL probes for the device pass (Supabase MCP):

```sql
-- every COMPLETED booking has exactly one client_receipt and its total equals the escrow split
SELECT b.id, i.invoice_number, i.total_credits, e.gross_credits, e.to_client_credits
  FROM lite_bookings b
  LEFT JOIN invoices i ON i.booking_id = b.id AND i.kind = 'client_receipt'
  LEFT JOIN escrow_holds e ON e.booking_id = b.id
 WHERE b.client_id = '<qa client>' AND b.status = 'COMPLETED';

-- the ledger sum per booking equals charged − refunded shown on the row
SELECT booking_id, SUM(amount_credits) FILTER (WHERE type IN ('payment','escrow_hold')) AS charged,
       SUM(amount_credits) FILTER (WHERE type IN ('refund','escrow_refund')) AS refunded
  FROM wallet_transactions WHERE user_id = '<qa client>' AND booking_id IS NOT NULL GROUP BY booking_id;
```

---

## 7. Acceptance criteria (founder-facing)

1. Opening Summary on the founder's Pro account shows the plan strip, the active/upcoming
   cards, and **every past booking** grouped by month — not "No active booking".
2. Each row shows service (and task type), date **and time** (local), duration, route, team
   size, one status chip that says what happened AND where the money is, the amount with the
   payment method, the rating if given, and the receipt number if issued.
3. Tapping a row opens the full detail with a payment block (quoted, charged, refunded,
   escrow state, transaction references), the receipt, the team, and the timeline.
4. Filters (bucket, service, date range, payment state) and "Load more" work; the count in
   the header is the true count for the filter.
5. The Pro "Activity & Reports" tile and "My Bookings" lead to the same list; nothing shows
   "No missions yet" to a client.
6. Amounts on the row reconcile to the wallet ledger for the same booking to the credit.
7. All of the above at fontScale 1.3 and at 320 dp without clipping or horizontal scroll.

---

## 8. Decisions needed from the founder (do not block P0 on these)

| #   | Question                                                                                                                      | Default if unanswered                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Q1  | Should Pro-plan requests and Virtual Bodyguard sessions appear **inside** the same list (P2 union), or stay as linked strips? | P1 = linked strips; P2 = union                       |
| Q2  | Show a secondary fiat line (`≈ AED …` from `total_aed`) under the BC amount?                                                  | BC only (matches every other surface)                |
| Q3  | Should a family **owner** see members' bookings in their Summary (with "Paid for <member>")?                                  | No — owner keeps the per-member spend view in Family |
| Q4  | Receipt export as PDF (server-generated, shareable) — wanted in P2?                                                           | Yes, P2                                              |
| Q5  | Keep the `BL-` reference format, or move to a short human code like the mission `short_code`?                                 | Keep `BL-` (support already uses it)                 |

---

## 9. Findings to log (sqa.md B-786, sub-items)

| Id     | Finding                                                                                                                                                               | Severity | Where                                                    |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------- |
| B-786  | Summary tab shows no booking history — a single in-flight card or an empty state                                                                                      | P1       | `SecureSummaryScreen.tsx`                                |
| B-786a | Pro dashboard "Activity & Reports" is structurally empty for every client: it calls the crew-scoped `GET /agents/me/missions` (`WHERE mc.agent_id = $1`)              | P1       | `ProActivityHistoryScreen.tsx`, `agent.service.ts`       |
| B-786b | `BookingHistoryScreen` formats dates in UTC (`timeZone: 'UTC'`) and shows no time of day — wrong calendar day for early/late bookings in UTC+4/+6 zones               | P2       | `BookingHistoryScreen.tsx` `formatDate`                  |
| B-786c | `GET /bookings` returns `total: rows.length` (page size) — no consumer can render a true count or know if a next page exists; the client never sends `page`           | P2       | `booking.service.ts` `list()`                            |
| B-786d | The list DTO carries no payment state, receipt, rating, crew, or mission timing although every one is stored (`escrow_holds`, `invoices`, `mission_crew`, `missions`) | P1       | `toClientBooking`                                        |
| B-786e | `TripHistoryScreen` is registered in `BookingNavigator` but nothing navigates to it — dead route with its own duplicate row model                                     | P3       | `BookingNavigator.tsx`                                   |
| B-786f | Credits ledger rows read `Booking <uuid>` with no link to the booking (server `description`), so the money history and the booking history cannot be cross-read       | P3       | `booking.service.ts` payment insert, `CreditsScreen.tsx` |
| B-786g | History sorts by `created_at`, so an upcoming 'later' booking made a week ago sits below a 'now' booking made yesterday                                               | P3       | `booking.service.ts` `list()`                            |

---

## 10. Do-not-re-propose

- Do not put the history into `useBookingStore.bookings` with a bigger page. That list is the
  resume/Home model (B-405 upcoming cards, LB17 one-mission slot, the pollers); widening it
  changes those behaviours. The history is its own read model and store.
- Do not compute the money word from `payment_captured` or `total_eur` alone. Escrow is the
  truth for auto-dispatch bookings (B-379: "money moved on the sweep timer alone" when the
  client half was missing).
- Do not soften the privacy allow-list to "return the row" — `rating_remarks` is
  quality/ops-only (Issue 31), `internal_notes`/`ops_note` are ops-only, `actor_id` in the
  audit trail is not the client's to see.
- Do not format any booking time in UTC anywhere in the client (`formatBookingTime` is the
  rule; review round 1 already rejected "14:30Z" for a "2:30 PM" pick).
- Do not render the list in a `ScrollView`; the measured lag cost is UI-thread mounting.
