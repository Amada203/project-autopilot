import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeGithubClient } from '../src/github-client.mjs';
import { prepareCandidate, CandidateError } from '../src/candidate.mjs';

const lane = (action, risk = 'L', requiresHumanApproval = false) => ({ action, risk, requiresHumanApproval });
const changes = [{ path: 'src/app.ts', content: 'export {};\n' }];
const digest = 'c'.repeat(64);

test('L lane creates branch, draft PR, and risk label', async () => {
  const client = new FakeGithubClient();
  const result = await prepareCandidate({
    client, repositoryId: 'Amada203/demo', projectSlug: 'demo-app', runId: 'r-1',
    objectiveDigest: digest, changes, evidence: { smokeResult: 'PASS' },
    lane: lane('OPEN_CANDIDATE_PR_WITH_AUTO_MERGE'),
  });
  assert.equal(result.dryRun, false);
  assert.match(result.branchName, /^autopilot\/demo-app-/);
  assert.equal(result.pr.draft, true);
  assert.match(result.pr.body, /Risk: L/);
  assert.match(result.pr.body, /smokeResult|PASS/);
  assert.ok(client.operations.some(([op]) => op === 'createBranch'));
  assert.ok(client.operations.some(([op, , , label]) => op === 'addLabel' && label === 'risk-l'));
});

test('H lane is plan-only with zero mutations', async () => {
  const client = new FakeGithubClient();
  const result = await prepareCandidate({
    client, repositoryId: 'Amada203/demo', projectSlug: 'demo', runId: 'r-2',
    objectiveDigest: digest, changes, evidence: {}, lane: lane('PREPARE_PLAN_ONLY', 'H', true),
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.pr, null);
  assert.equal(client.operations.length, 0);
});

test('protected and default-branch writes are refused', async () => {
  const client = new FakeGithubClient();
  await assert.rejects(
    prepareCandidate({
      client, repositoryId: 'r', projectSlug: 'p', runId: 'r-3', objectiveDigest: digest,
      changes: [{ path: '.env', content: 'x' }], evidence: {}, lane: lane('OPEN_CANDIDATE_PR'),
    }),
    CandidateError,
  );
  await assert.rejects(
    prepareCandidate({
      client, repositoryId: 'r', projectSlug: 'p', runId: 'r-4', objectiveDigest: digest,
      changes, evidence: {}, lane: lane('OPEN_CANDIDATE_PR'),
    }).then(() => client.createBranch('r', 'main', 'main')),
    /default branch/,
  );
});

test('invalid objective digest and empty changes refuse', async () => {
  const client = new FakeGithubClient();
  await assert.rejects(
    prepareCandidate({
      client, repositoryId: 'r', projectSlug: 'p', runId: 'x', objectiveDigest: 'deadbeef',
      changes, evidence: {}, lane: lane('OPEN_CANDIDATE_PR'),
    }),
    /SHA-256/,
  );
  await assert.rejects(
    prepareCandidate({
      client, repositoryId: 'r', projectSlug: 'p', runId: 'x', objectiveDigest: digest,
      changes: [], evidence: {}, lane: lane('OPEN_CANDIDATE_PR'),
    }),
    /no changes/,
  );
});

test('repeated run id is idempotent — second attempt fails on existing branch without duplication', async () => {
  const args = {
    repositoryId: 'Amada203/demo', projectSlug: 'demo', runId: 'same-run',
    objectiveDigest: digest, changes, evidence: {}, lane: lane('OPEN_CANDIDATE_PR_WITH_AUTO_MERGE'),
  };
  const client = new FakeGithubClient();
  await prepareCandidate({ client, ...args });
  const operationsAfterFirst = client.operations.length;
  await assert.rejects(prepareCandidate({ client, ...args }), /already exists/);
  assert.equal(client.operations.length, operationsAfterFirst);
});

test('fake client forbids self-approval', async () => {
  const client = new FakeGithubClient();
  await assert.rejects(client.addLabel('r', 1, 'approved'), /self-approval/);
});
