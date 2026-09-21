# Ops Console — Information Architecture Audit & Restructure Spec (2026-09-03)

> **Who this is for:** the engineer (human or Opus 5) who will rebuild the console's
> navigation and section layout. It is written to be executed without re-deriving anything:
> every finding carries file evidence, every target section carries its routes, columns,
> actions, backing endpoints, role gates and acceptance criteria, and §8 is the ordered
> build plan with gates. Read §0–§2 in full before touching code; the rest is reference.
>
> **Founder's brief (verbatim intent):** _"it very confusion — we have lite booking,
> executive and pro — so audit in that way that we all have separate section for all,
> another the user management, then the api calls to app (like package update change
> everything), then finance and internal thing — and dont make it so confusion make it
> industry standard."_
>
> **Scope:** `apps/ops-console/src/**` (Next.js 15 App Router, 35 pages) and the `/ops/*`
> surface in `apps/auth-service/src/**` that backs it. **Out of scope:** messenger crypto,
> auth/CSRF/JWT primitives, the mobile app (except as the _consumer_ of ops-managed config).
> This audit is about **structure, naming and completeness of the operator's map**, not
> data-fetching mechanics — those are already registered as OP-11..OP-20 in
> `OPS_PROPAGATION_AND_FETCHING_AUDIT_2026-09-02.md` and are NOT re-litigated here.
>
> **Register:** findings are `IA-01..IA-18` (sqa.md session 2026-09-03, findings-only, no
> B-numbers claimed — next free stays **B-739**). Prior console audits this builds on:
> `OPS_CONSOLE_AUDIT_2026-08-07.md` (SK/CA/IS), `OPS_CONSOLE_MONITORING_AUDIT_2026-08-26.md`
> (OC-01..18), `OPS_PROPAGATION_AND_FETCHING_AUDIT_2026-09-02.md` (OP-01..20),
> `WEBAPP_DATA_COVERAGE_AUDIT_2026-07-07.md` (DC-01..21).

---

## 0. The verdict in one screen

**The console is functionally rich and structurally confusing.** Twenty-three rail items
sit in seven groups whose names describe _tools_ ("Operations", "Dispatch", "Safety",
"Comms & Org") rather than the _businesses the operator runs_. The three product lines the
founder names — **Lite** (Secure Transfer bookings, auto-dispatched), **Executive
Protection** (fixed-block on-site details) and **Secure Pro** (3-month protection plans
with ops-assigned CPOs) — have **no section of their own**: Lite and Executive share one
`/bookings` list distinguished only by a derived "service" chip; Pro is spread across
three rail items in two different groups (`Pro Applications`, `Pro Management` under
_Operations_; `Protection` under _Safety_). The word **"Pro" means three different things**
in the console today (§2). Everything the mobile apps fetch as configuration — pricing,
regions, package catalog, subscription prices, tier grants, the dispatch kill-switch — is
scattered across a page called **"Console Settings"**, a user-detail card, and the dispatch
monitor, with no view of _what the app currently sees_. One backend operator action (the
MON-2 review-hold exit) is **unreachable from the UI at all** (IA-06).

| Axis (0–100)                                      | Now    | Target after this spec |
| ------------------------------------------------- | ------ | ---------------------- |
| **Overall information architecture**              | **48** | ≥ 90                   |
| Product-line separation (Lite / Exec / Pro)       | 25     | 95                     |
| Naming consistency (one word = one thing)         | 40     | 95                     |
| Config-to-app surface (find, edit, see effect)    | 45     | 90                     |
| Finance completeness (every money exit reachable) | 70     | 95                     |
| People / user-management completeness             | 60     | 90                     |
| Internal / governance grouping                    | 55     | 95                     |
| Visual/layout consistency between pages           | 50     | 90                     |

**What the fix is, in one paragraph:** re-group the rail by **business area**
(Overview · Lite · Executive · Pro · Enterprise · People · App Config · Finance · Safety ·
Internal), give each product a **landing page with its own pipeline KPIs**, split
`/bookings` by `service` **server-side**, merge the two dispatch pages into one, move every
app-facing setting into one **App Configuration** section with a **propagation panel**,
surface the missing money exit, add the missing provider-agency page, and put every URL
under its section prefix with permanent redirects so nothing bookmarked breaks. It is
mostly a _move_, not a _rewrite_: the page bodies survive; the map around them changes.

---

## 1. Method and evidence

- **Static walk** of every route (`find src/app -name page.tsx`), the rail (`Shell.tsx`
  `NAV`/`NAV_GROUPS`/`NAV_MIN_ROLE`), `lib/rbac.ts`, `lib/api.ts` (2,472 lines, ~120
  methods), and every `@Controller('ops…')` in `apps/auth-service/src`.
- **Cross-check against the product model**: `create-booking.dto.ts:71` (`service ∈
secure_transfer | executive_protection | recon_team | emergency_extraction`),
  `plan_catalog` seed keys (`messenger_lite/pro/enterprise`, `secure_pro`, `secure_lux`),
  `ops-subscription.controller.ts` (messenger tiers `lite|pro|enterprise`),
  `pro-applications-ops.controller.ts`, `pro-management-ops.controller.ts`,
  `protection-ops.controller.ts`, `docs/planning/PROTECTION_SESSIONS_SPEC.md` §1.
- **Console history** (`git log -- apps/ops-console`): the rail was last regrouped in
  `207cf09c` ("grouped collapsible sidebar") _before_ Executive Protection (`bb70afb2`,
  `a40c48a4`), Secure Pro (`2e8da170`), Pro Management (`2b6c9b14`), Protection Sessions
  (`2c110cff`) and ops-managed regions/pricing (`de54b983`, `74cb1180`, `ef20e9a1`) landed.
  The groups were never revisited — the confusion is accretion, not design.
- Nothing in this document was verified in a browser. Where a claim needs a runtime check
  it is marked **VERIFY** and §9 says how.

---

## 2. Glossary — the words the console must stop overloading

This table is the single most important thing in the document. Every rail label, page
title and column header in the rebuilt console must use **exactly** these terms.

| Term (use this)          | Means                                                                                                                                                                                          | Backing data                                                                                                 | Currently called                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| **Lite**                 | On-demand Secure Transfer bookings (+ `recon_team`, `emergency_extraction` variants) — paid per booking in BC, escrowed, **auto-dispatched** to provider agencies or manually via the Job Feed | `bookings.service ∈ {secure_transfer, recon_team, emergency_extraction}`, `jobs`, `missions`, `escrow_holds` | "Bookings", "Job Feed", "Dispatch", "Inspector", "Live Ops"           |
| **Executive Protection** | Fixed-block (3–24 h) on-site protection detail booked under the Lite product; per-unit pricing; hourly CPO check-ins instead of waypoints; optional transfer leg (`exec_transport`)            | `bookings.service = 'executive_protection'`, `task_type`, `hourly_checkins` on the mission                   | a chip inside "Bookings"; two conditional rows in booking detail      |
| **Secure Pro**           | 3-month protection **plan**: client applies → ops proposes → client accepts/pays → ops assigns dedicated CPOs → protection sessions on demand. No per-mission payout.                          | `pro_applications` (FSM), `pro_cpo_assignments`, `protection_sessions`, Pro orgs/fleet/resources             | "Pro Applications", "Pro Management", "Protection" (three rail items) |
| **Messenger tier**       | The subscription tier of the **messenger** product (`lite` / `pro` / `enterprise`), charged in BC every 30 days                                                                                | `subscription_prices`, `users.tier`, `plan_catalog.messenger_*`                                              | "Tier" on /users, "Messenger subscription pricing" on /settings       |
| **Enterprise**           | Messenger Enterprise workspaces: departments (channel tree), attendance, incident reports, enterprise join requests                                                                            | `org_workspaces`, `departments`, `attendance_*`, `incident_reports`, `enterprise_join_requests`              | "Comms & Org" group; "Incidents" under _Safety_                       |
| **Agent / CPO**          | An individual Close Protection Officer — applies, is KYC'd/doc-reviewed, approved, then works Lite missions or is placed in a Pro org's pool                                                   | `agents`, `agent_documents`, `kyc_*`, `users.kind = 'agent'`                                                 | "Agents" (roster), "CPO" (Pro), "officer" (Protection)                |
| **Provider agency**      | A `service_provider` organisation that receives Lite dispatch offers and employs CPOs                                                                                                          | `users.kind = 'service_provider'`, `org_*`, compliance docs, armed authorisations                            | a filter value on /users; no page                                     |
| **Client**               | An `individual` user who books Lite/Executive or holds a Secure Pro plan; may have linked family members                                                                                       | `users.kind = 'individual'`, `family_*`                                                                      | "Users"                                                               |
| **Admin / operator**     | A console user: `OPS` < `SUPERVISOR` < `ADMIN`                                                                                                                                                 | `admin_users`, invites                                                                                       | "Admins"                                                              |
| **App Configuration**    | Every value the mobile apps _fetch_ from the server that ops can change: pricing board, regions, package catalog, subscription prices, tier grants, dispatch kill-switch                       | `service_pricing`, `regions`, `plan_catalog`, `subscription_prices`, `users.tier`, Redis killswitch          | "Console Settings" (most), user detail (tier), Dispatch page (switch) |

**The three "Pro"s** — the root of the founder's "very confusion":

1. `Messenger Pro` = a messenger _tier_ (`subscription_prices.tier = 'pro'`), edited on
   `/settings` → "Messenger subscription pricing"; granted per user on `/users/[id]`.
2. `Bravo Secure Pro` = the protection _plan_ product (`pro_applications`), worked on
   `/pro-applications`.
3. `Pro Management` = the _internal_ Pro delivery organisation (orgs, CPO pool,
   assignments, fleet, resources) on `/pro-management`, plus `/protection` for the live
   sessions those assignments produce.

`a2c25c95 fix(tiers): messenger vs secure plan families never overlap` fixed the _data_
overlap; the _labels_ were never fixed. In the rebuilt console the word "Pro" alone is
banned in labels: it is always **"Secure Pro"** (the plan) or **"Messenger Pro"** (the
tier).

---

## 3. Current-state map (what exists today)

### 3.1 The rail as shipped (`Shell.tsx:24-160`)

| Group       | Items (in order)                                                                                         | Min role (nav)            |
| ----------- | -------------------------------------------------------------------------------------------------------- | ------------------------- |
| Overview    | Dashboard · Analytics                                                                                    | —                         |
| Operations  | Bookings · Pro Applications · Pro Management · Job Feed · Agents · **Users** · Live Ops · Referral Codes | Users = SUPERVISOR        |
| Dispatch    | Dispatch · Inspector                                                                                     | —                         |
| Safety      | SOS Log · Protection · Incidents · Compliance · VBG Monitoring                                           | —                         |
| Comms & Org | Messenger · Departments · Attendance                                                                     | —                         |
| Finance     | Finance · **Audit Log**                                                                                  | SUPERVISOR                |
| Admin       | Admins                                                                                                   | ADMIN                     |
| (footer)    | Settings                                                                                                 | — (editors gated in-page) |

