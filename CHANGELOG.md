# Changelog

## 0.1.0 — 2026-09-06

- Initial local implementation of the fail-closed controller: policy parser
  and L/M/H evaluator, exact enrollment state machine, constitution and
  controller-SHA pinning, kill switches, safe-stop, candidate branch/draft-PR
  orchestration with dry-run, fail-closed canary and promotion decisions,
  sanitized REVIEW-only feedback, and central control ledger verification.
- 52 adversarial tests: forged issuance, broken and tampered ledger chains,
  revocation, replay, budget exhaustion, protected paths, default branches,
  self-approval, H/unknown-risk non-promotion, and zero-mutation dry-runs.
- Workflow static security checker and draft-only reusable workflow.
- Deviation recorded: zero-dependency Node ESM + node:test instead of
  TypeScript/vitest/octokit (no-network local delivery; octokit integrates
  behind the narrow client interface later).
