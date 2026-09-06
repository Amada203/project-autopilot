import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProtectedPath, evaluatePolicy } from '../src/policy-evaluate.mjs';
import { verifyGrantAgainstLedger } from '../src/ledger.mjs';
import { parseLedger } from '../src/ledger.mjs';
import { buildLedger, grant } from './helpers.mjs';

// Cross-repo parity: these paths must be protected by BOTH the controller
// evaluator and the generated project's check-autopilot-contract.sh. The
// 2026-09-06 adversarial round caught nested-directory drift here.
const parityProtected = [
  'src/config/settings.yml',
  'app/deploy/x.yaml',
  'packages/secrets/key.pem',
  'services/infra/main.tf',
  'a/b/k8s/manifest.yml',
  '.env',
  '.env.local',
  'Dockerfile',
  'docker-compose.override.yml',
  'credentials.json',
  'server.key',
];

test('nested and root-level inherent protected paths deny (parity with harness)', () => {
  for (const path of parityProtected) {
    assert.equal(isProtectedPath(path, { protected_paths: [] }), true, path);
  }
});

test('normal business paths stay writable', () => {
  for (const path of ['src/app.ts', 'docs/notes.md', 'lib/exports.ts', 'configuration/readme.md']) {
    assert.equal(isProtectedPath(path, { protected_paths: [] }), false, path);
  }
});

test('policy-listed protected paths deny', () => {
  assert.equal(isProtectedPath('src/legacy/x.ts', { protected_paths: ['src/legacy/'] }), true);
  assert.equal(isProtectedPath('CODEOWNERS', { protected_paths: ['CODEOWNERS'] }), true);
});

test('protected-path touch denies a mutating lane', () => {
  const decision = evaluatePolicy(
    {
      autopilot_enabled: true, risk_level: 'L', promotion_lane: 'auto_merge',
      auto_merge_l: true, protected_paths: [],
    },
    { changedPaths: ['src/config/settings.yml'] },
  );
  assert.equal(decision.action, 'DENY');
});

test('grant numeric fields crossing the YAML/JSON boundary stay consistent', () => {
  const entries = parseLedger(
    JSON.stringify(buildLedger([{ type: 'issue', ...grant }])[0]),
  );
  const stringGrant = {
    ...grant,
    max_runs: String(grant.max_runs),
    revocation_epoch: String(grant.revocation_epoch),
  };
  assert.equal(verifyGrantAgainstLedger(entries, stringGrant).ok, true);
  assert.equal(
    verifyGrantAgainstLedger(entries, { ...grant, max_runs: 'many' }).ok,
    false,
  );
  assert.match(
    verifyGrantAgainstLedger(entries, { ...grant, revocation_epoch: 0 }).reason,
    /cannot predate/,
  );
});

test('CLI assembles policy from the generated three-file layout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-cli-'));
  const context = {
    constitutionText: `schema_version: 1
direct_default_branch_write: false
self_approve_pull_request: false
modify_autopilot_contract: false
modify_harness_controls: false
read_or_export_secrets: false
run_candidate_code_with_secrets: false
auto_promote_high_risk: false
`,
    controllerSha: 'a'.repeat(40),
    policyText: `schema_version: 1
risk_level: L
promotion_lane: observe_only
auto_merge_l: false
auto_promote_m: false
production_deploy: false
daily_budget: 0
approved_test_commands: []
allowed_paths: []
`,
    enrollmentText: `schema_version: 1
autopilot_enabled: false
controller_repository: Amada203/project-autopilot
controller_ref: UNCONFIGURED
auto_activate_after_stage0: false
requested_by: owner
`,
    protectedPathsText: `schema_version: 1
protected_paths: [.autopilot/, .ai/, .env]
`,
    currentState: 'ACTIVE',
    dryRun: true,
  };
  const contextPath = join(dir, 'context.json');
  writeFileSync(contextPath, JSON.stringify(context));
  const output = execFileSync(process.execPath, ['src/index.mjs', '--context', contextPath], {
    encoding: 'utf8',
  });
  const summary = JSON.parse(output);
  assert.equal(summary.decision, 'OBSERVE');
});
