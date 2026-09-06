# Controller rules — single source of truth

- Fail closed on any missing, malformed, stale, or unauthorized input.
- The grant binds to the actual request (repository, objective, paths,
  action, branch, reserved run id, clock) at the execution point.
- Revocation is decided only by ledger entries; holder copies cannot
  resurrect it. Evidence gates promotion; FAIL/missing evidence keeps
  human approval mandatory.
- Every security counterexample from a review becomes a permanent
  regression test before the fix is considered done.
