# Ops Console — Operator Guide

> **Who this is for:** an operator on shift, not an engineer. It says where each
> thing lives, what each control actually does, and which actions cannot be
> undone. Engineering detail is in
> [`docs/audits/OPS_CONSOLE_IA_AUDIT_2026-09-03.md`](../audits/OPS_CONSOLE_IA_AUDIT_2026-09-03.md).
>
> Written 2026-09-03, when the console was re-grouped by business. Closes OC-18.

---

## 1. Words that used to mean two things

Read this once. Most confusion in the old console came from three of these.

| Term                     | What it is                                                                                          | What it is **not**                             |
| ------------------------ | --------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Lite**                 | A single booking: secure transfer, recon or extraction. Paid per job, held in escrow, dispatched.   | Not a plan. Not a subscription.                |
| **Executive Protection** | A fixed block of hours (3–24) of on-site protection. Priced per unit, hourly check-ins, no dropoff. | Not a transfer — there is nowhere to drive to. |
| **Secure Pro**           | A three-month protection **plan**. The client applies, you propose, they pay, you assign a CPO.     | Not "Messenger Pro". Not a single booking.     |
| **Messenger Pro**        | A messenger **subscription tier** (Lite / Pro / Enterprise), billed every 30 days.                  | Nothing to do with Secure Pro plans.           |
| **Agent / CPO**          | One Close Protection Officer.                                                                       | Not an agency.                                 |
| **Provider agency**      | A company that receives Lite dispatch offers and employs CPOs.                                      | Not a Secure Pro organisation.                 |
| **Secure Pro org**       | An internal delivery organisation for Secure Pro plans.                                             | Does not receive Lite dispatch offers.         |

---

## 2. Starting a shift

1. Open **Dashboard**. Each business has its own strip. Read the left tile of
   each: **Waiting on ops**. That is work no automation will move.
2. Click any tile — it opens the list already filtered.
3. The rail carries the same counts as small badges, so you can see from any
   page which business needs you.

**What "waiting on ops" means per product**

| Product              | Counts                                                                      |
| -------------------- | --------------------------------------------------------------------------- |
| Lite                 | Pending Ops + No Provider + Agency No-Show                                  |
| Executive Protection | The same three, for on-site details                                         |
| Secure Pro           | Applications needing a proposal + protection dates with no officer assigned |
| Enterprise           | Workspace join requests still pending                                       |
| Safety               | SOS events not yet acknowledged                                             |

---

## 3. Lite — a booking end to end

1. **Approve** it (`Lite · Bookings`, open the booking, APPROVE & PUBLISH). You
   must write a dress brief; the modal will not let you skip it.
2. On approval the booking is **published to the Job Feed** for agencies to
   apply, and — if auto-dispatch is armed — the engine also starts offering it.
   The **Lane** column tells you which lane owns it:
   - **AUTO** — the engine holds it; watch it in `Lite · Auto-Dispatch · Requests`.
   - **MANUAL** — it is on the agent job feed only; shortlist and assign yourself.
3. **Dispatching** stalls have two outcomes, and both need a human:
   - **NO PROVIDER** — nobody eligible. Check the agency's compliance under
     `People · Provider Agencies`; an expired licence is the usual cause.
   - **AGENCY NO-SHOW** — an agency accepted and did not arrive.
4. When the mission completes, the escrow settles automatically **unless** the
   proof-of-completion gate parks it — see §7.

**Auto-dispatch off?** `App Configuration · Switches` shows the kill switch and
whether it is armed. Disarming stops NEW bookings entering the engine; bookings
already cascading finish.

---

## 4. Executive Protection — a detail

- Book-ahead work, so the section landing is calendar-shaped: the approval queue
  plus the next seven days.
- The approval queue flags a **lead-time breach** in red — the detail starts
  sooner than the minimum lead time allows, so it cannot be staffed normally.
  The minimum is read live from the pricing board, not hardcoded.
- The booking detail leads with the **Executive detail** panel: block hours,
  computed end time, units, add-ons, the optional transfer leg, and the price
  composition **as charged**. Changing the pricing board later does not change
  this booking's numbers.
- Progress is the CPO's **hourly check-in**, not waypoints. Open
  `Executive · Details & Check-ins`.

---

## 5. Secure Pro — a plan

The `Secure Pro` landing is the funnel, left to right:

**Applications** (client applied) → **Proposals out** (waiting on them) →
**Active plans** → **Dates unassigned** (they asked for protection on a date) →
**Sessions live** (an officer is with them right now).

- Write a proposal from `Secure Pro · Applications`. SUPERVISOR or above.
- Assign officers to a requested date under `Secure Pro · Assignments · Requests`.
  Each assignment carries the mission code the CPO enters after login.
- `Secure Pro · Organisations` is the **internal** delivery org list. Provider
  agencies are a different thing and live under People.