### 3.2 Route → backend → product ownership

| Route                          | Lines            | Backs onto (auth-service)                                                                                                                                                                 | Product(s) actually shown                                                                                                                                      | Mutations (role)                                                 |
| ------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `/dashboard`                   | 163              | `GET /ops/dashboard`, `/ops/activity`                                                                                                                                                     | all, unsegmented (`kpis.pending_approval` mixes Lite+Exec)                                                                                                     | —                                                                |
| `/analytics`                   | 230              | `GET /ops/analytics`                                                                                                                                                                      | Lite GMV/bookings/missions/SOS/prekeys; no Pro/Exec/Enterprise                                                                                                 | —                                                                |
| `/bookings`, `/[id]`           | 364 / 1519       | `GET /ops/bookings?q,region,status,limit` (**no `service` param** — `ops.controller.ts:122`), `/bookings/:id`, approve/reject/dispatch/complete/proposed-payouts/applicants/pool/vehicles | **Lite + Executive mixed**; service chip is client-derived (`bookings/page.tsx:57-65`)                                                                         | approve/reject/dispatch/complete (SUPERVISOR)                    |
| `/jobs`, `/[id]`               | 121 / 234        | `GET /ops/jobs`, `/jobs/:id`, cancel, shortlist/assign/reject applicants, `POST /jobs/:id/dispatch` (**deprecated** per `ops.controller.ts:321` doc-comment)                              | Lite manual lane (job published on approve — `ops.service.ts:400-402`)                                                                                         | shortlist (OPS), assign/reject/cancel (SUPERVISOR)               |
| `/dispatch`                    | 232              | `GET /ops/dispatch/monitor`, `/killswitch`, `POST /test`, `PUT /killswitch`, cancel, force-assign                                                                                         | Lite auto-dispatch engine; **hardcoded 4-region list** `dispatch/page.tsx:9-14`                                                                                | test (SUPERVISOR), cancel/force (SUPERVISOR), killswitch (ADMIN) |
| `/dispatch-inspector`, `/[id]` | 114 / 176        | `GET /ops/dispatch/requests`, `/requests/:id`                                                                                                                                             | Lite bookings in dispatch states — a **filtered bookings list** with its own status chip set                                                                   | —                                                                |
| `/live`, `/[id]`, `/wall`      | 228 / 1472 / 326 | `GET /ops/missions`, `/missions/:id`, deployment/signoff, waypoint, abort, route-options/select, messages, telemetry, SOS ack/escalate/resolve                                            | Lite **and** Executive missions (exec = hourly check-ins, `live/[id]/page.tsx:481-485`); `/wall` = **sample data** (OC-11)                                     | abort/reroute/complete/SOS (SUPERVISOR), ack (OPS)               |
| `/pro-applications`, `/[id]`   | 181 / 1350       | `/ops/pro-applications` + proposal/reject/cancel/schedule/decline/notes/messages; fleet+resource assignment (`/ops/pro-management/applications/:id/*`)                                    | Secure Pro plan pipeline                                                                                                                                       | proposal/reject (SUPERVISOR), notes (SUPERVISOR), thread (OPS)   |
| `/pro-management`              | 1099             | `/ops/pro-management/{orgs,cpos,pool,requests,assignments,fleet,resources}`                                                                                                               | Secure Pro delivery (5 tabs in one 1,099-line file)                                                                                                            | all mutations SUPERVISOR                                         |
| `/protection`                  | 281              | `/ops/protection/sessions`, `/:id`, `/timeline`, end, transfer                                                                                                                            | Secure Pro live sessions                                                                                                                                       | end/transfer (SUPERVISOR)                                        |
| `/agents`, `/[id]`             | 155 / 722        | `/ops/agents`, `/:id`, `/stats`, decide, terminate, docs/kyc review                                                                                                                       | CPO onboarding + roster                                                                                                                                        | decide/terminate/review (SUPERVISOR)                             |
| `/users`, `/[id]`              | 166 / 457        | `/ops/users?q,role,kyc,tier`, `/:id`, family, device revoke, suspend/restore/erase, wallet, `PATCH /ops/subscription/users/:id/tier`                                                      | clients, agents, providers as _rows_; **messenger tier** grant lives here                                                                                      | suspend/restore/erase/revoke/tier (SUPERVISOR)                   |
| `/compliance`                  | 143              | `/ops/compliance/pending`, verify/reject, armed verify/reject                                                                                                                             | provider agency documents + armed authorisations                                                                                                               | verify/reject (SUPERVISOR)                                       |
| `/referral-codes`              | 200              | `/ops/referral-codes` list/create/active                                                                                                                                                  | partner growth codes (B-404)                                                                                                                                   | mint/deactivate (SUPERVISOR)                                     |
| `/sos`                         | 191              | `GET /ops/sos`, ack/escalate/resolve                                                                                                                                                      | cross-product                                                                                                                                                  | resolve/escalate (SUPERVISOR), ack (OPS)                         |
| `/vbg`                         | 112              | `GET /ops/vbg/monitoring`                                                                                                                                                                 | biometric guard heartbeats (CPOs)                                                                                                                              | —                                                                |
| `/incidents`                   | 90               | `GET /ops/deptchat/incidents`                                                                                                                                                             | **Enterprise** dept-chat incident reports                                                                                                                      | —                                                                |
| `/messenger`                   | 107              | messenger-service (E2EE, ops identity)                                                                                                                                                    | Enterprise / mission Ops Rooms                                                                                                                                 | send                                                             |
| `/departments`                 | 138              | `GET /ops/departments` (server paging unused — OP-14)                                                                                                                                     | Enterprise channel tree                                                                                                                                        | —                                                                |
| `/dept-attendance`             | 251              | `/ops/deptchat/attendance/summary`, `/export`                                                                                                                                             | Enterprise attendance                                                                                                                                          | export                                                           |
| `/finance`                     | 645              | `/ops/finance/{transactions,escrows,payouts,invoices,promos,wallet/:id}`, `/ops/disputes`, resolve, `POST /ops/wallets/:id/adjust`                                                        | 7 tabs (LEDGER ESCROW PAYOUTS DISPUTES INVOICES PROMOS ADJUST); escrow tab shows a `review_required` badge (`finance/page.tsx:172-187`) but **no exit action** | adjust/resolve (SUPERVISOR)                                      |
| `/audit`                       | 241              | `GET /ops/audit?subject_type,actor,…`                                                                                                                                                     | governance                                                                                                                                                     | —                                                                |
| `/admins`                      | 262              | `/ops/admins` + invites                                                                                                                                                                   | internal                                                                                                                                                       | ADMIN                                                            |
| `/settings`                    | 664              | `/ops/subscription/{prices,catalog}`, `/ops/regions`, `/ops/service-pricing?region`                                                                                                       | **App configuration** behind a "Console Settings" title + a read-only info card                                                                                | all four editors SUPERVISOR                                      |
| `/login`, `/accept-invite`     | —                | auth                                                                                                                                                                                      | —                                                                                                                                                              | —                                                                |

### 3.3 Backend surface with **no console page** (dead from the operator's chair)

| Endpoint                                                                                                        | Purpose                                                                                            | Evidence                                                                                                  |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `POST /ops/bookings/:id/resolve-review` (MON-2)                                                                 | release or refund a HELD + `review_required` escrow — _"the only operator exit for that state"_    | `ops.controller.ts:196-205`; `lib/api.ts` has no `resolveReview`; finance escrow tab renders a badge only |
| `POST /ops/missions/:id/waypoint`                                                                               | advance a mission waypoint (audited since OC-13)                                                   | no `opsApi.*waypoint*` in `lib/api.ts`                                                                    |
| `POST /ops/jobs/:id/dispatch` (the reverse case)                                                                | `@deprecated` server-side, still exported as `opsApi.dispatchJob` — **zero page usage** (verified) | `api.ts:813`; `grep -rl dispatchJob src/app src/components` → none — delete the client method             |
| Enterprise tables (`enterprise_join_requests`, `org_workspaces`, `cpo_roster_months`, `attendance_corrections`) | live data, zero ops surface — SK-06(b), OC-15, still open                                          | services only: `department/enterprise-join.service.ts`, `agents/agent.service.ts`                         |

---

## 4. Findings (IA-01 … IA-18)

Severity: **P0** = the operator cannot find or do something the business depends on;
**P1** = structural confusion that causes wrong actions or wasted time daily; **P2** =
consistency/ergonomics; **P3** = polish.

