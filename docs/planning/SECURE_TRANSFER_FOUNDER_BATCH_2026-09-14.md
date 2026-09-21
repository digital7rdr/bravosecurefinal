# Secure Transfer founder batch — 2026-09-14 (B-873 … B-877)

Founder screenshots of the Lite **Secure Transfer** wizard (`CustomizeAddOnsScreen`),
five asks. Four are built here; the fifth is a money-model question and is
DOCUMENTED for the founder's decision (§6). Process per the standing rule: Fable
specs + reviews, Opus makers code, an Opus agent does git.

Baseline: `main` @ `a3686217` (1.0.314), tree clean, local == `origin/main`.

| #     | Ask (founder's words)                                                                                                                                                                                                                     | Packet   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| B-873 | _"change this name to 'ESCM' - Electronic Surveillance Counter Measures"_ (the `comms` add-on, today "Comms / SIGINT · Encrypted comms specialist")                                                                                       | A + B    |
| B-874 | _"the bottom message doesn't make sense. Rather remove the bottom message. Also, no need to indicate anything about dispatching immediately or 3 hours etc. The app must simply not allow you to select a time less than 3 hours ahead."_ | A        |
| B-875 | _"Why did you add 3 additional hours? Maybe it could take longer. Rather just say that any requests beyond baseline is sent to control system for review."_                                                                               | A        |
| B-876 | _"The limit is still here."_ (TEAM COMPOSITION: CPO **+** dead at 4; the Vehicles **+** is drawn live at 4 but silently no-ops — the B-590 "rendered button that no-ops" class)                                                           | A + B    |
| B-877 | _"What is this for? I've selected a pick up and drop off that is 10 min away. This card is not relative."_ (SERVICE DURATION hours stepper on a point-to-point transfer)                                                                  | DOCUMENT |

---

## 1. Facts the makers must not re-derive (verified 2026-09-14, re-grep before trusting a line)

- **The add-on label lives in FOUR places.** Client compiled fallback `ADDONS[]`
  (`CustomizeAddOnsScreen.tsx`, title + desc), client summary fallback
  `LITE_ADDON_LABELS` (`bookingSummaryRows.ts`), ops-console `BookingDetail.tsx`
  label map (~line 1676), and the LIVE ops-editable row `lite_booking_add_ons`
  (`id='comms'`, seeded in `20260423113000_booking_module.sql:105`) which
  `/bookings/add-ons` serves and `BookingConfirmationScreen` renders via
  `addOnLabels`. The wizard takes only the PRICE from the live row and keeps the
  compiled title, so the client file AND a migration are both required.
  The EXECUTIVE catalogue (`pricing.service.ts` `EXEC_ADDON_DEFS`, `comms` =
  "Secure Communications Support") is a different product's copy — **leave it**.
  `Route Recon / SIGINT` in the agent wizard is a CPO skill, not this add-on — leave it.
- **Lead-time model today (B-861).** One MISSION START field. Picker floor =
  `transferLeadHoursFor('now', autoDispatch)` = ops board `transfer_min_lead_hours`
  (0.25 h) on auto-dispatch accounts, 3 h on legacy. `booking_mode` is DERIVED:
  `start − now < MIN_LEAD_HOURS` → `'now'` (server lead-exempt, immediate dispatch
  on approval), else `'later'` (sweep at T-15, T-60 reminder, `lateCancelHours`
  policy). Server gate `booking.service.ts:610-615`: `!isOnDemandAuto && pickup <
now + 3 h` → 400. Every booking, both lanes, lands `PENDING_OPS` and waits for
  ops approval (`booking.service.ts:1083-1091`); `'later'` is then dispatched by
  `scheduled-dispatch.service.ts` inside `LEAD_WINDOW_MINUTES` (15).
  **Consequence of B-874:** with a 3 h floor enforced at pick, at every 30 s tick
  and at submit, every Secure Transfer files `'later'` by construction. The
  on-demand lane becomes unreachable from the wizard. **No server change** — the
  server keeps accepting `'now'` from other callers; nothing is removed there.
