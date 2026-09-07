# Project Autopilot Controller

Fail-closed controller that can evolve a generated Full Harness project's
business code only under an owner-approved policy, an externally issued
narrow candidate grant, and a verified central control ledger.

**Status: source published** to the private
github.com/Amada203/project-autopilot (main = cfe4f13, 2026-09-06). This is
a source push, not a pinned release: generated projects must still pin a
release commit SHA, and the GitHub App, remote pilot, and ledger belong to
the owner-authorized central deployment checklist (see `ai-full-harness/docs/`).

## Architecture

```text
candidate job (unprivileged): contract checks -> constitution -> controller pin
  -> kill switches -> state gate -> grant + ledger verification
  -> policy lane -> candidate branch + draft PR (or dry-run decision)
```

- Merge, release, deploy, and any workflow/permission/secret change are not
  implemented and cannot be granted: the client interface does not expose
  them, and every workflow is a draft-PR-only path.
- Candidate jobs never receive privileged credentials; the reusable workflow
  separates validation from any future protected promotion job.
- Dry-run, observe-only, and H-lane runs perform zero GitHub mutations.

## Zero-dependency deviation (recorded)

The original plan specified TypeScript + vitest + octokit. This delivery is
plain Node >=20 ESM with the built-in `node:test` runner and a fake GitHub
client behind a narrow interface, so the full adversarial suite runs without
any network or npm install. Swapping in octokit behind
`src/github-client.mjs` is an integration-time change only.

## Layout

```text
src/parse.mjs            safe flat-YAML subset parser (data, never sourced)
src/policy-evaluate.mjs  L/M/H lanes; unknown risk is H; protected paths deny
src/state-machine.mjs    exact enrollment transition table + SAFE_STOP
src/safety.mjs           constitution pin, controller SHA pin, kill switches
src/ledger.mjs           central control ledger chain + grant verification
src/github-client.mjs    narrow client interface + recording fake
src/candidate.mjs        branch/evidence/draft-PR orchestration
src/canary.mjs           fail-closed canary and promotion decisions
src/feedback.mjs         sanitized REVIEW-only feedback
src/controller.mjs       gate-ordered orchestrator
src/index.mjs            CLI/action adapter (JSON context in, summary out)
scripts/check-workflow-security.mjs
test/                    52 adversarial and lane fixtures
.github/workflows/       CI + project-local autopilot run workflow
```

## Commands

```bash
node --test "test/*.test.mjs"
node scripts/check-workflow-security.mjs .github/workflows/
```

## Ledger contract

See `ai-full-harness/docs/superpowers/specs/2026-09-06-control-ledger-design.md`.
The controller only verifies ledger snapshots; it never creates, repairs, or
extends them.

## Boundary

This repository never claims evidence truthfulness, never self-approves, and
never enlarges its own authority. A malicious repository administrator
remains outside any repository-only threat model, as documented by the Full
Harness assurance boundary.

## Trust boundary note (adversarial round 2)

Harness-side checks are enforced by workflow ordering
(`needs: validate-contract`), not by controller internals; direct CLI
invocation of mutating lanes outside that workflow is an integration-time
violation. Ledger snapshot freshness (revocation lag) is an owner
ledger-operations duty recorded in the central deployment checklist.

## Release

`v0.1.0` (commit b2e5d9a, 2026-09-07) is the first pinned release tag.
Generated projects and workflows must reference this full commit SHA —
never a branch. The candidate workflow reserves budget in the owner's
durable ledger before any external write; a non-dry-run fails closed
without a persistence target.
