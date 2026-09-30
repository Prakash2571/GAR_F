# Plan: Synchronize Synth lifecycle and authorization compatibility

Task: `2026-09-30-synth-risk-lifecycle` · Project: GAR_F-synth · Status: [STATUS.md](STATUS.md)

Implement only the Synth frontend types/UI/tests and established guides required by the companion backend risk, authorization, shutdown and readiness repairs. Preserve Box and unrelated source. Verify the backend health/session wire shape against current Synth usage; render server readiness/entry permission and schema-supported read/full capabilities where appropriate. Run focused Synth tests, strict build, unchanged Box contract checks and existing documentation validation. No commit, push, deployment or production changes are authorized.

Subsequent authorization: the user's "push to github" request is handled by [publication plan](../2026-09-30-push-synth-risk-lifecycle/PLAN.md), superseding the no-commit/no-push handoff for this completed work. Deployment remains separate.
