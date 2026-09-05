import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/controller.mjs';
import { FakeGithubClient } from '../src/github-client.mjs';
import { constitutionText, activeLpolicy, grant, objectiveDigest, ledgerText } from './helpers.mjs';

const baseContext = {
  constitutionText,
  controllerSha: 'a'.repeat(40),
  policy: activeLpolicy,
  currentState: 'ACTIVE',
  repositoryId: 'Amada203/demo',
  projectSlug: 'demo-app',
  runId: 'r-100',
  objectiveDigest,
  changedPaths: ['src/app.ts'],
  changes: [{ path: 'src/app.ts', content: 'export {};\n' }],
  evidence: { smokeResult: 'PASS', adversarialResult: 'PASS', rollbackPlan: 'revert branch' },
  dryRun: true,
};

const withGrant = { ...baseContext, grant, ledgerText: ledgerText([{ type: 'issue', ...grant }]) };

test('disabled or observe-only projects never mutate', async () => {
  for (const policy of [
    { ...activeLpolicy, autopilot_enabled: false },
    { ...activeLpolicy, promotion_lane: 'observe_only' },
  ]) {
    const client = new FakeGithubClient();
    const summary = await run({ ...baseContext, policy, client });
    assert.equal(summary.decision, 'OBSERVE');
    assert.equal(client.operations.length, 0);
  }
});

test('non-ACTIVE state cannot mutate', async () => {
  const summary = await run({ ...withGrant, currentState: 'OBSERVE_ONLY', client: new FakeGithubClient() });
  assert.equal(summary.decision, 'OBSERVE');
  assert.match(summary.failureReason, /ACTIVE/);
});

test('kill switches halt before any decision', async () => {
  for (const [patch, expected] of [
    [{ pauseSignal: true }, 'PAUSED'],
    [{ revokeSignal: true }, 'REVOKED'],
    [{ consecutiveFailures: 3 }, 'SAFE_STOP'],
  ]) {
    const summary = await run({ ...withGrant, client: new FakeGithubClient(), ...patch });
    assert.equal(summary.decision, 'HALT');
    assert.equal(summary.state, expected);
    assert.equal(summary.prNumber, null);
  }
});

test('constitution tampering denies before anything else', async () => {
  const tampered = constitutionText.replace('read_or_export_secrets: false', 'read_or_export_secrets: true');
  const client = new FakeGithubClient();
  const summary = await run({ ...withGrant, constitutionText: tampered, client });
  assert.equal(summary.decision, 'DENY');
  assert.equal(client.operations.length, 0);
});

test('unpinned controller ref denies', async () => {
  const summary = await run({ ...withGrant, controllerSha: 'main', client: new FakeGithubClient() });
  assert.equal(summary.decision, 'DENY');
  assert.match(summary.failureReason, /40-character/);
});

test('dry-run with grant and ledger decides but performs zero mutations', async () => {
  const client = new FakeGithubClient();
  const summary = await run({ ...withGrant, client });
  assert.equal(summary.decision, 'OPEN_CANDIDATE_PR_WITH_AUTO_MERGE');
  assert.equal(summary.dryRun, true);
  assert.equal(client.operations.length, 0);
});

test('missing grant or ledger denies a mutating lane', async () => {
  const noGrant = await run({ ...baseContext, client: new FakeGithubClient() });
  assert.match(noGrant.failureReason, /no grant present/);
  const noLedger = await run({ ...baseContext, grant, client: new FakeGithubClient() });
  assert.match(noLedger.failureReason, /no ledger snapshot/);
});

test('revoked grant denies through the ledger', async () => {
  const ledger = ledgerText([
    { type: 'issue', ...grant },
    { type: 'revoke', grant_id: grant.grant_id, revocation_epoch: 4, reason_ref: 'owner' },
  ]);
  const summary = await run({ ...withGrant, ledgerText: ledger, client: new FakeGithubClient() });
  assert.equal(summary.decision, 'DENY');
  assert.match(summary.failureReason, /revoked/);
});

test('full authorized run opens exactly one draft PR with evidence', async () => {
  const client = new FakeGithubClient();
  const summary = await run({ ...withGrant, dryRun: false, client });
  assert.equal(summary.decision, 'OPEN_CANDIDATE_PR_WITH_AUTO_MERGE');
  assert.equal(summary.dryRun, false);
  assert.equal(summary.prNumber, 1);
  assert.equal(summary.requiresHumanApproval, false);
  const prOps = client.operations.filter(([op]) => op === 'openPullRequest');
  assert.equal(prOps.length, 1);
  assert.ok(client.operations.some(([op, , , label]) => op === 'addLabel' && label === 'risk-l'));
});

test('H lane in full run stays plan-only with zero mutations', async () => {
  const client = new FakeGithubClient();
  const summary = await run({
    ...withGrant,
    dryRun: false,
    policy: { ...activeLpolicy, risk_level: 'H', promotion_lane: 'candidate_pr' },
    client,
  });
  assert.equal(summary.decision, 'PREPARE_PLAN_ONLY');
  assert.equal(summary.requiresHumanApproval, true);
  assert.equal(client.operations.length, 0);
});
