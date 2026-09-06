import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { run } from '../src/controller.mjs';
import { FakeGithubClient } from '../src/github-client.mjs';
import { verifyGrantAgainstLedger, parseLedger } from '../src/ledger.mjs';
import { evaluateCanary } from '../src/canary.mjs';
import { constitutionText, activeLpolicy, grant, ledgerText } from './helpers.mjs';

const controllerRoot = fileURLToPath(new URL('..', import.meta.url));
const objectiveDigest = grant.task_digest;

const base = {
  constitutionText,
  controllerSha: 'a'.repeat(40),
  policy: { ...activeLpolicy, allowed_paths: ['src/'], daily_budget: 3 },
  currentState: 'ACTIVE',
  repositoryId: grant.repository_id,
  projectSlug: 'demo',
  runId: 'review-1',
  objectiveDigest: grant.task_digest,
  grant,
  ledgerText: ledgerText([{ type: 'issue', ...grant }]),
  changedPaths: ['src/app.ts'],
  changes: [{ path: 'src/app.ts', content: 'test only' }],
  dryRun: false,
};

async function ops(patch) {
  const client = new FakeGithubClient();
  const result = await run({ ...base, client, ...patch });
  return { result, writes: client.operations.map((x) => x[0]) };
}

// F1: authorization binds to the actual execution request.
test('expired, wrong-repo, wrong-objective, and out-of-scope requests write nothing', async () => {
  const expired = { ...grant, expires_at: '2000-01-01T00:00:00Z' };
  for (const patch of [
    { repositoryId: 'DifferentOwner/different-repo' },
    { objectiveDigest: 'f'.repeat(64) },
    { changedPaths: ['docs/outside.md'], changes: [{ path: 'docs/outside.md', content: 'out of scope' }] },
    { grant: expired, ledgerText: ledgerText([{ type: 'issue', ...expired }]) },
    { grant: { ...grant, branch_prefix: 'other' } },
  ]) {
    const { result, writes } = await ops(patch);
    assert.equal(result.decision, 'DENY', JSON.stringify(patch));
    assert.match(result.failureReason, /denied|granted|outside/);
    assert.deepEqual(writes, [], JSON.stringify(patch));
  }
});

// F1: ledger verification enforces expiry even for an internally valid grant.
test('verifyGrantAgainstLedger enforces the trusted clock', () => {
  const verdict = verifyGrantAgainstLedger(
    parseLedger(ledgerText([{ type: 'issue', ...grant }])),
    grant,
    { repositoryId: grant.repository_id, taskDigest: grant.task_digest, paths: ['src/x.ts'], action: 'candidate_branch', branch: 'autopilot/r', now: '2099-01-01T00:00:01Z' },
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /expired/);
});

// F3: revocation is permanent regardless of the holder epoch.
test('raised holder epoch cannot resurrect a revoked grant', () => {
  const revoked = parseLedger(ledgerText([
    { type: 'issue', ...grant },
    { type: 'revoke', grant_id: grant.grant_id, revocation_epoch: 4 },
  ]));
  for (const epoch of [1, 4, 99]) {
    const verdict = verifyGrantAgainstLedger(revoked, { ...grant, revocation_epoch: epoch });
    assert.equal(verdict.ok, false, String(epoch));
    assert.match(verdict.reason, /revoked by ledger entry/);
  }
});

// F2: declared paths cannot hide the actual protected write.
test('actual candidate content decides protected-path enforcement', async () => {
  const { result, writes } = await ops({
    changedPaths: ['src/app.ts'],
    changes: [{ path: '.ai/PROJECT_RULES.md', content: 'changed rules' }],
  });
  assert.equal(result.decision, 'DENY');
  assert.deepEqual(writes, []);
});

// F4: a pause arriving mid-run stops all subsequent side effects.
test('pause after branch creation halts commit, PR, and label', async () => {
  const client = new FakeGithubClient();
  const ctx = { ...base, client };
  const original = client.createBranch.bind(client);
  client.createBranch = async (...args) => {
    const r = await original(...args);
    ctx.pauseSignal = true;
    return r;
  };
  const result = await run(ctx);
  assert.equal(result.decision, 'HALT');
  assert.equal(result.state, 'PAUSED');
  assert.deepEqual(client.operations.map((x) => x[0]), ['createBranch']);
});

