# Project Autopilot controller — agent entry

1. Read `.ai/PROJECT_CONTEXT.md` and `.ai/PROJECT_RULES.md`.
2. Run `node --test "test/*.test.mjs"` and
   `node scripts/check-workflow-security.mjs .github/workflows/` before
   claiming any change is complete.
3. Never weaken a gate to make a test pass; record counterexamples as
   regressions. Fail closed, disclose deviations, no remote writes.
