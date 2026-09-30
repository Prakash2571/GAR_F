# Status: Document the GAR Synthetic frontend

State: Done
Updated: 2026-09-30
Next action: Review `outputs/GAR_FRONTEND_GUIDE.md`; start a separate implementation task for route-aware Synthetic broker callback capture (R9) and delayed-response/reconnect state handling (R10), then validate with approved dependencies/browser checks.
Blockers: none for documentation; full build/DOM/browser checks need the missing project dependencies and remain unverified.
WIP override: none

Task: `2026-09-30-working-documentation` · Project: GAR_F-synth · Plan: [PLAN.md](PLAN.md)

## Current state

Delivered the detailed frontend guide and cross-linked Go system/API/settings/review documents. Each Synthetic screen, control, access/CSRF flow, stream/update pipeline, display calculation, and backend dependency is explained. Application source remains unchanged; test results and integration defects are recorded honestly.

## Completed

- 2026-09-30: Read shared workspace workflow and frontend README/package.json; enumerated routes, Synthetic components, API/stream/view helpers, and tests.
- 2026-09-30: Initial Git status was clean; frontend HEAD is `5d63f78`, branch `synth`.
- 2026-09-30: Created task records manually because the helper rejects existing uppercase/underscore project names.
- 2026-09-30: Traced routing, dedicated Synthetic passcode/CSRF lifecycle, requests/types, SSE reconnection, latest-frame parsing, structural sharing, state wiring, broker and settings panels, and compared these with the Go routes/views.
- 2026-09-30: Completed opportunities, chain, positions/history, execution/live controls, quick-control/banner, theme/bootstrap, transport/error, and backend-state tracing; wrote `outputs/GAR_FRONTEND_GUIDE.md` plus deliverable index.
- 2026-09-30: Reproduced the global bootstrap/Synthetic broker callback parser collision using the actual pure helper functions; documented it as R9 with source evidence. Logged other state-ordering/reconnect gaps separately.
- 2026-09-30: Ran focused test files directly to confirm 27 passing assertions, diagnosed empty Node child output independently, and validated the documentation against source. No dependencies were installed and no broker requests were made.
- 2026-09-30: Marked documentation Done and updated INDEX.md; application source unchanged.

- 2026-09-30: User requested GitHub publication; follow [publication task](../2026-09-30-publish-documentation/STATUS.md). GitHub links and README navigation prepared; documentation content remains source-based.

## Checks