| ID    | Sev | Finding                                                                                                                                                                                                                                                                                                                                                                                                                     | Evidence                                                                                                                                               | Fix (→ §)                           |
| ----- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| IA-01 | P0  | **No product-line sections.** Lite, Executive and Secure Pro are not navigable as businesses. "Operations" holds 8 unrelated items; Pro is split across two groups; Executive has no surface at all beyond a chip and two conditional detail rows.                                                                                                                                                                          | `Shell.tsx:126-134` `NAV_GROUPS`; `bookings/page.tsx:57-65`; `bookings/[id]/page.tsx:512-533`                                                          | §5, §6.2–6.4                        |
| IA-02 | P0  | **"Pro" means three things** (messenger tier, Secure Pro plan, Pro delivery org) and "Protection" (Pro sessions) is filed under _Safety_ next to SOS. `/users` "Tier: Lite/Pro/Enterprise" is the _messenger_ tier but sits beside Secure Pro pages with no qualifier.                                                                                                                                                      | `users/page.tsx:26-30`; `settings/page.tsx:615`; `Shell.tsx:131`                                                                                       | §2 glossary, §6.4, §6.6             |
| IA-03 | P1  | **Lite and Executive share one list with no server-side split.** `GET /ops/bookings` has no `service` filter; the chip set is derived from the loaded window (≤500 rows), so an Executive booking outside the window is invisible to the filter. Executive-specific columns (task type, block hours, add-ons, check-in count) do not exist in the list.                                                                     | `ops.controller.ts:122-126` (`q, region, status, limit` only); `bookings/page.tsx:57`                                                                  | §6.2.1, §6.3.1, §8 Phase B          |
| IA-04 | P1  | **Two dispatch pages, one engine.** `/dispatch` (monitor + test + killswitch) and `/dispatch-inspector` (a booking list filtered to dispatch states with its own copy of the status vocabulary) are separate rail items in their own group. The inspector duplicates `/bookings?status=DISPATCHING…`.                                                                                                                       | `dispatch-inspector/page.tsx:1-30` `FILTERS` vs `bookings/page.tsx:12-23` `STATUS_FILTERS`                                                             | §6.2.2 (merge as tabs)              |
| IA-05 | P1  | **The manual lane is unexplained.** Every approved booking is auto-published to the Job Feed (`publishFromBooking` on approve) _and_ may enter auto-dispatch; the console never says which lane a booking is on, and "Job Feed" / "Job Pipeline" / "Open Jobs" are three labels for it. `POST /ops/jobs/:id/dispatch` is `@deprecated` in the controller but still wired in `opsApi.dispatchJob`.                           | `ops.service.ts:396-402`; `ops.controller.ts:311-321`; `api.ts:813`; `jobs/page.tsx` heading "Job Pipeline"                                            | §6.2.3 + a lane badge on bookings   |
| IA-06 | P1  | **A money exit is unreachable.** MON-2 `POST /ops/bookings/:id/resolve-review` — the only operator exit for a HELD + `review_required` escrow — has no client method and no button; the escrow tab shows a "REVIEW" badge and nothing else.                                                                                                                                                                                 | `ops.controller.ts:196-205`; `grep resolveReview lib/api.ts` → none; `finance/page.tsx:172-187`                                                        | §6.8.2 (new action)                 |
| IA-07 | P1  | **App configuration is scattered and mislabeled.** Pricing board, regions, package catalog and subscription prices live on a page titled **"Console Settings"** under a read-only card whose fields are console trivia; the tier grant lives in user detail; the dispatch kill-switch on the dispatch page; platform/cancel fee % are env-only (OP-10). Nothing shows _what the app currently sees_ or when a change lands. | `settings/page.tsx:18-40, 71-80`; `users/[id]/page.tsx` (`setUserTier`); `dispatch/page.tsx` (killswitch)                                              | §6.7 (new section + propagation)    |
| IA-08 | P1  | **No provider-agency page.** `service_provider` orgs receive every Lite dispatch offer, yet the console has only a `/users` filter value and a document-centric `/compliance`. No roster, no offer/acceptance history, no CPO list per agency, no suspension. Enterprise join requests / workspaces likewise (SK-06b).                                                                                                      | `users/page.tsx:17`; `grep -rl service_provider src/app` → dispatch + users only; controllers `org`, `org/workspace`, `enterprise` exist app-side only | §6.6.3 (new page, new endpoints)    |
| IA-09 | P1  | **Governance filed under Finance; growth filed under Operations.** Audit Log is in the _Finance_ group; Referral Codes in _Operations_; Compliance in _Safety_; Incidents (Enterprise dept-chat) in _Safety_.                                                                                                                                                                                                               | `Shell.tsx:126-134`                                                                                                                                    | §5                                  |
| IA-10 | P2  | **Dashboard KPIs are not product-segmented.** `pending_approval` counts Lite+Exec together; no Executive, Enterprise or Messenger-tier KPIs; Pro has two counts (`pro_pending`, `pro_requests`) bolted on as badges.                                                                                                                                                                                                        | `api.ts:353-368` `DashboardResponse.kpis`; `dashboard/page.tsx:44-90`                                                                                  | §6.1.1 + backend KPI extension      |
| IA-11 | P2  | **Naming drift across pages.** "Agents" (roster) / "CPO" (Pro) / "officer" (Protection); "Live Ops" / "Protection Monitoring" / "Active Missions"; "Job Feed" / "Job Pipeline"; "Inspector"; "VBG Monitoring" (unexpanded acronym); "Users" (includes agents and providers).                                                                                                                                                | page `<h1>`/`<h2>` texts in §3.2; `format.ts:27`                                                                                                       | §2 glossary applied in §6           |
| IA-12 | P2  | **Two visual dialects.** Tailwind-utility pages (`finance`, `users`, `analytics`, `dispatch`, `admins`, `audit`, `referral-codes` — `h1.text-xl.font-bold`) vs inline-style/`card` pages (`bookings`, `settings`, `pro-*`, `dashboard` — `page-head > h2`). Breadcrumbs (`page-crumbs`) exist on some pages only. Tabs are local state on `/finance` and `/pro-management`, route segments nowhere.                         | `finance/page.tsx:624`; `settings/page.tsx:36-40`; `pro-management/page.tsx:194`                                                                       | §7 shared primitives                |
| IA-13 | P2  | **Monolithic product pages.** `bookings/[id]` 1,519 lines, `live/[id]` 1,472, `pro-applications/[id]` 1,350, `pro-management` 1,099 — each holds 4–6 independent panels inline. A product split cannot reuse them without extraction.                                                                                                                                                                                       | line counts §3.2                                                                                                                                       | §7.4 extraction list                |
| IA-14 | P2  | **Section landing pages do not exist.** Every group is a flat list of leaf pages; there is no "Lite at a glance", "Secure Pro pipeline", "Config status" view. An operator starting a shift has no per-product queue.                                                                                                                                                                                                       | route list §3.2                                                                                                                                        | §6.x.0 landing specs                |
| IA-15 | P2  | **Hardcoded regions on the dispatch page** contradict the ops-managed regions table shipped in `de54b983`. A region added on `/settings` never appears in the dispatch test picker or its map centres.                                                                                                                                                                                                                      | `dispatch/page.tsx:9-14` `REGIONS`; `settings/page.tsx` `RegionsCard`                                                                                  | §6.2.2, §6.7.2                      |
| IA-16 | P2  | **Executive detail is a Lite detail with two extra rows.** No block-duration, hourly-check-in timeline, add-on breakdown or per-unit price table in `bookings/[id]`; the check-in record exists only on `live/[id]`.                                                                                                                                                                                                        | `bookings/[id]/page.tsx:512-533`; `live/[id]/page.tsx:481-485,1058-1062`                                                                               | §6.3.2                              |
| IA-17 | P2  | **Status vocabulary is copied, not shared.** Booking statuses (`bookings/page.tsx`), inspector statuses, job statuses, agent statuses and Pro application statuses each define their own label/colour map inline.                                                                                                                                                                                                           | `bookings/page.tsx:11-23`, `dispatch-inspector/page.tsx:3-17`, `agents/page.tsx:9-15`, `pro-applications/page.tsx:18-27`                               | §7.3 `status.ts`                    |
| IA-18 | P3  | **Console has zero tests** (OC-05 residue) — a nav/route restructure of this size has no pin. `/live/wall` (sample data) is still routable.                                                                                                                                                                                                                                                                                 | `ls apps/ops-console/**/__tests__` → none; `live/wall/page.tsx:124`                                                                                    | §9.2 pin suite; delete `/live/wall` |

---

## 5. Target information architecture

### 5.1 Principles (industry-standard back-office layout)

1. **Group by business area, not by tool.** The rail answers "what am I running?" — a
   product line, the people in it, the money, the config that shapes it, the safety net,
   the house.
2. **One word, one meaning** (§2). A label never needs a tooltip to disambiguate.
3. **Every section has a landing page** with that section's queue/KPIs and links into
   its leaves. Deep pages are reached from a list, never from the rail.
4. **URLs mirror the rail** (`/lite/bookings`, `/pro/applications`, `/config/pricing`).
   Tabs that change _what data_ is shown are route segments (`/finance/escrow`), not
   local state — they are linkable and back-button-safe.
5. **Old URLs never 404.** Permanent redirects in `next.config.js` for every moved route;
   dynamic segments preserved.
6. **Role gating is at the group level first**, item level second, action level third
   (unchanged `rbac.ts` capabilities; backend `@RequireRoles` remains the boundary).
7. **Cross-product concerns (SOS, audit, admins) stay cross-product** — they are not
   duplicated into each product section; product pages _link_ to them with the product
   filter pre-applied.

### 5.2 The new rail

Ten groups. Collapsible; the collapsed rail shows group glyphs. Role filter hides whole
groups (existing `NAV_MIN_ROLE` mechanism, extended to groups).

```
OVERVIEW
  Dashboard                     /dashboard
  Analytics                     /analytics

LITE  (Secure Transfer)
  Overview                      /lite                         ← landing: pipeline KPIs + queue
  Bookings                      /lite/bookings, /lite/bookings/[id]
  Auto-Dispatch                 /lite/dispatch  (tabs: Monitor · Requests · Test)
  Manual Dispatch (Job Feed)    /lite/jobs, /lite/jobs/[id]
  Missions                      /lite/missions, /lite/missions/[id]

EXECUTIVE PROTECTION
  Overview                      /executive
  Bookings                      /executive/bookings, /executive/bookings/[id]
  Missions & Check-ins          /executive/missions, /executive/missions/[id]

SECURE PRO
  Overview                      /pro                          ← pipeline: applications → proposals → active plans → sessions
  Applications                  /pro/applications, /pro/applications/[id]
  Organisations & CPO Pool      /pro/organisations, /pro/organisations/[id], /pro/pool
  Requests & Assignments        /pro/assignments  (tabs: Requests · Assignments)
  Fleet & Resources             /pro/fleet  (tabs: Vehicles · Resources)
  Protection Sessions           /pro/protection, /pro/protection/[id]

ENTERPRISE  (Messenger Enterprise)
  Overview                      /enterprise
  Messenger                     /enterprise/messenger
  Departments                   /enterprise/departments
  Attendance                    /enterprise/attendance
  Incidents                     /enterprise/incidents
  Join Requests                 /enterprise/join-requests     ← NEW (SK-06b)

PEOPLE
  Clients                       /people/clients, /people/clients/[id]       (= today's /users filtered to individual)
  Agents (CPOs)                 /people/agents, /people/agents/[id]
  Provider Agencies             /people/agencies, /people/agencies/[id]     ← NEW (IA-08)
  Compliance                    /people/compliance
  All Users                     /people/users, /people/users/[id]          (unfiltered, SUPERVISOR)

APP CONFIGURATION  (what the apps fetch)
  Status                        /config                       ← landing: every config's version, last change, cache TTL, "what the app sees"
  Pricing Board                 /config/pricing  (region picker)
  Regions                       /config/regions
  Packages & Catalog            /config/packages  (plan_catalog copy + messenger subscription prices)
  Tier Grants                   /config/tier-grants           (list of comp grants; grant action stays on client detail too)
  Switches                      /config/switches              (dispatch kill-switch; env-only values shown read-only with "needs deploy")

FINANCE
  Overview                      /finance                      ← today's LEDGER tab + headline totals
  Ledger                        /finance/ledger
  Escrow & Review Holds         /finance/escrow               (+ IA-06 exit)
  Payouts                       /finance/payouts
  Disputes                      /finance/disputes
  Invoices                      /finance/invoices
  Promos & Referral Codes       /finance/promos  (tabs: Promos · Referral codes)
  Wallet Adjustments            /finance/adjust

SAFETY
  SOS Log                       /safety/sos
  Biometric Guard (VBG)         /safety/vbg

INTERNAL
  Admins                        /internal/admins
  Audit Log                     /internal/audit
  Console                       /internal/console             (today's read-only info card + system health)
```

**Rail group order is the operator's day**: overview → the three revenue products →
enterprise → the people behind them → the levers → the money → the safety net → the house.

### 5.3 Role visibility

