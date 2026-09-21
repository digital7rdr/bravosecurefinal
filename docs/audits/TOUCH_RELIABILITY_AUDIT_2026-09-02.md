# Touch reliability — why taps need 2-3 tries, land only on a precise spot, or die at the edge

**Date:** 2026-09-02 · **Status:** REMEDIATED SAME SESSION (Fable 5) — TCH-1..TCH-5 fixed as **B-732..B-738** (sqa.md session 2026-09-02), TCH-6..TCH-11 recorded per §E; gates: crypto 7218 ×2 · app messenger 751 · NAV block 174 · news/securepro/deptchat/agent 860 · tsc 46 = baseline; pins `touchTargets`, `composerSendRace` (+B-733), `incidentClientContract` (+B-736), `mediaReplyAffordance` (re-pointed to the new image onPress); **device pass OWED** · **Branch read:** `main` @ `acf0f56e` · **Symptom (client):** buttons need 2–3 taps; some respond only at a precise spot; edge taps do nothing; the touchable area is smaller than the visible control; the first tap is sometimes ignored.

> **Renumbered on push:** a parallel session claimed B-730 (Mapbox boot crash) first, so this
> work shipped as **B-732..B-738** (fetch-before-numbering rule).

> **Two sweep claims corrected during implementation (evidence discipline):**
> DepartmentChatScreen has NO autofocus-at-mount — the `focus()` calls are the emoji-toggle
> paths, so only the pull + markRead were gated (B-738). And `Vibration.vibrate` is an async
> bridge call, not a synchronous stall — haptics were dropped from the cause list.

> **Evidence levels — read them literally.** `VERIFIED` = the lead session re-read the cited
> lines today. `REPORTED` = found by a read-only sweep agent and consistent with neighbouring
> verified reads, but not re-read line-by-line by the lead. Line numbers go stale fast in this
> repo — **re-grep the symbol before editing.** Nothing in this document was measured on a
> device today (`adb` not exercised); the device pass is §F.

> **This audit deliberately does NOT re-open:** the eight measured JS-thread dead ends
> (CLAUDE.md lag dossier), the B-664..B-679 nav/rapid-use fixes (all re-verified present), the
> Android swipe-back ceiling (NAV-01/02, arch-gated), or the `tapGuard` 500 ms windows
> (N2/N3 invariants, runbook-pinned — see §E). Every finding here is a NEW mechanism.

---

## §0 Repo law that applies to the fix session

- **NAV_RAPID_USE_LOOP** applies (`onPress` surfaces, tab bars, `tapGuard.ts` context). Its §2
  invariants were checked against this plan; no fix below weakens N1–N11.
- **Messenger gate:** most fixes touch `src/screens/messenger/**` → run
  `npx jest --selectProjects messenger-crypto` **twice** AND
  `npx jest --selectProjects app --testPathPattern "screens/messenger"`.
- **Bug-regression contract (B-143+):** every behavioural fix lands with a pin that was RED
  first (or mutation-proved by reverting).
- **DESIGN_REVIEW_LOOP §3.4:** touch targets ≥ 44pt (iOS) / 48dp (Android), spacing between
  targets ≥ 8dp — the standard this audit measures against.
- Typecheck baseline 46; source scans must strip comments and use `\r?\n` (CRLF tree).

---

## §A Root causes (confirmed)

The complaint decomposes into **five mechanisms**, not one:

### TCH-1 — With the keyboard open, the FIRST tap on any control is eaten by the IME dismissal 🔴 Critical · VERIFIED

`keyboardShouldPersistTaps` defaults to `'never'`: while the keyboard is up, RN's ScrollView
responder consumes the first tap to dismiss the IME and the control under the finger never
fires. The user taps again — that one works. This is **verbatim** "buttons require 2 taps" and
"the first tap appears to be ignored", and it bites on the app's highest-traffic surfaces:

