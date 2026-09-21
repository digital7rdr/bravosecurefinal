# Coverage rings and cross-country booking — plan (B-788 / B-789)

> **Status:** IMPLEMENTED 2026-09-03 — Phase 1 (client box gate, cross-zone picker, zone clock,
> server `pickup_outside_region`) in commit `2a41f91a`; Phase 2 (Dispatch v2: areas, provider
> ladders, per-region routing switch, DARK by default) in the commit after. Device pass OWED;
> migration + auth-service NOT deployed; **deploy order migration → server → APK is HARD**.
> Status, gates and the review-fix list live in `sqa.md` B-788 / B-789 "Fix". §6 questions
> Q2 (TTLs), Q3 (dispatch at approval), Q4 (busy primary), Q5 (re-route on failure) remain
> open — v1 skips a busy primary and dispatches at T-15.
>
> Originally: PLAN ONLY — nothing implemented. **Revised the same day** after the founder's
> product decision on dispatch (§2.2 is now the assigned-provider model, not a wider radius;
> the decision is quoted there). Founder ask 2026-09-03, two parts:
>
> 1. _"Remove the distance restrictions from Secure Transfers and Executive Protection on the
>    map. I was in Cape Town and wanted to book Western Cape; it showed 'out of coverage 99 km'
>    but the client wants no restriction."_
> 2. _"I'm in the UAE, I search a Cape Town place in the booking and don't get it. The client
>    says: suppose I'm in Dubai and for tomorrow I want to schedule in another country."_
>
> Every claim about the current code below is cited to a symbol so it can be re-grepped. Run
> `docs/runbooks/LITE_BOOKING_LOOP.md` and `docs/runbooks/NAV_RAPID_USE_LOOP.md` when building
> it; both trigger lists fire (booking screens, `onPress` navigation, focus fetches).

---

## 0. TL;DR

Both asks have **one root cause**: the app carries **two different models of "where we
operate"**, and the client's is stricter than the server's.

| Layer                        | Model                                                                 | Where                                                                                                   |
| ---------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Client map (the restriction) | **City circles** — Cape Town 45 km, Johannesburg 50 km, Dubai 40 km…  | `src/modules/booking/coverageZones.ts` `COVERAGE_ZONES` + `checkCoverage` (haversine)                   |
| Server (create + price)      | **Country bounding box** per region — the ZA box is the whole country | `public.regions` `min_lat…max_lng`; `regionFromPoint()` in `apps/auth-service/src/common/regions.ts`    |
| Server (dispatch reach)      | Same region **AND** an agency's **live** position within **50 km**    | `dispatch.service.ts` `RANKING_SQL` — `ST_DWithin(a.last_location, pickup, DISPATCH_RADIUS_M = 50 000)` |

So a pin in the Western Cape 99 km from Cape Town is a **valid, priceable ZA booking to the
server**, and only the client's circle says no. Removing the circle is correct and cheap.