- Completing a Pro mission carries **no payout** — it just finishes.

---

## 6. People

| Page                  | Use it to                                                                       |
| --------------------- | ------------------------------------------------------------------------------- |
| **Clients**           | Find a customer, see their bookings, plan, family and messenger tier            |
| **Agents (CPOs)**     | Onboarding, documents, KYC, mission history, terminate                          |
| **Provider Agencies** | Judge an agency: compliance validity, roster, and its real offer/no-show record |
| **Compliance**        | Verify or reject licences, insurance and armed permits                          |
| **All Users**         | Everyone, unfiltered (SUPERVISOR+)                                              |

An agency is **not dispatch-eligible** until its licence and insurance are
verified and unexpired. The agency list's Compliance column shows PROBLEM first,
then EXPIRING within 30 days — work that column before it becomes a no-provider
stall.

---

## 6b. Enterprise — an organisation

`Enterprise · Departments` lists **organisations**, one row each: how many
channels it runs (and how many are E2E-active), departments, people, incidents
open, join requests pending, and when something last happened. Sort any column;
the search box matches the organisation name, workspace name or email.

Open a row for the organisation's page:

1. **Profile** — contact, region, tier, the level names its admins chose,
   hidden modules, invite-link counts, last activity.
2. **Departments** — each department with its channels, people and managers.
3. **Channels** — the whole tree, indented, with tier, type, access and posting
   rules, member counts and whether encryption is active. Message content is
   never here: it is end-to-end encrypted and the relay cannot read it.
4. **People** — managers, officers and employees, each linking to their record.
5. **Incidents / Join requests / Attendance (30 days) / Activity** — what the
   organisation has been doing. Join requests are decided by the organisation's
   own managers in the app; this page is read-only.
6. **Organisation graph** at the end — the channel hierarchy drawn as a tree.
   Colours are the four levels (L1..L4); dashed nodes are lateral chats and
   announcements. **FIT TO WIDTH** shrinks a wide organisation onto one screen;
   otherwise scroll sideways.

## 7. Money

Everything is under **Finance**, and the landing leads with the number that
means credits are stuck: **Parked for review**.

- **Escrow & Review Holds.** Every auto-dispatch booking is charged into a platform
  escrow account when the provider accepts — the provider wallet is untouched until
  the job is proven. The page opens with **How escrow works** (collapsed): the
  lifecycle, who moves the money and when, and the rules you must follow. Each row
  shows its **Timeline** (a PENDING RELEASE hold counts down to its automatic
  payout; a REVIEW hold says it will never auto-release).
  - A hold marked REVIEW REQUIRED was parked by the proof-of-completion gate. The
    failed checks are shown as chips on the row. Press **RESOLVE REVIEW** to open the
    decision brief: the hold's facts, every failed check with _what was checked_ and
    _what to verify_, and the two outcomes with their exact amounts (release =
    gross minus the region's platform fee to the provider; refund = the whole gross
    back to the client). A decision note is mandatory and audited. SUPERVISOR or
    above. The same control is on the booking's own Money panel. A review hold is
    never split — a split is a dispute.
- **Disputes.** Only a client can open one, from the app, inside the dispute window
  (or after a client no-show). The page opens with its own rulebook. Each row names
  which mechanic applies: **settle** (hold still DISPUTED — the money is in escrow and
  your split moves it), **clawback** (hold already RELEASED — your split is the final
  position and the difference is reclaimed from the provider wallet), or **no-show
  fee** (a PARTIAL from a client no-show — the fee can be reversed or reduced, never
  increased). **Resolve** offers the decisions as presets (uphold / reject — affirm
  the executed split / release / custom), previews the exact split the server will
  execute (it clamps provider to the gross, then client to what is left), shows how
  much is pulled from the provider on a clawback, and refuses BEFORE you submit any
  split the server would refuse. Rejecting a dispute = affirming the executed split:
  it is recorded and moves nothing.
- **Wallet Adjustments.** Manual grants and deductions. Reason mandatory; lands
  in the wallet ledger _and_ the audit trail.
- **Promos & Referrals.** Referral codes are **attribution only** — a code never
  changes pricing, availability or who is assigned.

---

### 7b. Referral campaigns (discount codes)

`Finance · Promos & Referrals · Referral campaigns` is where you mint a discount
code, watch it being used, and switch it off.

1. **Mint** — press NEW CAMPAIGN. Choose a code (letters, digits, dashes), a name
   for yourself, **Universal** or **One region**, and the discount: a percent (with
   an optional cap in credits) or a fixed number of credits. Optional: limit it to
   certain services, cap total uses, set uses per client (default one), and a
   start / expiry date. Supervisor or Admin only.