| Surface           | Cite (VERIFIED)                                                      | Co-existing input                                                    |
| ----------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Chat message list | `src/screens/messenger/ChatScreen.tsx:2192` (`<FlatList inverted>`)  | composer — every bubble tap (image open, retry, file, voice) pays it |
| Conversation list | `src/screens/messenger/MessengerHomeScreen.tsx:1154`                 | search at `:1117` — search → tap a chat = 2 taps                     |
| Dept chat feed    | `src/screens/messenger/DepartmentChatScreen.tsx:1137` (`ScrollView`) | composer at `:1460`                                                  |
| Contact picker    | `src/screens/messenger/NewChatScreen.tsx:531`                        | search at `:507`                                                     |
| Channel tree      | `src/screens/messenger/DepartmentChannelsScreen.tsx:913`             | search **inside** it at `:955`                                       |
| Files             | `src/screens/messenger/FilesScreen.tsx:961`                          | search at `:906`                                                     |
| SecurePro members | `src/screens/securepro/SecureProMembersScreen.tsx:423` (REPORTED)    | input at `:498`                                                      |
| Chat info         | `src/screens/messenger/ChatInfoScreen.tsx:787` (REPORTED)            | inputs `:1200,1248`                                                  |

The repo already knows the rule — `KeyboardAvoidingScreen.tsx:88` sets `"handled"`, the chat
mention picker uses `"always"` (`ChatScreen.tsx:4199`), ~40 screens are correct. These lists
were simply missed. **No screen-wide keyboard-dismiss `TouchableWithoutFeedback` layer exists**
(checked — the three uses are modal scrims), so this is the whole keyboard story.

### TCH-2 — The chat send button disables itself on STALE state while `submit` reads the ref ⚠ High · VERIFIED

`ChatScreen.tsx:4182` — `const hasText = text.trim().length > 0` (React state) drives both the
render swap (mic↔send, `:4300`) and `disabled={!composerEnabled || !hasText}` (`:4305`). But the
composer's own 20-line header comment (`:4013-4032`) documents that `text` state is one or more
keystrokes STALE under fast typing, which is why `submit` (`:4155`) reads `textRef` — the
synchronous truth. The `disabled` prop was left on the stale state: type fast, tap send in the
same tick → the button is still rendered disabled (or still rendered as the mic) and the tap
dies. This is the single most-used button in the app, failing under exactly the founder's
fast-typing repro. `submit` already bails safely on an empty ref, so the `!hasText` half of the
`disabled` is pure downside.

### TCH-3 — High-traffic icon controls are below the 44/48dp floor with no `hitSlop` ⚠ High · VERIFIED (inventory REPORTED, top surfaces re-read)

The census: **1,183 touchables, only ~15% carry `hitSlop`**, no shared constant, no
`pressRetentionOffset` anywhere. The visible box IS the touch box, and on these controls it is
well under the platform floor — "only works when I hit a precise spot":

| Control                                 | Cite                                                                                                                                              | Touch box today                                                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Composer emoji toggle**               | `ChatScreen.tsx:4274` — `TouchableOpacity` with **no `style`, no `hitSlop`**                                                                      | **the 18dp glyph** (worst in the app). Its dept-chat twin was deliberately given `hitSlop:13` with a comment (`DepartmentChatScreen.tsx:1482-1491`) — the fix pattern already exists in-repo |
| Send button                             | `ChatScreen.tsx:4301`, `sendBtn` `:4997`                                                                                                          | 38×38                                                                                                                                                                                        |
| Attach `+`                              | `ChatScreen.tsx:4243`, `attachBtn` `:4977`                                                                                                        | 40×40                                                                                                                                                                                        |
| Header back                             | `ChatScreen.tsx:2057`, `backBtn` `:4741`                                                                                                          | 34×34                                                                                                                                                                                        |
| Header search/voice/video               | `ChatScreen.tsx:2123-2134`, `iconBtn` `:4795`                                                                                                     | 34×34 each                                                                                                                                                                                   |
| Voice-note cancel / send / idle         | `VoiceNoteRecorder.tsx:215/222/204`, styles `:252-257`                                                                                            | **28×28** / 32×32 / 36×36, zero hitSlop in the file                                                                                                                                          |
| Dept reply-bar close ×2                 | `DepartmentChatScreen.tsx:1410,1424`, `replyBarClose` `:1920` (`padding:4`)                                                                       | ~22-24dp                                                                                                                                                                                     |
| Search-clear X                          | `MessengerHomeScreen.tsx:1127` — no style                                                                                                         | 15dp glyph                                                                                                                                                                                   |
| Breaking-banner dismiss                 | `NewsFeedScreen.tsx:245` — no style                                                                                                               | 16dp glyph                                                                                                                                                                                   |
| Group-call tile ⋯                       | `GroupCallScreen.tsx:2207,2269`, `heroMoreBtn`                                                                                                    | 28×28 (REPORTED)                                                                                                                                                                             |
| In-call chat close, dialpad clear/close | `GroupCallScreen.tsx:2817`, `CallScreen.tsx:3753,3756` — no style                                                                                 | glyph-sized (REPORTED)                                                                                                                                                                       |
| Bare `<Text onPress>` links             | `AttendanceScreen.tsx:205` (`viewAll` has zero padding — VERIFIED), `VerifyAttendanceScreen.tsx:174` (a CONFIRM action on a bare Text — REPORTED) | the glyph run only; `hitSlop` is not a Text prop                                                                                                                                             |

