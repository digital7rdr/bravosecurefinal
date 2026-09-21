# B-877 — Secure Transfer is billed as a per-region block; the hours card goes (2026-09-14)

Founder, on the SERVICE DURATION card of a 10-minute transfer: _"What is this for? … This card
is not relative."_ Decision relayed 2026-09-14 13:16: _"Confirm we can set the 4 hours per
region" — "Yes"_. Read as: **a Secure Transfer is billed as a fixed block of hours that OPS set
per region (default 4); the client does not choose hours.** Hourly services (`type !== 'transfer'`)
keep the stepper untouched. Executive Protection keeps its 3-hour grid untouched.

Baseline: `main` @ `aa1fcfc2` (1.0.315). Process: Fable spec + review, Opus makers, Opus git agent.

## 1. Facts (verified; re-grep before trusting a line)

- The ops board is a per-region overlay already: compiled `DEFAULT_SERVICE_PRICING` → `'GLOBAL'`
  rows → the region's rows (`pricing.service.ts` `config(regionCode)` ~L398; PK `(key, region_code)`,
  migration `20260901130000`). Adding a key = (a) the column CHECK `service_pricing_key_check`
  must be REPLACED with the full list + the new key (dropped by lookup — copy the DO block from
  `20260904120000_mission_crewed_status.sql` L58-82), (b) a `GLOBAL` seed row, (c) a field on
  `ServicePricingConfig` + `DEFAULT_SERVICE_PRICING` (`pricing.service.ts` ~L101/L270), (d) a
  BOUNDS entry in `ops/ops-service-pricing.controller.ts` (~L66; `KEYS` derives from
  `DEFAULT_SERVICE_PRICING`, so the PATCH allow-list follows automatically), (e) the console
  board: `apps/ops-console/src/lib/pricingBoard.ts` group + label, and the pin
  `apps/ops-console/src/__tests__/pricingBoard.test.ts` `SERVER_KEYS`.
- The CLIENT mirror is generic: `servicePricingStore` copies every finite positive key the server
  emits into `priceValue(key, fallback)` (`servicePricingOverrides.ts`). No store change is needed
  for a new key; `durationRule.ts` is the pattern (fail-open, read at CALL time, integer-checked).
- Duration today: `resolveDurationOrThrow(service, dto.duration_hours, cfg)` at create (~L793) and
  estimate (~L1923) → `resolveDurationRule` (hourly keys 4/1/24; exec = fixed grid) →
  `resolveDurationHours` (absent → default; off-rule → 400 `invalid_duration`). The estimate reply
  already returns `duration_hours` and `duration_rule` (`api.ts` ~L1000). Stored `duration_hours`
  is read downstream (job-portal cards, hourly check-ins `1..duration_hours`, the mission sweep's
  contracted block `pickup_time + duration_hours`) — a stored block value keeps all of them valid.
- Client: `CustomizeAddOnsScreen.tsx` — `durationRule`/`durationHours` ~L316-317, estimate payload
  `duration_hours: durationHours` ~L353, `localTotalBc({durationHours…})` ~L388, the SERVICE
  DURATION card ~L1170-1196, the total line `ESTIMATED TOTAL · {durationHours}H` ~L1340;
  `isHourly = type !== 'transfer'` already exists (~L412). `bookingStore.seedDraft()` seeds
  `duration_hours: hourlyDurationRule().default` (~L296); the submit payload sends
  `draft.duration_hours` (~L498). `bookingSummaryRows.ts` L147 prints "Duration · N hrs est.".
- Compatibility: OLD apps always send `duration_hours` (their stepper, default 4). NEW server must
  therefore NOT refuse a transfer whose sent hours ≠ block — it uses the block and the client's
  total already came from the server estimate, so preview == charge holds. NEW app + OLD server:
  the app sends the block (4) which the old rule accepts. **Deploy order migration → server → APK
  is HARD** (the server reads the new key; a missing CHECK entry makes the ops PATCH fail).

## 2. Packet A — client (Opus maker A)

Files ONLY: `src/screens/booking/durationRule.ts`, `src/screens/booking/CustomizeAddOnsScreen.tsx`,
`src/store/bookingStore.ts`, `src/screens/booking/bookingSummaryRows.ts` (one label),
tests under `src/screens/booking/__tests__/**`, `src/store/__tests__/**` if such a file exists for
the store (create `bookingStoreTransferBlock.test.ts` there or under `src/screens/booking/__tests__`
if not). Do NOT touch `apps/**`, `supabase/**`, `src/navigation/**`.

