# Device pass — v1.0.277 (vc324)

**Owed for:** B-709 family spending-quota system (never device-verified since it landed
2026-08-30) **and** the two changes made 2026-09-01: the channel Members row → 1:1 chat door,
and §14 partial approval.

**Why this doc exists:** the build machine has no Android device or emulator attached
(`adb devices` empty, no BlueStacks install, no AVD), so none of this could be exercised at
build time. Everything below is mechanical once a phone is plugged in.

**Build:** `android/app/build/outputs/apk/release/app-release.apk`, baked against Contabo
staging (`auth.94-136-184-52.sslip.io` / `relay.94-136-184-52.sslip.io`), `AUTO_DISPATCH` and
`DEPT_CHAT_V2` both on.

```bash
adb devices                      # confirm the device is listed FIRST
adb install -r android/app/build/outputs/apk/release/app-release.apk
adb logcat -c && adb logcat | grep -E "LAGDIAG|CALLSM|family|quota"
```

---

## A. Channel Members row opens the member's 1:1 chat

Two mounts, and only one of them was ever exercised by the unit tests. **Both must be walked** —
the whole reason this goes through `navigateToMessengerScreen` is that `Chat` is not registered
on the Departmental Channels stack.

| # | Step | Expect |
|---|---|---|
| A1 | Messenger tab → a channel → header member count → **Members** | The roster renders |
| A2 | Tap any member row (not your own) | Their 1:1 chat opens |
| A3 | Back | Returns to Members, not to the chat list |
| A4 | Tap **your own** row ("(you)") | Nothing happens — no self-thread |
| A5 | Tap a member you have **never** messaged | Empty thread opens under their name, not "Member" |
| A6 | Send one message, back out, reopen from Members | **Same** thread, with the message in it — not a second empty one |
| A7 | Tap a member whose thread already has history | History is there (canonical id, not a fresh `direct:` row) |
| A8 | Tap "Make viewer" / the remove icon on a row | The button acts — the row press does **not** also fire |
| A9 | Repeat A1–A2 from the **Departmental workspace** (Workspace → Channels → channel → Members) | Chat opens; this is the mount where a bare navigate would silently drop |
| A10 | Mash one row ~10× | One chat opens, and the next back press is immediate (not queued behind 10 dispatches) |

> A6 and A7 are the ones worth caring about — they are what proves the canonical-id resolve is
> real rather than minting a duplicate synthetic thread.

## B. B-709 family spending quota

Needs **two accounts**: a Root/holder on a Pro plan with credits, and a linked member.
Serial ↔ account mapping is in `sqa.md`'s Device & Identity Reference.

### B1 — member view (`Profile` → the quota card)

| # | Step | Expect |
|---|---|---|
| B1.1 | Member opens Profile | Card shows Limit / Used / Remaining, bar coloured by band |
| B1.2 | Spend to ~85% of quota | Bar turns amber; **holder** gets ONE 80% notification |
| B1.3 | Spend more inside the 80s | **No** second notification (crossing marker, not per-transaction) |
| B1.4 | Cross 90%, then 100% | One notification each, in order |
| B1.5 | With remaining = 0, attempt a booking | Refused **before** any deduction, "You've reached your spending limit", `[Request More Credit]` |
| B1.6 | Tap Request More Credit, submit 2,000 | Request created; holder notified |
| B1.7 | Try to submit a second request | Refused — the button is now a status line, not a duplicate-maker |

### B2 — holder view (`Secure Pro` → Members)

| # | Step | Expect |
|---|---|---|
| B2.1 | Open Members | Pending request card sits **above** the roster |
| B2.2 | Tap **Approve** | Limit rises by the full amount; alert "Credit approved" |
| B2.3 | **NEW** — file another request, tap "Approve a different amount", enter 2,000 of 5,000 | Alert reads "**Partially approved** — Requested 5,000 BC · Approved 2,000 BC"; limit rises by 2,000 only |
| B2.4 | **NEW** — try 0, a negative, and 5,001 | Confirm stays disabled; nothing is sent |
| B2.5 | **NEW** — with TalkBack on, focus both approve buttons | Two **different** announcements ("Approve 5000 credits…" vs "Approve 2000 of 5000 credits…") |
| B2.6 | Reject a request | Member's quota unchanged; member sees the rejection |
| B2.7 | Decide the same request from a second device | Second device says "Already decided" and refreshes — not "try again" |
| B2.8 | Reduce a member's limit below what they have spent | Refused, naming the floor: "has already spent 4,500… cannot go below that" |

### B3 — the financial rules (the ones that matter)

| # | Step | Expect |
|---|---|---|
| B3.1 | Member quota 3,000, **root credit 0** | `ROOT_CREDIT_UNAVAILABLE` copy — must **not** say their quota is exhausted |
| B3.2 | Root credit 300, member remaining 500, spend 400 | Refused |
| B3.3 | …same, spend 250 | Allowed |
| B3.4 | Suspend the root account, member attempts a spend | `ROOT_ACCOUNT_SUSPENDED` |
| B3.5 | Double-tap Pay hard, or kill the network mid-charge and retry | **One** charge, one ledger row (idempotency) |
| B3.6 | Two members spend simultaneously against a balance that covers only one | Exactly one succeeds; root balance never goes negative |
| B3.7 | Refund a family-charged booking | Root credit **+**, member `used` **−**, remaining rises by the same amount |
| B3.8 | Remove a member | Their transactions and quota history survive; their open request goes to CANCELLED |

---

## Known gaps — not bugs, do not log them as such

- **§22 member suspension** — a `held_until` hold makes the member fall back to their **own**
  wallet rather than blocking outright. Existing product decision, deliberately preserved; it
  differs from the spec. Worth a product call, not a bug report.
- **§35/§36 quota reset** — the product is `NO_RESET`. There is no reset to test.
- **§29 pending-transaction reservation** — satisfied by the escrow model (`holdToEscrow` at
  accept); nothing separate to exercise.