### TCH-4 — Dept-chat send button: the `hitSlop` sits on a NON-RESPONDER child · Medium · VERIFIED

`DepartmentChatScreen.tsx:1495-1509` — the `TouchableOpacity` has no style; `styles.sendBtn`
(38×38) **and** `hitSlop:6` are both on the `<LinearGradient>` **child**. The gradient never
becomes the responder, so the slop rides on the wrong view — unreliable at best (bubbling may
rescue it on Android, iOS clips subview hit-tests to bounds). `ChatScreen.tsx:4301-4311` shows
the correct shape: style + press on the Touchable, gradient as a `pointerEvents="none"`
absolute-fill child.

### TCH-5 — First-tap dead ends in handlers ⚠ High (5a) / Medium (5b, 5c) · VERIFIED

- **5a — Incident submit becomes permanently dead after a dismissed alert.**
  `ReportIncidentDetailsScreen.tsx:207` — `submittedRef.current = true` after a successful POST
  is **never reset**, and the partial-evidence alert (`:231-243`) carries `Retry` / `Continue`
  but **no `onDismiss`**. Back/backdrop-dismiss the alert → the user is stranded on a screen
  whose Submit looks alive (`finally` re-enables `busy`) but returns at `:180` forever, and
  never reaches `IncidentSubmitted`. The report IS filed, so the honest dismissal behaviour is
  the same as Continue.