1. `durationRule.ts`: add
   ```ts
   export const TRANSFER_BLOCK_HOURS = 4;
   /** B-877 — the hours a Secure Transfer is billed as, set by ops PER REGION. Read at call time; fail-open to 4; integer 1..24. */
   export function transferBlockHours(): number;
   ```
   same shape as `hourlyDurationRule()` (`intInRange(priceValue('transfer_block_hours', 4), 1, 24) ?? 4`).
2. `CustomizeAddOnsScreen.tsx`:
   - `const isTransfer = draft.type === 'transfer'` (reuse the existing `isHourly` selector — one
     source; do not add a second subscription for the same field).
   - `durationHours`: for a transfer = `serverBlock ?? transferBlockHours()` where `serverBlock` is
     the estimate reply's `duration_hours` (store it in state next to `serverTotal`, reset with it);
     for hourly services unchanged. The estimate payload sends `duration_hours: durationHours` in
     both cases (the server ignores it for transfers; an OLD server validates it — 4 is legal).
   - Render the SERVICE DURATION card ONLY when `!isTransfer` (`{!isTransfer && (<View …>)}`); the
     hourly branch is byte-identical. No replacement card. The `ESTIMATED TOTAL · {durationHours}H`
     line stays (it is the disclosure of the block).
   - One `useEffect`: when `isTransfer` and `draft.duration_hours !== durationHours`,
     `updateDraft({duration_hours: durationHours})` — so the submit payload and the Summary row carry
     the block the server will store. Dependency list explicit; no loop (guard on inequality).
   - Update the B-795 comment at the card to say what a transfer does instead (B-877, founder
     2026-09-14 "set the 4 hours per region").
3. `bookingStore.ts` `seedDraft()`: unchanged (the screen effect owns the transfer value; the seed
   is still the hourly default for hourly drafts). If `setService`/`bookingTypeFor` writes
   `type: 'transfer'` in the store, ALSO set `duration_hours: transferBlockHours()` there (grep the
   writer of `type:`), so a draft that never reaches the effect (e.g. resumed) still carries the block.
4. `bookingSummaryRows.ts` L147: transfer row label stays "Duration", value `${n} hrs block`
   instead of `hrs est.` when `b.type === 'transfer'` / service `secure_transfer` (check what the
   row object carries — `type` or `service`; use what exists). Flip its pin in `bookingSummaryRows.test.ts`.
