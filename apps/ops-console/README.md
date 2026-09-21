# Bravo Ops Console

Next.js 15 (App Router) operator console for Bravo Secure. Desktop-first, obsidian
palette, SWR over the `/ops/*` surface in `apps/auth-service`.

```bash
npm install
npm run dev        # http://localhost:3002
npm run typecheck  # must stay clean
npm run lint
npm run build
```

Pin suite (runs from the repo root, node environment, no DOM):

```bash
npm run test:ops-console
```

---

## The map: ten sections, grouped by business

Restructured 2026-09-03 — see
[`docs/audits/OPS_CONSOLE_IA_AUDIT_2026-09-03.md`](../../docs/audits/OPS_CONSOLE_IA_AUDIT_2026-09-03.md)
for why (findings IA-01…IA-18). The rail answers "what am I running?", not "which
tool is this?".

| Section               | Prefix        | What lives there                                                                                |
| --------------------- | ------------- | ----------------------------------------------------------------------------------------------- |
| **Overview**          | `/dashboard`  | Per-product KPI strips, the live map, the activity feed, analytics                              |
| **Lite**              | `/lite`       | Secure Transfer bookings, auto-dispatch (monitor · requests · test), the job feed, missions     |
| **Executive**         | `/executive`  | Fixed-block on-site details and their hourly check-ins                                          |
| **Secure Pro**        | `/pro`        | Plan applications, organisations, CPO pool, assignments, fleet, protection sessions             |
| **Enterprise**        | `/enterprise` | Messenger Enterprise: messenger, departments, attendance, incidents, join requests              |
| **People**            | `/people`     | Clients, agents (CPOs), provider agencies, compliance, all users                                |
| **App Configuration** | `/config`     | Everything the mobile apps fetch that ops can change, plus what they read and how long it takes |
| **Finance**           | `/finance`    | Ledger, escrow and review holds, payouts, disputes, invoices, promos, wallet adjustments        |
| **Safety**            | `/safety`     | SOS log, biometric guard heartbeats                                                             |
| **Internal**          | `/internal`   | Admins, audit log, console facts                                                                |

Every pre-restructure URL (`/bookings`, `/live`, `/pro-management`, `/settings`, …)
is a permanent redirect. The list is `REDIRECTS` in `src/lib/routes.ts`.

---

## Vocabulary — one word, one meaning

The single biggest source of confusion was **"Pro"**, which meant three different
things. In this console it is never used bare:

| Term                     | Means                                                                      |
| ------------------------ | -------------------------------------------------------------------------- |
| **Lite**                 | On-demand Secure Transfer / recon / extraction bookings, escrowed per job  |
| **Executive Protection** | Fixed-block on-site detail; per-unit pricing; hourly check-ins, no dropoff |
| **Secure Pro**           | The three-month protection **plan** product (`pro_applications`)           |
| **Messenger Pro**        | A messenger subscription **tier** (`lite` / `pro` / `enterprise`)          |
| **Agent (CPO)**          | An individual Close Protection Officer                                     |
| **Provider agency**      | A `service_provider` org that receives Lite dispatch offers                |
| **Secure Pro org**       | An INTERNAL delivery organisation for Secure Pro — not a provider agency   |

`nav.test.ts` fails the build if a rail label uses a bare "Pro".

---

## Four rules for anyone adding to this console

1. **Never write an internal path as a string.** Every path lives in
   `src/lib/routes.ts`; `routesLiteral.test.ts` bans `href="/…"` everywhere else.
   Use `bookingHref()` / `missionHref()` for anything product-dependent — they are
   the only place that decides Lite vs Executive.
2. **Tabs are routes, not `useState`.** Render `<RouteTabs>` over sibling
   segments so a tab is linkable and Back does the obvious thing.
3. **Never render a raw enum.** `src/lib/status.ts` holds every status label and
   tone; `status.test.ts` fails when the server grows a value the console cannot
   name.
4. **A `page.tsx` may only export `default`.** Next.js type-checks page modules
   against a fixed field set, so a shared component in a page file fails the
   production build (not the dev server) — put it in `src/features/…`.

## Layout

```
src/
├── app/
│   ├── (console)/          every authenticated page; layout.tsx mounts Shell ONCE
│   ├── login/  accept-invite/  api/health/
│   └── globals.css         obsidian tokens + every shared class
├── components/             Shell · PageHeader · RouteTabs · DataTable ·
│                           SectionLanding · StatusPill · BravoMap · messenger/
├── features/               page bodies shared across routes
│   ├── bookings/  missions/       Lite + Executive share these, `product` prop
│   ├── pro/  people/  finance/  config/  dispatch/
├── lib/
│   ├── routes.ts   the path source (+ REDIRECTS)
│   ├── nav.tsx     the rail as data (+ role gating)
│   ├── status.ts   the status vocabulary
│   ├── rbac.ts     capability checks mirroring backend @RequireRoles
│   └── api.ts      typed client: CSRF, silent refresh, idempotency keys
└── __tests__/              nav · routesLiteral · status
```