- **5b — An undownloaded image bubble tap silently no-ops.** `ChatScreen.tsx:3460` —
  `onPress={() => !imageBroken && attachment.uri && onOpenImage()}`. The video/audio/file
  branch two arms down (`:3542-3547`) got the Media-parity G8 treatment ("one tap: download
  AND open"); the image path never did. Tap, nothing, tap again later — literally.
- **5c — DepartmentChatScreen never received the B-691 transition gate.** Its mount effects —
  relay `pullEnvelopes()` (`:790`), the markRead 200 ms timer (`:820`, whose comment says
  "mirrors ChatScreen.tsx exactly" — it mirrors the PRE-fix ChatScreen), composer autofocus
  (`:786`) — all land inside the 220 ms open slide, competing with the animator. The first tap
  after opening a dept chat queues behind that burst. `useOpenTransitionGate` exists, is
  proven on ChatScreen, and has exactly one consumer.

### Contributing / recorded (not fixed this round — reasons in §E)

- **TCH-6** `confirmSwitchDashboard`'s 600 ms latch is module-global and destination-blind
  (`alert.ts:193-202`) — two different drawer rows inside 600 ms swallow the second. Low.
- **TCH-7** Opaque loading overlay passes taps through blind while `isLoading`
  (`navigation/index.tsx:117`, `pointerEvents="none"` branch over an opaque `LoadingView`).
  Deliberate fail-open (comment in situ); recorded, unchanged. The 1.5 s cold-intro capture
  branch is deliberate and visible — not an invisible blocker.
- **TCH-8** `goBackOnce`/`navigateOnce` stamp their window BEFORE dispatch (`tapGuard.ts:84,144`),
  so a refused/no-op navigation burns 500 ms. Self-healing; guard changes are runbook-gated.
- **TCH-9** Async-effect-disabled-on-first-paint buttons (vault-bio row
  `MessengerSettingsScreen.tsx:197`, `VerifyAttendanceScreen.tsx:183`, LocationPicker confirm
  `:717` — all REPORTED): visible affordance exists ("Checking…", "MAP LOADING…"). Low.
- **TCH-10** `launchCall.ts` 10 s dial latch — refuses WITH an alert; watchdog-bounded. Recorded.
- **TCH-11** Watch items needing device evidence, not code: `removeClippedSubviews` on both chat
  lists; tab-bar `elevation:20` vs `BookingHomeScreen` FAB `elevation:10` overlap band;
  `AgentLiveTrackerScreen` zIndex stack with no elevations; `VbgFooter` opaque gutter;
  `FloatingCallOverlay`/`CallScreen` PiP PanResponders (tap fallbacks exist; drag-vs-tap slop
  is 4dp); `FitLine` `twin` measurement Text without `pointerEvents="none"`.

### Ruled out (so nobody re-hunts them)

Decorative-gradient interception (~95 layers already `pointerEvents="none"`, zero `box-none`
misuse, zero stale modal backdrops — all 68 modals are `visible`-driven RN `<Modal>`);
`delayPressIn`/`pressRetentionOffset` misconfiguration (zero usage); RNGH pan theft on the
swipe-to-reply rows (both carry `activeOffsetX:16` + `failOffsetY:±14` — correct);
`Vibration.vibrate` on press (async bridge call, not blocking); the eight measured JS-thread
dead ends; `tapGuard` swallowing a FIRST tap (it can only drop repeats).

---

## §B Affected components

**Fix targets:** `ChatScreen.tsx`, `MessengerHomeScreen.tsx`, `DepartmentChatScreen.tsx`,
`NewChatScreen.tsx`, `DepartmentChannelsScreen.tsx`, `FilesScreen.tsx`, `ChatInfoScreen.tsx`,
`SecureProMembersScreen.tsx`, `VoiceNoteRecorder.tsx`, `NewsFeedScreen.tsx`,
`GroupCallScreen.tsx`, `CallScreen.tsx`, `ReportIncidentDetailsScreen.tsx`,
`AttendanceScreen.tsx`, `VerifyAttendanceScreen.tsx` (+ pins).

**Untouched by design:** `tapGuard.ts`, navigators, `alert.ts` queue, `FloatingCallOverlay`,
`LoadingView`/cold-intro, all modal scrims, gesture configs.

---

## §C Severity

| ID        | Issue                                                 | Severity       |
| --------- | ----------------------------------------------------- | -------------- |
| TCH-1     | Keyboard eats the first tap on 8 input-adjacent lists | **Critical**   |
| TCH-2     | Send button disabled off stale state                  | **High**       |
| TCH-3     | Sub-floor hit areas on high-traffic icon controls     | **High**       |
| TCH-5a    | Incident Submit permanently dead after alert dismiss  | **High**       |
| TCH-4     | Dept send slop on non-responder child                 | Medium         |
| TCH-5b    | Image bubble tap no-ops before download               | Medium         |
| TCH-5c    | Dept chat missing transition gate                     | Medium         |
| TCH-6..10 | Latches / overlays / disabled-timing                  | Low (recorded) |
| TCH-11    | Device-evidence watch items                           | n/a (watch)    |

---

## §D Fix plan (Problem → Root cause → Fix → Why safe)

1. **TCH-1** First tap dismisses keyboard → RN default `'never'` → add
   `keyboardShouldPersistTaps="handled"` to the 8 lists (plus `keyboardDismissMode="on-drag"`
   on the three feeds/lists where tap-to-dismiss was the only dismiss path, so the keyboard
   stays dismissible by scroll — the WhatsApp model). _Safe:_ prop-only; `"handled"` still lets
   non-touchable areas dismiss nothing but changes no handler; the repo's own blessed wrapper
   already uses it. Pin: source scan asserting the prop at each decision site (comment-stripped,
   `\r?\n`).
2. **TCH-2** Send tap dies under fast typing → `disabled` reads stale `text` state → drop
   `!hasText` from `disabled` (keep `composerEnabled`); keep the opacity cue keyed on `hasText`.
   A tap with an empty ref is already a safe no-op in `submit` (`:4160`). _Safe:_ the ref-clear
   IS the double-send guard (`composerSendRace.test.ts` pins it); this widens when the tap is
   accepted, never what it does. Pin: extend the composer race suite, RED first.
3. **TCH-3** Precise-spot taps → sub-floor boxes, no slop → add `hitSlop` sized to
   **min(floor-deficit, half the gap to the nearest neighbour)** per control: emoji toggle gets
   the dept-chat 13 precedent; 34-40dp header/composer buttons get 4-6; the glyph-only
   dismiss/close buttons get 10; voice-note controls get 8/6; the two bare `<Text onPress>`
   actions are wrapped in a padded `TouchableOpacity` (hitSlop is not a Text prop). _Safe:_
   overlapping-slop ambiguity is avoided by the half-gap rule (the `ChannelTree.tsx:456`
   precedent); no destructive action gains reach toward a neighbour; visuals unchanged.
4. **TCH-4** Dept send slop inert → slop/style on the gradient child → move style+press box to
   the `TouchableOpacity`, gradient becomes `pointerEvents="none"` absolute fill (mirror
   `ChatScreen` send). _Safe:_ identical rendered pixels; the responder finally owns its box.
5. **TCH-5a** Dead Submit → latch never reset + alert with no `onDismiss` → give the
   partial-evidence alert an `onDismiss: go` (dismissal = Continue; the report is already
   durable — same outcome the Continue button promises). _Safe:_ no new state; copies the
   `MessengerSettingsScreen.tsx:417` both-buttons-and-dismiss pattern; pin in
   `incidentClientContract.test.ts`, RED first.
6. **TCH-5b** Image tap no-op → missing G8 arm → mirror the file-branch: if no uri and not
   loading, `setAutoOpen(true); attachment.load()`. _Safe:_ the sibling branch has shipped this
   exact behaviour since the media-parity round; `autoOpen` effect already opens on-ready.
7. **TCH-5c** Dept chat first tap late → ungated mount burst → adopt `useOpenTransitionGate`
   for the relay pull, the markRead timer, and the autofocus (side effects only — the hook's
   contract forbids gating JSX; content untouched). _Safe:_ delayed-never-lost by the 400 ms
   fallback; proven one screen over; full messenger gate + the existing markRead pins must stay
   green.

---

## §E DO-NOT list for this fix round

| Idea                                                           | Why not                                                                             |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Touch `tapGuard` windows / key shape                           | N2/N3 runbook-pinned; changes need B-261/BB-6 context. TCH-8 recorded instead       |
| Capture touches on the `isLoading` overlay                     | Deliberate fail-open (wedged-flag risk chosen over frozen app; comment in situ)     |
| Remove the 1.5 s cold-intro capture                            | Founder feature; capture is the SAFE half (blind taps were the audit-shape worry)   |
| Blanket `hitSlop` / giant targets                              | Overlap between neighbours mis-fires the LATER sibling; half-gap rule instead       |
| Flip `removeClippedSubviews`, elevations, PanResponder configs | Device-evidence items (TCH-11); this repo does not ship unmeasured perf/touch flips |
| Android swipe-back, predictive back                            | NAV-01/02 arch-gated                                                                |
| Any `setTimeout`/delay/retry "fix"                             | Banned by the task and by this repo's history                                       |

---

## §F Verification

**Automated:** new/extended pins RED-first (persist-taps scan, composer-disabled, incident
dismiss, image one-tap, dept gate wiring); then
`npx jest --selectProjects messenger-crypto` ×2 · app-project `screens/messenger` ·
NAV loop pin block (`tapGuard|rapidUseSourceGuards|...`) · `npm run typecheck` ≤ 46.

**Device (owed if no device attached — founder rule):** keyboard-open first-tap on chat row /
bubble / channel row; fast-type→send; edge taps on emoji toggle, back, voice-note cancel;
double-tap send (one message); incident submit → dismiss partial alert → not stranded;
image tap before download opens on arrival; dept chat open feels like chat open; iOS pass for
the same list.