**The trap:** the circle was hiding the dispatch reach. Agencies are ranked by their live GPS
position within 50 km of the pickup — for on-demand AND for scheduled bookings (the scheduled
cron calls the same `startDispatch`). Delete the circle alone and the Western Cape booking
goes through, searches, finds nobody within 50 km, and ends as **NO_PROVIDER** ("No detail
available"). The restriction moves from a clear map banner to a worse place: after the user
has committed.

**The founder's decision (same day) replaces the radius with a routing model:** no distance
gate at all, on-demand or scheduled. Bravo appoints a **primary** provider per province /
operational area and a **secondary** as backup; the booking goes to the primary regardless of
distance, the provider decides feasibility, and a decline cascades to the secondary. Distance
is shown to the provider as information. §2.2 is that design.

**Part 2 is three defects in one flow**, all in `LocationPickerScreen.tsx`:

1. the picker **yanks the pin to GPS on open** whenever the booking has no pin yet
   (`usedInitialPin === false` → `fetchPosition()`), so a Dubai user who chose zone South
   Africa opens the map over Johannesburg and is immediately recentred to Dubai;
2. the address search is scoped to the **country under the pin** (`pinCountry`, reverse-geocoded
   from the WebView) — now `ae` — so "Cape Town" returns nothing;
3. the scheduled time is built on the **device clock** (`computeStartTime`), and the app has
   **no per-zone timezone**, so "tomorrow 09:00" for Cape Town books 09:00 Gulf = 07:00 SAST.

The zone chooser itself already allows another country (`ZoneMapScreen.selectZone` has no GPS
gate; GPS only picks the default), so the fix is to make the **zone**, not the GPS fix, the
authority for where the picker opens, what it searches, and what clock it uses.

---

## 1. Current mechanics (evidence)

### 1.1 The distance restriction is client-only

- `coverageZones.ts` — ten circles (`COVERAGE_ZONES`). `checkCoverage(lat, lng, countryCode)`
  tests the pin against **every** circle globally; `countryCode` only chooses which rings are
  drawn and which one the banner names as "nearest".
- `LocationPickerScreen.tsx` consumes it four ways:
  - `confirm()` refuses when `!coverage.inCoverage`; the CTA is `disabled` and reads
    `OUT OF COVERAGE`;
  - the banner: `Out of coverage — ${distanceKm} km from ${nearest.label}` (the founder's
    "99 km from Cape Town");
  - `hasZones` — a country with **no** rings (GB) reads `NOT AVAILABLE IN THIS REGION` even
    though it is a supported region server-side;
  - `initialCenter` only honours a passed-in pin if it sits **inside a ring**; otherwise it
    recentres to the first ring's centre.
- The WebView draws the rings (`bravoLocationPickerMapHtml.ts` `zones`, layers `coverage-fill`
  / `coverage-outline`, legend "Coverage").
- **Both services share the gate.** Every caller opens the same picker with
  `countryCode: draft.zone_code || 'AE'`: Lite (`BookingDateTimeScreen`, `CustomizeAddOnsScreen`)
  and Executive (`ExecReviewScreen` ×2, `ExecTaskScreen`, `ExecTransportScreen`). One fix
  covers "Secure Transfers and Executive Protection".

### 1.2 The server never had a circle

- `BookingService.create()` gates on `dto.region ∈ supportedRegions()`
  (`unsupported_region`), then derives `priceRegion = regionFromPoint(pickup)` from the
  region's **bounding box** — never from the client's code. The seeded ZA box is
  `−35.0…−22.1 lat, 16.4…33.0 lng`: the whole country. Western Cape is inside it.
- `regions()` is ops-managed (`public.regions`, `RegionsService`, 60 s cache, fail-open to the
  compiled seed). Boxes are data, not code.
- **Gap to close while here:** a pickup **outside every box** (zone ZA, pin dropped in Namibia)
  makes `priceRegion` null, and a null region resolves to the **GLOBAL** price board rather than
  being rejected. Today the client circle makes that unreachable; once the circle goes, the
  server must refuse it explicitly (§2.1 step 4).

### 1.3 Dispatch reach — the real restriction

`RANKING_SQL` (dispatch.service.ts):

```sql
WHERE a.type = 'company' AND a.status = 'ACTIVE' AND a.on_duty = TRUE
  AND a.last_location_at > NOW() - ($5 || ' minutes')::interval   -- 5 min fresh
  AND a.region_code = $3                                            -- same region
  AND ST_DWithin(a.last_location, pickup, $6)                       -- DISPATCH_RADIUS_M = 50 000
```

- Used for **on-demand and scheduled** bookings alike — the ops-approved subscriber and the
  scheduled cron both call `startDispatch` (comment at `dispatch.service.ts` "scheduled cron
  call this after approval").
- For a scheduled job this is the wrong question. An agency's live position at T-15 tells you
  where it is **now**, not whether it will drive 99 km for a booking it accepted three days ago.
  In a protection business the agency travels to the job; the model assumes an Uber pool.
- `NO_PROVIDER` → `no_provider_fallback.can_widen: true` is **ops-driven** — the client has no
  self-serve re-dispatch. So "no restriction on the map" without a reach change is a promise
  the dispatcher cannot keep.
- `DISPATCH_DISABLE_REGION_FILTER` exists but is **staging-only** and refused at boot in
  production — not a lever.

### 1.4 Cross-country: the zone step already works, the picker undoes it

- `ZoneMapScreen`: all 195 countries listed; `activeCodes` = live launched regions ∪ the
  compiled seed (AE, ZA). `selectZone(code)` has **no GPS gate** — GPS (`useVbgLocation` +
  `vbgApi.geocode`) only picks the **default** row. A user in Dubai can pick South Africa.
- `useBookingStore.updateDraft` clears `pickup`/`dropoff` when `zone_code` changes (pinned by
  `bookingStore.zoneChange.test.ts`) — correct, keep.
- The picker then: `initialCenter` = Johannesburg (first ZA ring), `usedInitialPin = false`
  → on `mapState === 'ready'` → `fetchPosition()` → pin recentred to Dubai → the WebView's
  `moveend` reverse-geocode sets `pinCountry = 'ae'` → search URL carries `country=ae` and
  `proximity=<Dubai>` → "Cape Town" cannot be found → banner "Out of coverage — 6,4xx km from
  Johannesburg" → CONFIRM disabled. **This is the second report, end to end.**

### 1.5 Time: the device clock is the only clock

- `CustomizeAddOnsScreen.computeStartTime` → `new Date(); setHours(hour, minute)` /
  `new Date(laterDate)`: the picked wall-clock in the **device's** zone.
- The client has **no per-zone UTC offset** (`src/utils/regions.ts` carries none;
  `regionsAvailability` does not ship `utc_offset_hours` although `public.regions` has it).
- Server lead-time gates (`MIN_LEAD_HOURS`, `assertExecLeadTime`) compare **instants** — they
  are unaffected. The T-15 scheduled-dispatch sweep and the reminder use the same instant — so
  a wrong instant is dispatched consistently wrong.

### 1.6 What already protects us (do not touch)

- `unsupported_region` gate — a Coming-Soon country still cannot be booked. The zone list says
  "Coming Soon" and `create()` refuses. Correct.
- Anti-fraud `mockedLocationClause` in the ranking — unchanged by anything here.
- B-405 / LB17 resume semantics — unaffected (no status change).

---

## 2. Target behaviour

### 2.1 Part 1 — the map restriction (client) + the server floor

**Decision: replace the ring GATE with the server's own rule (the region box); keep rings as
information.** Options considered:

| Option                                                            | Verdict                                                                                                                       |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| O1 Delete rings, CONFIRM always on                                | Moves the refusal to after commit (NO_PROVIDER). Rejected on its own.                                                         |
| **O2 Gate on the zone's country box; rings become informational** | **Recommended.** Client and server finally agree; the box is ops data; nothing becomes bookable that the server would refuse. |
| O3 Keep the ring as a soft warning, no gate                       | Same as O2 minus the box gate; lets a Namibia pin through to a GLOBAL-priced booking. Rejected.                               |

Steps:

1. **`coverageZones.ts`** — add `isInsideZone(lat, lng, countryCode)` backed by the country
   box (`src/utils/regions.ts` already has `REGION_BBOX` + `regionFromBBox`; reuse, do not
   fork). Keep `checkCoverage` for the "nearest hub" label only. Rename its result field
   `inCoverage` → `nearHub` so no caller can keep gating on it by accident (the compiler finds
   every site).
2. **`LocationPickerScreen`** — CONFIRM gates on `isInsideZone`, never on a ring. Banner copy:
   inside the box → `In South Africa · nearest Bravo hub Cape Town, 99 km`; outside the box →
   `Outside South Africa — move the pin or change the booking zone` (CTA disabled with
   `OUTSIDE ZONE`). `hasZones` is deleted: a supported region with no rings is bookable.
   `initialCenter` honours a passed-in pin whenever it is inside the **box**.
3. **Rings stay drawn** but the legend reads "Bravo hubs" and the fill opacity drops; they are
   a hint about response time, not a wall.
4. **Server — `create()`:** if `regionFromPoint(pickup)` is null **or ≠ `dto.region`**, refuse
   with `pickup_outside_region` (400) instead of pricing on the GLOBAL board. Same check on
   `estimate()` so the quote and the charge agree (the estimate/create parity rule this file
   already follows for lead time). Executive `exec_transport` legs get the same check.
5. **Expectation copy** on the review screen when the pin is > `DISPATCH_RADIUS_M` from every
   hub: "Outside our usual response area — availability is confirmed when an agency accepts."
   (Distance to hubs is client-computable from `COVERAGE_ZONES`.)

### 2.2 Part 1 — dispatch routing (server) — assigned providers, no radius

**Founder, 2026-09-03 (verbatim, the product decision):**

> The system should not limit service providers to a fixed 50 km radius, whether the booking
> is on-demand or scheduled. Bravo's operating model is not based on onboarding multiple
> service providers within every small geographic area. We intend to appoint a primary
> service provider for each province or operational region, with a secondary provider
> available as backup. The decision on whether a pickup location is too far away should be
> made by the service provider receiving the request, not automatically by Bravo based on
> distance. […] Bravo should route according to assigned province/region and provider
> priority, not a 50 km GPS restriction. The service provider decides whether the distance
> is operationally feasible.

So the Uber-style "nearest on-duty agency within 50 km" ranker is replaced by a **priority
cascade over an assignment table**. What stays is everything that is not about distance:
compliance eligibility, capacity, cooldown, the one-live-offer invariants, the offer/escrow
state machine, and the sweeps.

#### 2.2.1 Data model (two ops-managed tables, two stamped columns)

```
operational_areas
  id uuid PK · region_code FK regions(code) · code text (e.g. ZA-WC) · name text
  min_lat/max_lat/min_lng/max_lng numeric   -- same bbox shape + constraints as `regions`
  active bool · created_at/updated_at

area_provider_assignments
  area_id FK operational_areas · provider_user_id FK agents(user_id) (type='company')
  priority smallint CHECK (priority BETWEEN 1 AND 5)   -- 1 = primary, 2 = secondary, …
  active bool · assigned_by uuid · assigned_at
  UNIQUE (area_id, priority) WHERE active · UNIQUE (area_id, provider_user_id)

lite_bookings.area_id uuid NULL        -- stamped at create: areaFromPoint(pickup) within the
                                       -- booking's region; NULL = no area drawn yet
dispatch_offers.source text            -- 'assigned:1' | 'assigned:2' | … | 'regional_fallback'
```

- **Areas sit under regions, not beside them.** `regions` stays country-level because pricing,
  currency and licence/insurance eligibility (`is_eligible_for_dispatch(agency, region, …)`)
  are per country. An area is a routing partition inside a region; an area may equal its
  whole region (the UAE at launch).
- Both tables are ops rows (RLS deny-by-default catch-up like every other new table; ops
  console CRUD). No new region code, no pricing change.
- `areaFromPoint` mirrors `regionFromPoint`: first active area in the booking's region whose
  box contains the pickup; otherwise the region's **default area** (one per region, box =
  the region box) so an un-partitioned region still routes.

#### 2.2.2 Routing — `nextCandidate(booking)` replaces `RANKING_SQL`

Order of candidates for a booking in area A of region R:

1. `area_provider_assignments` for A, `active`, by `priority` ascending;
2. **regional fallback** (founder Q1): every other eligible company agent in R, ordered by
   distance to the pickup **with no radius** — so an unassigned or unlucky area still finds
   someone rather than dying at NO_PROVIDER;
3. exhausted → `NO_PROVIDER` (unchanged, refund unchanged).

Every candidate, assigned or fallback, must still pass the **non-distance** predicates the
ranker enforces today — these are compliance and correctness, not reach:

| Predicate (today)                                                   | Keep?         | Note                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a.status = 'ACTIVE'`, `a.type = 'company'`                         | yes           |                                                                                                                                                                                                                                       |
| `is_eligible_for_dispatch(agency, region, requirements)`            | yes           | licence + insurance for the region, armed authorisation — the founder did not ask to drop compliance                                                                                                                                  |
| `has_free_cpo_capacity(agency, cpo_count)`                          | yes           |                                                                                                                                                                                                                                       |
| `cooldown_until`                                                    | yes           |                                                                                                                                                                                                                                       |
| not already offered THIS booking (REJECTED / EXPIRED / SUPERSEDED)  | yes           | the cascade must move forward                                                                                                                                                                                                         |
| `ST_DWithin(…, DISPATCH_RADIUS_M)`                                  | **no**        | the decision itself                                                                                                                                                                                                                   |
| `a.on_duty = TRUE`                                                  | mode          | on-demand: honour (a self-declared "not taking work now"); scheduled: ignore — the offer reaches the agency's dispatcher who has hours to answer (founder Q4)                                                                         |
| `last_location_at > NOW() − 5 min` (freshness)                      | **no**        | it existed to make a proximity rank trustworthy; distance is no longer a ranking input                                                                                                                                                |
| `mockedLocationClause` (anti-fraud)                                 | move          | it protected the proximity rank from GPS spoofing. Routing no longer reads GPS, so it leaves the router; it STAYS on CPO telemetry / arrival verification, where it still matters                                                     |
| `one_live_per_provider` (a provider holds one live offer at a time) | mode          | on-demand: a busy primary is skipped to the secondary (client is waiting); scheduled: the primary is **retried** on the next sweep for up to `DISPATCH_ASSIGNED_WAIT_MINUTES` (default 10) before the secondary is tried (founder Q4) |
| ORDER BY distance band, rating, distance                            | fallback only | assignments are ordered by priority; the fallback keeps today's rank order minus the radius                                                                                                                                           |

Distance is still **computed** (`distance_km` on the offer row, from the provider's last
known position — however stale) and **shown**, never a gate. `distance_bucket` for the coarse
pre-accept card widens from `<2 / 2-5 / 5-10 / >10 km` to
`<5 / 5-20 / 20-50 / 50-100 / 100-200 / >200 km` — "100 km from Cape Town" has to be
legible on the card, and a rounded band still withholds the exact pickup (LB1).

#### 2.2.3 Time to decide — offer TTL by mode

Today: `DISPATCH_OFFER_TTL_SECONDS = 30`, one value. A provider asked to judge a 100 km
deployment cannot do that in 30 seconds, and a scheduled job does not need them to.

| Mode    | TTL env (default)                                    | Reminder                          |
| ------- | ---------------------------------------------------- | --------------------------------- |
| `now`   | `DISPATCH_OFFER_TTL_SECONDS` 30 → **120** (Q2)       | none (a client is waiting)        |
| `later` | `DISPATCH_OFFER_TTL_SCHEDULED_SECONDS` **1800** (Q2) | push at half-time to the provider |

The offer-expiry sweep (8 s cadence, `EXPIRY_GRACE_SECONDS`) already expires any TTL; only
the value bound at insert changes. `MAX_OFFERS = 8` and `MAX_OFFER_ATTEMPTS = 32` stay.

#### 2.2.4 When a scheduled booking is dispatched

Today the scheduled sweep starts searching **15 minutes before pickup**
(`DISPATCH_SCHEDULED_LEAD_MINUTES = 15`). That is an Uber assumption: a nearby car. Under the
assigned model a primary needs to plan a deployment, possibly 100 km away, and a secondary
may need its own window after a decline. **Proposal (Q3): dispatch a scheduled booking at
ops approval** (or immediately for an auto booking) with the long TTL, and shorten the TTL
automatically when the pickup is inside `2 × TTL`. Escrow is still charged at accept, so an
early accept simply holds the client's credits earlier — the same money model, just sooner.
The T-15 sweep stays as the backstop for anything still un-dispatched.

#### 2.2.5 When the primary accepted and then cannot fulfil

Today: accepted-but-never-crewed → `crew-sla` flips **AGENCY_NO_SHOW** and refunds; an arrival
no-show or agency withdraw **relists** the booking to the open-jobs portal (not the cascade).
With a secondary on record, both paths get a better first move: if `pickup_time − now` is
above `DISPATCH_REROUTE_MIN_MINUTES` (default 120), **SUPERSEDE** the failed offer and
**re-offer to the next assignment** (the secondary) before refunding or relisting; below the
threshold, today's behaviour (refund / portal) stands. Founder Q5.

#### 2.2.6 Ops console — where assignments are made

`apps/ops-console/src/app/dispatch/page.tsx` gains an **Areas & providers** panel: create an
area (name + box), assign priority 1..n from the region's ACTIVE company agents, see every
area with **no active assignment** flagged (they route on fallback only). The page's own
hardcoded `REGIONS` list is missing ZA — fold it into the live regions fetch while there
(logged as B-788d).

#### 2.2.7 Agency app

`IncomingOfferScreen`: the real distance band and a **"Primary provider · Western Cape"** (or
"Secondary" / "Regional offer") badge so the agency knows why it is seeing the job; the
scheduled countdown reads as minutes, not seconds; decline reasons gain `too_far`, which
the ops console surfaces per area so a mis-drawn area is visible.

#### 2.2.8 Rollout — dark, per region

`DISPATCH_ROUTING_MODE = nearest | assigned` (env, default `nearest`), read the way the
other dispatch flags are, refused-at-boot rules unchanged. Migration + ops UI ship first;
ops draws ZA's areas (Western Cape, Gauteng, … Q6) and assigns providers; the flag flips
per region (`regions.routing_mode` column, ops-editable) once every launched area has a
primary. AE launches as one area equal to the region.

### 2.3 Part 2 — booking another country for tomorrow (client + one server field)

**Decision: the ZONE is the authority.** GPS may suggest a default; it never overrides a
choice.

1. **No GPS yank when the zone ≠ the GPS country.** `LocationPickerScreen` learns the device
   country (it already reverse-geocodes on `moveend`; the zone screen already has `myCountry`).
   If `countryCode !== deviceCountry`, `fetchPosition()` on ready is skipped and the map opens
   at the zone's principal hub (first ring) with a one-line note "Booking in South Africa".
   The "locate me" button still works when tapped.
2. **Search scoped to the ZONE, not the pin.** The suggest request sends
   `country=<zone country>` and `proximity=<zone hub or current pin if inside the zone>`.
   If a zone-scoped search returns **zero** results, retry once **without** `country` and label
   each result with its country so a mis-typed zone is visible rather than silent.
3. **Zone chip in the picker header** — "Booking in: South Africa ▾" → `navigateOnce` to
   `ZoneMap`. The user who searched "Cape Town" from Dubai never reached the zone step; put
   the door where they are.
4. **Timezone.** `regionsAvailability` ships `utc_offset_hours` (already in `public.regions`).
   The client stores it on the zone (`zone_utc_offset_hours` in the draft, seeded by
   `selectZone`). `computeStartTime` builds the instant from the picked wall-clock **in the
   zone's offset**; the label shows both: `Tue 04 Sep · 9:00 AM SAST (7:00 AM your time)` when
   they differ. Server lead gates are instant-based and need no change; `assertExecLeadTime`
   already takes `region`.
   - Sub-decision: the app has no tz database. A fixed offset (no DST) is what the server
     already models (`utc_offset_hours numeric`), so mirror it; ZA/AE/BD/SA have no DST, GB
     does — note it as a known limit and keep GB `launched: false` until a tz lib is added.
5. **Everywhere a booking is shown, show its zone** when it differs from the device country:
   the history row (`region_label` is already on the wire, `bookingHistoryRows` can prefix the
   route with the flag), the active card, TripSummary's ORDER block.
6. **Coming-Soon countries:** unchanged — selectable = launched. P2: a "Notify me when Bravo
   covers <country>" capture on the Coming Soon row (a `coverage_requests` table, one row per
   user+country), so the founder learns where demand is.

### 2.4 Not changing (and why)

- The `unsupported_region` gate. Removing it lets a booking exist that no agency can be
  matched to (the ranker hard-matches `region_code`).
- The anti-fraud mocked-location check on CPO telemetry and arrival verification. It leaves
  the router (routing no longer reads GPS) but not the product.
- The zone-change clears pickup/dropoff. A stale Dubai pin inside a South Africa booking is
  exactly the bug this plan fixes from the other side.

---

## 3. Delivery plan

### P0 — client (one session): the map stops lying

| #   | Change                                                                                                                                | Files                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 0.1 | `isInsideZone` on the country box; `checkCoverage.inCoverage` → `nearHub`; CONFIRM gates on the box; new banner copy; `hasZones` gone | `coverageZones.ts`, `LocationPickerScreen.tsx`, `src/utils/regions.ts` (reuse `REGION_BBOX`) |
| 0.2 | No GPS yank when zone ≠ device country; open at the zone hub; "Booking in …" note                                                     | `LocationPickerScreen.tsx`                                                                   |
| 0.3 | Search scoped to the zone; zero-result global retry with country labels                                                               | `LocationPickerScreen.tsx`                                                                   |
| 0.4 | Zone chip in the picker header → `ZoneMap`                                                                                            | `LocationPickerScreen.tsx`, `navigation/types.ts` (route params)                             |
| 0.5 | Rings become hints (legend, opacity)                                                                                                  | `bravoLocationPickerMapHtml.ts`                                                              |
| 0.6 | Expectation copy on review when far from every hub                                                                                    | `CustomizeAddOnsScreen.tsx`, `ExecReviewScreen.tsx`                                          |

P0 ships behind nothing: the server already accepts what the box allows.

### P1 — server + client: honest reach and the right clock

| #    | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Files                                                                                                                                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1  | `pickup_outside_region` on create **and** estimate, incl. executive legs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `booking.service.ts`, `pricing.service.ts` (parity)                                                                                                                                                                                   |
| 1.2  | **Dispatch v2 — assigned providers per area** (§2.2): migration (`operational_areas`, `area_provider_assignments`, `lite_bookings.area_id`, `dispatch_offers.source`, RLS catch-up), `areaFromPoint` stamped at create, `nextCandidate` replacing `RANKING_SQL` (assignments → regional fallback, no radius, mode-aware `on_duty` / busy-primary wait), mode-aware TTLs, dispatch-at-approval for scheduled, re-route to the next assignment on crew-SLA / arrival no-show / withdraw when time allows, `DISPATCH_ROUTING_MODE` + `regions.routing_mode` | `dispatch.service.ts`, `scheduled-dispatch.service.ts`, `crew-sla.service.ts`, `arrival-noshow.service.ts`, `relist-timeout.service.ts`, `booking.service.ts` (`area_id` stamp), new migration, `.env.example`, `main.ts` flags guard |
| 1.2b | Ops console **Areas & providers** panel + live regions on the dispatch page                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `apps/ops-console/src/app/dispatch/**`, `apps/auth-service/src/ops/*` (area/assignment CRUD endpoints)                                                                                                                                |
| 1.2c | Agency app: real distance band, assignment badge, minute-scale countdown, `too_far` decline reason                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `src/screens/agent/IncomingOfferScreen.tsx`, `api.ts` `CoarseOffer`                                                                                                                                                                   |
| 1.3  | `regionsAvailability` ships `utc_offset_hours`; draft carries `zone_utc_offset_hours`; zone-clock start_time + dual label                                                                                                                                                                                                                                                                                                                                                                                                                                | `booking.service.ts`, `api.ts`, `bookingStore.ts`, `CustomizeAddOnsScreen.tsx`, `BookingDateTimeScreen.tsx`, exec schedule screens                                                                                                    |
| 1.4  | Zone shown on history row / active card / TripSummary when ≠ device country                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `bookingHistoryRows.ts`, `TripSummaryScreen.tsx`                                                                                                                                                                                      |

**Deploy order for P1:** migration → server (1.1, 1.2 dark, 1.3 wire field) → ops console →
ops seeds areas + assignments → flip `routing_mode` per region → app. 1.1 is a new rejection;
ship the client box gate (P0) **first** so no current build can trip it. The routing flip is
the one step that changes who gets offers: do it region by region with the dispatch
inspector open.

### P2

Per-region `scheduled_radius_m` in ops; "Notify me" coverage capture; a real tz library for
DST regions before GB launches.

---

## 4. Pins (bug-regression contract — RED first, mutation-proved)

| Pin (new)                                       | Guards                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Project        |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `coverageGate.test.ts`                          | a Western Cape point (−33.0, 22.0) is `isInsideZone('ZA')` = true and `nearHub` = false — RED under the ring gate; a Namibia point is false for ZA; the nearest-hub label still names Cape Town with its km                                                                                                                                                                                                                                                                                                                                                                        | `booking`      |
| `locationPickerZoneAuthority.test.ts`           | source scan: CONFIRM `disabled` never references `inCoverage`/`nearHub`; `fetchPosition` on ready is guarded by the zone/device-country comparison; the suggest URL's `country=` is built from the ZONE, not `pinCountry`; a zero-result retry exists                                                                                                                                                                                                                                                                                                                              | `booking`      |
| `startTimeZoneClock.test.ts`                    | "09:00" in a zone at UTC+2 from a device at UTC+4 yields 07:00Z; the dual label appears only when offsets differ; no offset ⇒ device clock (today's behaviour)                                                                                                                                                                                                                                                                                                                                                                                                                     | `booking`      |
| `dispatch.assigned-routing.spec.ts` (service)   | primary offered first regardless of distance (a 100 km primary beats a 2 km unassigned agency); decline → secondary; both decline → regional fallback ordered by distance with NO `ST_DWithin`; exhausted → NO_PROVIDER; compliance (`is_eligible_for_dispatch`), capacity, cooldown and the already-offered exclusion still applied to an assigned provider; `mockedLocationClause` absent from the router; on-demand honours `on_duty`, scheduled does not; a busy primary is skipped on-demand and retried for the wait window when scheduled; `dispatch_offers.source` stamped | `auth-service` |
| `dispatch.ttl-by-mode.spec.ts` (service)        | `now` binds the on-demand TTL, `later` the scheduled TTL; the half-time reminder fires once; the expiry sweep expires a long TTL exactly like a short one                                                                                                                                                                                                                                                                                                                                                                                                                          | `auth-service` |
| `dispatch.reroute-on-failure.spec.ts` (service) | crew-SLA / arrival no-show / withdraw with time to spare SUPERSEDEs and re-offers to the next assignment; without time, today's refund / relist path runs unchanged                                                                                                                                                                                                                                                                                                                                                                                                                | `auth-service` |
| `areaFromPoint.spec.ts` (service)               | a Langebaan point resolves to ZA-WC; a point in no drawn area resolves to the region's default area; a point outside the region is null                                                                                                                                                                                                                                                                                                                                                                                                                                            | `auth-service` |
| `routingMode.spec.ts` (service)                 | `nearest` keeps today's ranker byte-for-byte; `assigned` uses the cascade; per-region override wins over the env                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `auth-service` |
| `booking.pickup-outside-region.spec.ts`         | zone ZA + Namibia pin → 400 `pickup_outside_region` with no INSERT; estimate and create agree; an executive transport leg outside the box is refused                                                                                                                                                                                                                                                                                                                                                                                                                               | `auth-service` |
| `regionsAvailability` spec (extend)             | `utc_offset_hours` present per region                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `auth-service` |

Existing dispatch specs to re-anchor (the ranker's shape is asserted in several):
`dispatch.service.spec.ts`, `scheduled-dispatch.service.spec.ts`, `offer-expiry.service.spec.ts`,
`crew-sla.service.spec.ts`, `arrival-noshow.service.spec.ts`, `relist-timeout.service.spec.ts`,
`dispatch-inspector.service.spec.ts`, `ops-approved-dispatch.service.spec.ts`,
`dispatch-admin.spec.ts`. Under `routing_mode = nearest` every one of them must still pass
unchanged — that is the proof the dark rollout is actually dark.

Existing client pins to **re-anchor, not delete**: `zoneCountries.test.ts` /
`zoneMapCountryLabels.test.ts` (unchanged intent), `bookingStore.zoneChange.test.ts` (keep as
is — the clear is correct), `execProtectionDashboard.test.ts` and
`secureTransferDashboard.test.ts` (they assert the `LocationPicker` navigate params — the new
zone chip adds a param), `mapWebViewSource.test.ts` (legend copy), `booking.region.spec.ts`
(unchanged — the region gate stays).

Gates: typecheck baseline · booking · app · auth-service · then `LITE_BOOKING_LOOP.md` §7 for
the client lane. Both Lite and Executive pickers on device.

---

## 5. Device pass (owed before either bug closes)

| Scenario                                                                                           | Device / account                            | Expect                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In Cape Town, zone ZA, drop the pin 99 km out (Worcester / Hermanus)                               | Redmi, ZA test account                      | Banner "In South Africa · nearest hub Cape Town, 99 km"; CONFIRM enabled; booking created as ZA                                                                                       |
| Same pin (Langebaan, ~100 km), `booking_mode = later`, Cape Town agency assigned primary for ZA-WC | + staging agency, `routing_mode = assigned` | The Cape Town agency receives the offer with "~100 km · Primary · Western Cape"; decline → the secondary receives it; both decline → regional fallback → NO_PROVIDER only when nobody |
| Same, on-demand                                                                                    |                                             | Same cascade; the primary's `on_duty = false` skips it; the 120 s countdown                                                                                                           |
| Primary accepts, assigns no crew, pickup is 6 h away                                               |                                             | Re-offered to the secondary, not refunded (P1 §2.2.5)                                                                                                                                 |
| In Dubai (GPS AE), zone South Africa, open the picker                                              | BlueStacks with a Dubai mock fix            | Map opens over Johannesburg, NOT yanked to Dubai; "Booking in South Africa" note                                                                                                      |
| Same, search "Cape Town"                                                                           |                                             | Cape Town results, ZA-scoped; picking one lands the pin in ZA; CONFIRM enabled                                                                                                        |
| Same, schedule tomorrow 09:00                                                                      |                                             | Label "9:00 AM SAST (11:00 AM your time)"; `start_time` = 07:00Z; server accepts; row shows the ZA flag                                                                               |
| Zone ZA, pin dragged into Namibia                                                                  |                                             | CTA `OUTSIDE ZONE`; if forced via API → 400 `pickup_outside_region` (P1)                                                                                                              |
| Zone Kenya (Coming Soon)                                                                           |                                             | Not selectable; unchanged                                                                                                                                                             |

---

## 6. Decisions for the founder (P0 does not block on these)

| #   | Question                                                                                                                                                        | Default if unanswered                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Q1  | When BOTH assigned providers decline (or an area has none): offer to any eligible agency in the region, nearest first with no radius — or stop at NO_PROVIDER?  | Regional fallback, no radius                       |
| Q2  | Offer time-to-decide: on-demand 30 s → **120 s**? Scheduled **30 min** with a half-time reminder?                                                               | 120 s / 30 min, both env-tunable                   |
| Q3  | Dispatch a scheduled booking **at ops approval** (provider plans days ahead) rather than 15 minutes before pickup as today?                                     | At approval; T-15 stays as the backstop            |
| Q4  | An assigned provider that is **off duty** or **holding another live offer**: skip to the secondary at once (on-demand), wait up to 10 min for them (scheduled)? | As stated                                          |
| Q5  | Primary accepted then failed to crew / no-show / withdrew, with hours to spare: **re-offer to the secondary** before refunding or relisting?                    | Yes, when > 2 h to pickup                          |
| Q6  | Launch areas: South Africa = Western Cape, Gauteng, KwaZulu-Natal, … (one primary + one secondary each)? UAE = a single area equal to the region?               | ZA three provinces, AE one area; ops adds the rest |
| Q7  | Keep the rings drawn on the client map as "Bravo hubs" hints, or remove them?                                                                                   | Keep as hints                                      |
| Q8  | Capture demand on Coming-Soon countries ("Notify me")?                                                                                                          | Yes, P2                                            |

---

## 7. Do-not-re-propose

- Do not drop the region match or the `is_eligible_for_dispatch` gate to "remove restrictions"
  — licence / insurance / armed eligibility are per-region compliance, not distance. The
  founder removed the RADIUS, not the law. `DISPATCH_DISABLE_REGION_FILTER` stays staging-only.
- Do not implement the decision as a bigger radius (300 km, region-wide). The founder's model
  is a priority list per area with the provider deciding; a radius of any size still lets
  Bravo pre-empt that decision, and a Cape Town primary would still lose a Langebaan job to a
  closer unassigned agency.
- Do not make provinces into `regions` rows. Pricing, currency and licences are per country;
  an area is a routing partition under a region.
- Do not gate CONFIRM on the ring again "for now". The ring is a response-time hint; the box is
  the contract.
- Do not build a tz database into the app for this. Fixed offsets match what the server
  models; DST regions are not launched.
- Do not let the picker's reverse-geocoded `pinCountry` drive anything but the address label.