5. Pins (each mutation-proved RED; restore verified by printing the region): `durationRule.test.ts`
   (+ `transferBlockHours` fail-open / live / malformed / call-time); a source-scan block in
   `secureTransferDashboard.test.ts`: the SERVICE DURATION card is inside `{!isTransfer && (` and
   `Billable time starts` is inside that same guarded slice (comment-stripped, `\r?\n`-safe, slice
   anchored on `SERVICE DURATION` with a length guard); the draft effect exists
   (`updateDraft({duration_hours: durationHours})` under an `isTransfer` guard); the
   `serverBlock ?? transferBlockHours()` selection. A render test is NOT required (the zone-heal
   render harness exists at `src/modules/booking/__tests__/customizeAddOnsZoneHeal.test.tsx` — if you
   can add a case there cheaply that asserts no "SERVICE DURATION" text for a transfer draft and the
   draft's `duration_hours` equals 4 after mount, do it; if the harness fights you, say so and stop).

Gates: `npx jest --selectProjects booking`; `npx jest --selectProjects app --testPathPattern
"screens/booking|modules/booking|store"`; `npm run typecheck` (≤ 46, report the number);
`npx eslint <changed files>`.

## 3. Packet B — server + migration + console (Opus maker B)

Files ONLY: `supabase/migrations/20260914130000_transfer_block_hours.sql` (NEW),
`apps/auth-service/src/booking/pricing.service.ts`, `apps/auth-service/src/booking/booking.service.ts`,
`apps/auth-service/src/ops/ops-service-pricing.controller.ts`, their specs
(`pricing.duration.spec.ts`, `booking.duration.spec.ts`, and whichever spec pins the ops BOUNDS/KEYS
— grep `hourly_default_hours` under `apps/auth-service/src/**/*.spec.ts`),
`apps/ops-console/src/lib/pricingBoard.ts`, `apps/ops-console/src/__tests__/pricingBoard.test.ts`.
Nothing under `src/**`.

1. Migration: replace `service_pricing_key_check` with the FULL current list (copy it from
   `20260904120000_mission_crewed_status.sql` L58-82, all 21 keys) plus `'transfer_block_hours'`;
   `INSERT … ('transfer_block_hours', 4, 'GLOBAL') ON CONFLICT (key, region_code) DO NOTHING;`.
   Header comment: B-877, founder decision, per-region, deploy order HARD. `.sql` only; no backticks
   inside SQL comments are needed — avoid them anyway.
2. `pricing.service.ts`: `transfer_block_hours: number` on `ServicePricingConfig` (docblock: hours a
   Secure Transfer is billed as, per region, the client has no duration control for transfers since
   1.0.316) and `transfer_block_hours: 4` in `DEFAULT_SERVICE_PRICING`. Add
   `export function resolveTransferBlockHours(cfg): number` — integer 1..`HOURLY_DURATION_HOURS_MAX`
   else the compiled 4 (same malformed-board discipline as `resolveDurationRule`). Make
   `resolveDurationRule('secure_transfer', cfg)` return `{default: block, min: block, max: block}`
   so the estimate's `duration_rule` tells an old app the range collapsed (an old stepper clamps to it).
3. `booking.service.ts` `resolveDurationOrThrow`: for `service === 'secure_transfer'` (also when
   `service` is absent/null — today that defaults to the transfer formula; confirm by reading
   `pricing.calculate`'s service switch and mirror its default) RETURN the block and IGNORE
   `requested` (never throw; a `// Why:` naming the old-app compatibility reason). Both create and
   estimate flow through it, so preview == charge; the estimate reply's `duration_hours` becomes the
   block. `pickup_time + duration_hours` consumers keep working on the stored block.
4. `ops-service-pricing.controller.ts` BOUNDS: `transfer_block_hours: {min: 1, max: 24}`.
5. Console `pricingBoard.ts`: add `'transfer_block_hours'` to the `transfer` group (NOT `duration`
   — that group's copy is about the hourly stepper) and the label
   `'Secure Transfer: billed block per transfer (hours) — set per region; the app has no hours control for transfers'`;
   append the key to `SERVER_KEYS` in `pricingBoard.test.ts`.
6. Specs (mutation-proved RED, restore printed): `pricing.duration.spec.ts` — `resolveTransferBlockHours`
   default 4 / board 5 / malformed → 4; `resolveDurationRule('secure_transfer')` collapses to the
   block. `booking.duration.spec.ts` — a `secure_transfer` create with `duration_hours: 8` is priced
   and STORED with the block (`capture.insertParams[19] === 4`, total = rate × 4), with a board
   `transfer_block_hours: 5` it stores 5, an absent value stores the block, and NO `invalid_duration`
   is thrown for any transfer value; an hourly service (`close_protection` or whatever non-transfer
   Lite service the spec already uses) still refuses 30. Estimate for a transfer returns
   `duration_hours === block`. The BOUNDS/KEYS spec gets the new key.

Gates: `cd apps/auth-service && npm test -- pricing.duration booking.duration ops-service-pricing`
then the FULL `npm test`, then `npm run build`; `cd apps/ops-console && npm test` if a test script
exists (it does not — then `npx jest` on `src/__tests__/pricingBoard.test.ts` with the console's
jest config if present; otherwise report exactly what you could run) and `npm run typecheck`.

## 4. Review, deploy, device (Fable)

Diff review both packets; caller-completeness for `resolveDurationRule('secure_transfer')` (every
caller listed); the old-app matrix in §1 traced, not assumed. Then: `db-migrate.sh --check/--apply`,
row read back, `VERIFY_SYMBOL=resolveTransferBlockHours deploy-manual.sh auth-service ops-console`,
watchdog snapshot by hand (the console verify always fails), `/ready`, `GET /bookings/service-pricing`
shows the key; ops board shows it under Secure Transfer. APK 1.0.316, Pie64: transfer wizard has NO
SERVICE DURATION card, total reads `· 4H`, Summary "4 hrs block"; hourly path unchanged (not
reachable from the Select Service screen today — say so). sqa B-877 flips DOCUMENTED → FIXED.