- **`roundUpToMinuteStep` carries seconds (B-861 P2-1)**, so `earliestStart()` is
  never a hair under the server gate. Keep using it; never a local `setMinutes`.
- **The date dialog already floors** (`minimumDate: earliest`). The time field is
  the PLATFORM clock (`TimeDropdownField`, B-646 r3) which has no minimum on
  Android, so a sub-floor time pick is caught by `commitStart`'s snap-UP. That
  stays; only its COPY changes (§3). "Must simply not allow" = floor the dialog +
  auto-correct the clock pick, never a silent different time (E2E-10).
- **Team cap today.** Client `pricing.ts` `MAX_CPOS = 4`; `setCount` ceilings
  `cpo_count` at `maxCpos` and `vehicle_count` at a literal `4` with NO
  `plusDisabled` on the vehicle cell. Server: DTO `@Max(4)` on `cpo_count` AND
  `vehicle_count` in BOTH `CreateBookingDto` and the estimate DTO
  (`create-booking.dto.ts:90-95, 153-158`), `MAX_CPOS = 4` clamp in
  `booking.service.ts:53/757/1870` (exec rejects `exec_cpo_cap`, Lite clamps —
  unreachable once the DTO bounds), and `AssignCrewDto @ArrayMaxSize(4)`
  (`org/dto/org.dto.ts:32-35`) — a team above 4 could never be CREWED by the
  agency. Exec screens (`ExecTeamScreen`, `ExecReviewScreen`) read `MAX_CPOS` and
  clamp the stored draft to it; they inherit the new ceiling unchanged.
- **Pins that WILL go red** (re-point, never delete; each new assertion must be
  mutation-proved RED by reverting the fix): `bookNowLeadTime.test.ts` (the
  E2E-10 rule block ~55-118 and the wiring block ~120-220, the `Earliest start
is` copy ~335), `zoneFollowsPickup.test.ts:298-315`,
  `secureServicesGapClosure.test.ts:183,218`, `secureTransferDashboard.test.ts:235`
  (slice END anchor is `'onDemandLaneOpen &&'` — an absent anchor makes
  `indexOf` −1 and the slice VACUOUS, so re-anchor on a line that survives, e.g.
  `{leadHint &&`), `customizeAddOnsZoneHeal.test.tsx:245` (`getByText('On
demand')`), `pricing.test.ts:76` (`MAX_CPOS toBe(4)`),
  `bookingSummaryRows.test.ts:171` (label), server
  `create-booking.dto.spec.ts` ("above the max of 4"),
  `booking.executive-validation.spec.ts:152-158, 197-213` (`cpo_count: 5` →
  `exec_cpo_cap`).
- Source-scan trap list applies (CLAUDE.md): strip comments before an absence
  assertion; these files are CRLF; anchor on the shape the code uses.

---

## 2. Packet A — client (Opus maker A) — files

`src/screens/booking/CustomizeAddOnsScreen.tsx`, `src/screens/booking/scheduleGate.ts`,
`src/screens/booking/pricing.ts`, `src/screens/booking/bookingSummaryRows.ts`,
tests under `src/screens/booking/__tests__/**` and
`src/modules/booking/__tests__/customizeAddOnsZoneHeal.test.tsx`,
`docs/planning/SECURE_TRANSFER_ZONE_SCHEDULE_PLAN_2026-09-11.md` (a 3-line
"superseded" note only). Nothing else. Do NOT touch `apps/**`, `supabase/**`,
`src/navigation/**`, `src/store/**`.

### B-873 (client half)

- `ADDONS[]` `comms` → `title: 'ESCM'`, `desc: 'Electronic Surveillance Counter Measures'`. Icon unchanged (not asked).
- `LITE_ADDON_LABELS.comms` → `'ESCM'`. Flip `bookingSummaryRows.test.ts:171`.

