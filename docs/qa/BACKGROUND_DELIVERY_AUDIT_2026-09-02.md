# "The other person gets the message late" — background delivery, measured on device (2026-09-02)

**Status:** audit (morning) → **FIXED the same evening** (§6). Logged as **B-776 / B-777 / B-778** in `sqa.md`; B-779 (killed-lane double card) stays open. 1.0.285 (vc342) is on the two test devices only — not released.
**Complaint (founder):** "when someone is not in the app and I message them, the other person
gets the message a little late. WhatsApp doesn't."
**Devices:** Redmi Note 11 (`2201116SG`, Android 13 / HyperOS `V816.0.12.0`, on ADB, account
**Ari** `88d34848`, Bravo **1.0.284 / vc335** installed 18:28 today) as the recipient; a
BlueStacks instance (`127.0.0.1:5555`, account **QA-Bravo** `f9c33ea6`, upgraded to the same
1.0.284 release APK) as the sender; staging relay `bravo-staging-msgr` (server clock within
0.2 s of the PC and phone clocks; BlueStacks runs 2 s behind and is corrected below).
WhatsApp `2.26.33.76` and Telegram `12.10.1` are installed on the same phone and were read as
the control.

This is the two-clock device capture that B-693 / B-715 have owed since 2026-08-01. The
`[NOTIFLAT]`, `[recv.total]` and `[send.*]` probes were read off a phone for the first time.

---

## 0. Plain-English summary

Think of the recipient's phone as an office worker. When Bravo is on screen the worker sits at
a desk with the lights on and opens the envelope in under two seconds. When Bravo is in the
background, Android moves that worker into a broom cupboard on the slowest chair in the building
(the `background` CPU group, little cores only, a few percent of the CPU when anything else is
busy). The envelope still arrives instantly — the socket was live and the push wake landed in
about a second — but opening it in the cupboard takes **11 seconds** for a known contact and
**23 seconds** for a first-time contact, on the very same phone where it takes **1.8 seconds**
at the desk. The notification, the ✓✓ tick and the ack all wait behind that work.

WhatsApp gets the same push wake, but the first thing it does is stand up a **foreground
service** ("GcmFGService"), which moves its worker back to the desk for the three seconds it
needs. Its notification posted **one second** after the wake on this phone. It also does not
try to keep a socket open in the background at all, and its decryption is native code.

Three smaller things sit around that:

- The founder's own phone (the Ranak account, not on this desk) drops its socket within a
  minute of leaving the app, so every background message there goes push → reconnect → flush.
  One of today's two probes to that phone reconnected with a token that had been rotated two
  seconds earlier, was refused, and took **20 s** to reach the phone instead of **4 s**.
- Xiaomi's **Autostart** permission is **denied** for Bravo on this phone (allowed for WhatsApp),
  and the app's own reliability card never asks for it once battery optimisation is exempt —
  which is exactly this phone's state. Autostart does not affect the alive-process lane measured
  here, but it decides whether a swiped-away Bravo can be woken at all.
- The push wake starts an HTTP drain that finds the same envelope already in flight on the
  socket lane and steps past it — duplicate work in the one window where the thread is starved.

---

## 1. What was measured

Five probe messages, three captures running throughout (phone `logcat -b main -b system
-b events` with an 8 MiB buffer, sender `logcat -s ReactNativeJS`, and `docker logs -f` on the
relay). All numbers are wall-clock from those logs.

| #   | To                     | Recipient state                                           | Tap → relay accept             | FCM transit (`T7 transitMs`) | Socket frame at recipient     | `[recv.total]` (unwrap / cert / chainWait / txn) | Tap → notification                 | Tap → ✓✓ on sender                      |
| --- | ---------------------- | --------------------------------------------------------- | ------------------------------ | ---------------------------- | ----------------------------- | ------------------------------------------------ | ---------------------------------- | --------------------------------------- |
| 1   | Ranak (off-desk phone) | not in app, socket dead since 18:45, first contact        | 2.4 s (X3DH `session` 1521 ms) | not observable               | flush at +21.6 s              | not observable (no ADB)                          | not observable                     | +5 min 56 s (when Ranak opened the app) |
| 2   | Ranak                  | not in app, socket dead                                   | 0.9 s                          | not observable               | flush at +4.9 s               | not observable                                   | not observable                     | +31 s (Ranak opened the app at +28 s)   |
| 3   | Ari (Redmi on desk)    | **background**, process alive, socket live, first contact | 2.4 s (`session` 1641 ms)      | **855 ms**                   | +2.5 s (instant after accept) | **22,794 ms** (862 / 3,776 / 12 / 17,225)        | **+8.3 s** (wake-drawn banner)     | **+26 s**                               |
| 4   | Ari                    | **foreground**, warm session                              | 0.8 s (`session` 7 ms)         | (wake at +1.0 s)             | +0.8 s                        | **1,799 ms** (245 / 455 / 3 / 1,082)             | +2.6 s (in-app)                    | **+3.1 s**                              |
| 5   | Ari                    | **background 76 s**, warm session                         | 0.5 s                          | **1,604 ms**                 | +0.5 s (instant)              | **11,026 ms** (1,653 / 1,886 / 195 / 7,268)      | **+13.7 s** (post-commit notifier) | **+14 s**                               |