| Group             | OPS                                 | SUPERVISOR | ADMIN    | Notes                                                                 |
| ----------------- | ----------------------------------- | ---------- | -------- | --------------------------------------------------------------------- |
| Overview          | ✓                                   | ✓          | ✓        |                                                                       |
| Lite              | ✓                                   | ✓          | ✓        | mutations gated by existing `can*` capabilities                       |
| Executive         | ✓                                   | ✓          | ✓        |                                                                       |
| Secure Pro        | ✓                                   | ✓          | ✓        | decisions SUPERVISOR (`canDecideProApplication`)                      |
| Enterprise        | ✓                                   | ✓          | ✓        |                                                                       |
| People            | Agents, Compliance, Agencies (read) | ✓          | ✓        | `/people/clients`, `/people/users` SUPERVISOR (today's `/users` rule) |
| App Configuration | ✗                                   | ✓          | ✓        | Switches → kill-switch flip ADMIN (`canFlipKillswitch`)               |
| Finance           | ✗                                   | ✓          | ✓        | unchanged                                                             |
| Safety            | ✓                                   | ✓          | ✓        | ack OPS; resolve/escalate SUPERVISOR                                  |
| Internal          | Audit ✗ / Console ✓                 | Audit ✓    | Admins ✓ | Admins ADMIN-only                                                     |

### 5.4 Redirect map (put in `next.config.js` `redirects()`, `permanent: true`)

| From                      | To                               | Note                                                                                                                                                                                        |
| ------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/bookings`               | `/lite/bookings`                 | Exec bookings are reachable from `/lite/bookings` via a cross-link banner (see 6.2.1)                                                                                                       |
| `/bookings/:id`           | `/lite/bookings/:id`             | the detail route reads `service` and **renders the Executive detail when `executive_protection`**, with a canonical-URL rewrite to `/executive/bookings/:id` (client-side `router.replace`) |
| `/jobs`, `/jobs/:id`      | `/lite/jobs`, `/lite/jobs/:id`   |                                                                                                                                                                                             |
| `/dispatch`               | `/lite/dispatch`                 |                                                                                                                                                                                             |
| `/dispatch-inspector`     | `/lite/dispatch/requests`        |                                                                                                                                                                                             |
| `/dispatch-inspector/:id` | `/lite/dispatch/requests/:id`    |                                                                                                                                                                                             |
| `/live`                   | `/lite/missions`                 |                                                                                                                                                                                             |
| `/live/:id`               | `/lite/missions/:id`             | same service-aware canonicalisation as bookings                                                                                                                                             |
| `/live/wall`              | `/lite/missions`                 | page deleted (IA-18)                                                                                                                                                                        |
| `/pro-applications(/:id)` | `/pro/applications(/:id)`        |                                                                                                                                                                                             |
| `/pro-management`         | `/pro`                           |                                                                                                                                                                                             |
| `/protection`             | `/pro/protection`                |                                                                                                                                                                                             |
| `/agents(/:id)`           | `/people/agents(/:id)`           |                                                                                                                                                                                             |
| `/users(/:id)`            | `/people/users(/:id)`            |                                                                                                                                                                                             |
| `/compliance`             | `/people/compliance`             |                                                                                                                                                                                             |
| `/referral-codes`         | `/finance/promos/referral-codes` |                                                                                                                                                                                             |
| `/sos`                    | `/safety/sos`                    |                                                                                                                                                                                             |
| `/vbg`                    | `/safety/vbg`                    |                                                                                                                                                                                             |
| `/incidents`              | `/enterprise/incidents`          |                                                                                                                                                                                             |
| `/messenger`              | `/enterprise/messenger`          |                                                                                                                                                                                             |
| `/departments`            | `/enterprise/departments`        |                                                                                                                                                                                             |
| `/dept-attendance`        | `/enterprise/attendance`         |                                                                                                                                                                                             |
| `/finance`                | `/finance` (landing)             | tab deep-links: none existed (local state) — nothing to preserve                                                                                                                            |
| `/audit`                  | `/internal/audit`                |                                                                                                                                                                                             |
| `/admins`                 | `/internal/admins`               |                                                                                                                                                                                             |
| `/settings`               | `/config`                        |                                                                                                                                                                                             |

**Internal link inventory to update** (from `grep -rhoE "href=\{?[\`'\"]/[a-z-]+"`and`router.(push|replace)`): `/live`×12,`/bookings`×15,`/users`×8,`/pro-applications`×7,`/agents`×6,`/sos`×3,`/jobs`×2,`/dispatch-inspector`×2, one each of`/vbg`,
`/settings`, `/incidents`, `/finance`, `/dispatch`, `/dashboard`. Also `NotificationBell`and`SosAlertBar`deep links,`middleware.ts` `PUBLIC_PATHS`, and the messenger provider's
mission-room links. Replace every literal with the `routes.ts` helper (§7.1) so this never
drifts again.

---

## 6. Section specifications

Each subsection: **Purpose → Landing → Pages (columns, filters, actions, endpoints) →
Backend additions → Acceptance.** Existing page bodies are reused unless a change is
listed. "Endpoint" = auth-service unless stated.

### 6.1 Overview

#### 6.1.1 `/dashboard`

Keep the page; **segment the KPI strip by product**:

| Strip      | KPIs                                                                                        | Source                                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lite       | Pending approval · Dispatching · Live missions · No-provider/No-show today · GMV today (BC) | `kpis.*` split by `service` — **backend change**: `GET /ops/dashboard` returns `kpis.lite.*`, `kpis.executive.*`, `kpis.pro.*`, `kpis.enterprise.*` (keep flat legacy keys for one release) |
| Executive  | Pending approval · Upcoming (next 24 h) · Live details · Check-ins overdue                  | same, `service='executive_protection'`; overdue = `hourly_checkins` gap > 70 min on a live exec mission (**VERIFY** the check-in cadence constant in `agent.service.ts`)                    |
| Secure Pro | Applications pending · Proposals awaiting client · Date requests unassigned · Sessions live | `pro_pending`, `pro_requests` + two new counts                                                                                                                                              |
| Enterprise | Join requests pending · Incidents (critical, 24 h)                                          | new                                                                                                                                                                                         |
| Safety     | SOS active (unacked / acked)                                                                | existing                                                                                                                                                                                    |

Each KPI tile links to the section list with the filter pre-applied. Activity feed
unchanged. Remove the two nav badges (`navBadges`) in favour of group-level badges: the
rail shows a count on **Lite**, **Executive**, **Secure Pro**, **Safety** groups
(sum of their "waiting on ops" KPIs).

#### 6.1.2 `/analytics`

Keep; add a **Product** filter (`all | lite | executive | pro | enterprise`) passed as a
query param. Backend: `GET /ops/analytics?product=` — where a series is not product-aware
(prekey health), it ignores the filter and says so in the card footer.

**Acceptance:** an OPS operator can, from the dashboard alone, answer "what is waiting on
me in each product?" in one glance; every tile is a link; no tile mixes products.

### 6.2 Lite (Secure Transfer)

**Purpose:** everything about per-booking, escrowed, dispatched work for
`service ∈ {secure_transfer, recon_team, emergency_extraction}`.

#### 6.2.0 `/lite` landing

Pipeline board (columns = booking statuses, cards = bookings, counts in headers), a
"needs a human" queue (PENDING_OPS, NO_PROVIDER, AGENCY_NO_SHOW, review-hold escrows,
stuck DISPATCHING > offer TTL), and the auto-dispatch engine health pill from
`/ops/dispatch/monitor`. Reuse `useBookings` + `useDispatchMonitor`.

#### 6.2.1 `/lite/bookings`, `/lite/bookings/[id]`

- List = today's `/bookings` with **`service` applied server-side** and Executive
  removed. Columns: Ref · Status · Lane (AUTO / MANUAL / DEDICATED — see below) · Client ·
  Region · Pickup time · Crew · Provider/agency · Total BC · Age.
- Status chips = shared `status.ts` vocabulary (§7.3).
- **Lane badge (IA-05):** derived server-side and returned on the row:
  `lane = 'dedicated'` when B-415 routed it to a dedicated CPO, `'auto'` when a dispatch
  request row exists, `'manual'` when only a job row exists, `'—'` before approval.
  **Backend:** extend the bookings list projection (`ops.service.ts` list query) with
  `lane`; **VERIFY** the exact source columns (`dispatch_requests`, `jobs`,
  `dedicated_cpo_user_id`) before writing SQL.
- Detail page: today's component, extracted into panels (§7.4). Approve / Reject /
  Dispatch / Complete / Proposed payouts unchanged. Add a **"Money"** panel that shows the
  escrow row and, when `review_required`, the **Resolve review** action (IA-06) — same
  component as §6.8.2.
- A top banner on the list: "Looking for Executive Protection? → `/executive/bookings`".

**Backend additions:** `GET /ops/bookings?service=` (comma list allowed;
`@IsIn` the four values; omitted = all, for `/people/clients/[id]` history); `lane` on the
row; `GET /ops/bookings/:id` unchanged.

#### 6.2.2 `/lite/dispatch` (merges `/dispatch` + `/dispatch-inspector`)

Route-segment tabs:

| Tab                       | Content                                                                                                          | Source                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `/lite/dispatch` Monitor  | engine state, dispatching-now, recently settled, kill-switch (ADMIN) — today's `/dispatch` minus the test form   | `/ops/dispatch/monitor`, `/killswitch`    |
| `/lite/dispatch/requests` | today's `/dispatch-inspector` list + `/[id]` detail                                                              | `/ops/dispatch/requests`                  |
| `/lite/dispatch/test`     | today's "Fire test dispatch" form; **region picker reads `/ops/regions`** (IA-15), centre = region bbox centroid | `/ops/regions`, `POST /ops/dispatch/test` |

Kill-switch also appears on `/config/switches` (same component, same endpoint).

#### 6.2.3 `/lite/jobs`, `/lite/jobs/[id]` (rename "Manual Dispatch")

Keep the page; rename heading to **Manual Dispatch — Job Feed**; one-line explainer under
the title: _"Every approved Lite booking is published here for agencies to apply. Auto-
dispatch may settle it first; a job whose booking is CONFIRMED by auto-dispatch shows
SETTLED BY AUTO."_ Delete `opsApi.dispatchJob` (`api.ts:813`) — verified unused by any
page or component; the controller marks the endpoint deprecated in favour of
`dispatchBooking`.

#### 6.2.4 `/lite/missions`, `/lite/missions/[id]`

Today's `/live` filtered to Lite services (server: `GET /ops/missions?service=`; **VERIFY**
the missions projection already joins `bookings.service` — `live/[id]` reads
`hourly_checkins`, so the detail does). `/live/wall` deleted.

**Acceptance (Lite):** an operator can work a Lite booking from approval to payout without
leaving the Lite group; no Executive row appears in any Lite list; the dispatch tabs are
deep-linkable; the test picker shows every launched region from `/ops/regions`.

### 6.3 Executive Protection

**Purpose:** fixed-block on-site protection details (`service = 'executive_protection'`),
priced per unit, with hourly check-ins.

#### 6.3.0 `/executive` landing

Calendar-first: a 7-day strip of upcoming details (pickup time, block hours, crew, task
type), the approval queue, live details with **check-in freshness** (last check-in age;
red when overdue), and the lead-time rule in force (`exec_min_lead_hours` from
`/ops/service-pricing`).

#### 6.3.1 `/executive/bookings`

Same list component as Lite with `service=executive_protection` and Executive columns:
Ref · Status · Client · Task type (`site_protection` / …) · Start · Block (h) · CPOs ·
Vehicles · Add-ons (chips: Female CPO · Recon · Medical · Comms) · Transfer leg (Y/N) ·
Total BC. **Backend:** the row projection must return `task_type`, `block_hours` (or
`duration_hours` — **VERIFY** column name in `bookings`), the add-on flags and
`exec_transport IS NOT NULL`.

#### 6.3.2 `/executive/bookings/[id]`

The shared detail shell with an **Executive** panel set (IA-16):

- **Detail** — task type, site address, start, block hours, end (computed), crew.
- **Pricing breakdown** — per-unit lines from the stored quote: CPO × h, vehicle × h,
  driver-only, each add-on × h, peak multiplier, total (all from the booking's stored
  `pricing_breakdown` — **VERIFY** the JSON shape in `booking.service.ts:559-600`; never
  recompute from the live board).
- **Transfer leg** — mode, pickup → dropoff, pax, time.
- **Check-ins** — the hourly "all smooth" timeline (today's `live/[id]` block, extracted
  to `ExecCheckinTimeline`), visible from the booking as well as the mission.
- **Money** panel — as Lite.

#### 6.3.3 `/executive/missions`, `/executive/missions/[id]`

Today's `/live` filtered to `executive_protection`; detail = today's `live/[id]` with the
waypoint panel hidden and the check-in panel first.

**Acceptance (Executive):** an operator can see every Executive detail's block, add-ons and
check-in state without opening the mission; the approval queue shows lead-time violations
(pickup − now < `exec_min_lead_hours`) in red.

### 6.4 Secure Pro

**Purpose:** the plan business — applications, proposals, active plans, the CPO pool and
assignments that serve them, and the live protection sessions.

#### 6.4.0 `/pro` landing

Funnel: **Applications** (`PENDING_PROPOSAL`, `REVISION_REQUESTED`) → **Proposals out**
(`PROPOSAL_CREATED`) → **Active plans** (`ACTIVE`, with end-date within 14 d flagged) →
**Date requests unassigned** (`REQUESTED`) → **Sessions live**. Each column links to its
list. Plus the pool availability bar for the next 7 days (`/ops/pro-management/pool`).

#### 6.4.1 `/pro/applications`, `/pro/applications/[id]`

Today's pages, retitled **Secure Pro — Applications**. Detail page split into panels
(§7.4): Applicant · Proposal & terms · Family members · Missions & date requests ·
Assigned vehicles & resources · Internal notes · Thread · Client history. No behaviour
change.

#### 6.4.2 `/pro/organisations`, `/pro/organisations/[id]`, `/pro/pool`

Today's `/pro-management` ORGS drill-down and CPO POOL tab as two routes. Title the org
list **Secure Pro — Organisations (internal delivery)** so it is never confused with
provider agencies (§6.6.3).

#### 6.4.3 `/pro/assignments` (tabs Requests · Assignments)

Today's REQUESTS + ASSIGNMENTS tabs. Requests = "the global incoming queue" of protection
dates; Assignments = date-windowed CPO ↔ member bookings with PMC codes.

#### 6.4.4 `/pro/fleet` (tabs Vehicles · Resources)

Today's FLEET + RESOURCES tabs.

#### 6.4.5 `/pro/protection`, `/pro/protection/[id]`

Today's `/protection`, retitled **Secure Pro — Protection Sessions**. Unchanged.

**Acceptance (Pro):** the word "Pro" never appears unqualified in this group; the landing
funnel counts match the list pages' filtered counts; `/pro-management` redirects to `/pro`.

### 6.5 Enterprise (Messenger Enterprise)

#### 6.5.0 `/enterprise` landing

Workspaces count, join requests pending, incidents by severity (24 h), attendance
exceptions today. Backend: one `GET /ops/enterprise/summary` (**new**, trivial counts).

#### 6.5.1–6.5.4 Messenger · Departments · Attendance · Incidents

Today's four pages moved. `/enterprise/departments` **passes `limit`/`cursor`** (OP-14 —
do it while moving the file). Incidents title: **Incident Reports (Enterprise)**.

#### 6.5.5 `/enterprise/join-requests` — NEW (SK-06b / OC-15)

List `enterprise_join_requests` (requester, workspace, status, created) with
approve/reject. **Backend:** `GET /ops/enterprise/join-requests`, `POST …/:id/{approve,
reject}` — wrap `department/enterprise-join.service.ts` methods that already exist
app-side (**VERIFY** the service API + who is allowed to approve today; the ops path must
write an `ops_audit` row with `subject_type: 'user'` or a new `'enterprise'` subject type —
adding a subject type means updating `AuditSubjectType`, the `ops_audit_subject_type_chk`
constraint via migration, and the `/internal/audit` dropdown (OC-13 rule)).

### 6.6 People

#### 6.6.1 `/people/clients`, `/people/clients/[id]`

Today's `/users` with `role=individual` pinned; detail = today's `users/[id]`. The tier
card is retitled **Messenger tier** (never "Tier"). Add a **Products** strip on the client
detail: Lite bookings (count, link), Executive bookings, Secure Pro plan (status, link),
Messenger tier, Family members.

#### 6.6.2 `/people/agents`, `/people/agents/[id]`

Today's `/agents` (roster) and `/agents/[id]`. Subtitle: _"Close Protection Officers —
onboarding, documents, KYC, missions."_ Add a **Pro pool** row when the agent is in a Pro
org's pool (`/ops/pro-management/pool` membership — **VERIFY** it is queryable per user).

#### 6.6.3 `/people/agencies`, `/people/agencies/[id]` — NEW (IA-08)

| Element | Content                                                                                                                                                                                                                             | Backend                                                                                                                                 |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| List    | Agency · Region · Status (active / suspended) · CPOs · Compliance (docs valid / expiring / expired) · Offers 30 d (received / accepted / no-show) · Rating                                                                          | **new** `GET /ops/agencies` — join `users.kind='service_provider'`, org membership, compliance docs, dispatch request outcomes          |
| Detail  | Profile · Compliance docs (reuse `/compliance` row component) · Armed authorisations · CPO roster · Dispatch history (offers, acceptances, no-shows, cancellations) · Wallet/payouts summary · Suspend/restore (reuse user suspend) | `GET /ops/agencies/:id`; dispatch history from `dispatch_requests` filtered by agency; suspend = existing `POST /ops/users/:id/suspend` |

**VERIFY** the agency ↔ org tables in `apps/auth-service/src/org/*` before writing the
query; the console must not invent a relation that does not exist.

#### 6.6.4 `/people/compliance`

Today's `/compliance`, moved. Each row links to the agency (6.6.3) instead of the bare
agent.

#### 6.6.5 `/people/users`, `/people/users/[id]`

Today's `/users` unfiltered (SUPERVISOR). The "Type" filter values renamed to the
glossary: Client · Agent (CPO) · Provider agency.

### 6.7 App Configuration — the "API calls to the app" section

**Purpose:** one place for every value the mobile apps fetch from the server that ops can
change, with the effect and the delay made visible. This is the founder's _"package update
change everything"_ ask.

#### 6.7.0 `/config` landing — Configuration status

A table, one row per configurable thing:

| Config                                                               | Editor (ops)                                                                   | App read path                                         | Lands in the app                                                                                          | Last change (who / when)        | Audit action                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------- |
| Pricing board (per region)                                           | `PATCH /ops/service-pricing` (`region`)                                        | `GET /bookings/service-pricing` + quote at charge     | next quote; **server cache 60 s per pod** (OP-02); region overrides do not reach the display path (OP-01) | `service_pricing.updated_*`     | `pricing.service.update` / `pricing.service.clear` |
| Regions (launch, bbox, tz)                                           | `POST/PATCH/DELETE /ops/regions`                                               | `GET /bookings/regions/availability`                  | next fetch; pod refresh (OP-05); client zone list is **compiled** — needs a build (OP-04)                 | `regions.updated_*`             | `region.create` / `region.update` / `region.close` |
| Package names & descriptions                                         | `PATCH /ops/subscription/catalog`                                              | `GET /subscription/catalog`                           | next catalog fetch (mount-scoped store, OP-08)                                                            | `plan_catalog.updated_*`        | `subscription.catalog.update`                      |
| Messenger subscription prices                                        | `PATCH /ops/subscription/prices`                                               | `GET /subscription/prices`; charge at subscribe/renew | every subscribe/renewal from now                                                                          | `subscription_prices.updated_*` | `subscription.price.update`                        |
| Messenger tier grants                                                | `PATCH /ops/subscription/users/:id/tier`                                       | `/auth/me` (30 s throttle), tier-gate 30 s            | ≤ 30 s (OP-03)                                                                                            | `ops_audit`                     | `user.tier.change`                                 |
| Dispatch kill-switch                                                 | `PUT /ops/dispatch/killswitch`                                                 | engine-side only                                      | ≤ 2 s (Redis)                                                                                             | Redis + audit                   | `system.killswitch`                                |
| Platform fee % / cancel fee %                                        | **none** — env (`DISPATCH_PLATFORM_FEE_PCT`, `DISPATCH_CANCEL_FEE_PCT`, OP-10) | —                                                     | redeploy                                                                                                  | —                               | —                                                  |
| Behaviour flags (`AUTO_DISPATCH`, `DEPT_CHAT_V2`, `MULTI_DEVICE`, …) | **none** — `EXPO_PUBLIC_*` baked at build                                      | —                                                     | store release                                                                                             | —                               | —                                                  |

Rows in the last two groups render greyed with the badge **NEEDS DEPLOY** / **NEEDS APP
RELEASE** so the operator learns the boundary instead of hunting for a control. The
"Lands in the app" column is the honest delay from OP-01..OP-10; when those fixes ship,
update the copy in one place (`config/propagation.ts`).

**Backend (small):** `GET /ops/config/status` returning `updated_at`/`updated_by` per
table (five queries; no new tables). Until it exists, the landing reads the existing four
list endpoints and shows `updated_at` from their rows.

#### 6.7.1 `/config/pricing`

Today's `ServicePricingCard`, alone on a page, with the region picker promoted to the page
header. Group the rows under headings that match the products: **Root** (`eur_per_bc`,
`base_rate_aed`, `peak_multiplier`) · **Lite — Secure Transfer** (`transfer_*`) ·
**Executive Protection** (`exec_*`, `addon_*`) · **Lead times** (`*_min_lead_hours`).
Confirm dialogs unchanged (OC-03). A "view as the app sees it" toggle calls
`GET /bookings/service-pricing` with the chosen region **once OP-01 lands** — until then
the toggle is hidden (do not ship a control that lies).

#### 6.7.2 `/config/regions`

Today's `RegionsCard`. Add the launched/not-launched pill in the list header and the map
preview of the bbox (reuse `BravoMapLazy`). The dispatch test picker (§6.2.2) reads this
table.

#### 6.7.3 `/config/packages`

Today's `PackageCatalogCard` + `SubscriptionPricingCard` on one page, in two clearly
titled blocks: **Package cards — names & descriptions** (all five `plan_catalog` keys:
`messenger_lite`, `messenger_pro`, `messenger_enterprise`, `secure_pro`, `secure_lux`) and
**Messenger subscription prices** (`pro`, `enterprise`). A one-line note under the second:
_"Secure Pro plans are priced per proposal, not here."_

#### 6.7.4 `/config/tier-grants`

New list: users with a non-`lite` messenger tier set by ops (`users.tier`,
`tier_expires_at`/permanent — **VERIFY** column names from RS-17/RS-19) with actor and
date from `ops_audit`. Grant/revoke = today's user-detail tier editor, reused. Backend:
`GET /ops/subscription/grants` (new, read-only join).

#### 6.7.5 `/config/switches`

Kill-switch (same component as the dispatch monitor) + the read-only env table from 6.7.0
with the deploy badge. When OP-10 item 9 lands (fee % on the pricing board), the fee rows
move to `/config/pricing` and off this page.

**Acceptance (Config):** every ops-changeable value is reachable from `/config` in one
click; each editor states what the app reads and how long it takes; nothing labelled
"Settings" edits money; an OPS-tier operator sees the group hidden, not 403s.

### 6.8 Finance

#### 6.8.0 `/finance` landing

Headline tiles (today's `useWalletOverview`/analytics money cards): GMV today, escrow held,
payouts pending, disputes open, **review holds open** (IA-06), promo redemptions 7 d.
Then today's LEDGER tab.

#### 6.8.1 Route-segment tabs

`/finance/ledger` · `/finance/escrow` · `/finance/payouts` · `/finance/disputes` ·
`/finance/invoices` · `/finance/promos` (sub-tabs Promos · Referral codes — today's
`/referral-codes` page mounted as the second tab) · `/finance/adjust`. Bodies = today's
tab components, unchanged, with CSV export retained.

#### 6.8.2 Review-hold exit (IA-06) — NEW action

On `/finance/escrow`, rows with `review_required && !settled_at` get a **RESOLVE REVIEW**
button (SUPERVISOR; `canResolveReviewHold` added to `rbac.ts`, mirroring
`@RequireRoles` on the endpoint). Modal = `ConfirmReasonModal` with a **Release to
provider / Refund to client** choice and mandatory reason. Client method:

```ts
resolveReviewHold: (bookingId: string, body: {action: 'release' | 'refund'; reason: string}) =>
  fetchJson(`/ops/bookings/${bookingId}/resolve-review`, {method: 'POST', body, idempotent: true}),
```

DTO verified: `ResolveReviewDto { action: 'release' | 'refund'; reason: string (≤ REASON_MAX) }`
(`apps/auth-service/src/ops/dto/*.ts:143-146`); the route is `@RequireRoles('SUPERVISOR','ADMIN')`

- `IdempotencyInterceptor` (`ops.controller.ts:205-214`), so the client call must send the
  idempotency key exactly like `approveBooking` does. The same action appears in the booking
  detail Money panel.

**Acceptance (Finance):** every money-moving endpoint under `/ops/*` has a button; every
button has a confirm-with-reason; every tab is a URL.

### 6.9 Safety

`/safety/sos` (today's `/sos`) and `/safety/vbg` (today's `/vbg`, title **Biometric Guard
(VBG) heartbeats**). SOS rows carry a **product** column (Lite / Executive / Secure Pro,
from the mission's booking service or protection session) and link to the right product
detail. `SosAlertBar` and `NotificationBell` are unchanged in behaviour; their links move
to the `routes.ts` helper.

### 6.10 Internal

`/internal/admins` (today's `/admins`), `/internal/audit` (today's `/audit`; add
`enterprise` subject type if 6.5.5 adds it), `/internal/console` (today's read-only info
card from `/settings`, plus `/api/health` status and build SHA — **VERIFY** the build
exposes a SHA env; if not, show `v1.0.0` as today).

---

## 7. Shared primitives to build FIRST (they make the move mechanical)

### 7.1 `src/lib/routes.ts` — one source for every path

```ts
export const routes = {
  dashboard: '/dashboard',
  lite: {
    root: '/lite',
    bookings: '/lite/bookings',
    booking: (id: string) => `/lite/bookings/${id}`,
    dispatch: '/lite/dispatch',
    dispatchRequests: '/lite/dispatch/requests',
    dispatchRequest: (id: string) => `/lite/dispatch/requests/${id}`,
    dispatchTest: '/lite/dispatch/test',
    jobs: '/lite/jobs',
    job: (id: string) => `/lite/jobs/${id}`,
    missions: '/lite/missions',
    mission: (id: string) => `/lite/missions/${id}`,
  },
  executive: {
    root: '/executive',
    bookings: '/executive/bookings',
    booking: (id: string) => `/executive/bookings/${id}`,
    missions: '/executive/missions',
    mission: (id: string) => `/executive/missions/${id}`,
  },
  pro: {
    root: '/pro',
    applications: '/pro/applications',
    application: (id: string) => `/pro/applications/${id}`,
    organisations: '/pro/organisations',
    organisation: (id: string) => `/pro/organisations/${id}`,
    pool: '/pro/pool',
    assignments: '/pro/assignments',
    fleet: '/pro/fleet',
    protection: '/pro/protection',
    session: (id: string) => `/pro/protection/${id}`,
  },
  enterprise: {
    root: '/enterprise',
    messenger: '/enterprise/messenger',
    departments: '/enterprise/departments',
    attendance: '/enterprise/attendance',
    incidents: '/enterprise/incidents',
    joinRequests: '/enterprise/join-requests',
  },
  people: {
    clients: '/people/clients',
    client: (id: string) => `/people/clients/${id}`,
    agents: '/people/agents',
    agent: (id: string) => `/people/agents/${id}`,
    agencies: '/people/agencies',
    agency: (id: string) => `/people/agencies/${id}`,
    compliance: '/people/compliance',
    users: '/people/users',
    user: (id: string) => `/people/users/${id}`,
  },
  config: {
    root: '/config',
    pricing: '/config/pricing',
    regions: '/config/regions',
    packages: '/config/packages',
    tierGrants: '/config/tier-grants',
    switches: '/config/switches',
  },
  finance: {
    root: '/finance',
    ledger: '/finance/ledger',
    escrow: '/finance/escrow',
    payouts: '/finance/payouts',
    disputes: '/finance/disputes',
    invoices: '/finance/invoices',
    promos: '/finance/promos',
    referralCodes: '/finance/promos/referral-codes',
    adjust: '/finance/adjust',
  },
  safety: {sos: '/safety/sos', vbg: '/safety/vbg'},
  internal: {admins: '/internal/admins', audit: '/internal/audit', console: '/internal/console'},
  login: '/login',
  acceptInvite: '/accept-invite',
} as const;

/** Product-aware detail links — the ONLY place that decides Lite vs Executive. */
export function bookingHref(b: {id: string; service?: string | null}) {
  return b.service === 'executive_protection'
    ? routes.executive.booking(b.id)
    : routes.lite.booking(b.id);
}
export function missionHref(m: {id: string; service?: string | null}) {
  return m.service === 'executive_protection'
    ? routes.executive.mission(m.id)
    : routes.lite.mission(m.id);
}
```

An ESLint rule (or the §9.2 scan test) bans string-literal hrefs beginning with `/` in
`src/app/**` and `src/components/**` except in `routes.ts` and `next.config.js`.

### 7.2 `src/lib/nav.ts` — the rail as data

```ts
export type NavItem = {
  label: string;
  href: string;
  icon: ReactNode;
  minRole?: AdminRole;
  badgeKey?: string;
};
export type NavGroup = {
  key:
    | 'overview'
    | 'lite'
    | 'executive'
    | 'pro'
    | 'enterprise'
    | 'people'
    | 'config'
    | 'finance'
    | 'safety'
    | 'internal';
  label: string;
  minRole?: AdminRole;
  items: NavItem[];
};
export const NAV_GROUPS: NavGroup[] = [
  /* §5.2 verbatim */
];
```

`Shell.tsx` renders from this and nothing else; the existing `NAV_MIN_ROLE` object is
deleted in favour of `minRole` on group/item. Group badges read
`dash.kpis.<group>.waiting` (6.1.1).

### 7.3 `src/lib/status.ts` — one status vocabulary

One `Record<BookingStatus, {label, tone}>`, one for jobs, agents, Pro applications,
dispatch requests, escrow, protection sessions. `StatusPill` component consumes it. Every
inline map listed in IA-17 is deleted.

### 7.4 Page-shell primitives

- `PageHeader` — crumbs (from the nav tree, automatic), title, subtitle, actions slot.
  Replaces both `page-head > h2` and `h1.text-xl` dialects (IA-12). One typographic scale:
  title 20/800 Manrope, subtitle 12.5/500 `--tx-3`, crumbs JetBrains Mono 10/700.
- `RouteTabs` — tabs as `<Link>`s to sibling segments with `aria-current`.
- `SectionLanding` — KPI tile row + queue list + links; used by `/lite`, `/executive`,
  `/pro`, `/enterprise`, `/config`, `/finance`.
- `DataTable` — the OC-14 primitive (sortable headers, sticky head, empty/loading/error
  states, CSV slot). Build the minimal version now (no virtualization); it unblocks every
  moved list from re-implementing `<table>`.

**Extraction list (IA-13)** — split before moving, no behaviour change, one commit each:

| From                             | Into (`src/app/(sections)/…/_panels/`)                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bookings/[id]/page.tsx`         | `BookingHeader`, `BookingDetailPanel`, `BookingPreferencesPanel`, `BookingApprovalPanel`, `BookingDispatchPanel` (applicants + vehicles), `BookingPayoutPanel`, `BookingMoneyPanel` (new), `ExecPricingBreakdown` (new), `ExecTransferLeg` |
| `live/[id]/page.tsx`             | `MissionMap`, `MissionCrewPanel`, `MissionWaypointsPanel`, `ExecCheckinTimeline`, `MissionRoutePanel`, `MissionSosPanel`, `OpsChat`, `TelemetryTrail`                                                                                      |
| `pro-applications/[id]/page.tsx` | `ProApplicantPanel`, `ProProposalPanel`, `ProFamilyPanel`, `ProMissionsPanel`, `ProResourcesPanel`, `ProNotesPanel`, `ProThreadPanel`, `ProClientHistory`                                                                                  |
| `pro-management/page.tsx`        | `ProOrgsList`, `ProOrgDetail`, `ProPoolTable`, `ProRequestsQueue`, `ProAssignmentsTable`, `ProFleetTable`, `ProResourcesTable`                                                                                                             |
| `finance/page.tsx`               | one file per tab (`LedgerTab` … `AdjustTab`) + `ReviewHoldAction` (new)                                                                                                                                                                    |
| `settings/page.tsx`              | `ServicePricingBoard`, `RegionsTable`, `PackageCatalogEditor`, `SubscriptionPricesEditor`, `ConsoleInfoCard`                                                                                                                               |