### B-874 — MISSION START: 3 h floor for everyone, no lane copy

1. `scheduleGate.ts`: DELETE `TRANSFER_MIN_LEAD_HOURS`, `transferMinLeadHours`,
   `transferLeadHoursFor`, `leadHoursLabel` — after this packet they have no
   production caller and they encode the rule the founder reversed (a dead
   15-minute floor is a trap for the next maker). Keep `MIN_LEAD_HOURS`,
   `deriveBookingMode`, `bookingModeLabel` (summary row), `startNeedsReseed`, the
   exec helpers, `canAdvanceSchedule`, `bookingTypeFor`. Update the `MIN_LEAD_HOURS`
   docblock: it is now the Secure Transfer picker floor as well as the mode
   boundary (founder 2026-09-14, B-874).
2. `CustomizeAddOnsScreen.tsx`:
   - `earliestStart()` becomes parameterless:
     `roundUpToMinuteStep(new Date(Date.now() + MIN_LEAD_HOURS * 3600_000), 5)`.
     Rewrite its docblock (the E2E-10 "leadHours is a PARAMETER, never 3" rule is
     reversed by the founder; say so with the date).
   - Delete `leadHours`, `onDemandLaneOpen`, `derivedMode` (its only reader was
     the pill), the `seededForAuto` re-seed effect and `startTouchedRef` (the only
     thing that read it) — the floor no longer depends on `auto_dispatch_enabled`.
     `autoDispatch` STAYS (consent gate).
   - `earliest`, the `startPick` seed, `computeStartTime`, `commitStart` and the
     zone-change re-seed effect all floor at `MIN_LEAD_HOURS` (write
     `MIN_LEAD_HOURS * 3600_000` / `earliestStart()` directly; no `lead` local).
   - Delete the pill block `{onDemandLaneOpen && (<View style={s.modeRow}> … )}`
     and the styles `modeRow`, `modePill`, `modePillNow`, `modePillText`,
     `modePillTextNow`, `modeHelp`.
   - `commitStart` hint copy → `` `Moved to the earliest available start · ${date} · ${time}.` ``
     (same date/time formatting as today). No "hours", no "from now".
   - The `useEffect` that writes `start_time` + `mode` on `nowTick`, and the
     submit re-derive, STAY as they are (they are what keeps the filed start ≥ the
     floor while the screen sits open). Add one `// Why:` line at the submit
     re-derive: every start is ≥ now + MIN_LEAD_HOURS by construction, so this
     files `'later'`; kept as the shared vocabulary, not as a lane chooser.
   - Imports: drop `transferLeadHoursFor`, `bookingModeLabel`, `leadHoursLabel`.
   - Rendered-copy rule for the whole wizard after this packet: no string
     contains `3 hour`, `dispatch immediately`, `On demand`, `Scheduled`,
     `from now`, `minutes of pick-up`.
3. Plan doc note: under the title of
   `SECURE_TRANSFER_ZONE_SCHEDULE_PLAN_2026-09-11.md` add a 3-line
   "**Superseded 2026-09-14 (B-874):** the on-demand pill/helper (D2/A1) and the
   ops-board picker floor are gone; the Secure Transfer floor is `MIN_LEAD_HOURS`
   for every account. See `SECURE_TRANSFER_FOUNDER_BATCH_2026-09-14.md`." Do not
   edit the table rows.

### B-875 — approval notice copy

`needsOpsApproval` condition unchanged; the amber card unchanged. Text becomes:
`Requests beyond the baseline (1 CPO + 1 Vehicle) are sent to the ` +
`<Text style={s.alertBold}>Bravo Control System</Text>` + ` for review.`
(This is TRUE: every booking lands `PENDING_OPS` — the card just says so for the
ones the founder wants called out.)

### B-876 (client half) — one sanity ceiling, never a dead button