Server side, every probe: `postPutMs` 3–4 ms; `push.chat.delivered … heldMs=201/252/253
fcmMs=201/252/253` (no coalescing hold — the FCM API round trip is the whole server cost).

The three readings that matter, on one phone, same code, same sender:

```
foreground, warm     [recv.total] ms=1799  unwrap=245  cert=455   chainWait=3   txn=1082
background, warm     [recv.total] ms=11026 unwrap=1653 cert=1886  chainWait=195 txn=7268    (6.1×)
background, 1st-cont [recv.total] ms=22794 unwrap=862  cert=3776  chainWait=12  txn=17225   (12.7×)
```

`unwrap` (ECIES) and `cert` (Ed25519 verify) do not touch the session at all, and they are
4–8× slower in the background — that is scheduling, not protocol work. The JS thread's cgroup
was read directly during each run:

```
foreground:  3:cpuset:/top-app     2:cpu:/top-app
background:  3:cpuset:/background  2:cpu:/background      (4 s after HOME, and still 76 s later)
```

Probe 3's notification landed **before** its commit (at +8.3 s, commit at +25 s): the warm
msg-wake handler drew it itself (`fcmBootstrap.ts` `msg-wake` branch → `showMessageNotif`
after a mute lookup, a conversation-meta resolve and an unread count, ~5 s on the starved
thread). Probe 5's landed **after** its commit (+2.2 s later, via the store notifier). Either
way the ack — and therefore the sender's ✓✓ — waited for the full receive.

### The founder's phone (probes 1–2), from the relay's side only

```
17:05:46  [envelope.send] accepted envId=96245d75 … lane=ws postPutMs=3
17:05:47  push.chat.delivered env=96245d75 sub=3165d0e1 sent=1/1 heldMs=201 fcmMs=201
17:05:49  auth.refresh (auth-service)           ← device woke, rotated its token
17:05:50  auth.refresh
17:05:51  [handshake] reject token_revoked sub=3165d0e1 jti=f9508919   ← reconnect used the pre-rotation token
17:06:06  +conn 3165d0e1 · ws open · flush 4 pending envelopes         ← 20 s after send
17:06:17  -conn                                                        ← 11 s later, gone again
17:11:11  accepted envId=68ffbc91 … push.chat.delivered fcmMs=252
17:11:14  +conn · flush 5 pending envelopes                            ← 4 s after send
17:11:38  presence active (app opened)  → sender's ✓✓ for BOTH probes lands 17:11:38–39
```

Ranak's socket history over four hours: sessions of 34 s, 2.5 min, 53 s, 6.9 min, 11 s and
2 min — it only holds a socket while the app is on screen. The Redmi on the desk held one
socket continuously from 18:32 to the end of the session (50+ min in the background). Which
lane a recipient is on is decided per device, not by the server.

---

## 2. WhatsApp on the same phone — what it actually does (from its logs, not from lore)

```
13:38:07.753  SmartPower.com.whatsapp: idle->background R(broadcast start Intent { act=com.google.android.c2dm.intent.RECEIVE … })
13:38:07.974  ActivityManager: Background started FGS: Allowed [com.whatsapp … GcmFGService; code:SYSTEM_ALLOW_LISTED]
13:38:13.652  SmartPower.com.whatsapp: … R(service destroy com.whatsapp/.messaging.service.GcmFGService)
usagestats:   18:47:48 FOREGROUND_SERVICE_START GcmFGService → 18:47:49 NOTIFICATION_INTERRUPTION → 18:47:51 FOREGROUND_SERVICE_STOP
```

