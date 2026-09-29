# CI Jest jobs — three settings and why (2026-09-29)

The `Jest (app)` and `Jest (messenger-crypto)` jobs in `ci.yml` had not
passed on `main` since the repo was imported. Three separate causes, all in
the test setup, none in app code:

| Symptom | Cause | Setting |
|---|---|---|
| `Jest (app)` ran for GitHub's 6-hour limit and was cancelled | Some suites leave timers running after they finish. In a long-lived Jest worker those leak into the next file until the worker spins at 100% CPU and never reports back. Every suite passes when run on its own. | `"workerIdleMemoryLimit": "1KB"` in `package.json` → `jest`: Jest starts a fresh worker for every test file. Full app project: 4,314 tests pass, the run exits by itself. |
| 8 `messenger-crypto` suites fail to load: `No such built-in module: node:sqlite` | The SQL store tests use `node:sqlite`, which exists from Node 22.13; CI used Node 20. | `node-version: '22'` for the Jest job (and Flake Watch). The service images still build on `node:20`. |
| `shiftWindowDst` fails: "the host timezone has DST" | The test sweeps a year of shift windows across DST changes and refuses to pass on a DST-free zone. The runner is UTC. | `TZ: Europe/London` on the Jest step (and Flake Watch). |

The Jest job also has `timeout-minutes: 30`, so a future hang fails in half
an hour instead of holding a runner for six.

Locally: the `package.json` setting applies to every `npm test` / `jest` run.
On a Mac in a zone without DST, run the DST test as
`TZ=Europe/London npx jest shiftWindowDst`.