2. **Announce** — a live campaign is pushed to every client the moment you mint
   it, wherever they live (someone in Dhaka may be in Cape Town next week; the
   region is checked when they book, not when they are told). The message names
   the discount, the code, where it works and until when. The mint confirmation
   tells you how many clients it reached. A scheduled campaign is not announced
   until it is live: open it and press **NOTIFY CLIENTS**. A second send within
   24 hours is refused unless you confirm **NOTIFY AGAIN**.
3. **Share** — open the campaign. The **Web link** opens a public page with the
   code and an Open-in-app button; the **App link** opens Bravo Secure directly
   with the code ready. Either one is fine on a poster, a message or an email.
4. **Watch** — the row shows Used (and the cap), Sold (gross, before discount),
   Given away (the discount), and Charged (net, what clients actually pay), with
   the paid share split out. The campaign page adds the last 30 days, the
   by-status split and every booking that used it, linking to each booking.
5. **Stop** — DEACTIVATE refuses new bookings immediately; past discounts stay as
   charged. You can also move the expiry, change the caps, or rename it. The code
   and the discount themselves cannot change — mint a new campaign instead.

What a campaign never does: change who is available, who is licensed, who is
assigned, or whether ops approves. It lowers the client's total and nothing
else. Partner codes (the third tab) are different again — they only record who
referred a booking and change no price.

## 8. Changing what the apps see

**App Configuration** is the only place platform behaviour changes, and its
first page tells you the truth about timing.

| Change                        | Reaches the app                                                        |
| ----------------------------- | ---------------------------------------------------------------------- |
| Pricing board                 | The next quote. Allow a minute for every server to agree.              |
| Regions                       | The next fetch — but a brand-new region needs an app build first.      |
| Package names & descriptions  | The app's next catalog fetch (an app already open keeps the old copy). |
| Messenger subscription prices | Every subscribe and renewal from now. Paid periods finish as charged.  |
| Tier grant                    | Up to 30 seconds.                                                      |
| Auto-dispatch kill switch     | Under 2 seconds.                                                       |
| Platform fee % / cancel fee % | **Not changeable here** — needs an engineering deploy.                 |
| App behaviour flags           | **Not changeable here** — needs a new app release.                     |

Two things worth knowing before you edit:

- Changing an **existing booking's price is impossible from here** and that is
  deliberate. A booking keeps the total it was charged.
- `eur_per_bc` is **the root**. Changing it re-prices every booking charge from
  the next quote. The confirm dialog says so in louder words.

---

## 9. Actions you cannot undo

| Action                      | Where                       | Effect                                                                              |
| --------------------------- | --------------------------- | ----------------------------------------------------------------------------------- |
| **Erase a user**            | People · All Users · detail | Irreversible account erasure                                                        |
| **Resolve a review hold**   | Finance · Escrow            | Moves real money to the provider or back to the client                              |
| **Resolve a dispute**       | Finance · Disputes          | Settles escrow, or claws credits back from a provider wallet                        |
| **Wallet adjustment**       | Finance · Adjustments       | Real credits in or out                                                              |
| **Change `eur_per_bc`**     | App Config · Pricing        | Re-prices every booking charge platform-wide                                        |
| **Change a settlement fee** | App Config · Pricing        | `platform_fee_pct` / `cancel_fee_pct` apply to every escrow settlement from then on |
| **Fire a test dispatch**    | Lite · Auto-Dispatch · Test | Creates a REAL booking and sends REAL offers — cancel it afterwards                 |
| **Disarm auto-dispatch**    | App Config · Switches       | Every new booking waits for a human until re-armed                                  |
| **Terminate an agent**      | People · Agents · detail    | Ends their access                                                                   |

Every one of these is audited against your call sign. `Internal · Audit Log`
answers "who changed this, when, and from what to what" — filter by actor to
review one operator's shift.

---

## 10. During an SOS

- The red bar appears on **every** page and is audible. It stays until the SOS is
  resolved; it is not dismissible.
- **Acknowledge** is open to every operator on shift — speed matters more than
  tier. Escalating and resolving need SUPERVISOR.
- The idle logout is **deferred while an SOS is unresolved**, so an unattended
  station cannot log itself out mid-emergency.
- `Safety · SOS Log` carries every SOS including mission-less client and
  biometric-guard panics, which have no mission to drill into.

---

## 11. If something looks wrong

- **A list looks empty but you know rows exist.** Check the product section: a
  Lite list never shows Executive bookings and the reverse. The header carries a
  link to the other product.
- **A table blanks while you type.** Known and logged (OP-12) — the data is not
  gone, the fetch is in flight.
- **A tab is stale.** Most pages pause polling when the browser tab is hidden;
  the SOS bar does not. Bring the tab forward to refresh.
- **A number on the dashboard disagrees with the list.** The dashboard counts
  server-side over everything; the list may be showing a loaded window. Trust the
  dashboard tile and press LOAD MORE.