- `pricing.ts`: `MAX_CPOS = 50`; add `export const MAX_VEHICLES = 50`. Docblock:
  a SANITY bound against garbage input, NOT a product limit — the founder's rule
  is "no boundary on booking" (B-864, restated 2026-09-14); any team beyond the
  baseline is reviewed by the Bravo Control System. Mirrors the server
  (`create-booking.dto.ts` `@Max`, `booking.service.ts` `MAX_CPOS`,
  `org.dto.ts` `AssignCrewDto`).
- `setCount`: `ceil = k === 'cpo_count' ? MAX_CPOS : MAX_VEHICLES` (the literal
  `4` goes). Vehicle `TeamCell` gets `plusDisabled={vehicle_count >= MAX_VEHICLES}`
  so the button can never be drawn live and do nothing.
- Pins: `pricing.test.ts:76` → `toBe(50)`; ADD a client↔server drift pin that
  reads `apps/auth-service/src/booking/booking.service.ts` and
  `apps/auth-service/src/booking/dto/create-booking.dto.ts` from disk and asserts
  the literal `50` at the decision sites (`const MAX_CPOS = 50`, `@Max(50)` ×4)
  and `org.dto.ts` `@ArrayMaxSize(50)` — comment-stripped, `\r?\n`-safe, and
  anchored so an absent file FAILS rather than passes. Maker B lands the server
  side; if it is not there yet when you run, the pin is expected RED until both
  packets are in — say so in your report, do not weaken it.

### Packet A gates (run all; report counts and the exact failures, never "green")

```bash
npx jest --selectProjects booking
npx jest --selectProjects app --testPathPattern "screens/booking|modules/booking|useKeyboardLayout|keyboardContract|bottomInsetContract"
npm run typecheck      # must stay ≤ 47 (.tsc-baseline.json)
npx eslint <every changed file>
```

Mutation proofs (each: revert the ONE line, run the pin, see RED, restore, VERIFY
the restore applied by printing the region — CLAUDE.md restore trap): (1) put the
pill block back; (2) put `transferLeadHoursFor` back as the floor in `commitStart`;
(3) restore the old "3-hour additional lead time" sentence; (4) `MAX_CPOS = 4`;
(5) drop the vehicle `plusDisabled`; (6) restore "Comms / SIGINT".

---

## 3. Packet B — server + ops-console + migration (Opus maker B) — files

`apps/auth-service/src/booking/booking.service.ts`,
`apps/auth-service/src/booking/dto/create-booking.dto.ts`,
`apps/auth-service/src/org/dto/org.dto.ts`, their specs,
`apps/ops-console/src/features/bookings/BookingDetail.tsx`,
`supabase/migrations/20260914100000_escm_addon_label.sql` (new). Nothing under `src/**`.

### B-873 (server/console half)

- Migration (idempotent, plain UPDATE, no schema change):
  ```sql
  -- B-873 (founder 2026-09-14): the Lite 'comms' add-on is ESCM.
  UPDATE lite_booking_add_ons
     SET label = 'ESCM', description = 'Electronic Surveillance Counter Measures'
   WHERE id = 'comms';
  ```
  NEVER put a backtick in a comment inside a JS template literal (n/a here — this
  is a .sql file; keep it .sql). `id` stays `comms` (wire id; never rename ids).
- `BookingDetail.tsx` label map `comms: 'ESCM'`. `cd apps/ops-console && npm run typecheck`.

### B-876 (server half)

- ONE literal. Export `TEAM_UNIT_MAX = 50` from `create-booking.dto.ts` (decorators
  need a compile-time value; a `const` import is fine) and use it in: `@Max(...)`
  on `cpo_count` and `vehicle_count` in BOTH DTOs; `booking.service.ts`
  `MAX_CPOS = TEAM_UNIT_MAX` (rewrite the B-864 docblock: sanity bound, not a
  product limit, founder 2026-09-14 "The limit is still here"); `org.dto.ts`
  `AssignCrewDto @ArrayMaxSize(TEAM_UNIT_MAX)` and fix its comment (it says
  "aligned to MAX_CPOS (4)"). Keep exec's reject-never-reprice at the new value.
