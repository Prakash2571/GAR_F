# Status: Synchronize Synth UI with six backend repairs

State: Done
Updated: 2026-09-30
Next action: Follow tasks/2026-09-30-push-synth-repairs/STATUS.md for the user-authorized GitHub commit/push and verification; coordinate any separately authorized deployment with backend migration 005 and its upgrade runbook.
Blockers: none for this task; focused tests passed through the approved scratch TypeScript loader. Installed Node lacks native TypeScript stripping, so the native test failure is retained below.
WIP override: none

## Starting state

Branch `synth`, HEAD `628955cd572f4403581d042e80c324100880c57e`, clean worktree. No project-local AGENTS.md or WORKFLOW.md exists. Read shared workspace rules, README, existing publication and documentation records. Preserve unrelated content. This companion work is required by the user's Synth API/frontend synchronization scope.

## Checks

- 2026-09-30: `git status --short --branch` and `git rev-parse HEAD` exit 0; clean starting state recorded above.
- 2026-09-30: `cat AGENTS.md WORKFLOW.md` found neither file; shared WORKFLOW.md applies.
- 2026-09-30 (resume): `git status --short --branch` and `git log -5 --oneline` exit 0; existing Synth changes and task records are present at the recorded HEAD.
- 2026-09-30 (resume): `python3 scratch/synth-live-repairs/check-frontend.py test` (from GAR_B-synth) exit 0; all four focused Synth test files passed with the approved scratch TypeScript loader.
- 2026-09-30 (final): `python3 scratch/synth-live-repairs/check-frontend.py test` (from GAR_B-synth) exit 0 after final edits; all four Synth test files passed, zero failed/skipped, using approved scratch TypeScript loader.
- 2026-09-30 (final): `python3 scratch/synth-live-repairs/check-frontend.py build` (from GAR_B-synth) exit 0; strict TypeScript/Vite production build and all 16 asset checks passed. Existing Vite chunk-size warning remains.
- 2026-09-30 (final): `node --experimental-strip-types --test tests/synthApi.test.mjs tests/synthExecution.test.mjs tests/synthLive.test.mjs tests/synthView.test.mjs` exit 1: installed Node 22.22.1 lacks TypeScript support (`ERR_NO_TYPESCRIPT`). Not reported as passed.
- 2026-09-30 (final): `node contract/verify.mjs` exit 0; unchanged Box v1.23.0 pin and 52 schemas verified.
- 2026-09-30 (final): `npm run contract:types:check` exit 0; generated Box types unchanged.
- 2026-09-30 (final): `python3 scratch/gar-documentation/validate_docs.py` (from GAR_B-synth) exit 0; 7 docs/214 links, route/settings/env/table/frontend-function coverage and 6 JSON examples verified.
- 2026-09-30 (final): `python3 scratch/gar-documentation/publication_audit.py --links-only` (from GAR_B-synth) exit 0; 237 links and 43 pinned source targets checked locally.
- 2026-09-30 (final): `git diff --check` exit 0; untracked PLAN/STATUS checked with `git diff --no-index --check /dev/null <path>` and no whitespace diagnostics. Inputs and Box contract unchanged; final `git status --short --branch` exit 0 showed only intended Synth/docs/task changes.
- 2026-09-30 (handoff): workspace `bin/work status` exit 0; no unfinished tasks, 0 of 2 Doing. `git diff --check` in workspace/backend/frontend all exit 0 after task/index completion.

## Completed

- Added Synth API fields for durable recovery, verified account ownership, accounting and settlement status, and quote timestamp/coherence diagnostics.
- Updated execution, opportunity and position displays; pending/recovery positions have appropriate labels and disabled close actions, and pending P&L is shown explicitly.
- Added focused status/metric regressions and synchronized README and existing frontend documentation.
- Added `priced_qty`/`priced_avg_price` intent diagnostics matching the backend's durable cumulative-value evidence and completed final API/UI fault-boundary review.
- Completion criteria met: required labels/types/docs and regressions align with the six repaired service findings; final affected tests, build, contract and documentation checks finished.

## Reconciliation notes

- On resume, the implementation and documentation were already present although this task's previous next action still requested those edits. The actual worktree was preserved and the next action corrected to final review/validation.

## Delivery and review

- Existing deliverables: `outputs/GAR_FRONTEND_GUIDE.md`, `outputs/README.md` and updated README, alongside the focused Synth source/tests.
- Account/settlement evidence uses the existing authenticated API transport. The scoped UI provides status/instructions, as documented; a statement confirmation form, bootstrap callback capture and general REST/SSE response ordering remain independent follow-up work.
- Worktree remains uncommitted; no production release or external publication performed.
- Proposed frontend checkpoint message: `2026-09-30-synth-live-contract: synchronize recovery and settlement UI`. Review and stage the intended diff manually; no checkpoint was created automatically.
- Subsequent user request authorizes committing/pushing this completed work. [Publication status](../2026-09-30-push-synth-repairs/STATUS.md) supersedes the original uncommitted handoff and records actual commits/push results; earlier checks retain their original context.

## Relevant files

- `src/api/synth.ts`, `src/lib/synthView.ts`, `src/components/synth/`, `tests/synth*.test.mjs`
- `outputs/GAR_FRONTEND_GUIDE.md`, `outputs/README.md`
- [Backend repair task](https://github.com/Prakash2571/GAR_B/tree/synth/tasks/2026-09-30-synth-live-repairs)