Use a Next.js **route group** `src/app/(console)/` with a shared `layout.tsx` that mounts
`Shell` once, instead of every page importing `<Shell>` (35 imports today). `/login` and
`/accept-invite` sit outside the group.

---

## 8. Implementation plan (ordered, gated, each phase shippable)

| Phase | Work                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Touches                                                                                                   | Size | Gate before next phase                                                                                                                                                                         |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | Primitives: `routes.ts`, `nav.ts`, `status.ts`, `PageHeader`, `RouteTabs`, `SectionLanding`, minimal `DataTable`, `(console)/layout.tsx`. Replace every literal href with `routes.*`. **No URL changes yet** — `routes.ts` initially maps to today's paths.                                                                                                                                                                                          | `src/lib/*`, `src/components/*`, every page's header + links                                              | M    | typecheck 0 new errors · lint clean · `next build` · §9.2 pin suite green · click-through of all 23 rail items at 1280 px                                                                      |
| **B** | Backend additions (all additive, all audited): `GET /ops/bookings?service=` + `lane`; `GET /ops/missions?service=`; dashboard `kpis.{lite,executive,pro,enterprise,safety}`; `GET /ops/analytics?product=`; `GET /ops/config/status`; `GET /ops/subscription/grants`; `GET /ops/enterprise/summary`, `/join-requests` (+ approve/reject); `GET /ops/agencies`, `/:id`. Each with a spec file next to the existing `ops-data.routes.spec.ts` pattern. | `apps/auth-service/src/ops/*`, `dispatch`, `department`, `org`                                            | L    | `cd apps/auth-service && npm test` green · `ops.controller.authz-roles.spec` extended for every new route · migration (if `enterprise` subject type) applied on staging via the OVERLAY deploy |
| **C** | Extraction (§7.4) — split the six monoliths into panels, no behaviour change, one commit each.                                                                                                                                                                                                                                                                                                                                                       | the six files → `_panels/`                                                                                | M    | typecheck · build · visual diff at 1280/1024 for each split page (screenshot before/after)                                                                                                     |
| **D** | The move: create the ten section trees, mount the extracted panels, flip `routes.ts` to the new paths, add `next.config.js` redirects, delete `/live/wall`, merge dispatch pages, split bookings/missions by service, retitle everything per §2.                                                                                                                                                                                                     | `src/app/(console)/**`, `next.config.js`, `Shell.tsx`, `NotificationBell`, `SosAlertBar`, `middleware.ts` | L    | §9.1 redirect test (every old URL → 3xx → 200) · §9.2 pin suite · role matrix §9.3 · widths §9.4                                                                                               |
| **E** | New surfaces: `/config` status landing + `/config/*` pages; `/finance/escrow` review-hold action (IA-06); `/people/agencies`; `/enterprise/join-requests`; product-segmented dashboard; section landings.                                                                                                                                                                                                                                            | new pages + `rbac.ts` (`canResolveReviewHold`, `canDecideJoinRequest`)                                    | L    | as D, plus: resolve-review mutation exercised on staging against a synthetic `review_required` hold (§9.5)                                                                                     |
| **F** | Polish: group badges, SOS product column, Executive columns/pricing breakdown, tier-grants list, agency links from compliance, delete `dispatchJob`, `DataTable` sorting.                                                                                                                                                                                                                                                                            | scattered                                                                                                 | M    | full §9 again · founder walk-through · sqa.md session entry closing IA-01..IA-18                                                                                                               |

