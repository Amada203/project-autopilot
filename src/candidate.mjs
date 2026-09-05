// Candidate branch, evidence, and draft-PR orchestration. Dry-run and
// observe/H-lane modes perform zero GitHub mutations. Run ids make repeats
// idempotent.

import { isProtectedPath } from './policy-evaluate.mjs';

export class CandidateError extends Error {}

function deterministicBranchName(projectSlug, objectiveDigest, runId) {
  const short = objectiveDigest.slice(0, 12);
  const safeSlug = projectSlug.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40);
  return `autopilot/${safeSlug}-${short}-${runId}`;
}

export async function prepareCandidate({ client, repositoryId, projectSlug, runId, objectiveDigest, changes, evidence, lane }) {
  if (!/^[0-9a-f]{64}$/.test(objectiveDigest)) {
    throw new CandidateError('objective digest must be a SHA-256 digest of the approved objective');
  }
  if (changes.length === 0) throw new CandidateError('candidate contains no changes');

  const forPaths = changes.map((change) => change.path);
  for (const path of forPaths) {
    if (isProtectedPath(path, { protected_paths: [] })) {
      throw new CandidateError(`candidate touches an inherently protected path: ${path}`);
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
    '',
    '### Changed paths',
    ...forPaths.map((p) => `- ${p}`),
    '',
    '### Smoke result',
    evidence.smokeResult ?? 'not run',
    '',
    '### Adversarial result',
    evidence.adversarialResult ?? 'not run',
    '',
    '### Rollback plan',
    evidence.rollbackPlan ?? 'revert the candidate branch; deployment untouched',
  ].join('\n');

  const plan = { branchName, body, files: changes, pr: null, mutations: [] };

  if (lane.action === 'OBSERVE' || lane.action === 'DENY' || lane.action === 'PREPARE_PLAN_ONLY') {
    return { ...plan, dryRun: true };
  }

  await client.createBranch(repositoryId, branchName, client.defaultBranch ?? 'main');
  await client.createCommit(
    repositoryId,
    branchName,
    changes,
    `autopilot: candidate for run ${runId}`,
  );
  const pr = await client.openPullRequest(repositoryId, {
    head: branchName,
    base: client.defaultBranch ?? 'main',
    title: `autopilot(${lane.risk}): run ${runId}`,
    body,
    draft: true,
  });
  await client.addLabel(repositoryId, pr.number, `risk-${lane.risk.toLowerCase()}`);
  return { ...plan, dryRun: false, pr };
}