| Behaviour on this Redmi                                | WhatsApp                                                                                 | Bravo                                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Background socket                                      | none (its one TCP conn was `CLOSE_WAIT`; process later killed and restarted by the wake) | three `ESTABLISHED` sockets to the relay, held for 50+ min                              |
| On push wake                                           | starts `GcmFGService` (FGS, `FOREGROUND_SERVICE_DATA_SYNC`) within ~0.2 s                | runs the RNFB headless task + the socket-lane handler as a **cached** process           |
| Scheduling group during the receive                    | foreground service → `top-app`/foreground cpuset                                         | `cpuset:/background`, `cpu:/background`                                                 |
| Wake → notification                                    | ~1 s                                                                                     | 5–12 s                                                                                  |
| Work per message                                       | native fetch + native decrypt                                                            | JS ECIES + JS Ed25519 + JS ratchet + SQLCipher, one thread shared with the wake's drain |
| Xiaomi Autostart (AppOps `10008`)                      | `allow` (exercised 9 min before the capture)                                             | **`ignore`** (Telegram: `ignore`, with a rejection stamped 11 h earlier)                |
| Doze allowlist / standby bucket                        | user allowlist / `EXEMPTED`                                                              | user allowlist / `EXEMPTED` (same)                                                      |
| `SCHEDULE_EXACT_ALARM`, `FOREGROUND_SERVICE_DATA_SYNC` | granted / declared                                                                       | removed by manifest / not declared                                                      |

The point is not that WhatsApp is faster at crypto. It is that WhatsApp refuses to do the work
in the cupboard: it promotes itself to a foreground service for the three seconds the work
takes, then steps back down. That is also Signal's model (`FcmFetchForegroundService`).

---

## 3. Root causes, ranked

### B-776 (P0, MEASURED) — the receive path runs as a cached background process and is 6–13× slower there

The high-priority FCM wake does elevate the uid (`am_uid_active 10517` within 1.2 s of the
send), but only the RNFB headless task rides that elevation. The envelope itself arrives over
the still-live socket a few hundred ms earlier and is handled by the main runtime's
`handleDeliverInner` → global `txnChain` → JS decrypt → SQLCipher commit, in whatever
scheduling group the process is in — `background`. The measured cost is 11 s warm / 23 s
first-contact against 1.8 s in the foreground, and the notification, the ack and the sender's
✓✓ all queue behind it. This is the whole of the founder's "a little late" on the
alive-process lane, and it is not crypto cost, fan-out, the server, or FCM (each ≤ 1.6 s).

The old DL-1 hypothesis ("serialized decrypt chain") is answered by `chainWait=3…195 ms` and
`qdepth=0`: the chain was empty. DL-2 ("frozen JS, buffered dead fd") is answered too, on this
phone: the process was `State: S`, `freezer:/`, the socket was read within ~60 ms of the emit,
and the JS thread ran — just very slowly.

### B-777 (P1, CONFIG + PRODUCT GAP) — Xiaomi Autostart denied, and the app never asks for it

`cmd appops get com.bravosecure.app` → `MIUIOP(10008): ignore`; WhatsApp `allow`. The
founder's phone habit is a recents sweep (`Killing … SwipeUpClean` at 12:55 and 13:13 today,
15 processes killed at 19:05:44 during probe 1). A swiped-away Bravo with Autostart denied is
not restartable by FCM on MIUI/HyperOS; the message then waits for the next manual open.
`NotificationReliabilityCard.tsx` renders the "Auto-start" button only inside
`needBatt && showAutostart`, and `needBatt` is false as soon as battery optimisation is
exempt — this phone's state — so the prompt can never appear here. Pinned by a `DOCUMENTS
B-777` render test.

### B-778 (P1, MEASURED on the founder's phone) — reconnect handshake with a just-rotated token

Probe 1: two `auth.refresh` events at 17:05:49/50, then a socket handshake at 17:05:51 that the
gateway rejected as `token_revoked` (the pre-rotation jti), then the next successful handshake
15 s later. Delivery to the device took 20 s instead of the 4 s probe 2 took on the same phone
with a fresh token. `packages/messenger-core/src/transport/client.ts` pre-refreshes in-place
for a _live_ socket (`auth.refresh` frame, `:744-799`); the _reconnect_ path evidently handed
the old token to the handshake. Needs the code trace with that phone on ADB; the server-side
evidence is unambiguous.

### Also found, not numbered

- **The wake's HTTP drain duplicates the socket lane.** Every background probe logged
  `[bravo.drainRelay] page made no progress (1 envelopes: 1 in-flight-skipped …) — stepping