**Order rationale:** A gives you the tooling to move without breaking links; B is
independent of the UI and can run in parallel with C; D is the visible change and is only
safe after A+C; E and F are additive on the new tree. **Do not start D before A's pin
suite exists** — this is the one change in the console's history big enough to lose a
page silently.

**Deploy:** the console ships via the manual SSH tar-overlay
(`scripts/deploy-staging.sh`, GitHub Actions is dead — see memory `project_cicd_staging_deploy`).
Backend (B) must be deployed **before** D/E or the new lists 404 on the new query params —
the console must tolerate a missing `lane`/`kpis.lite` for one release (`?? legacy`).

---

## 9. Verification (real, not asserted)

### 9.1 Redirect and reachability test (script, run against `next build && next start`)

For every row of §5.4: `curl -sI -o /dev/null -w "%{http_code} %{redirect_url}" <old>` →
must be `308` to the new path; then `curl` the new path with a valid session cookie → `200`.
For dynamic routes use a real id from staging. Save the output as
`docs/qa/OPS_CONSOLE_IA_REDIRECTS_<date>.txt`.

### 9.2 Pin suite (the console gets its first tests — Vitest or Jest `app` project, node env)

- `nav.test.ts` — every `NavItem.href` exists as a page under `src/app/(console)`; every
  page under `(console)` is reachable from exactly one nav item or one list page (walk
  `routes.ts`); no two items share a label; the word `Pro` never appears unqualified in a
  label; `minRole` on `config`/`finance`/`internal.audit`/`internal.admins` matches
  `rbac.ts`.