| When | Command / check | Result |
|------|-----------------|--------|
| 2026-09-30 | `git status --short` | Exit 0; no changes; shell startup emitted stream-fd diagnostics. |
| 2026-09-30 | `git log -5 --oneline` | Exit 0; recent commits cover `/synth`, standalone access/brokers, execution modes, and stream optimization. |
| 2026-09-30 | `bin/work new-task GAR_F-synth working-documentation --title 'Document the GAR Synthetic frontend' --doing --date 2026-09-30` | Exit 1; helper accepts lowercase/dashes only. Existing name preserved; task files created manually. |
| 2026-09-30 | Existing tool/dependency inventory | Node available; Node 22 exists in `/home/prakash/gar-testenv/`; project node_modules absent. No installation performed. |
| 2026-09-30 | `/home/prakash/gar-testenv/node-v22.23.2-linux-x64/bin/node --experimental-strip-types --test tests/synthApi.test.mjs tests/synthExecution.test.mjs tests/synthLive.test.mjs tests/synthView.test.mjs` | Exit 0; 4 test files passed, 0 failed or skipped. |
| 2026-09-30 | `/home/prakash/gar-testenv/node-v22.23.2-linux-x64/bin/node contract/verify.mjs` | Exit 0; contract version 1.23.0, 52 Box schemas verified. This contract does not cover Go Synthetic. |
| 2026-09-30 | `/home/prakash/gar-testenv/node-v22.23.2-linux-x64/bin/node --experimental-strip-types --test tests/*.test.mjs` | Exit 1; 34 of 36 test files passed. `emergencyControlsDom.test.mjs` could not resolve React; `contractVerify.test.mjs` failed. |
| 2026-09-30 | `/home/prakash/gar-testenv/node-v22.23.2-linux-x64/bin/node --experimental-strip-types tests/contractVerify.test.mjs` | Exit 1; all 5 assertions failed because subprocess output was empty. Direct verifier succeeded; underlying subprocess/environment cause not established. |
| 2026-09-30 | `env PATH=/home/prakash/gar-testenv/node-v22.23.2-linux-x64/bin:/usr/bin:/bin /home/prakash/gar-testenv/node-v22.23.2-linux-x64/bin/node --experimental-strip-types tests/contractVerify.test.mjs` | Exit 1; same empty-subprocess-output failures. Changing PATH did not resolve it. |
| 2026-09-30 | `/home/prakash/gar-testenv/node-v22.23.2-linux-x64/bin/node --experimental-strip-types tests/synthApi.test.mjs` | Exit 0; 5 assertions passed, 0 failed/skipped. |
| 2026-09-30 | `/home/prakash/gar-testenv/node-v22.23.2-linux-x64/bin/node --experimental-strip-types tests/synthExecution.test.mjs` | Exit 0; 8 assertions passed. |
| 2026-09-30 | `/home/prakash/gar-testenv/node-v22.23.2-linux-x64/bin/node --experimental-strip-types tests/synthLive.test.mjs` | Exit 0; 6 assertions passed. |
| 2026-09-30 | `/home/prakash/gar-testenv/node-v22.23.2-linux-x64/bin/node --experimental-strip-types tests/synthView.test.mjs` | Exit 0; 8 assertions passed. |
| 2026-09-30 | Node pure helper callback reproduction (full exact command in review report) | Exit 0; bootstrap stripped the query and Synthetic parsed null: `{"cleanedSearch":"","synthResultAfterBootstrap":null}`. |
| 2026-09-30 | Minimal Node `execFileSync(process.execPath, ["-e","console.log(123)"], ...)` diagnostic | Parent exited 0 and printed empty child stdout; independently reproduced contract-test output symptom. Underlying runtime cause unestablished. |
| 2026-09-30 | `python3 scratch/gar-documentation/validate_docs.py` from backend | Exit 0; all 6 documentation files/source links/API-settings coverage/JSON examples validated. |
| 2026-09-30 | `git diff --check` / final `git status --short` | Exit 0; frontend has outputs/tasks only, no tracked application code changes. Full production build/browser checks not run due missing dependencies. |
| 2026-09-30 | `bin/work status --all` | Exit 0; both documentation tasks Done, 0 Doing, no workspace warnings. |
| 2026-09-30 | Final task-link/completion/placeholder audit (local Python) | Exit 0; task links resolve, completion criteria checked, final outputs contain no unexpanded placeholders. |

## Relevant files

- `src/app/routes.tsx`, `src/pages/SyntheticPage.tsx`
- `src/components/synth/`, `src/api/synth.ts`, `src/lib/synthLive.ts`, `src/lib/synthStream.ts`, `src/lib/synthView.ts`
- `tests/synth*.test.mjs`
- `../GAR_B-synth/synth/`
- `PLAN.md`
- [Frontend guide](../../outputs/GAR_FRONTEND_GUIDE.md)
- [Deliverable index](../../outputs/README.md)
- [Go system guide](https://github.com/Prakash2571/GAR_B/blob/synth/outputs/GAR_WORKING_GUIDE.md)
- [Review report](https://github.com/Prakash2571/GAR_B/blob/synth/outputs/GAR_REVIEW_AND_VERIFICATION.md)

## Reconciliation notes

- No project-local AGENTS.md or WORKFLOW.md and no prior task records were present.
- README calls Synthetic paper trading; current source must be checked for all five execution modes, including live.