past stuck head (B-315)` 2–8 s into the receive: the drain fetched a page, found the envelope
  already in flight, and moved on — a fetch, a parse and a skip on the starved thread while the
  real work waits.
- **Notifier post-commit cost in the background** ≈ 2.2 s (probe 5: commit 19:23:10.4 →
  `notification_enqueue` 19:23:12.6). Minor next to B-776; goes away with it.
- **First-contact X3DH on the sender** costs 1.5–1.6 s (`session=1521/1641 ms`), once per peer.
  Protocol cost; fine.
- **Copy:** the chat header reads "Ranak are offline" / "PiyalDebnath are offline".

---

## 4. What to do (recommendations — nothing below is implemented)

1. **Run the receive under a foreground service for the wake window (fixes B-776; the
   WhatsApp/Signal mechanism).** On `msg-wake`, before kicking the drain, start a notifee
   foreground service typed `dataSync` using the existing silent LOW-channel placeholder as its
   notification (the founder's "keep the silent placeholder" decision stands — it becomes the
   FGS notification), and stop it after `flushAcksBounded`. Needs
   `FOREGROUND_SERVICE_DATA_SYNC` in the manifest and `foregroundServiceType="dataSync"` on
   notifee's service (Android 14 hard-requires the type). Starting an FGS from the wake is
   permitted while the app holds the high-priority-FCM temp allowlist (WhatsApp's line shows
   `code:SYSTEM_ALLOW_LISTED` because it is also Doze-allowlisted — so is Bravo on this phone).
   Expected effect on this phone: 11–23 s → ~2 s, because the process moves to the foreground
   scheduling group for the duration. Verify with the same five-probe protocol (§5) — the
   `[recv.total]` legs are the pass/fail.
2. **Do not run the HTTP drain when the socket lane already holds the envelope in flight** — or
   give the wake-drain a short grace when `transport` is connected. Removes the duplicate fetch
   from the starved window. Keep the drain for the killed lane and the dead-socket lane.
3. **Fix the reconnect token (B-778):** the handshake must read the token _after_ any pending
   refresh settles, and a `token_revoked` handshake error must refresh-and-retry immediately
   rather than fall to the next ladder rung. Trace on the founder's phone first.
4. **Ask for Xiaomi Autostart independently of the battery state (B-777):** show the
   "Auto-start" action whenever `hasOemAutostartScreen()` and the user has not snoozed it, with
   its own copy ("Xiaomi may stop Bravo from waking for messages after you swipe it away…").
   The op cannot be set programmatically; the deep link to
   `com.miui.permcenter.autostart.AutoStartManagementActivity` already exists in
   `BravoBatteryOptimizationModule.kt`.
5. **Longer term: native crypto on the receive path.** `cert=3776 ms` for one Ed25519 verify in
   the background is JS on a starved little core. W5 already moved sha256 native; ECIES, Ed25519
   and the ratchet decrypt are the remaining JS legs.
6. **Keep it measurable:** stamp the JS thread's cpuset (`/proc/self/task/<tid>/cgroup` is
   readable by the app) and the notifee draw time into `[recv.total]` / `[NOTIFLAT]`, so a
   regression of this class reads off one line.

Deliberately **not** proposed (see B-715 founder decisions): raising push priority (already
maximum), alerting on the killed-lane placeholder, multi-device receipts.

---

## 5. How to reproduce (the protocol used today)

```bash
# recipient phone (release APK, app backgrounded with HOME — never Force-stop)
adb -s <phone> logcat -G 8M; adb -s <phone> logcat -c
adb -s <phone> logcat -v threadtime -b main -b system -b events > redmi_live.txt
# sender (BlueStacks 127.0.0.1:5555, same release APK)
adb -s 127.0.0.1:5555 logcat -s ReactNativeJS:* > bs_live.txt
# relay
ssh -i ~/.ssh/bravo-staging.pem admin@94.136.184.52 \
  "docker logs -f bravo-staging-msgr 2>&1 | grep --line-buffered -E 'push\.chat|envelope\.send|conn '"