- `routesLiteral.test.ts` — source scan: no `href="/…"` / `router.push('/…')` literal
  outside `routes.ts` and `next.config.js`. (Strip comments first; files are CRLF — use
  `\r?\n` — the two scan traps from CLAUDE.md.)
- `redirects.test.ts` — `next.config.js` `redirects()` covers every path in §5.4 and every
  redirect target exists.
- `status.test.ts` — every enum value the backend can return (`BookingStatus`,
  `JobStatus`, `AgentStatus`, `ProApplicationStatus`, escrow status) has a `status.ts`
  entry.

### 9.3 Role matrix (browser, staging, three real admin accounts)

For OPS / SUPERVISOR / ADMIN: screenshot the rail; confirm hidden groups per §5.3; visit
one page in each hidden group by URL → console shows the friendly 403 page, not a blank.

### 9.4 Layout matrix

1440 · 1280 · 1024 · 768 (rail collapses) · 390 (`@media (max-width: 640px)` path) for:
each section landing, `/lite/bookings`, `/executive/bookings/[id]`, `/pro`,
`/config`, `/finance/escrow`. No horizontal scroll on the body; tables scroll inside
their container.

### 9.5 Behavioural probes on staging

- Approve a Lite booking → appears in `/lite/jobs` and (if auto-dispatch on) in
  `/lite/dispatch/requests`; lane badge correct on `/lite/bookings`.
- Create an Executive booking from the app → appears only under `/executive/*`; check-in
  timeline populates on `/executive/bookings/[id]` after the CPO's first hourly check-in.
- Change a pricing key on `/config/pricing` → `/config` status row updates
  (`updated_at`/actor) → `/internal/audit` shows `service_pricing.update`.
- Manufacture a `review_required` hold (proof-of-completion gate — **VERIFY** the recipe in
  `ops.review-hold.spec.ts`) → RESOLVE REVIEW on `/finance/escrow` → ledger rows + audit
  row; a second click with the same idempotency key is a no-op.
- `/pro-management` bookmark → lands on `/pro`; `/live/wall` → `/lite/missions`.

### 9.6 Standing gates

`cd apps/ops-console && npm run typecheck && npm run lint && npm run build` (baseline:
typecheck must stay at its current count — **VERIFY** the current number first and record
it in the PR); `cd apps/auth-service && npm test` for phase B; self-diff every phase
against HEAD per CLAUDE.md rule 8 (enumerate consumers of every moved file: the
`NotificationBell`, `SosAlertBar`, `MessengerProvider` and `middleware.ts` links are the
ones a grep for `href` misses).

---

## 10. Stop conditions and do-nots

- **Do not change any `/ops/*` endpoint path or DTO.** Everything in §8-B is additive
  (new query params with defaults, new routes). Existing mobile-app builds and the
  deployed console must keep working during the rollout.
- **Do not add a backend mutation without `@RequireRoles` + an `OpsAuditService` row**
  (OC-03/OC-04 rule). New subject types need the DB check constraint migration.
- **Do not touch** `lib/messenger/**`, `middleware.ts` security headers/CSP, CSRF, the
  session refresh/idle logic in `Shell.tsx` — move the JSX, keep the hooks byte-identical.
- **Do not "fix" OP-01..OP-20 inside this work** except the two called out (OP-14 on
  departments while moving it; IA-15 region picker). Data-fetching mechanics are a separate
  approved plan.
- **Do not re-propose** a global search (IS-12 — tombstoned until a server-side search
  exists), a websocket alert channel (OC-08 — architecture-gated), or the `/live/wall`
  video pipeline (OC-11).
- **Design system:** obsidian/cobalt tokens only (`globals.css` `--bg-*`, `--surf-*`,
  `--acc`, `--tx-*`); no new colours; the 8-pt grid; one primary action per page header
  (`DESIGN_REVIEW_LOOP.md` G8).
- **Do not delete an old route file until its redirect is tested** (§9.1).

---

## 11. Open questions for the founder (answer before Phase D; defaults stated)

