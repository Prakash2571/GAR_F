# Plan: Document the GAR Synthetic frontend

Task: `2026-09-30-working-documentation` · Project: GAR_F-synth · Created: 2026-09-30 · Status: [STATUS.md](STATUS.md)

## Goal

Explain in detail how the React Synthetic workspace works and how it communicates with the standalone Go service, using the actual implementation as evidence.

## Scope

- `/synth` routing and the distinction from the public `/` and older `/box` surfaces.
- The dedicated Synthetic access gate, transport, cookies/CSRF, broker login, REST and SSE.
- State refresh, stream parsing/coalescing, screen components, settings, execution controls, positions/history, and display calculations.
- Available local tests, observed integration gaps, and detailed developer/operator documentation in `outputs/`.
- Source behavior is reviewed but not changed; no dependencies, remote calls, deployments, or commits.

## Steps

1. [x] Inspect project README, package manifest, source inventory, and Git state.
2. [x] Trace routes and every Synthetic module and compare frontend calls/types with Go handlers/views.
3. [x] Run available local frontend checks and record actual results and unavailable prerequisites.
4. [x] Deliver the detailed frontend guide and link the combined system guide and review report.
5. [x] Verify documentation references and update status/index.

## Completion criteria

- [x] A detailed Markdown guide documents component responsibilities, transport, authentication, user workflows, state updates, and backend dependencies.
- [x] Source links and request/response examples match the inspected implementation.
- [x] Actual tests and known limitations are accurately recorded.
- [x] STATUS.md and INDEX.md link final deliverables.

## Checks to run

- `npm test` or equivalent Node test invocations using an existing suitable Node toolchain; do not install dependencies.
- `node contract/verify.mjs`; type/build and asset verification only when prerequisites exist.
- Local documentation checks against routes/types/source links, plus final Git status and workspace task status.

## Risks and open decisions

- The root README still describes Synthetic as paper-only; current commits and code include live mode. Documentation must follow source behavior.
- Project node_modules is absent. Reuse existing tools where appropriate and record unavailable checks rather than claiming they passed.