// F4: cross-run budget is bound to a ledger-reserved run id.
test('mutating runs require a ledger reservation bound to the run id', async () => {
  const reserved = ledgerText([
    { type: 'issue', ...grant },
    { type: 'consume', grant_id: grant.grant_id, run_id: 'review-1' },
  ]);
  const { result } = await ops({ ledgerText: reserved, requireRunReservation: true });
  assert.notEqual(result.decision, 'DENY');
  const { result: unreserved } = await ops({ requireRunReservation: true });
  assert.equal(unreserved.decision, 'DENY');
  assert.match(unreserved.failureReason, /reservation/);
});

// F8: FAIL evidence never returns a promotion-capable decision.
test('FAIL or missing evidence strips promotion and demands human approval', async () => {
  for (const evidence of [
    { smokeResult: 'FAIL', adversarialResult: 'FAIL' },
    {},
    { smokeResult: 'PASS', adversarialResult: 'PASS', objectiveDigest: 'd'.repeat(64) },
  ]) {
    const { result, writes } = await ops({ evidence });
    assert.equal(result.decision, 'OPEN_CANDIDATE_PR', JSON.stringify(evidence));
    assert.equal(result.requiresHumanApproval, true, JSON.stringify(evidence));
    assert.ok(writes.includes('openPullRequest'));
  }
});

// F6: --dry-run=true is honored; explicit dry-run cannot be downgraded.
test('CLI dry-run accepts all boolean forms and stays authoritative', () => {
  const temp = mkdtempSync(join(tmpdir(), 'dryrun-'));
  const context = {
    constitutionText, controllerSha: 'a'.repeat(40),
    policyText: `schema_version: 1
risk_level: L
promotion_lane: candidate_pr
auto_merge_l: false
auto_promote_m: false
production_deploy: false
daily_budget: 0
approved_test_commands: []
allowed_paths: [src/]
`,
    enrollmentText: [
      'schema_version: 1',
      'autopilot_enabled: true',
      'controller_repository: Amada203/project-autopilot',
      'controller_ref: UNCONFIGURED',
      'auto_activate_after_stage0: false',
      'requested_by: owner',
    ].join('\n'),
    protectedPathsText: 'schema_version: 1\nprotected_paths: [.ai/, .env]\n',
    currentState: 'ACTIVE',
    repositoryId: grant.repository_id,
    projectSlug: 'demo',
    runId: 'r9',
    objectiveDigest,
    grant,
    ledgerText: base.ledgerText,
    dryRun: false,
    changes: [{ path: 'src/app.ts', content: 'x' }],
  };
  const contextPath = join(temp, 'ctx.json');
  writeFileSync(contextPath, JSON.stringify(context));
  for (const flag of ['--dry-run', '--dry-run=true', '--dry-run=1']) {
    const result = spawnSync(process.execPath, [join(controllerRoot, 'src/index.mjs'), '--context', contextPath, flag], { encoding: 'utf8' });
    assert.equal(result.status, 0, flag);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.dryRun, true, flag);
    assert.equal(summary.decision, 'OPEN_CANDIDATE_PR', flag);
  }
});