| #   | Question                                                                                                                 | Default if unanswered                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Q1  | Are `recon_team` and `emergency_extraction` Lite services (same list, a chip) or their own section?                      | Lite, shown as a chip; they share the Lite pipeline and pricing keys               |
| Q2  | Should `secure_lux` (coming-soon premium card) appear anywhere in the console beyond the catalog editor?                 | No — catalog copy only                                                             |
| Q3  | Provider agencies (§6.6.3): read-only roster first, or with suspend/restore from day one?                                | Read-only + reuse user suspend; agency-level suspension needs its own product rule |
| Q4  | Should OPS-tier operators see the **App Configuration** group at all (read-only) or nothing?                             | Nothing (matches today's in-page gate)                                             |
| Q5  | Enterprise join-request approval in the console — who owns it today (workspace admin in-app)? Is an ops override wanted? | Read-only list until answered                                                      |
| Q6  | Keep "Bravo Ops Console" branding on the rail head, or per-section wordmark (e.g. "BRAVO OPS · LITE")?                   | Rail head constant; section name in `PageHeader` crumbs                            |

---

## 12. Register

- **sqa.md** session 2026-09-03 — IA-01..IA-18 logged findings-only; no B-numbers claimed;
  next free stays **B-739**.
- Related open items this plan closes or moves: IS-12 (no — stays tombstoned), IS-16
  (assignment calendar — the `/pro` landing is the first step), IS-23 (skeletons — via
  `DataTable`), OC-11 (`/live/wall` deleted), OC-14 (`DataTable` minimal), OC-15
  (SK-06b enterprise tables — `/enterprise/join-requests`), OP-14 (departments paging),
  MON-2 console gap (IA-06).
- Docs to update when shipped: `docs/CODEBASE_MAP.md` §Ops Console tree,
  `docs/README.md` audits index, `apps/ops-console/README.md` (create — one page: the
  ten groups, the glossary, `routes.ts` rule), and the OC-18 operator runbook stub
  (`docs/runbooks/OPS_CONSOLE_OPERATOR_GUIDE.md`) — the §5.2 tree is its table of contents.

---

## 13. Remediation — executed 2026-09-03 (same day)

The founder approved the plan with "fix all". Phases A–F were executed in one
session. Status per finding, with the gate evidence in §14.

| ID    | Status              | What landed                                                                                                                                                                                                                                                                        |
| ----- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IA-01 | **FIXED**           | Ten business-shaped rail groups (`lib/nav.tsx`), every page moved under its section prefix, 29 permanent redirects, cross-product doors on both the Lite and Executive lists                                                                                                       |
| IA-02 | **FIXED**           | Glossary applied to every label; `nav.test.ts` fails on a bare "Pro"; the users column is "Messenger tier"; Secure Pro pages are titled "Secure Pro — …"; Pro orgs say "INTERNAL delivery"                                                                                         |
| IA-03 | **FIXED**           | `GET /ops/bookings?service=` and `GET /ops/missions?service=` filter SERVER-side; one `BookingsList` / `MissionsList` with a `product` prop; detail pages rewrite the URL to the canonical product                                                                                 |
| IA-04 | **FIXED**           | `/lite/dispatch` with Monitor · Requests · Test-harness tabs; the inspector is the Requests tab                                                                                                                                                                                    |
| IA-05 | **FIXED**           | `lane` (auto / manual / null) computed server-side and shown as a chip on the Lite list; the Job Feed page explains both lanes; the deprecated `dispatchJob` client method deleted                                                                                                 |
| IA-06 | **FIXED**           | `resolveReviewHold` client method + `ReviewHoldAction` modal on BOTH the finance escrow tab and the booking Money panel; `canResolveReviewHold` in rbac; escrow list gained a `booking` filter                                                                                     |
| IA-07 | **FIXED**           | `/config` section: a status board naming what each app reads, when a change lands and its known caveat (sourced from OP-01..OP-10), plus Pricing · Regions · Packages · Tier Grants · Switches                                                                                     |
| IA-08 | **FIXED**           | `/people/agencies` list + detail on new `GET /ops/agencies[/:id]`: compliance validity, roster, armed permits and the real 30-day offer / acceptance / no-show record                                                                                                              |
| IA-09 | **FIXED**           | Audit Log → Internal; Referral Codes → Finance · Promos; Incidents → Enterprise; Compliance → People                                                                                                                                                                               |
| IA-10 | **FIXED**           | `GET /ops/dashboard` returns `kpis.lite` / `.executive` / `.enterprise`; the dashboard renders one strip per business, every tile a link; rail badges are group-level                                                                                                              |
| IA-11 | **FIXED**           | Glossary titles applied ("Job Feed", "Agents (CPOs)", "Biometric Guard (VBG)", "Incident Reports (Enterprise)")                                                                                                                                                                    |
| IA-12 | **FIXED**           | `PageHeader` on every page; `RouteTabs` replaces every `useState` tab (finance ×8, pro ×6, config ×6, dispatch ×3, people ×5, enterprise ×5); the Shell is mounted once in `(console)/layout.tsx`                                                                                  |
| IA-13 | **FIXED (partial)** | pro-management (1,099 lines) → 6 routes + one shared component; settings (663) → 5 files; finance (645) → 8 routes; bookings and missions extracted into `features/` and shared by both products. `bookings/[id]` and `live/[id]` are still large — their panels are not yet split |
| IA-14 | **FIXED**           | Landings for Lite, Executive, Secure Pro, Enterprise, App Configuration and Finance, each with KPI tiles and real work queues                                                                                                                                                      |
| IA-15 | **FIXED**           | The dispatch test harness reads `/ops/regions` and centres on each region's own bounding box; it warns about regions that have none                                                                                                                                                |
| IA-16 | **FIXED**           | `ExecPricingBreakdown` panel (block, computed end, units, add-ons, transfer leg, price composition as charged) plus Executive columns on the list, from a widened server projection                                                                                                |
| IA-17 | **FIXED**           | `lib/status.ts` is the one vocabulary; `StatusPill` renders it; `status.test.ts` asserts coverage of every server enum value                                                                                                                                                       |
| IA-18 | **FIXED**           | The console's first tests: nav · routesLiteral · status (30 tests, `npm run test:ops-console`); `/live/wall` deleted                                                                                                                                                               |

### Deliberately NOT done, and why

- **Enterprise join-request DECISIONS** stay read-only. Approving one grants
  workspace membership and seeds E2EE scope acting as that workspace's own
  manager; whether ops may do that is §11 Q5, unanswered. The page says where the
  decision is made instead of implying ops is blocked.
- **`/pro/organisations/:id`** is not a route — the org drill-down is in-page
  state inside the Organisations section. The routes helper does not advertise a
  path that does not exist.
- **OP-01..OP-20** (data-fetching mechanics) were not touched beyond the one the
  restructure had to fix anyway (the region picker, IA-15). They remain the
  separate approved plan.

### New backend surface (all additive, all guarded)

| Endpoint                                     | Role        | Notes                                                              |
| -------------------------------------------- | ----------- | ------------------------------------------------------------------ |
| `GET /ops/bookings?service=`                 | any admin   | comma list, DTO-validated; also returns `lane` + Executive columns |
| `GET /ops/missions?service=`                 | any admin   | plus `service` on the row so links can route by product            |
| `GET /ops/dashboard` (extended)              | any admin   | adds `kpis.lite` / `.executive` / `.enterprise`; flat keys kept    |
| `GET /ops/finance/escrows?booking=`          | SUPERVISOR+ | scopes the booking detail's Money panel                            |
| `GET /ops/config/status`                     | SUPERVISOR+ | per-config last-changed plus actor                                 |
| `GET /ops/agencies`, `GET /ops/agencies/:id` | any admin   | region-scoped by-id read (the AUTH-01 rule)                        |
| `GET /ops/enterprise/summary`                | any admin   | landing counts                                                     |
| `GET /ops/enterprise/join-requests`          | any admin   | read-only queue                                                    |
| `GET /ops/subscription/grants`               | SUPERVISOR+ | who currently holds a comp'd tier                                  |

No endpoint path or DTO changed. Every new query param has a default, so a
console deployed ahead of the server degrades to the old behaviour rather than
breaking.

---

## 14. Verification actually run (2026-09-03)

| Gate                                     | Result                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| ops-console typecheck                    | **clean**                                                                                   |
| ops-console lint                         | **clean**, zero warnings                                                                    |
| ops-console production build             | **passes** — all ~50 routes compile                                                         |
| `npm run test:ops-console`               | **30 / 30 pass** across 3 suites                                                            |
| Pin-suite mutation proof                 | a nav href typo turns `nav.test.ts` **RED** (2 failures), then reverted — the scan is real  |
| auth-service full suite                  | **167 suites / 3,129 tests pass**                                                           |
| Redirect probe (built server, port 3199) | all **24** legacy URLs return **308** to the right new path, `:id` forms included           |
| New-route probe                          | all **49** new routes resolve (307 to `/login?next=…`, i.e. auth-gated rather than missing) |
| `/api/health`                            | **200**                                                                                     |
| messenger-crypto project                 | **578 suites / 7,229 tests pass**                                                           |
| booking project (after the pin repoint)  | **916 / 916 pass**                                                                          |
| mobile typecheck ratchet                 | **46 errors — exactly the baseline, unmoved**                                               |
| Backend spec mutation proof              | removing the `service` clause turns `ops.sections.spec.ts` **RED** (2 failures), reverted   |

| app (React Native) project | 246/246 suites pass on a clean tree; one run showed a single failure in `activityStore` that PASSES in isolation and MOVED on re-run — the known order/timing flake class, not this change (nothing here is imported by the app project)

### One regression the gates caught

Three **mobile** booking tests (`referralCode`, `auditFixPins`, `sosVisibility`) are
cross-repo pins that scan ops-console FILE PATHS. Moving the console broke five of
their assertions — a failure the console's own typecheck, lint, build and pin suite
could not possibly see, because it lives in another project's test folder. They were
repointed at the new locations with the same assertions (the referral pin also moved
from the old Shell nav array to `lib/nav.tsx` + `lib/routes.ts`), and the booking
project is back to 916/916.

**Rule for the next move:** run
`grep -rn "apps/ops-console/src" --include=*.test.ts src apps packages` before
relocating a console file. Four suites outside the console scan its sources.

### Second self-check (same day, after "check everything")

One real defect found and fixed that no gate could see: the SOS alert bar's LOST SIGNAL
link and the notification bell's Live-ops link pointed at the new **Lite-only** missions
list while their counts come from the **unfiltered** mission poll — an Executive detail that
lost signal would have led to a list that did not contain it. The alert now links straight
to the mission when there is one, and to the board that holds them otherwise (with an extra
Executive link when mixed); the bell links to the dashboard map, which spans every product.
Known UX quirk left as-is: choosing a completed protection session from the "All" filter
navigates to its route, which remounts with the filter back on "Live".

**Not run, and owed before this reaches operators:**

- A browser pass with a real session at 1440 / 1280 / 1024 / 768 / 390 px. Every
  route was proven to _resolve_; none was proven to _render correctly_, because
  the probes ran unauthenticated.
- The §9.3 role matrix with three real admin accounts. Rail filtering is
  unit-tested against `rbac.ts`, not observed in a browser.
- The §9.5 behavioural probes on staging: the review-hold resolve against a real
  `review_required` hold, the lane chip against a real auto-dispatched booking,
  and the Executive check-in timeline against a real hourly check-in.
- Backend deploy. The console must ship AFTER auth-service or the new params and
  endpoints 404. Every new client field is optional, so a console-first deploy
  degrades rather than breaks — but the new pages would read empty.

### 14.1 Staging deploy — done 2026-09-03 (auth-service first, console second)

- **auth-service** deployed 22:51 via `scripts/deploy-manual.sh auth-service` with
  `VERIFY_SYMBOL=OpsSectionsService` — the symbol was grepped in the running
  `bravo-staging-auth` dist; watchdog pristine snapshot refreshed.
- **ops-console** deployed 22:56 (container `bravo-staging-ops` healthy, 64 `(console)`
  pages in `.next/server/app`, no `/dashboard` route left, Next ready in 149 ms).
  The FIRST build failed with `You cannot have two parallel pages that resolve to the
same path … /(console)/dashboard/page and /dashboard/page`: the manual deploy is an
  OVERLAY extract that never deletes, so the 32 pre-restructure page files were still
  on the box beside the new tree. Fix: diffed the box's `apps/ops-console/src` file
  list against `git ls-files` (`LC_ALL=C sort` + `comm`; the default locale sort
  mis-orders `(`/`[` and produced false positives), confirmed each path untracked,
  removed exactly those files on the box, pruned the empty dirs, re-ran the script.
  **Any future MOVE of a Next.js page needs the same pre-delete on the box.**
- Unauthenticated probes against `https://ops.94-136-184-52.sslip.io` after the deploy:

| Probe (public host)   | Result                                        |
| --------------------- | --------------------------------------------- |
| `GET /bookings`       | 308 → `/lite/bookings`                        |
| `GET /pro-management` | 308 → `/pro`                                  |
| `GET /settings`       | 308 → `/config`                               |
| `GET /live/abc`       | 308 → `/lite/missions/abc`                    |
| `GET /login`          | 200                                           |
| `GET /lite/bookings`  | 307 → `/login?next=%2Flite%2Fbookings` (gate) |

Still owed (unchanged): the browser pass with a real session, the role matrix, and the
three behavioural probes listed above.