- Sweep for other hard-coded 4s on the team path: `grep -rn "ArrayMaxSize(4)\|Max(4)\|> 4\|>= 4\|\.slice(0, 4)" apps/auth-service/src apps/ops-console/src` — list every hit in your report with a verdict (team path or not).
- Specs: `create-booking.dto.spec.ts` "above the max of 4" → 50 accepted, 51
  refused, for both fields; `booking.executive-validation.spec.ts` `cpo_count: 5`
  → 51 for `exec_cpo_cap`, and ADD "5 CPOs are accepted and priced (5 × rate)" on
  the exec estimate and a Lite create with `cpo_count: 6` persisting 6 (not
  clamped). If an org/crew-assign spec pins 4, re-point it.

### Packet B gates

```bash
cd apps/auth-service && npm test -- booking create-booking org-mission dispatch   # then the full `npm test`
cd apps/auth-service && npm run build
cd apps/ops-console && npm run typecheck
```

The booking-flow specs have carried 3 pre-existing failures on some HEADs
(LITE_BOOKING_LOOP §3) — if you see red, `git stash` is BANNED for you (a maker
ran it once and lost work); instead run the same spec on a clean checkout via
`git worktree add <scratch> HEAD` and compare. Mutation proofs: `@Max(4)` back on
`cpo_count` → the new 5/6/50 cases go RED; `ArrayMaxSize(4)` back → its case RED.

---

## 4. Review (Fable) — what I will check on both diffs

- Caller-completeness for every deleted/renamed symbol (MESSAGE_LOOP §5 shape).
- No rendered string in the wizard mentions hours/dispatch/lanes (grep the JSX, not the comments).
- The filed `booking_mode` is `'later'` at pick, at the 30 s tick and at submit — traced, not assumed.
- The vehicle `+` can no longer be drawn live and no-op.
- Every re-pointed pin is still load-bearing (mutation RED evidence in the report).
- Exec side effects of the raised ceiling are named, not hidden.

## 5. Deploy order (HARD, migration → server → APK) and device pass

1. Apply the migration on staging (psql via SSH; Supabase MCP is down this session), verify the row.
2. `scripts/deploy-manual.sh` auth-service (watchdog snapshot refresh is load-bearing) + ops-console.
3. Version bump → 1.0.315, local APK, ADB install on every attached device, drive:
   ESCM row visible; MISSION START seeds at +3 h, picking an earlier time snaps up
   with the new hint, no pill; 2 CPOs → the new notice; CPO + and Vehicle + keep
   going past 4; Summary "Add-ons: ESCM". Firebase: HELD unless the founder says.

## 6. B-877 — SERVICE DURATION on a transfer (DOCUMENTED, founder decision)

What the card is: the number of hours the escrow charges — `rate × hours`
(`pricing.service.ts` `calculate`, `Math.max(1, durationHours)`), validated
against the ops board (`hourly_default/min/max_hours` = 4 / 1 / 24, 2026-09-04
"never hard-code 4 h"). Settlement releases the BOOKED total; nothing bills
actual time, and no route/ETA estimate exists anywhere in the stack (dispatch only
ranks providers by straight-line `distance_km`). So a 10-minute transfer is
priced at whatever hours are chosen, default 4. Hiding the card without changing
the rule would charge 4 h silently, which is worse than showing it. Options for the
founder: (A) transfers priced from a server-side route estimate (Mapbox
Directions drive time + ops-editable buffer, rounded UP to the hour, min 1 h),
card replaced by "Estimated N h · M km" — recommended; (B) a flat per-transfer
minimum block (ops key `transfer_block_hours`, seeded 1), no stepper; (C) keep
the stepper, reword it as "time you need the team, pick-up to drop-off". Not built here.