# scheduling group of the recipient's JS thread (pid/tid from `ps -A | grep bravosecure`; tid = mqt_js)
adb -s <phone> shell cat /proc/<pid>/task/<tid>/cgroup
```

Send from the QA account's chat with the recipient, note the tap time, then read, per probe:
sender `[send.1v1]` + `[send.accepted]`; relay `[envelope.send] accepted` + `push.chat.delivered
… fcmMs=`; phone `RNFirebaseMsgReceiver: broadcast received`, `[NOTIFLAT] T7 … transitMs=`,
`[recv.total]`, `notification_enqueue … com.bravosecure.app`, `[messenger.deliver] ACK ok`;
sender `[send.delivered]`. Run one probe with the app on screen as the control. The phone's
`main` log buffer defaults to 256 KiB on this Redmi and rotates in minutes — enlarge it or
capture live; a post-hoc `logcat -d` holds none of the JS lines.

Two things to know before repeating it: the test account on `127.0.0.1:5555` is **QA-Bravo**
(`f9c33ea6`), the Redmi on this desk is **Ari** (`88d34848`), and the founder's account
**Ranak** (`3165d0e1`) is on a phone that is _not_ on ADB — probes 1–2 went to that phone and
are visible to the founder as "Latency probe 1/2 from QA".

---

## 6. Fix status — same evening (1.0.285 rev5, vc342, installed on the Redmi + BlueStacks; NOT released to Firebase)

| Lane on the Redmi (app in background) | Before                             | rev5                                                                                                                                                            |
| ------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decrypt + store (`[recv.total]`)      | 11.0 s warm / 22.8 s first contact | **0.47–0.71 s**                                                                                                                                                 |
| Tap → rich notification               | 13.7 s                             | **0.4–1.5 s**                                                                                                                                                   |
| Tap → ✓✓ on the sender                | 14 s                               | **1.1–2.1 s**                                                                                                                                                   |
| Process cgroup during the receive     | `cpuset:/background`               | `cpuset:/foreground` (back to background 2 s after the last release)                                                                                            |
| Visible chrome                        | —                                  | none (silenced channel; the "Checking for new messages…" card of rev1 and the slower notification-free job of rev4 were both rejected by the founder on device) |

B-776 (§3) is closed by `receiveForegroundHold.ts` + `MessageSyncForegroundService` /
`MessageSyncJobService` (§4 item 1 + 2), B-777 by the Auto-start row (item 4), B-778 by the
per-attempt handshake token (item 3). Open: **B-779** — the killed-lane double card (generic
wake-fallback next to the rich card when the drain budget expires ~15 ms before the notifier
posts); `[NOTIFDIAG]` traces the notifier's decision in release logs. The killed-lane headless JS
boot (~8 s before the wake handler runs) is the remaining structural cost on that lane.

## 7. Static device facts recorded (for the next session)

| Item                                                        | Bravo (`10517`)                                                    | WhatsApp (`10310`)                                               | Telegram (`10321`)        |
| ----------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------- |
| Standby bucket                                              | 5 EXEMPTED                                                         | 5 EXEMPTED                                                       | 10 ACTIVE                 |
| Doze user allowlist                                         | yes                                                                | yes                                                              | no                        |
| MIUIOP 10008 (Autostart)                                    | ignore                                                             | allow                                                            | ignore (rejectTime +11 h) |
| MIUIOP 10020 / 10021 (show-when-locked / bg-start-activity) | ignore / ignore                                                    | default                                                          | allow / allow             |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`                      | granted                                                            | n/a                                                              | —                         |
| `FOREGROUND_SERVICE_DATA_SYNC`                              | not declared                                                       | declared                                                         | —                         |
| `SCHEDULE_EXACT_ALARM`                                      | removed (`tools:node="remove"`)                                    | granted                                                          | —                         |
| Process while backgrounded                                  | `cch+2 CAC`, adj 700, `State: S`, `freezer:/`, cpuset `background` | killed by recents sweep 19:05:48, restarted as `svc` by its wake | —                         |
| Relay sockets while backgrounded                            | 3 × `ESTABLISHED` to 94.136.184.52:443                             | 1 × `CLOSE_WAIT`                                                 | —                         |
| `RNFirebaseMsgReceiver` on a wake                           | logs `broadcast received for message` (D)                          | —                                                                | —                         |