// F5: the FULL generated ENROLLMENT.yml is accepted by the CLI.
test('CLI accepts the complete generated enrollment contract', () => {
  const harness = process.env.HARNESS_DIR ?? '/Users/apple/ai-full-harness';
  const temp = mkdtempSync(join(tmpdir(), 'enroll-'));
  const generated = spawnSync('bash', [join(harness, 'bin/new-full-project'), '--no-git', 'pilot', temp], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const project = join(temp, 'pilot');
  const context = {
    constitutionText: readFileSync(join(project, '.autopilot/CONSTITUTION.yml'), 'utf8'),
    policyText: readFileSync(join(project, '.autopilot/POLICY.yml'), 'utf8'),
    enrollmentText: readFileSync(join(project, '.autopilot/ENROLLMENT.yml'), 'utf8'),
    protectedPathsText: readFileSync(join(project, '.autopilot/PROTECTED_PATHS.yml'), 'utf8'),
    currentState: 'ACTIVE',
  };
  const contextPath = join(temp, 'ctx.json');
  writeFileSync(contextPath, JSON.stringify(context));
  const result = spawnSync(process.execPath, [join(controllerRoot, 'src/index.mjs'), '--context', contextPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.decision, 'OBSERVE');
});

// F5: Action-style inputs produce outputs instead of usage errors.
test('action entry reads INPUT_* and writes GITHUB_OUTPUT', () => {
  const temp = mkdtempSync(join(tmpdir(), 'action-'));
  const output = join(temp, 'github-output.txt');
  const generated = spawnSync('bash', [join(process.env.HARNESS_DIR ?? '/Users/apple/ai-full-harness', 'bin/new-full-project'), '--no-git', 'pilot', temp], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const result = spawnSync(process.execPath, [join(controllerRoot, 'src/index.mjs')], {
    encoding: 'utf8',
    cwd: temp,
    env: {
      ...process.env,
      'INPUT_PROJECT-DIRECTORY': join(temp, 'pilot'),
      'INPUT_DRY-RUN': 'true',
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: 'Amada203/pilot',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(output, 'utf8'), /decision=OBSERVE/);
});

// P2: invalid canary dates are inconclusive, never promotable.
test('invalid canary window is inconclusive', () => {
  const verdict = evaluateCanary({
    baseline: { errorRate: 0, observations: 100 },
    candidate: { errorRate: 0, observations: 100 },
    minObservations: 10, maxErrorRate: 0.1, rollbackThreshold: 0.1,
    windowExpiresAt: 'invalid-date',
  });
  assert.equal(verdict.result, 'INCONCLUSIVE');
});

// P2: quoted write-all must fail the workflow security check.
test('workflow security check rejects quoted write-all', () => {
  const temp = mkdtempSync(join(tmpdir(), 'wfsec-'));
  mkdirSync(temp, { recursive: true });
  writeFileSync(join(temp, 'probe.yml'), 'name: probe\non: workflow_dispatch\npermissions: "write-all"\njobs:\n  p:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n');
  const result = spawnSync(process.execPath, [join(controllerRoot, 'scripts/check-workflow-security.mjs'), temp], { encoding: 'utf8' });
  assert.equal(result.status, 1);
});

// F7 (harness side): allowlisted source behind an out-of-project parent
// symlink must refuse to sync.
test('knowledge-sync refuses out-of-project parent symlinks', () => {
  const harness = process.env.HARNESS_DIR ?? '/Users/apple/ai-full-harness';
  const temp = mkdtempSync(join(tmpdir(), 'kbf7-'));
  const generated = spawnSync('bash', [join(harness, 'bin/new-full-project'), '--no-git', 'pilot', temp], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const project = join(temp, 'pilot');
  const vault = join(temp, 'vault');
  mkdirSync(vault);
  const kb = join(harness, 'bin/knowledge-base');
  const args = ['--project', project, '--vault', vault, '--folder', 'pilot'];
  const preview = JSON.parse(spawnSync(process.execPath, [kb, 'preview', ...args], { encoding: 'utf8' }).stdout);
  const bind = spawnSync(process.execPath, [kb, 'bind', ...args, '--approval-ref', preview.approvalRef], { encoding: 'utf8' });
  assert.equal(bind.status, 0, bind.stderr);
  const outside = join(temp, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'PRD.md'), 'SYNTHETIC_PRIVATE_DOCUMENT_OUTSIDE_PROJECT\n');
  renameSync(join(project, 'docs/product'), join(project, 'docs/product-original'));
  symlinkSync(outside, join(project, 'docs/product'));
  const sync = spawnSync(process.execPath, [join(project, 'scripts/knowledge-sync.mjs'), 'sync'], { encoding: 'utf8' });
  const copied = (() => { try { return readFileSync(join(vault, 'pilot/docs/product/PRD.md'), 'utf8'); } catch { return ''; } })();
  assert.doesNotMatch(copied, /SYNTHETIC_PRIVATE_DOCUMENT_OUTSIDE_PROJECT/);
  assert.notEqual(sync.status, 0, sync.stdout);
});
