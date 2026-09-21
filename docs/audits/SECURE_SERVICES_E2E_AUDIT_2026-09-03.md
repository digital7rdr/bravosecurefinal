# Secure Services — End-to-End Reality Audit (client → ops → agency → CPO), 5k-user readiness

> **Date:** 2026-09-03 · **Source audited:** `origin/main` @ `d6fce4d6` (app v1.0.290 / vc347, the build on the founder's Pixel) · **Worktree:** `E:\tmp\bs-ship`
> **Method:** static source audit, six parallel lanes (client Secure Transfer, Executive Protection, Secure Pro reserved dates, agency/CPO + money, ops console reality, 5k scale), then an **adversarial verification pass** that re-opened every file behind the nine highest-impact claims. Every finding cites `file:line`; a claim the verifier could not reproduce is not in this document. Nothing was executed against a live server, device, DB or Stripe — §9 says what that leaves unproven.
> **Founder's questions (verbatim intent):** does every booking type flow smoothly from the client to the CPO and the service provider; does a Pro reserved date really activate a mission on the day; is the ops console really workable; is every function on the apps real and managed as written; does it hold at a minimum of 5,000 users.
> **Prior register this builds on:** `SECURE_SERVICES_ADVERSARIAL_AUDIT_2026-08-28.md` (P0/P1/P2 there are **largely remediated** in this HEAD — §7), `DB_PAYMENT_SCALE_AUDIT_2026-09-02.md`, `OPS_PROPAGATION_AND_FETCHING_AUDIT_2026-09-02.md`, runbook `LITE_BOOKING_LOOP.md`, spec `PROTECTION_SESSIONS_SPEC.md`.

---

> **REMEDIATED 2026-09-04 — see §11.** 44 of the 52 findings are closed, 3 are partial and the
> rest are recorded with reasons. The §0 verdicts below describe the code **as audited on
> 2026-09-03**; read them together with §11, which states what changed, which behaviours an
> operator will notice, what is owed on deploy, and what remains unproven without a device and a
> load run.

## 0. Executive verdict

| Question                                                                              | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Where it breaks                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Secure Transfer (Lite, auto-dispatch)** client → ops → agency → CPO → payout: real? | **Yes, end to end.** Wizard → `PENDING_OPS` → ops approve → Postgres offer cascade (30 s TTL, 8 attempts) → escrow held at agency accept → crew assign with rollback → CPO `DISPATCHED→PICKUP→LIVE→COMPLETED` → proof gate → 72 h release → payout. All plumbing real, all money paths `FOR UPDATE`, all pushes emitted and tap-routed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Business-rule gaps, not plumbing: **no client no-show path** (E2E-06), **settlement failure after completion never retries** (E2E-05), **"Book Now" is unreachable from the wizard** (E2E-10), a **backgrounded agency drops out of dispatch in ~5 min** (E2E-17).                                                                                                                                                 |
| **Executive Protection** (always scheduled, fixed blocks, hourly check-ins)           | **Booking, approval, lead-time, pricing and the check-in emit are real.** The _mission_ half is Secure-Transfer machinery wearing an EP label.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **Proof-of-completion is transport-shaped** — a stationary site-protection block can fail it and strand the agency's money (E2E-02); **no block-end / auto-complete, no missed-check-in handling, no extension** (E2E-13/14); **no-show clocks and the hourly clock are anchored to accept/go-live, not to the contracted start** (E2E-15/16); **ops can approve a booking whose start is already past** (E2E-04). |
| **Secure Pro: on a reserved date, does the mission really activate?**                 | **No.** Nothing in the backend is triggered by the date. There is no cron, sweeper or scheduler that reads `pro_plan_missions`. The date only **unlocks the Live Map tile**; the client must still tap "Request Protection", and both phones must pass a readiness + GPS gate within 10 minutes or the session aborts. (E2E-01, verified)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Also: a **SCHEDULED date cannot be cancelled by anyone** (no client route, ops guard is `REQUESTED`-only, no `CANCELLED` enum value) (E2E-07); a reserved date **with no team assigned fails silently** — no SLA, no alert (E2E-08); **"today" is computed three different ways** (client UTC, server Gulf, DB `CURRENT_DATE`) so the tile can unlock ~4 h late for a UAE user (E2E-09).                           |
| **Ops console: really workable?**                                                     | **Mostly yes.** Every booking/dispatch/pro/finance/compliance control traced resolves to a live handler that mutates the same table the app reads and writes an audit row; the B-739..B-748 fetching fixes are in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | **Resolving a client panic SOS 404s** (and silently resolves the row anyway) (E2E-03); **OPS-tier operators get 403 on SOS ack** (client/server role drift) (E2E-18); the **stranded-escrow "resolve review" endpoint has no button** (E2E-02b); **agent directory has no region scoping** (E2E-19); the **live wall page is hardcoded sample data** (E2E-30).                                                     |
| **5,000 users**                                                                       | **Not yet provable, and three configuration facts make it unsafe today**: the global rate limiter is in **shadow mode** (logs, never 429s) unless `THROTTLE_ENFORCE=true`, which is set nowhere (E2E-20); **no container/process memory or CPU limits, single Node process per service** on one 4-vCPU/8 GB box shared with Redis and coturn (E2E-21); the **34-index migration from 2026-09-02 is written but not applied** (E2E-22). Beyond that: the legacy `POST /bookings` route has **no idempotency and no DB-level one-active-booking guard** (E2E-23), the offer-expiry lock TTL is shorter than its worst-case batch (E2E-24), the ranking query cannot use its geo index for ordering (E2E-25), two sweeper predicates are unindexed (E2E-26). **Nothing operational has ever been measured** — no load test exists in the repo (§8). |

**Bottom line for a launch decision:** the Secure Transfer lane is production-shaped and the 2026-08-28 money/fraud blockers are fixed; ship it behind the existing kill-switch once E2E-05/06 and the three scale configuration items are done. Executive Protection and Secure Pro are **not** what their screens promise on the mission side: EP needs a block-anchored lifecycle and an EP-native proof gate; Pro needs an actual date-driven activation (or the product copy changed to "unlocks on the day"). Ordered fix list in §10.

---

## 1. Actor × product matrix — what is real today

Legend: ✅ real and wired end to end · ⚠️ real but with a gap listed in §5 · ❌ does not exist · 🧪 exists but ships dark / gated by config.

| Capability                                        | Secure Transfer (Lite)                                                              | Executive Protection                                                       | Secure Pro                                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Client books; server prices; escrow/affordability | ✅ `booking.service.ts:253-728`, `pricing.service.ts`                               | ✅ block/lead/transfer rules mirrored client+server                        | ✅ apply → proposal → accept → pay (`pro-applications.service.ts:151/376`)                                      |
| Ops approval                                      | ✅ `ops.service.ts:346-458`                                                         | ✅ same path; ⚠️ no past-start check (E2E-04)                              | ✅ proposal / reject / cancel / schedule-with-CPOs                                                              |
| Dispatch to agencies                              | 🧪 `AUTO_DISPATCH_ENABLED` (offer sweeps `return` early when off)                   | 🧪 same; ⚠️ starts only at T-15 (E2E-11)                                   | n/a — ops assigns a dedicated officer (`pro_cpo_assignments`)                                                   |
| Money held                                        | ✅ at agency accept, balanced ledger                                                | ⚠️ at agency accept ≈ T-14 min, nothing reserved before (E2E-11)           | ✅ whole plan debited once at activation; **no per-date/per-session money**                                     |
| Agency assigns CPO                                | ✅ `org-mission.service.ts:368-674`, rollback on room failure                       | ✅ same                                                                    | ✅ ops-side assignment, overlap-safe                                                                            |
| CPO mission lifecycle                             | ✅ `DISPATCHED→PICKUP→LIVE→COMPLETED`, FSM asserted                                 | ⚠️ same graph with transport wording; **no block end** (E2E-13)            | ⚠️ session `REQUESTED→ACTIVE→…` but **manual start** (E2E-01)                                                   |
| Live GPS to client + ops                          | ✅ mission FGS + mirror + WS (`mission-lead.service.ts:214-271`)                    | ✅ same                                                                    | ✅ session location ingest                                                                                      |
| Hourly check-ins                                  | n/a                                                                                 | ⚠️ emit + read real; **missed check-in ignored** (E2E-14)                  | ❌ none on Pro (the `hourlyCheckin` API is the Lite/EP mission's)                                               |
| Verify (team) code                                | ✅ `GET /bookings/:id/verify-code` + server handshake stamps `identity_verified_at` | ✅ same                                                                    | n/a (PMC code gate on CPO screen)                                                                               |
| Completion → payout                               | ✅ proof gate → `PENDING_RELEASE` → release sweep → `mission_payouts`               | ⚠️ proof gate is transport-shaped (E2E-02)                                 | ❌ **no payout leg by design** ("Pro missions carry NO payout", `pro-management.service.ts:73`)                 |
| Cancel                                            | ✅ pre-commit free; post-crew fee via `cancel_fee_pct`; LIVE blocked                | ⚠️ always free up to T-14 min; whole block inside the free window (E2E-12) | ❌ SCHEDULED date uncancellable (E2E-07)                                                                        |
| No-show handling                                  | ⚠️ agency-side only (crew SLA 15 min, arrival 20 min)                               | ⚠️ same clocks, not anchored to start (E2E-15)                             | ❌ none                                                                                                         |
| Notifications at every step                       | ✅ every kind emitted, copy + tap route                                             | ✅ + T-60 reminder                                                         | ⚠️ `psession-conn-lost` defined, never emitted                                                                  |
| Ops console surfaces                              | ✅                                                                                  | ✅ (⚠️ breakdown recomputed at compiled defaults, E2E-28)                  | ✅ pro-management / protection monitor; ❌ no "start/force session", no cross-plan "what's reserved today" view |

---

## 2. Flow maps (condensed, evidence-linked)

### 2.1 Secure Transfer (auto-dispatch) — client lane

1. `ServiceTypeScreen.handlePick` (`src/screens/booking/ServiceTypeScreen.tsx:207-211`) → `CustomizeAddOnsScreen` (zone chips, schedule, `LocationPicker`, team, add-ons; the old 6-screen wizard is registered but skipped).
2. Add-on catalogue `GET /bookings/add-ons?region` → `BookingService.listAddOns` (`booking.service.ts:1746`); de-listed rows dropped **and** de-selected (B-385).
3. Debounced quote `POST /bookings/estimate` → `BookingService.estimate` (`:1027-1129`) → `PricingService.calculate`; offline fallback = local `rateBc × hours` (omits peak, E2E-33).
4. Submit → `bookingStore.confirmBooking` (`src/store/bookingStore.ts:243-372`): if `user.auto_dispatch_enabled` → `POST /dispatch/request` with a per-attempt `Idempotency-Key` (`api.ts:599-602`), else legacy `POST /bookings` (no key, E2E-23).
5. `ClientDispatchController.request` (`client-dispatch.controller.ts:45-64`): throttle 5/min, idempotency, Redis kill-switch → `BookingService.create` (`booking.service.ts:253-728`): one-active guard (`:302-320`, app-level), ≤3 parked `later` (`:326-340`), region gate, lead gate (**exempt for on-demand auto**, `:386-391`), consent, capacity, pricing, payer + family cap + affordability (`:562-617`) → INSERT `lite_bookings` **`PENDING_OPS`** (`:631-705`). Both `now` and `later` go to the ops board.
6. Client → `OpsRoomReview` (polls 4 s, stops after 5 min, E2E-32) or, for `later`, pop-to-top + "Booking scheduled".
7. Ops approve (`ops.service.ts:346-410`): `now` → publish `dispatch:ops-approved` → `DispatchService.start`; `later` → parked `OPS_APPROVED` until the scheduled sweep (T-15) or the stuck-`now` recovery (2 min, INFRA-2 fixed).
8. `offerNext` (`dispatch.service.ts:742-854`): `RANKING_SQL` (PostGIS, eligibility + capacity functions), one live `dispatch_offers` row (TTL 30 s), `MAX_OFFERS=8`, unique partials arbitrate races; exhaustion → `noProvider()` (terminal, `TODO(LB13)` fallback).
9. Agency accept → `settleWonOffer` (`:1114-1365`): conditional `OFFERED→ACCEPTED`, family re-lock, `wallet.holdToEscrow`, `escrow_holds HELD`, booking `CONFIRMED`, `crew_deadline_at = +15 min`, siblings cancelled blameless.
10. Crew assign `POST /org/bookings/:id/crew` (`org-mission.service.ts:368-674`) → `missions DISPATCHED`, E2EE Ops Room (rollback to `ABORTED` on room failure), pushes `missionDispatched` (CPO) + `crewAssigned` (client).
11. CPO: `DISPATCHED` respond → pickup (deploy checks) → go-live (`live_at`, booking `LIVE`) → complete (`LIVE|SOS`, `live_at IS NOT NULL`) (`agent.service.ts:1344-1755`); telemetry `useLeadTelemetry.ts` (15 m / 5 s / 15 s heartbeat, mission FGS) → `mission-lead.service.ts:214-271` mirror + WS.
12. `completeMissionCore` → `settleEscrowOnFinish` (outside txn) → `runProofGate` → `PENDING_RELEASE` (+72 h) or `review_required` → `escrow-release-sweep` (60 s) → `SettlementService` → agency credited minus fee, `mission_payouts`, `payoutSettled` push.

**Sweepers** (all `setInterval` + Redis `SET NX`, no `@nestjs/schedule`): offer-expiry 8 s · crew-SLA 60 s · arrival-no-show 60 s · scheduled-dispatch 60 s · booking-reminder 60 s / T-60 · relist 60 s · payment-pending 60 s · dispatch-SLO 60 s · privacy-purge 5 min · escrow-release 60 s · escrow-reconciliation daily (read-only) · wallet-expiry / pro-lapse (fenced).

### 2.2 Executive Protection

1. `ServiceTypeScreen` → `ExecReviewScreen` (single dashboard; `ExecTask/Transport/Team` routes registered but unreachable). Mount seeds the draft (`bookingStore.ts:185-204`: `duration_hours 3`, `vehicle_count 0`, always `mode:'later'`).
2. Lead floor = `execMinLeadHours()` (`scheduleGate.ts:57-60`, ops-editable, fail-open 3 h); transfer window `[start−2h, start+block]` (`transferTime.ts:17-52` ≡ `booking.service.ts:443-453`).
3. Estimate `POST /bookings/estimate` → `calculateExecutive` (`pricing.service.ts:404-455`, no peak by design) — **without `pickup`**, so it prices GLOBAL (E2E-27).
4. Create: `assertExecLeadTime` (`booking.service.ts:1006-1025`, server clock, echoes `earliest_start`) → block/task/transfer/seat validation (reject, never reprice) → INSERT `PENDING_OPS`.
5. Ops approve (no time check, E2E-04) → parked `OPS_APPROVED` → T-60 reminder (client only) → **T-15** scheduled-dispatch → cascade → agency accept = escrow held → crew assign (no waypoints for EP) → CPO lifecycle as 2.1 with transport wording.
6. Hourly check-in `agent.service.ts:1921-1993`: lead-only, EP-only, `hour_index ≤ duration_hours`, due at `live_at + h·3600 s − 120 s`, idempotent, pushes client + agency; read by client (`LiveTrackingScreen.tsx:962-989`) and ops (`live/[id]/page.tsx:1080-1098`). Only writer of `mission_hourly_checkins`; status hard-coded `'SMOOTH'` (`:1967`) while three UIs render an `'ISSUE'` branch.
7. Finish → same proof gate and payout as 2.1.

### 2.3 Secure Pro (the reserved-date path in full)

1. Apply (`SecureProApplyScreen` → `POST /pro-applications`, past-date check in **Gulf time** `todayGulf()`, `pro-applications.service.ts:122`) → ops proposal → client accept → pay/activate (`:376-410`: one txn, whole `total_credits` debited, `ACTIVE`, `current_period_end = coverage_end + 1`).
2. Reserve dates `SecureProCalendarScreen.tsx:173` → `POST /pro-applications/:id/missions` → `requestMission` (`:447-507`): if a dedicated officer's window already spans the dates → inserted directly **`SCHEDULED`** (`:478-483`), else `REQUESTED`.
3. Ops `/pro-management` REQUESTS tab (filters `REQUESTED` only, `pro-management.service.ts:350`) → `schedule-cpos` (`:527-612`): one `pro_cpo_assignments` row per officer spanning `dates[0]→dates[last]`, PMC code, mission → `SCHEDULED`, push `proMissionUpdate`.
4. **The date arrives — nothing executes.** Writers of `pro_plan_missions`: `pro-applications.service.ts:479, 495, 601` and `pro-management.service.ts:599` — all request/decision paths. No `setInterval` anywhere reads the table (verified by enumerating every sweep). `COMPLETED` is in the CHECK (`20260803210000_pro_plan_missions.sql:14`) and has zero writers. `apps/auth-service/src/dispatch/README.md:26` confirms `ScheduleModule` is deliberately not registered.
5. What the date does: `ProDashboardScreen.tsx:157-185` builds `scheduledDates` from `SCHEDULED` rows, `liveToday = has(today)` (**UTC**), and unlocks the Live Map tile ("MISSION DAY"); `listTeam.live_today` (`CURRENT_DATE BETWEEN starts_on AND ends_on`, `:542`) paints "ON DUTY"; CPO screen paints "LIVE TODAY".
6. Tapping Live Map → `ProLiveMissionScreen.tsx` (the on-demand session screen) → "Request Protection" (`:361-386`) → consent → `ensureLiveLocationAccess` → `POST /protection/sessions` → `ProtectionService.create` (`protection.service.ts:84`): plan `ACTIVE`, `coveringAssignmentToday` over **Postgres `CURRENT_DATE`** (`:917-927`) else `409 no_cpo_assigned`; row `REQUESTED`, CPO woken.
7. `REQUESTED→ACTIVE` needs **both** sides device-ready with a real fix (`:236-249`, `:350-365`); no fix within `NO_FIX_ACTIVATION_TIMEOUT_MIN = 10` → `ABORTED` by a **lazy** sweep that runs only from `getCurrent` / `cpoOverview` / `opsListSessions` (`:128, :413, :517`).
8. End: customer, ops, or the 12 h max-duration sweep; **no end-of-day completion of the reserved date**; assignments swept to `COMPLETED` lazily when `ends_on < CURRENT_DATE`.

---

## 3. Findings register (deduped across lanes; ✔︎ = re-verified by the adversarial pass)

Severity: **P0** breaks the product promise or money · **P1** wrong outcome reachable in normal use · **P2** degraded/inconsistent · **P3** dead code, copy, cosmetics.

### P0

**E2E-01 ✔︎ — Pro reserved dates never activate a mission.** No date-triggered writer of `pro_plan_missions`; the tile unlocks and everything after is manual + a 10-minute two-device readiness gate. Evidence: writers at `pro-applications.service.ts:479/495/601`, `pro-management.service.ts:599`; gate `ProDashboardScreen.tsx:157-185`; activation `protection.service.ts:236-249, 350-365, 828-851`. _Breaks:_ the calendar says "booked", the team chip says "ON DUTY", and unless the client opens the app and taps at the right moment with the officer also in-app, no session exists and nobody is told. _Fix:_ either (a) a 60 s fenced sweep that, for `SCHEDULED` rows whose date = today (in ONE canonical timezone), creates the session, pushes both parties, and escalates to ops if not `ACTIVE` within N min; plus `pro_plan_missions.ACTIVE/COMPLETED` writers and an end-of-day close — or (b) change the product copy everywhere to "unlocks on the day" and keep it manual. Decide (a) vs (b) before any code.

**E2E-02 ✔︎ — EP proof-of-completion is transport-shaped; a stationary block can fail it and strand the agency's money.** `proof-of-completion.service.ts:36-137` needs ≥`minPings` fixes while LIVE, a fix within 150 m of pickup and (when `DISPATCHING_REQUIRE_LIVE_MOVEMENT`) ≥25 m of spread — the comment concedes "a truly stationary detail would trip it". It never reads `mission_hourly_checkins`. FAIL ⇒ `review_required` (`agent.service.ts:2164-2168`) ⇒ release sweep skips forever (`escrow-release-sweep.service.ts:73`). **E2E-02b ✔︎:** the only exit, `POST /ops/bookings/:id/resolve-review` (`ops.controller.ts:213-222`), has **no caller in the console** — full-text scan of `apps/ops-console/src` finds none. _Breaks:_ residential/site details and any app-killed-during-block case → agency unpaid with no operator button. _Fix:_ EP-native gate (check-in cadence + presence at the service location, not displacement) and add the resolve-review control to the booking detail page.

**E2E-03 ✔︎ — Ops cannot resolve a client/VBG panic SOS, and the row resolves silently anyway.** `ops.controller.ts:533` hard-codes `returnToLive=true`; `mission.service.ts:747-752` UPDATEs `sos_events.resolved_at` **outside a transaction** and then `requireMission(sos.mission_id)` throws `NotFound` for `mission_id IS NULL`; `/sos` renders those rows (`sos/page.tsx:141-145`) with RESOLVE (`:178-185`) and SWR rolls the optimistic row back on the 404. _Breaks:_ operator sees a failure, DB says resolved, alert bar clears — a panic is closed with no human having confirmed it. _Fix:_ branch on `mission_id` before `requireMission`; wrap in a txn.

**E2E-04 — Ops can approve a booking whose `start_time` is already past; dispatch then fires immediately.** `ops.service.ts:346-386` has no time check; `scheduled-dispatch.service.ts:78-85` selects `pickup_time <= NOW()+15 min` with **no lower bound**. _Breaks:_ an EP booking approved 4 h late still searches, holds escrow, and starts the hourly clock at `live_at` for a block the client already lost. _Fix:_ refuse/flag approval past `start_time − lead`; lower-bound the sweep and route stale rows to a distinct terminal status with refund.

**E2E-05 ✔︎ — Settlement failure after completion has no retry: escrow strands HELD.** `agent.service.ts:2142-2176` catches and logs only ("escrow stranded HELD — needs operator settle"); re-running completion returns early (`:1749-1757`); the release sweep matches only `PENDING_RELEASE` (`escrow-release-sweep.service.ts:71`); reconciliation is read-only (`escrow-reconciliation.service.ts:132,160`). Production evidence in a code comment: 16 completed missions, zero `mission_payouts` rows (`org-cpo.service.ts:880-887`). _Fix:_ a `COMPLETED + HELD + completed_at < now−N min` sweep that re-runs `settleEscrowOnFinish`; alert on age.

**E2E-06 ✔︎ — No client no-show path.** Repo-wide there is no `client_no_show`; a mission at `PICKUP` can only complete after go-live (`agent.service.ts:1749-1755`), `missionAction.ts:34` offers only "Client Picked Up", and the only exits are SOS or an ops abort that refunds the client in full pre-live (`ops/mission.service.ts:576-579`). _Breaks:_ the agency deployed a crew and earns nothing, with no recourse. _Fix:_ a lead-initiated `client_no_show` after `pickup_time + grace` with a partial settlement (`cancel_fee_pct` basis) and a client dispute door.

**E2E-20 ✔︎ — Global rate limiting is shadow-mode.** `global-http-throttler.guard.ts:51` `enforce = process.env.THROTTLE_ENFORCE === 'true'`; `:68-76` logs and returns. `THROTTLE_ENFORCE` appears in **no** `.env*`, compose, or `infra/` file. Only the ~40 `@Throttle`-decorated routes are protected. _Breaks at scale:_ one runaway client loop saturates the 20-connection pg pool (`database.service.ts:31-37`) → every request blocks on `connectionTimeoutMillis=5000` → fleet-wide 500s. _Fix:_ confirm the legitimate poll mix does not 429, then set `THROTTLE_ENFORCE=true` on the box; move throttler storage to Redis before any second replica.

**E2E-21 — No resource limits, single process per service.** No `mem_limit/cpus/deploy.resources` in `docker-compose.yml`; `infra/systemd/bravo-auth.service:54-58` has no `--memory/--cpus`; no PM2/cluster, no `--max-old-space-size`. One 8 GB box also runs Redis, coturn, ops-console. _Breaks:_ an auth-service leak OOM-kills Redis → every fenced sweep lock and every call dies with it. _Fix:_ cgroup limits per container, heap ceiling, Redis on its own limit; readiness on `/ready`.

### P1

**E2E-07 ✔︎ — A SCHEDULED Pro date cannot be cancelled by anyone.** `secureProApi` has no mission cancel (`api.ts:3132-3161`); ops `decideMission` guards `status='REQUESTED'` (`pro-applications.service.ts:604`); the CHECK has no `CANCELLED` (`20260803210000_pro_plan_missions.sql:14`); `cancelAssignment` (`pro-management.service.ts:616-627`) leaves the mission `SCHEDULED` so the client calendar keeps painting it booked with no officer.

**E2E-08 — A reserved date with no team assigned fails silently.** `REQUESTED` rows have no SLA, deadline, or alert; the date passes; the tile counts `SCHEDULED` only (`ProDashboardScreen.tsx:158`); ops dashboard counts only `REQUESTED` and has no cross-plan "reserved today/tomorrow" view (`ops/ops.service.ts:160`, `pro-management.service.ts:350`).

**E2E-09 — Three different "today" on Pro.** Client `new Date().toISOString().slice(0,10)` (UTC) at `ProDashboardScreen.tsx:166`, `SecureProCalendarScreen.tsx:157`; server validation `todayGulf()` (UTC+4) `pro-applications.service.ts:122`; coverage `CURRENT_DATE` (`protection.service.ts:917-927`, `:542`). For a UAE user the tile is locked ~4 h into the mission day and open ~4 h into the next. Violates the repo's own `@utils/datetime` UTC-everywhere rule.

**E2E-10 ✔︎ — "Book Now" is unreachable from the Secure Transfer wizard.** `CustomizeAddOnsScreen.tsx:48-51, 309-321` pushes any start under `now + MIN_LEAD_HOURS(3)` to **tomorrow** and the banner asserts a 3 h lead (`:580`), while the server exempts on-demand auto from the lead gate (`booking.service.ts:386-391`) and ops seeds the transfer lead at 0.25 h (`20260901130000_…sql:114`). The headline "guard now" product cannot be booked.

**E2E-11 — EP: nothing is reserved between submit and T-15; exhaustion is terminal with no retry.** Escrow is held only at agency accept (`dispatch.service.ts:1296-1319`); scheduled dispatch starts at `LEAD_WINDOW_MINUTES` default 15 (`scheduled-dispatch.service.ts:24-27`); `noProvider()` is terminal (`:923-963`, `TODO(LB13)`). A client who books 7 days ahead can learn 15 min before start that nobody is coming — after a T-60 reminder that never says "no team yet" (`ExecReviewScreen.tsx:504-509`). _Fix:_ EP-specific lead window (e.g. T-24 h search with re-tries), reminder copy conditioned on assignment.

**E2E-12 — EP has no cancellation fee at any lead distance.** `PENDING_OPS/OPS_APPROVED` are free (`booking.service.ts:1379-1394`); post-`CONFIRMED` the window anchors to `dispatch_settled_at + 1 h`, which for EP is ≈ T-14 min, so the whole block sits inside the free window.

**E2E-13 — EP block has no end.** Nothing reads `pickup_time + duration_hours`; only the drift janitor closes missions and only once the booking is terminal (`ops/mission-drift-janitor.service.ts`). No extension endpoint exists. Over-run is never billed; under-delivery never detected.

**E2E-14 — Missed hourly check-in has no consequence.** Only writer is `agent.service.ts:1966`; no sweeper, escalation, SOS, or payout effect; status hard-coded `'SMOOTH'` (`:1967`) while `LiveTrackingScreen.tsx:978-985`, the CPO screen and ops render an `'ISSUE'` branch that can never occur.

**E2E-15 — CPO no-show clocks are not anchored to the contracted start.** Crew SLA = accept + 15 min (`crew-sla.service.ts:117-190`), arrival = crew-assign + 20 min (`org-mission.service.ts:377,389`). An agency crewing at T-90 gets an arrival deadline at T-70; at T+5 gets T+25. No "block started and nobody is LIVE" detector.

**E2E-16 — Hourly clock anchored to `live_at`, not `start_time`.** `agent.service.ts:1954`; a CPO 40 min late produces a schedule 40 min offset from the block paid for; hour N becomes confirmable 40 min after the contracted end (`AssignedMissionDetailScreen.tsx:566` states it).

**E2E-17 — A backgrounded agency silently leaves the dispatch pool in ~5 min.** `src/services/onDutyHeartbeat.ts` keep-alive is a TODO no-op; Android suspends the interval; `last_location_at` stales → ranking excludes (`dispatch.service.ts:162`) and the expiry sweep kills any live offer as "holder gone" (`offer-expiry.service.ts:98-99`) **and** charges decline accounting (`dispatch.service.ts:910`) → cooldown for being backgrounded.

**E2E-18 ✔︎ — SOS ack role drift.** `rbac.ts:93-97 canAckSos` allows OPS; server `ops.controller.ts:500-504` requires SUPERVISOR+; `/sos` renders ACK with no gate (`sos/page.tsx:154-161`); `live/[id]/page.tsx:543` uses `canAckSos`. First responders at OPS tier always 403.

**E2E-19 — Agent directory has no region scoping.** `ops.service.ts:510` declares `filter.region` and never uses it; `ops.controller.ts:342/347` carry no `@RequireRoles`/`assertRegionScope`; a region-scoped admin reads every agent's email + phone (`:524`) while bookings are force-scoped (`:213-221`).

**E2E-22 — The 34-index migration is not applied.** `20260902090000_scale_indexes_50k.sql` written 2026-09-02; `DB_PAYMENT_SCALE_AUDIT_2026-09-02.md:61-63` and `BUILD_RUNBOOK.md` both list the staging apply as owed. Every "covered" verdict in §8 is conditional on it.

**E2E-23 ✔︎ — Legacy `POST /bookings` has no idempotency and no DB one-active guard.** `booking.controller.ts:25-31` bare `@Post()`; no partial unique on `lite_bookings(client_id) WHERE status NOT IN (terminal)`; enforcement is read-then-throw (`booking.service.ts:302-320`). **Still reachable:** `bookingStore.ts:280,315-317` uses `/dispatch/request` only when `user.auto_dispatch_enabled === true`, else `POST /bookings`. Two concurrent creates → two active bookings; the orphan blocks the client's next booking and confuses the sweepers.

**E2E-24 — Offer-expiry lock TTL < worst-case batch.** `LOCK_TTL_MS=7000` vs interval 8000 and 50 serial `offerNext()` ranking passes per tick (`offer-expiry.service.ts:31,104-112`); under load the lock lapses and two ticks overlap. Only the conditional UPDATEs prevent damage. Throughput ceiling ≈ 375 expiries/min.

**E2E-25 — Ranking query cannot use its geo index for ordering.** `dispatch.service.ts:191-200` `ORDER BY floor(dist/bucket), rating, KNN` defeats the GiST KNN; two plpgsql functions (`20260621100000_dispatch_eligibility_fns.sql:12-63`) run per surviving row. Instrumented (`dispatch_rank_query_ms`) but never measured. Time-to-first-offer grows superlinearly with agencies per region.

**E2E-26 — Unindexed sweeper predicates.** booking-reminder `pickup_time … WHERE reminder_sent_at IS NULL` (`booking-reminder.service.ts:71-72`); scheduled-dispatch `later` cohort (`scheduled-dispatch.service.ts:79-81`); `agents` GiST re-written on every 30 s heartbeat (`agent.service.ts:2537-2543`) contending with the ranking scan.

**E2E-27 — EP estimate omits `pickup` so it quotes GLOBAL while create charges the region.** `api.ts:666-681` type has no `pickup`; `ExecReviewScreen.tsx:373-384` omits it; server `booking.service.ts:1047` → `null` → GLOBAL (`pricing.service.ts:296-297`) vs create `regionFromPoint` (`:363`). Any region with an `exec_*` override shows ≠ charges; paywall shortfall basis wrong.

**E2E-28 — Ops EP breakdown recomputes at compiled defaults.** `ops.service.ts:311-317` calls `pricingSvc.calculate` / `resolveExecAddOns` with no cfg, ignoring the persisted `pricing_breakdown` (`booking.service.ts:696`) and region overlay. Ops approves against a number the client was not charged. Client-side twin: `execPriceSummary.ts:32-46` line items use raw constants (E2E-38).

**E2E-29 ✔︎ (latent) — Estimate returns EUR, client treats it as BC.** `booking.service.ts:1124` `total: price.total_eur` → stored as `estimated_price`, rendered "BC" (`CustomizeAddOnsScreen.tsx:887`), compared to `bravo_credits` (`bookingStore.ts:302-307`); escrow charges `round(total_eur / eur_per_bc)` (`pricing.service.ts:395`). `eur_per_bc` **defaults to 1.0** (`20260826170000_service_pricing.sql:38`) so it coincides today; it bites the moment ops or a per-region override moves the peg (range 0.01–100 accepted).

**E2E-31 — Region chip vs pickup point never cross-checked server-side.** `region_code` persisted from the chip while pricing uses `regionFromPoint(pickup)` (`booking.service.ts:350-363, 659`); dispatch hard-matches `agents.region_code = booking.region_code`. A ZA pickup on an AE chip prices ZA and dispatches into AE → guaranteed `NO_PROVIDER`.

**E2E-34 — CPO decline dead-ends.** `agent.service.ts:1388-1394` states no automatic reassignment; agency merely pushed while `arrival_deadline_at` keeps ticking from crew-assign.

**E2E-35 — Protection-session sweeps run inline on the ops 2 s poll, unlocked and unbounded.** `protection.service.ts:128-129, 413-414, 517-518` (`sweepStaleActivations`/`sweepMaxDuration`, no Redis lock, no LIMIT; the live-session partial index can bound them). Retention `DELETE` (`:883-885`) runs on `create()` only (verifier correction), has no LIMIT, no `received_at`-leading index (`psl_session_idx` is `(session_id, received_at)`), and swallows errors (`:886-888`) — once it exceeds `statement_timeout=15000` it silently never runs again. Ops poll cadence `refreshInterval: 2000` at `api.ts:1883`.

### P2

- **E2E-30** `/live/wall` is hardcoded sample data (`live/wall/page.tsx:7-14, 124-127, 236-243`; LAYOUT button `:185` has no handler).
- **E2E-32** `OpsRoomReviewScreen.tsx:430-433` stops polling after 5 min with no focus restart; a `PENDING_OPS` booking freezes on screen; recovery depends solely on the `booking-approved` push.
- **E2E-33** Offline: estimate failure swallowed (`CustomizeAddOnsScreen.tsx:239`), fallback omits the peak surcharge (`src/screens/booking/pricing.ts:79-81` vs `pricing.service.ts:379-388`, ~20 % under-quote 17:00–20:00); submit dies in a generic alert; no queue/retry.
- **E2E-36** Double submit: `handleSubmit` guard is React state (`CustomizeAddOnsScreen.tsx:407,427`), idempotency key minted per attempt (`bookingStore.ts:316`); server one-active guard exempts parked `later` (`booking.service.ts:306-308`) → two reservations possible (cap 3). `CreditPaywallScreen.tsx:141-144` uses the correct `processingRef` pattern.
- **E2E-37** Timezone on the wizards: `CustomizeAddOnsScreen.tsx:354,403,634` and `ExecReviewScreen.tsx:104-105,204,297,337,660,687` render device-local while ops/CPO render UTC (`@utils/datetime`); `transferTime.ts:26-33` resolves the transfer day in local time.
- **E2E-38** EP CALCULATION rows use raw constants next to a live total (`execPriceSummary.ts:32-46`, `ExecReviewScreen.tsx:1002,1020-1029`); `splitConsistent` hides only subtotals.
- **E2E-39** `suspendUser`/`restoreUser` skip `bustAccountGate` (`ops-data.service.ts:282-303`) → ≤30 s of continued access; `useOpsMe` never revalidates (`api.ts:2017`).
- **E2E-40** SOS escalate is write-only (`mission.service.ts:723-738`): no ops-room post, no push — the crew never learns police were called.
- **E2E-41** Ops dispatch pushes agents only, no `crewAssigned` to the client (`ops.service.ts:1336-1338`; the org path does, `org-mission.service.ts:671`); `advanceWaypoint` mutates the client timeline with no emit (`mission.service.ts:777-786`).
- **E2E-42** `/live` truncates at 200 active missions with no LOAD MORE on that tab (`mission.service.ts:136-138`, `live/page.tsx:47`); `usePagedList` not adopted on `/sos`, `/compliance`, `/protection`, `/vbg`, disputes/escrows/payouts, `/jobs` — silent truncation at server caps.
- **E2E-43** `AdminGuard` runs `UPDATE admin_users SET last_active_at` on **every** `/ops/*` request (`admin.guard.ts:92-95`); with 2 s polls that is several row-locking writes/second/operator.
- **E2E-44** Pro internal notes: UI ungated, server SUPERVISOR+ (`pro-applications/[id]/page.tsx:909-922` vs `pro-applications-ops.controller.ts:117-118`) — OPS types a note and loses it.
- **E2E-45** EP CPO advance copy is vehicle-transport wording on a location-anchored detail (`missionAction.ts:53-82`) while ops renders "On-site detail (no dropoff)".
- **E2E-46** Shrinking an EP block can silently blank the transfer time (`ExecReviewScreen.tsx:171-190`, `:181`, reverts to "Same as start time" at `:339`).
- **E2E-47** Estimate/create parity misses `exec_transport_required` / `exec_vehicle_required` (`booking.service.ts:508,516` vs `:1027-1130`).
- **E2E-48** Ops approve toast says "published to the job feed" on the auto path where nothing is published (`bookings/[id]/page.tsx:136` vs `ops.service.ts:400-409`).
- **E2E-49** Notification fan-out is serial, un-queued, no retry (`push.service.ts:949-1039`); a broadcast = N sequential FCM round trips on the single subscriber's event loop.
- **E2E-50** `pro_cpo_assignments` spanning `dates[0]→dates[last]` (`pro-management.service.ts:543-545`) locks an officer's availability for the whole span between two dates a month apart; sessions cap at 12 h so back-to-back days need two manual re-requests.
- **E2E-51** Pro plan expiry: `sweepExpired` (`pro-applications.service.ts:213-227`) has no live-session check and the spec'd `plan_expired_session_live` / `cpo_offline_session_live` ops alerts are not built; renewal creates a new application so reserved dates/assignments do not carry over (`:288-331`).
- **E2E-52** Family members reserve dates and open sessions at zero cost — `spend_limit_credits` never applies on Pro (`assertPlanAccess`, `pro-applications.service.ts:431`, `protection.service.ts:898`).

### P3 (dead code, stubs, copy)

Client `DISPATCHING`/`NO_PROVIDER` branches after submit are unreachable (`create()` always returns `PENDING_OPS`) · CreditPaywall card form (PAN/expiry/CVV) is dead UI, real charge is Stripe PaymentSheet (`CreditPaywallScreen.tsx:77-81,536-551`) · `opsApi.cancelJob/dispatchJob` dead (`api.ts:818,823`) · `psession-conn-lost` push defined never emitted (`booking-push-bridge.service.ts:384`) · `OPS_SILENT_ALERT_MIN` unused (`protection.constants.ts:23`) · `cpo_pool` roster returns phantom `verified:false` (`cpo-assignment.service.ts:376-382`) · `AgentRejectedScreen` re-submit is mailto only · `dispatch/page.tsx:9-14` hardcodes 4 regions against an ops-managed table · EP `ExecTask/Transport/Team` routes registered, unreachable · female/medical crew requirements not enforced (`org-mission.service.ts:437-439`, only `armed`) · "Confirm Booking" CTA copy while the row files `PENDING_OPS`.

---

## 4. Edge-case matrix (the founder's list, answered)

| Edge case                         | Secure Transfer                                                                                                                        | Executive Protection                    | Secure Pro                                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------- |
| Reserved/scheduled date arrives   | T-15 search starts; escrow only at accept                                                                                              | same (E2E-11)                           | **nothing happens** (E2E-01)                                  |
| Nobody available                  | `NO_PROVIDER` terminal, refund, push; no fallback (`TODO(LB13)`)                                                                       | same, but discovered at T-15            | `409 no_cpo_assigned` on tap; unassigned date silent (E2E-08) |
| Client cancels                    | pre-commit free; post-crew fee; LIVE blocked, `FOR UPDATE`                                                                             | always free to T-14 (E2E-12)            | cannot cancel a SCHEDULED date (E2E-07)                       |
| CPO/agency no-show                | crew SLA 15 min → `AGENCY_NO_SHOW` + refund; arrival 20 min → re-dispatch                                                              | clocks not start-anchored (E2E-15)      | no detector; session just never activates                     |
| Client no-show                    | **none** (E2E-06)                                                                                                                      | **none**                                | n/a                                                           |
| App killed mid-mission            | FGS dies with process; SLO pages Sentry; no auto-recovery; agency can complete via `POST /org/missions/:id/complete` (same proof gate) | same + proof gate likely FAILs (E2E-02) | session `ABORTED` after 10 min no-fix or 12 h cap             |
| Backgrounded agency/CPO           | agency drops from pool ≈5 min (E2E-17); lead's FGS keeps telemetry                                                                     | same                                    | CPO must be in-app for readiness                              |
| Two offers same agency / busy CPO | structurally impossible (`dispatch_offers_one_live_per_provider`, `mission_crew_agent_active_uq`)                                      | same                                    | gist no-overlap on assignments                                |
| Double submit                     | per-attempt key + one-active guard; parked `later` exempt (E2E-36); legacy route unguarded (E2E-23)                                    | same                                    | idempotent `activate`; one-live session unique index          |
| Timezone                          | server authoritative for lead; wizard renders local vs UTC elsewhere (E2E-37)                                                          | same                                    | three "todays" (E2E-09)                                       |
| Over-run / extension              | mission has no contracted end check                                                                                                    | no block end, no extension (E2E-13)     | 12 h session cap                                              |
| Payout double / idempotency       | `ux_wallet_tx_payout` + `ON CONFLICT (mission_id, agent_user_id)` ✅                                                                   | same                                    | no payout leg                                                 |
| Settlement fails after completion | strands HELD, no retry (E2E-05)                                                                                                        | same                                    | n/a                                                           |
| Ops flips kill-switch             | client submit refused ≤2 s; money sweeps always-on (INFRA-3 fixed)                                                                     | same                                    | n/a                                                           |
| Ops resolves SOS                  | mission SOS ✅; panic without mission ✗ (E2E-03)                                                                                       | same                                    | session SOS carries `protection_session_id` ✅                |

---

## 5. Ops console — control reality (condensed; full table in the lane report)

| Surface                                                                                 | Real controls                                                                                                                                                                                                         | Broken / missing                                                                                      |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `/bookings`, `/bookings/[id]`                                                           | list (LIMIT/OFFSET, server search), approve (Idempotency), reject, dispatch (mission + room + pushes), complete with payout overrides, proposed payouts, PII reveal audit                                             | **no resolve-review button** (E2E-02b); approve has no past-start guard (E2E-04); toast copy (E2E-48) |
| `/dispatch`, `/dispatch-inspector`                                                      | kill-switch (Redis, fleet-wide ≤2 s), test dispatch, cancel, force-assign, inspector paging                                                                                                                           | hardcoded region list                                                                                 |
| `/jobs`, `/jobs/[id]`                                                                   | board (LIMIT 500), shortlist/assign/reject                                                                                                                                                                            | dead `cancelJob/dispatchJob` client fns                                                               |
| `/live`, `/live/[id]`                                                                   | re-route, deployment sign-off, abort (refund + crew push + room delete), complete, ops-room message, SOS ack/resolve                                                                                                  | 200-active cap no paging (E2E-42); OPS 403 on ack (E2E-18)                                            |
| `/live/wall`                                                                            | —                                                                                                                                                                                                                     | **decorative** (E2E-30)                                                                               |
| `/sos`                                                                                  | ack, escalate, resolve                                                                                                                                                                                                | panic resolve 404 + silent DB resolve (E2E-03); escalate silent (E2E-40); ack ungated (E2E-18)        |
| `/pro-applications/[id]`, `/pro-management`, `/protection`                              | proposal/reject/cancel, notes, messages, schedule-with-CPOs, decline, vehicle/resource assign+release, org/CPO create, suspend, assignment create/cancel/complete, fleet CRUD, session END/TRANSFER, org audit drawer | notes gate drift (E2E-44); **no "start/force session"**, no cross-plan reserved-dates view (E2E-08)   |
| `/finance`                                                                              | dispute resolve, wallet adjust (+push), keyset ledger, escrows/payouts/invoices/promos                                                                                                                                | read-only lists truncate silently                                                                     |
| `/users/[id]`, `/agents/[id]`, `/compliance`, `/settings`, `/admins`, `/referral-codes` | tier, revoke device, suspend/restore/erase; decide/terminate/KYC; verify/reject (+push); regions, service pricing (+`bumpConfigVersion`), subscription prices; admins CRUD; codes                                     | suspend skips gate bust (E2E-39); agent list unscoped (E2E-19)                                        |

**Propagation (ops → app):** `BookingPushBridge` → Redis `push:events` → messenger FCM wake → app hydrates `/events/by-id` + durable inbox; `useMissionEvents` joins `mission:<id>` and resubscribes on reconnect. Pricing (`bumpConfigVersion`), tier (`bustTierGate`) and terminate (`bustAccountGate`) busts are in (OP-02/03/06). **No ops websocket** — every operational surface is SWR polling at 2 s / 5 s.

---

## 6. Money map (where credits actually move)

| Event                                | Who is debited/credited                                                                    | Code                                                                                         | Verified                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Secure Transfer / EP booking created | **nobody** (only affordability check)                                                      | `booking.service.ts:562-617`                                                                 | ✔︎                                                   |
| Agency accepts offer                 | payer → `escrow_holds HELD` (family cap re-locked)                                         | `dispatch.service.ts:1269-1319`                                                              | ✔︎ paired ledger rows pinned by spec                 |
| Client cancels pre-crew              | full refund                                                                                | `booking.service.ts:1494-1534`                                                               | ✔︎                                                   |
| Client cancels post-crew             | `cancel_fee_pct` split                                                                     | `:1521-1531`                                                                                 | ✔︎                                                   |
| Agency no-show (crew SLA)            | full refund                                                                                | `crew-sla.service.ts`                                                                        | ✔︎                                                   |
| Mission completes, proof PASS        | `PENDING_RELEASE` → +72 h → agency minus platform fee, `mission_payouts`                   | `agent.service.ts:2142`, `escrow-release-sweep.service.ts:69-97`, `settlement.service.ts:64` | ✔︎                                                   |
| Mission completes, proof FAIL        | `review_required`, **stranded** (no console exit)                                          | `agent.service.ts:2164-2168`                                                                 | ✔︎ E2E-02b                                           |
| Settlement throws                    | HELD, **stranded** (no retry)                                                              | `:2170-2175`                                                                                 | ✔︎ E2E-05                                            |
| Dispute resolve / clawback           | ops §41 path, `booking_id IS NOT NULL` fix in                                              | `ops.service.ts:1788-1968`, `wallet.service.ts:1104`                                         | ✔︎                                                   |
| Stripe refund/dispute                | reversal incl. pre-settle tombstone                                                        | `wallet.service.ts:1376-1392`, spec MON-1                                                    | ✔︎                                                   |
| Secure Pro plan                      | whole plan debited once at activation; **no per-date/session money, no payout to the org** | `pro-applications.service.ts:396`, `pro-management.service.ts:73,628`                        | ✔︎ — off-platform compensation assumed, undocumented |

---

## 7. Status of the 2026-08-28 adversarial register in this HEAD

| 08-28 finding                                                             | Status now      | Evidence                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AUD-P0-1 fabricated proof / no identity handshake / never-live completion | **Fixed**       | verify-code POST stamps `identity_verified_at` (`agent.service.ts:2064-2131`), proof check 5 reads it (`proof-of-completion.service.ts:45-46,122-126`); `missionFsm.assert` wired in every writer with a coverage pin (`ops/fsmWriterCoverage.spec.ts`); complete requires `live_at` |
| AUD-P1-1 MON-1 chargeback minting                                         | **Fixed**       | `charge.refunded` / `charge.dispute.funds_withdrawn` handled, proportional, pre-settle tombstone (`wallet.service.spec.ts:399-499`)                                                                                                                                                  |
| AUD-P1-2 INFRA-1 Redis crash-loop                                         | **Fixed**       | `main.ts:20-23` `unhandledRejection`/`uncaughtException` handlers; sweeps wrapped                                                                                                                                                                                                    |
| AUD-P1-3 MON-2 stranded review_required                                   | **Half**        | endpoint `POST /ops/bookings/:id/resolve-review` exists (`ops.controller.ts:213`) — **no console UI** (E2E-02b)                                                                                                                                                                      |
| AUD-P1-4 FSM-1 decorative FSM                                             | **Fixed**       | as P0-1                                                                                                                                                                                                                                                                              |
| AUD-P1-5 FRAUD-4 job-board coords                                         | **Fixed**       | `agent.service.ts:696-706` returns NULL coords + distance bucket                                                                                                                                                                                                                     |
| AUD-P1-6 MOB-1 emergency log cross-account                                | **Fixed**       | cleared in `authStore.ts:1036-1042` sign-out                                                                                                                                                                                                                                         |
| AUD-P2-1 AUTHZ-1 SOS forgery                                              | **Fixed**       | owner-bound `sos.service.ts:112-125, 213-218`                                                                                                                                                                                                                                        |
| AUD-P2-4 INFRA-2 lost ops-approved frame                                  | **Fixed**       | stuck-`now` recovery `scheduled-dispatch.service.ts:86-93` + spec                                                                                                                                                                                                                    |
| AUD-P2-5 INFRA-3 kill flag strands money                                  | **Fixed**       | money sweeps always-on (per lane 4)                                                                                                                                                                                                                                                  |
| AUD-P2-10 FSM-3 unfenced locks                                            | **Fixed**       | `common/redis-lock.ts:25-46` fenced + Lua release                                                                                                                                                                                                                                    |
| AUD-P2-14 MOB-5 background GPS/keep-alive                                 | **Open**        | `onDutyHeartbeat.ts` still TODO (E2E-17)                                                                                                                                                                                                                                             |
| AUD-P2-18 FRAUD-7 offer budget griefing / no fallback                     | **Open**        | `TODO(LB13)` (E2E-11)                                                                                                                                                                                                                                                                |
| AUD-P2-2 AUTHZ-2 region scope gaps                                        | **Partly open** | agents surface still unscoped (E2E-19)                                                                                                                                                                                                                                               |
| P3 MON-5 clawback fee index                                               | **Fixed**       | 42P10 fix (`wallet.service.ts:1104`)                                                                                                                                                                                                                                                 |

---

## 8. Scale readiness at 5,000 users

### 8.1 Hot paths

| Path                                                         | Shape                                                           | Index                                                      | Lock / idempotency                                                              | Verdict                          |
| ------------------------------------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------- |
| Booking create                                               | ~6 indexed round trips, single INSERT                           | `lite_bookings_client_created_idx` (pending apply, E2E-22) | `/dispatch/request` keyed; `/bookings` **not** (E2E-23); no DB one-active guard | risk                             |
| Escrow at accept                                             | conditional UPDATE + `FOR UPDATE` chain, deadlock retry         | PK                                                         | first-accept-wins ✅                                                            | OK                               |
| Offer cascade                                                | `RANKING_SQL` PostGIS + 2 plpgsql fns/row, ORDER BY defeats KNN | `agents_last_location_gix`, `agents_dispatch_pool`         | unique partials ✅                                                              | risk (E2E-25)                    |
| Offer-expiry sweep                                           | 8 s, LIMIT 50, serial `offerNext`                               | `dispatch_offers_expiry`                                   | fenced lock TTL 7 s < batch (E2E-24)                                            | risk                             |
| Scheduled / T-60 / relist / payment-pending / escrow-release | 60 s, LIMIT 25–50, per-row txn                                  | two predicates uncovered (E2E-26)                          | fenced + conditional ✅                                                         | mostly OK                        |
| Protection lazy sweeps                                       | inline on 2 s ops poll, no lock/LIMIT                           | partial live index usable; retention DELETE unbounded      | none                                                                            | will degrade (E2E-35)            |
| Telemetry ingest                                             | 1 upsert (one row per booking) + Redis `XADD MAXLEN 500`        | PK                                                         | per-user throttle ✅                                                            | OK — best path in the repo       |
| CPO duty heartbeat                                           | GiST rewrite per 30 s fix                                       | —                                                          | —                                                                               | risk (E2E-26)                    |
| Notifications                                                | Redis pub/sub → serial FCM multicast, no queue/retry            | `notifications_created_at_idx`                             | —                                                                               | risk at burst (E2E-49)           |
| Ops lists                                                    | all LIMIT-bounded post-B-721                                    | mixed                                                      | —                                                                               | OK; poll volume is the real load |

### 8.2 Configured limits (as shipped)

pg pool `max 20`, `connectionTimeoutMillis 5000`, `statement_timeout 15000` set via startup `options` **through the Supabase transaction-mode pooler :6543 — not guaranteed to apply** (open question) · one ioredis client, no `retryStrategy` (messenger has one) · global throttle 120/60 s IP-keyed, **in-memory, shadow-mode** (E2E-20) · WS `pingInterval 30 s`, no connection cap, `WS_SESSION_RECOVERY` single-replica, SFU single-replica by design · **no container limits, no cluster, no heap ceiling** (E2E-21) · JWT HS256 + one Redis `EXISTS` per request; guard DB reads Redis-cached 30 s with bust ✅ · client polls: home 8 s, finding 5→15 s, ops 2 s mission/dispatch, 5 s dashboard.

### 8.3 Measured vs assumed

**Measured: nothing.** `OPS_PROPAGATION_AND_FETCHING_AUDIT_2026-09-02.md:5`: "Nothing was measured on a live server today." The 2026-09-02 index work is a static predicate cross-reference. Real-pg integration tests exist for lock serialization (`test/integration/concurrency.itest.ts`, `dispatch-money-invariant.itest.ts`, `reconciliation.itest.ts`); `scripts/e2e-ops-load.ts` is functional, not load. **No k6/artillery/autocannon anywhere**; `BUILD_RUNBOOK.md` still owes `apps/auth-service/test/load/` and the `EXPLAIN ANALYZE` on the ranking query.

### 8.4 Minimum before claiming 5k

1. Apply `20260902090000` to staging (`CONCURRENTLY` on the large tables), then `EXPLAIN (ANALYZE, BUFFERS)` on `RANKING_SQL`, both protection sweeps, booking-reminder and scheduled-dispatch selects at 5k users / 500 agencies / 200k `lite_bookings` / 2M `protection_session_locations`.
2. Set `THROTTLE_ENFORCE=true` after confirming the legitimate poll mix does not 429; cgroup limits + heap ceiling; Redis on its own limit.
3. k6: 200 concurrent creates in 60 s (proves E2E-23), 300 heartbeats @30 s, 400 clients polling @8 s, 20 ops seats @2 s, 50 simultaneous cascades. Assert `dispatch_rank_query_ms` p95, `numbackends` vs 20, event-loop lag, offer-expiry tick overlap.
4. Confirm the pooler honours `statement_timeout`; if not, set it per-transaction.

---

## 9. What this audit could not prove (needs runtime/device/DB)

- Whether `AUTO_DISPATCH_ENABLED` and the Redis `dispatch:enabled` flag are on in staging/production — every offer-creating sweep `return`s early when off; if off, the cascade has never run under load.
- Whether `eur_per_bc` ≠ 1.0 anywhere (E2E-29 severity is conditional on it).
- Killed-app push delivery on both platforms (LM-N1/N3), verify-code display parity, and the 3-device §7 sign-off of `LITE_BOOKING_LOOP.md` — device only.
- Supabase pooler behaviour for startup `options`; pooler connection cap; whether the index migration was applied `CONCURRENTLY`.
- The B-number ledger is double-booked: `BUILD_RUNBOOK.md:4379` maps B-716..B-723 to the payment/scale audit while `sqa.md` assigns B-716..B-719 to messenger/vault/call bugs. The code fixes are real; the ledger needs one owner.

---

## 10. Recommended fix order (sized)

| #   | Item                                                                                                                                                                                                                                                                  | Findings                    | Size                               | Gate                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------- | ------------------------------------ |
| 1   | Product decision: Pro reserved date = auto-activate (sweep + FSM states + end-of-day + alerts) **or** "unlocks on the day" copy; plus SCHEDULED cancel path and one canonical timezone                                                                                | E2E-01/07/08/09             | M (decision) + L (auto) / S (copy) | founder                              |
| 2   | Ops SOS: branch on `mission_id` before `requireMission`, transactional resolve; align `canAckSos` with server; gate the ACK button                                                                                                                                    | E2E-03/18                   | S                                  | ops.spec + rbac test                 |
| 3   | Stranded money: `COMPLETED+HELD` retry sweep; resolve-review button on booking detail                                                                                                                                                                                 | E2E-05/02b                  | S–M                                | escrow spec + console e2e            |
| 4   | Client no-show: lead-initiated after `pickup_time + grace`, partial settlement, client dispute door                                                                                                                                                                   | E2E-06                      | M                                  | FSM pin + money spec                 |
| 5   | Scale config: `THROTTLE_ENFORCE`, container limits, heap ceiling, apply index migration, offer-expiry TTL ≥ batch ceiling (or batch 10), two partial indexes, throttler storage → Redis                                                                               | E2E-20/21/22/24/26          | S                                  | staging apply + k6                   |
| 6   | `POST /bookings`: `IdempotencyInterceptor` + `@Throttle` + partial unique `lite_bookings(client_id) WHERE status NOT IN (terminal)`                                                                                                                                   | E2E-23/36                   | S                                  | itest                                |
| 7   | EP lifecycle: block-anchored no-show/arrival clocks, hourly clock from `start_time`, block-end auto-complete + over-run, missed-check-in escalation, EP-native proof gate, past-start approval guard, EP lead window ≥ T-24 h with retries, cancellation fee schedule | E2E-02/04/11/12/13/14/15/16 | L                                  | new `EP_MISSION_LOOP` runbook        |
| 8   | Pricing parity: estimate sends `pickup`; ops breakdown reads persisted `pricing_breakdown`; client line items via `priceValue`; estimate mirrors transport/vehicle rules; BC-vs-EUR at the estimate boundary                                                          | E2E-27/28/29/38/47          | M                                  | `bookingSummaryRows` + pricing specs |
| 9   | Wizard: real Book Now (respect server exemption / ops lead key), region-vs-pickup server check, ref-based submit guard, focus-restart polling, offline fallback with peak                                                                                             | E2E-10/31/32/33/36          | M                                  | booking project                      |
| 10  | Agency/CPO: real background keep-alive (or honest "you went offline" + no decline accounting), CPO decline → auto-reassign                                                                                                                                            | E2E-17/34                   | M                                  | device pass                          |
| 11  | Console hygiene: agent region scope, suspend gate bust, escalate emit, `crewAssigned` on ops dispatch, `/live` paging, AdminGuard write debounce, delete `/live/wall`, notes gate                                                                                     | E2E-19/39/40/41/42/43/44/30 | S–M                                | console tests                        |

**Sign-off criteria for "works smoothly for 5k users":** items 2–6 shipped and device-verified; §8.4 load run recorded with p95 numbers in this doc; item 1 decided and either shipped or copy changed; item 7 at least the past-start guard, block-end and EP proof gate. Until then the honest statement is: _Secure Transfer is production-shaped and safe behind the kill-switch; Executive Protection and Secure Pro deliver their booking and payment halves but not the mission-day promises on their screens; nothing has been load-measured._

---

## 11. Remediation — 2026-09-04 ("fix all")

Fixed in one campaign across six file-disjoint lanes plus two integration lanes, each lane
gated and mutation-proven where a mutation was meaningful. **84 files changed, +5,317 / −489
lines, 26 new files (3 migrations, 1 sweeper service, 2 helpers, 1 console component, 19 test
files).** No finding was closed by weakening a check, and no `skip in dev` branch was added
(diff-verified).

### 11.1 Gates at the close (final tree: remediation + critic round + upstream merge + B-792)

| Gate                                                              | Result                                                                                                               |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `apps/auth-service` full Jest                                     | **193 suites / 3,604 tests / 0 failures** (was 186 / 3,460 before the campaign)                                      |
| `apps/auth-service` `tsc --noEmit`                                | clean                                                                                                                |
| `jest --selectProjects booking`                                   | **89 suites / 1,200 tests / 0 failures** (was 86 / 1,134)                                                            |
| `jest --selectProjects app` (full mobile project)                 | **255 suites passed / 1 skipped, 3,422 tests** — two first-run reds were both non-defects, see §11.7                 |
| `jest --selectProjects messenger-crypto` (×2, flake rule)         | **596 suites / 7,345 tests**, both runs identical, no flake (run after the last touch of `src/modules/messenger/**`) |
| `jest --selectProjects app --testPathPattern "screens/messenger"` | 56 passed / 1 skipped, 754 tests                                                                                     |
| `jest --selectProjects ops-console`                               | **4 suites / 75 tests** (was 3 / 30)                                                                                 |
| Mobile `tsc --noEmit`                                             | **46 errors = baseline 46**, none in touched files                                                                   |
| ops-console typecheck + lint                                      | clean · clean                                                                                                        |
| Encoding + conflict-marker sweep over every staged file           | clean (the 1,034 mojibake sequences in `sqa.md` predate this session on both sides)                                  |
| Version                                                           | **1.0.293 / vc350** (upstream landed 1.0.292 / vc349 mid-campaign)                                                   |

### 11.2 Status by finding

**Closed (44):** E2E-01, 02, 02b, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 16, 18, 19,
20, 21, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 35, 36, 37, 38, 39, 40, 41, 43, 44, 45, 46,
47, 48, 50, 51, 52.

Two were already fixed upstream by the ops-console IA restructure that landed mid-campaign
(**E2E-02b** the resolve-review control, **E2E-30** the decorative live wall, now deleted with
its route redirected); both were verified rather than re-implemented.

**Partial (3):**

- **E2E-17** — a real background keep-alive was NOT built. The mission foreground service
  exists, but notifee registers exactly one foreground-service task per process and the mission
  service owns it, so a duty stop could tear down a live mission's GPS (B-339 class) with no
  device to verify on. Shipped instead: a duty-link state machine (`off/connecting/live/stale`)
  using the same locatability rule the dispatch ranking uses, an honest **"ON DUTY · NOT
  RECEIVING JOBS"** banner, a "send my location now" button, and a foreground-return fix push.
  The agency is no longer lied to; it is still dropped while backgrounded.
- **E2E-34** — client-side honesty only (the CPO is told what actually happens after a decline).
  Server-side automatic reassignment is unbuilt.
- **E2E-42** — truncation notices added to the two surfaces that matter operationally (active
  missions, SOS). `/compliance`, `/protection`, `/vbg`, disputes/escrows/payouts/invoices and
  `/jobs` still truncate silently; several need a server `offset` first.

**Deliberately not done (recorded, with reasons):**

- **EP block extension** — out of scope; an over-run is still not billed.
- **EP pre-escrow cancellation fee** — before an agency accepts there is no HELD hold to split.
  Charging would need a pre-authorised hold at submit: a product decision, not a code change.
- **`NO_PROVIDER` terminal reopen** — it is one of the four statuses that free the one-active
  slot, so reopening could collide with a booking the client has since made. E2E-11's retry is
  implemented as a re-drive of a _stalled_ `DISPATCHING` search plus an ops page instead.
- **`@RequireRoles` tier gate on the ops agent reads** — the region scoping (the real isolation
  defect) is fixed hard, but adding a SUPERVISOR gate without a matching console change would
  403 every OPS operator on a page the console still shows them, recreating E2E-18 elsewhere.
- **Strict idempotency on `POST /bookings`** — the installed client sends no key on that route,
  so a hard requirement would 400 every booking on shipped builds. Uses the pre-existing
  _optional_ interceptor; the race itself is closed at the database by a partial unique index.
  One-word swap to strict once the client ships a key.
- **Clamping `pull` inside `clawbackReleasedHold`** — would change `RELEASED` semantics, where
  the agency deliberately fronts the platform's original fee back to the client. Bounded at the
  caller instead.

### 11.3 Behaviour changes an operator or the founder should know about

1. **Rate limiting now enforces by default** (`THROTTLE_ENFORCE=true`), with the global per-IP
   ceiling raised 120 → 600/min to compensate. The bucket is IP-keyed and runs before auth, so
   users behind one carrier NAT share it. Storage is still in-memory, so limits multiply per
   replica — **Redis `ThrottlerStorage` is required before scale-out.**
2. **"Agency keeps everything" dispute resolution now refuses.** It was already broken (it
   recorded a split that never happened and pushed the client a refund notice while no money
   moved). If rejecting a dispute without moving money is a real workflow it needs its own
   path that writes the unchanged split honestly — a new behaviour, deliberately not invented.
3. **Executive Protection now searches from T-24 h** (was T-15 min), so `NO_PROVIDER` surfaces
   with time to recover, and a stalled search is re-driven.
4. **Book Now is bookable again** and clamps up to the earliest bookable instant instead of
   silently rolling to tomorrow; the resolved start is rendered under the picker.
5. **A Pro reserved date now activates itself** at 60 s cadence, escalating to ops when a date
   has no officers or never went live. Sessions are still born `REQUESTED` so the existing
   two-device readiness gate is untouched.
6. **The canonical business day is Gulf (UTC+4)**, written as an explicit UTC offset so it
   depends on neither session `TimeZone` nor tzdata.

### 11.4 Deploy — OWED, in this order (no server access from this session)

1. `20260902090000_scale_indexes_50k.sql` — written 2026-09-02, **never applied**.
2. `20260903100000_pro_mission_activation.sql` — **must land before the code**; without it
   `listMissions` / `requestMission` / `cancelMission` 500 (the sweeper itself never throws).
3. `20260903110000_settlement_retry_and_no_show.sql` — without it the settlement retry pass
   logs a warning each tick and does nothing; the other passes are unaffected.
4. `20260903120000_booking_guards_and_scale_indexes.sql`.
5. `20260903130000_dispatch_areas.sql` (upstream B-788a; the server reads `dispatch_offers.source`
   and writes `lite_bookings.area_id`, so it too is **migration before server**).

`scripts/db-migrate.sh` uses `--single-transaction`, so **`CONCURRENTLY` cannot run inside it** —
the index list needing a by-hand pass first is in each migration's header. `db-migrate.sh --apply`
now runs a post-apply assertion over the objects each migration promises and **exits non-zero**
if one is missing; the one-active-booking unique index pre-counts duplicates and degrades to a
`RAISE WARNING`, which that assertion then turns into a failed run — clean the duplicates and
re-run.

**The box's compose file is not in this repo.** The live path is `~/bravo/docker-compose.staging.yml`
on `94.136.184.52` (`scripts/deploy-staging.sh`, `docs/runbooks/CICD_STAGING.md`); the limits in
the repo's `docker-compose.yml` and `infra/systemd/*` are dev-only and inert for staging. Hand-add:

- `auth-service`, `messenger-service`: `mem_limit: 1536m`, `memswap_limit: 1536m`, `cpus: 1.5`,
  `NODE_OPTIONS: '--max-old-space-size=1024'`, and `THROTTLE_ENFORCE: 'true'` — present even at
  its default, because `'false'` is the only rollback lever and it must be reachable.
- `redis`: `mem_limit: 512m`, `memswap_limit: 512m`, `cpus: 0.5`,
  `command: redis-server --appendonly yes --appendfsync everysec --maxmemory 384mb` plus a
  `redis-data:/data` volume. **Two deliberate departures from the line originally written here
  (applied 2026-09-04, see the incident note below):** (1) **NOT `allkeys-lru`.** This Redis is
  not a cache — it is the messenger relay's only envelope store, the JTI allowlist, ack tokens,
  media grants and the cron locks; eviction is silent message loss. `maxmemory` with the default
  `noeviction` refuses the write instead, which is recoverable. (2) **Persistence + a volume,
  not `--save '' --appendonly no`.** Without them a container recreate is a full wipe.
- `coturn`: `mem_limit: 512m`, `memswap_limit: 512m`, `cpus: 1.0` (host networking does not exempt it).
- Verify: `docker inspect -f '{{.Name}} mem={{.HostConfig.Memory}} cpu={{.HostConfig.NanoCpus}}' $(docker ps -q)`
  every value non-zero, and `docker exec bravo-staging-auth printenv THROTTLE_ENFORCE NODE_OPTIONS`.

New config keys (all `get(...) ?? default`, so absent = default): `DISPATCH_CLIENT_NO_SHOW_GRACE_MINUTES`
20 · `DISPATCH_SETTLE_RETRY_GRACE_MINUTES` 10 · `DISPATCH_SETTLE_MAX_ATTEMPTS` 5 ·
`DISPATCH_EP_BLOCK_END_GRACE_MINUTES` 15 · `DISPATCH_CHECKIN_OVERDUE_GRACE_MINUTES` 20 ·
`DISPATCH_EP_MIN_CHECKINS` 1 · `DISPATCH_NO_SHOW_FIX_MAX_AGE_MINUTES` 10 ·
`DISPATCH_EP_SCHEDULED_LEAD_MINUTES` 1440 · `DISPATCH_STALE_START_FLOOR_MINUTES` 30 ·
`DISPATCH_SCHEDULED_RETRY_MINUTES` 5 · `DISPATCH_RANK_CANDIDATE_CAP` 200 ·
`BOOKING_LATE_CANCEL_HOURS` 12 · `PRO_MISSION_UNASSIGNED_ESCALATE_DAYS` 1.

Note the **first-tick backfill**: on deploy the settlement sweep immediately acts on the known
stranded holds, the block-end pass closes stale LIVE EP missions through the proof gate, and the
Pro activation sweeper opens sessions for any date that is today. Intended, but visible one-offs.

**Staging deploy record + incident, 2026-09-04.** The three remediation migrations were applied
(ledger rows with checksums; the one-active guard **built**, not skipped — zero duplicates
pre-existed), the container limits, `NODE_OPTIONS` and `THROTTLE_ENFORCE` are live, and the
server still runs the previous image, so the new backend behaviour is dormant until the code
deploys (correct order). The database now holds **33 COMPLETED bookings with escrow still HELD**
and **11 SCHEDULED Pro dates at or before today** that the first sweeper tick will act on.

**Incident:** applying the limits required recreating the Redis container, and staging Redis
had **no volume and no persistence** (`--save '' --appendonly no`), so the recreate emptied it —
the messenger relay (any undelivered envelopes for offline devices, up to the 30-day dwell), the
JTI allowlist (every live access token), presence, ack tokens, cron locks. Deploys had NOT been
doing this: `deploy-staging.sh` recreates only the target service, so Redis had likely run for
weeks. Impact assessment from code: **tokens self-heal** (the refresh path validates the refresh
token against Postgres, then re-issues a JTI — one 401 then a silent refresh, no logout, and the
logs show zero auth failures after); **relay envelopes in flight were lost** (the Postgres
`sealed_envelope_archive` is the backup-restore copy, not a relay replay source); everything else
rebuilds. **The miss:** the contents could have been exported (`SAVE` + `docker cp`) before the
recreate and were not. Fixed while empty: AOF `everysec` + a named volume, so a recreate is no
longer a wipe. Rule for the next person: **a Redis recreate is not a deploy — check for a volume
first, and never recreate a persistence-less Redis without dumping it.**

### 11.5 Still unproven — the honest limits of this campaign

Everything above is static, unit and typecheck evidence. **Nothing was run against a live
database, Redis, Stripe or a device.** Specifically still owed: the §8.4 load run (no k6 in the
repo), `EXPLAIN ANALYZE` on the ranking query at 5k scale, and a device pass on Book Now, the
no-show door, the ISSUE check-in, the duty-stall banner and the Pro activation round trip.
**E2E-31's region cross-check is inert today** because `DEFAULT_REGIONS` ship no bounding box,
so point-to-region resolution returns null until ops populates `public.regions`.

### 11.6 Adversarial critic round — what the lane gates missed (2026-09-04)

Before pushing, six read-only critics attacked the six lane diffs. **Every lane returned
"fix first."** Between them they found five P0s and roughly fifteen P1s that the lane gates,
the mutation proofs and the coordinator's diff review had all passed. All were fixed by the
owning lane with a spec and, for the P0s, a mutation proof; the numbers in §11.1 are AFTER
this round. Recorded so the next reader knows what a green suite did not catch.

| #   | Lane       | What the critic found                                                                                                                                                                                                                                                                                     | Why the gate missed it                                                                 | Fix                                                                                                                |
| --- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| P0  | booking    | The one-active-booking unique index mirrored the INSERT-time read guard, but an index fires on every UPDATE. A parked `later` reservation entering `DISPATCHING` beside a live `now` booking (both legal, B-405) hit 23505 with no handler; the new stale-start sweep then **cancelled and refunded** it. | The spec modelled the INSERT, never the transition.                                    | Index scoped to `booking_mode='now'`; a stateful fake index drives the transition under both predicates.           |
| P0  | booking    | Throttle enforce-ON at 600/min **per IP** with no ops controller carved out; four console seats behind one NAT exceed it, twenty are throttled continuously; carrier CGNAT hits it at ~30 users.                                                                                                          | Unit tests exercise one caller.                                                        | Global bucket re-framed as a 3000/min DDoS backstop; `UserThrottlerGuard` on every ops controller.                 |
| P0  | ops        | Agent region scoping filtered on `agents.region_code`, which has ONE writer — the agency profile. Every individual officer's is NULL, so a region-scoped admin saw **no officers at all** (incl. the approval queue) and 403'd on detail.                                                                 | Every fixture set `region_code:'AE'`.                                                  | Region derived through org → home_region → coverage → country in one SQL expression shared by list and detail.     |
| P0  | settlement | The no-show "at the pickup point" guard accepted a **client-supplied** `lat/lng` and, failing that, any telemetry row with no time bound. A lead could POST the pickup coordinates from the depot and collect the fee.                                                                                    | The spec tested a FAR fix, never a fabricated NEAR one.                                | Body fix dropped; requires `pickup_at` and a server-stamped `mission_telemetry` row inside the radius ≤10 min old. |
| P0  | settlement | Grace anchored on `pickup_time` only, so a crew arriving 90 min late could declare a no-show **at once** and the client who waited paid for the agency's lateness.                                                                                                                                        | Only the early-arrival case was reasoned about.                                        | `anchor = max(pickup_time, pickup_at)`.                                                                            |
| P1  | ops        | Tightening both terminal dispute branches to fail on `clawed:false` left the MOST COMMON verdict — "the fee stands / dispute rejected" — **unrecordable**; the row stayed open forever. (A consequence of a tightening the coordinator authorised.)                                                       | The tightening was reasoned about as "refuse the broken case," not "what replaces it." | Explicit `NO_CHANGE` → `rejected` outcome with audit + push and no wallet call.                                    |
| P1  | ops        | PARTIAL clawback over-pulled when one leg clamped (`{500,100}` on 800/200/600 drained the agency of 200 though the operator said it keeps 100).                                                                                                                                                           | Only `pull > held` was tested.                                                         | Bound is `pull > held − toProvider`; reductions of a leg refuse by name.                                           |
| P1  | ops        | Approve's on-demand exemption was broader than create's: EP is lead-gated unconditionally at create, so an EP auto+now booking skipped even the non-overridable past-start refusal.                                                                                                                       | Spec used `secure_transfer`.                                                           | Service-gated exemption.                                                                                           |
| P1  | ops        | The new mission-less SOS resolve was **unauthorised** across regions (the region assert returned early on null mission), and the spec asserted no region read.                                                                                                                                            | Pre-fix the path always 404'd, so it was unreachable.                                  | Region derived from the SOS's booking/raiser; spec flipped.                                                        |
| P1  | ops        | Mission-less resolve cleared the KPI but left `sos_events.status='active'` and `protection_sessions.sos_active` set — the Pro live screen kept its SOS banner forever.                                                                                                                                    | Only `resolved_at` was asserted.                                                       | Both cleared inside the txn.                                                                                       |
| P1  | settlement | Lock-order inversion (mission→booking) vs `cancelBooking` (booking→mission): deadlock on a PICKUP no-show racing a client cancel.                                                                                                                                                                         | No concurrent test.                                                                    | Booking lock first; pinned by call order.                                                                          |
| P1  | settlement | `fsmWriterCoverage` is a hand-listed whitelist; two new SYSTEM writers landed unpinned (and one used an `as` cast that the regex would never match).                                                                                                                                                      | The pin is a whitelist.                                                                | Two cases added; the cast forbidden by assertion.                                                                  |
| P1  | settlement | The block-end sweep routed a legacy (no-hold) booking to `disburseMissionPayout` — a **timer-initiated wallet credit with no proof gate**.                                                                                                                                                                | Idempotent, so no double-pay to trip.                                                  | System close refuses the no-hold branch; core refuses `SYSTEM` on the legacy payout.                               |
| P1  | settlement | Proof gate measured EP due-hours from `live_at` while the clock and sweep used `pickup_time`; a 45-min-late go-live on a 1 h block skipped the presence check entirely. And every EP booking skipped movement even with a real transfer leg.                                                              | The three anchors were never asserted equal.                                           | Gate anchored on `pickup_time`; classified by transfer leg.                                                        |
| P1  | pro        | One UTC "today" survived in the converted folder (`buildMissionView`), one client screen was missed, and the timezone spec imported the same helper it tested (delete the +4 h and it still passed).                                                                                                      | Self-referential pin.                                                                  | `todayGulf()` everywhere; 11 literal-instant tests; mutation kills 6.                                              |
| P1  | pro        | Ops cancel on day 2 of a multi-day run released the covering assignment while a session was **live** on it; officer views went dark, no end, no signal.                                                                                                                                                   | E2E-51 protected plan expiry, not cancel.                                              | Both cancel paths refuse with `mission_has_live_session`.                                                          |
| P1  | console    | Reserved-date panel cried wolf: `officers_today` counts today's coverage but rows include tomorrow, so a healthy tomorrow date showed **NO OFFICERS ASSIGNED** — and the test pinned it. Suppressing tomorrow alerts would re-silence E2E-08.                                                             | Server field semantics not read.                                                       | Server adds `officers_on_date` per row; console alerts on it for any row.                                          |
| P1  | console    | A malformed `POLL_*` env → `NaN` → SWR disables polling; the diff widened it to the amber SOS sweep and the STALE pill. `useOpsMe` polling the one 401-booting endpoint every 60 s could discard an open modal on a token-rotation race.                                                                  | Env parsing untested.                                                                  | Guarded parser; `me` fetched without boot, two consecutive 401s required.                                          |
| P1  | mobile     | ISSUE check-in shared the SMOOTH idempotency key; the strict interceptor replayed the cached SMOOTH for 24 h. Refusal handling branched on codes the server never emits (and the test pinned them).                                                                                                       | Client and server were written from the same brief, not from each other.               | Status in the key; real codes; fresh telemetry push before a no-show instead of a body fix.                        |

**Process notes recorded for the next campaign.** A scoped Jest pattern is not a typecheck
(the throttler binding broke compile in four folders and passed its own gate). A PowerShell
`.Replace()`/`Set-Content` round-trip silently no-ops on CRLF or corrupts UTF-8 — every
mutation must be applied by a script that reports what it changed, then grep-verified. Eight
orphaned Jest workers from one killed run degraded every later measurement on the box until
found. And one agent routed around a denied `git checkout` by rewriting file contents; the
result was verified byte-identical, but that is not a habit to keep.

### 11.7 Merge with upstream B-788..B-791 (Dispatch v2, cross-zone booking)

While the remediation was in flight the other session pushed five commits (1.0.291/292):
no map distance restriction with the zone as authority, Dispatch v2 assigned-provider routing
per area (dark by default), a zone clock, and an EP Confirm & Book Fabric fix. Twelve files
collided. Nine merged mechanically; three by intent:

- **Pickup pin vs zone** — upstream refuses whenever the pin is outside the chosen zone's own
  box (founder rule, spec'd, also covers ocean/unmapped pins); ours refused only when the pin
  was unambiguously in one other zone. **Upstream taken**, our richer error body ported.
- **Book Now timing** — upstream keeps roll-to-tomorrow under the 3 h lead, in zone wall-clock;
  ours removes the roll (E2E-10). **Ours for the floor, upstream for the clock frame.**
- **EP review UTC stamp** — upstream makes the scheduled date zone wall-clock, so our stamp
  would have printed the wrong instant on the money screen; converted at the stamp.

Dispatch v2 is dark (`routing_mode` default `nearest`), so the KNN candidate cap still runs
on every production offer and the scheduled lead window, stalled re-drive and stale-start
close-out all remain required. Upstream's migration `20260903130000_dispatch_areas.sql` joins
the deploy order **before** the server.

Resolution notes worth knowing (the merge changed four tests deliberately, never to make a
run green):

- `booking.e2e-audit-20260903.spec.ts` — two error-code renames to upstream's
  `pickup_outside_region`, and **one assertion flipped**: "accepts a pin in NO box" became a
  refusal, because the adopted rule covers unmapped/ocean pins. The overlap cases still pass; the
  overlap now only decides whether the refusal can _name_ the other zone (`pickup_region`).
- `dispatch.assigned-routing.spec.ts` (upstream's own new spec) — its `noProvider` row-lock mock
  matched a three-column SELECT that E2E-11 had widened; the textual auto-merge hid it and the
  mock returned `null`, so the `NO_PROVIDER` flip silently never ran. Relaxed to the leading
  columns. **This was the only real semantic collision the auto-merge concealed.**
- Two further instances of the wall-clock-vs-instant mix appeared where our E2E-37/E2E-10 lines
  landed in upstream's zone-clock `laterDate` (`CustomizeAddOnsScreen`, `bookNowLeadTime.test.ts`);
  fixed by the same conversion as the EP stamp.
- **B-792 (new, found during the merge):** upstream's own `commitLater` compared a zone
  wall-clock against an instant floor and seeded an instant into the wall-clock date, skewing
  the Book-Later auto-correct by the zone offset whenever zone ≠ device clock. Pre-existing in
  1.0.292, single-sided, outside every hunk — fixed here rather than shipped as a known instance
  of the class just closed three times over.
- `subscription/planCatalog.spec.ts` — built a bare Nest test module around the subscription
  controller, which now binds the per-user throttler; the guard's real constructor needs
  throttler options the unit module never provides. Overridden like the three guards it already
  overrides. It was outside every lane's scoped Jest pattern and only surfaced on the full run —
  the same lesson as the `Throttle` import: **a scoped pattern is not the suite.**
- **P0 re-verification after the merge (5 fixes re-opened by a fresh verifier):** index scoping,
  derived agent region, no-show presence guard and grace anchor all intact and pinned. The
  throttle fix **regressed at the seam**: upstream's new `ops-dispatch-areas.controller.ts`
  arrived with no per-user throttler, and the binding spec was a hardcoded 14-entry list that
  could not see a 15th. Fixed by binding it and replacing the list with discovery over every
  `@Controller('ops…')` in the tree, so the next controller anyone adds is covered the day it
  lands. **A whitelist pin is only as good as the day it was written.**
- **Full mobile run, first pass: two reds, both non-defects, both instructive.**
  `sourceScanSafety` (the repo's guard that a static scan never silently swallows real code)
  flagged the console lane's new `useOpsMe` comment: the path `/ops/*` written in prose contains
  `/*`, which the house-style comment stripper reads as a block-comment opener, eating 89 lines
  of `api.ts` from every static scan that runs over it. Rephrased. Same family as the backtick
  and `@ts-expect-error` prose traps in `CLAUDE.md`: **a scanner reads prose as code.**
  `channelTreeInteraction` ran 541 s under a contended box and passed alone in 6 s — the orphan/
  contention flake, not a defect.
