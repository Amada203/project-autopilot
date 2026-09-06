// Candidate branch, evidence, and draft-PR orchestration. Dry-run and
// observe/H-lane modes perform zero GitHub mutations. Run ids make repeats
// idempotent.
//
// Round-4 hardening (independent review F2/F4/F8):
// - the ONLY path set is derived from the actual candidate changes; policy
//   evaluation, grant scope, and the commit all use this one set;
// - checkHalted() is awaited before EVERY visible side effect, so a stop
//   signal arriving mid-run prevents all subsequent operations;
// - evidence gates promotion: FAIL or missing evidence can still produce a
//   diagnostic draft PR, but never a promotion-capable decision.

import { isProtectedPath } from './policy-evaluate.mjs';

export class CandidateError extends Error {}
export class HaltedError extends Error {
  constructor(state) {
    super(`run halted before external side effect: ${state}`);
    this.haltState = state;
  }
}

export function actualCandidatePaths(changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new CandidateError('candidate contains no changes');
  }
  return changes.map((change) => String(change.path));
}

function deterministicBranchName(projectSlug, objectiveDigest, runId) {
  const short = objectiveDigest.slice(0, 12);
  const safeSlug = projectSlug.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40);
  return `autopilot/${safeSlug}-${short}-${runId}`;
}

export async function prepareCandidate({
  client, repositoryId, projectSlug, runId, objectiveDigest, changes, evidence, lane,
  policy, checkHalted = async () => null,
}) {
  if (!/^[0-9a-f]{64}$/.test(objectiveDigest)) {
    throw new CandidateError('objective digest must be a SHA-256 digest of the approved objective');
  }
  const paths = actualCandidatePaths(changes);

  // F2: the full protected list (policy + inherent) applies to the ACTUAL
  // candidate paths, not to declared paths and not to an empty policy.
  const protectedContext = { protected_paths: policy?.protected_paths ?? [] };
  for (const path of paths) {
    if (isProtectedPath(path, protectedContext)) {
      throw new CandidateError(`candidate touches a protected path: ${path}`);
    }
  }

  const branchName = deterministicBranchName(projectSlug, objectiveDigest, runId);

  const body = [
    '## Autopilot candidate',
    '',
    `- Controller SHA: ${process.env.AUTOPILOT_CONTROLLER_SHA ?? 'dev'}`,
    `- Run id: ${runId}`,
    `- Objective digest: ${objectiveDigest}`,
    `- Risk: ${lane.risk}; lane decision: ${lane.action}`,
    `- Human approval required: ${lane.requiresHumanApproval}`,
    `- Evidence: smoke=${evidence.smokeResult ?? 'missing'} adversarial=${evidence.adversarialResult ?? 'missing'}`,
    '',
    '### Changed paths',
    ...paths.map((p) => `- ${p}`),
    '',
    '### Rollback plan',
    evidence.rollbackPlan ?? 'revert the candidate branch; deployment untouched',
  ].join('\n');

  const plan = { branchName, body, files: changes, paths, pr: null, mutations: [] };

  // F8: only a fully evidenced lane may carry promotion semantics.
  const promotedLane = restrictLaneToEvidence(lane, evidence, objectiveDigest);

  if (promotedLane.action === 'OBSERVE' || promotedLane.action === 'DENY' || promotedLane.action === 'PREPARE_PLAN_ONLY') {
    return { ...plan, lane: promotedLane, dryRun: true };
  }

  // F4: re-check the authoritative stop state before every side effect.
  let halted = await checkHalted();
  if (halted) throw new HaltedError(halted);
  await client.createBranch(repositoryId, branchName, client.defaultBranch ?? 'main');

  halted = await checkHalted();
  if (halted) throw new HaltedError(halted);
  await client.createCommit(
    repositoryId,
    branchName,
    changes,
    `autopilot: candidate for run ${runId}`,
  );

  halted = await checkHalted();
  if (halted) throw new HaltedError(halted);
  const pr = await client.openPullRequest(repositoryId, {
    head: branchName,
    base: client.defaultBranch ?? 'main',
    title: `autopilot(${promotedLane.risk}): run ${runId}`,
    body,
    draft: true,
  });

  halted = await checkHalted();
  if (halted) throw new HaltedError(halted);
  await client.addLabel(repositoryId, pr.number, `risk-${promotedLane.risk.toLowerCase()}`);
  return { ...plan, lane: promotedLane, dryRun: false, pr };
}

// Promotion-capable lanes require PASS smoke + adversarial evidence bound to
// the same objective digest. Anything else keeps the diagnostic draft PR but
// strips promotion and demands human approval.
export function restrictLaneToEvidence(lane, evidence, objectiveDigest) {
  const pass = (v) => v === 'PASS';
  const bound = evidence?.objectiveDigest === undefined || evidence.objectiveDigest === objectiveDigest;
  const evidenced = pass(evidence?.smokeResult) && pass(evidence?.adversarialResult) && bound;
  if (evidenced) return lane;
  if (lane.action === 'OPEN_CANDIDATE_PR_WITH_AUTO_MERGE' || lane.action === 'OPEN_CANDIDATE_PR_THEN_CANARY') {
    return {
      ...lane,
      action: 'OPEN_CANDIDATE_PR',
      requiresHumanApproval: true,
      reason: `promotion requires PASS smoke/adversarial evidence bound to objective ${objectiveDigest.slice(0, 12)}; got smoke=${evidence?.smokeResult ?? 'missing'} adversarial=${evidence?.adversarialResult ?? 'missing'}`,
    };
  }
  return lane;
}
