import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicy } from '../src/policy-evaluate.mjs';
import { parseFlatYaml, ParseError } from '../src/parse.mjs';

const basePolicy = {
  autopilot_enabled: true,
  risk_level: 'L',
  promotion_lane: 'auto_merge',
  auto_merge_l: true,
  auto_promote_m: false,
  production_deploy: false,
  protected_paths: ['.autopilot/', '.ai/', '.env'],
};

test('L lane with explicit opt-in may auto-merge', () => {
  const decision = evaluatePolicy(basePolicy, { changedPaths: ['src/app.ts'] });
  assert.equal(decision.action, 'OPEN_CANDIDATE_PR_WITH_AUTO_MERGE');
  assert.equal(decision.requiresHumanApproval, false);
});

test('auto-merge without L risk or opt-in falls back to human approval', () => {
  const decision = evaluatePolicy({ ...basePolicy, risk_level: 'M' }, { changedPaths: ['src/app.ts'] });
  assert.equal(decision.action, 'OPEN_CANDIDATE_PR');
  assert.equal(decision.requiresHumanApproval, true);
});

test('M canary lane without opt-in requires human approval', () => {
  const decision = evaluatePolicy(
    { ...basePolicy, risk_level: 'M', promotion_lane: 'canary', auto_merge_l: false },
    { changedPaths: ['src/app.ts'] },
  );
  assert.equal(decision.action, 'OPEN_CANDIDATE_PR');
  assert.equal(decision.requiresHumanApproval, true);
});

test('H risk never auto-promotes', () => {
  for (const risk of ['H', undefined]) {
    const decision = evaluatePolicy({ ...basePolicy, risk_level: risk }, { changedPaths: ['src/app.ts'] });
    assert.equal(decision.action, 'PREPARE_PLAN_ONLY');
    assert.equal(decision.requiresHumanApproval, true);
    assert.equal(decision.risk, 'H');
  }
});

test('unknown risk is treated as H', () => {
  const decision = evaluatePolicy({ ...basePolicy, risk_level: undefined }, { changedPaths: ['src/x.ts'] });
  assert.equal(decision.risk, 'H');
  assert.equal(decision.requiresHumanApproval, true);
});

test('protected paths always deny automation', () => {
  const decision = evaluatePolicy(basePolicy, { changedPaths: ['.env'] });
  assert.equal(decision.action, 'DENY');
  assert.equal(decision.touchedProtectedPath, true);
});

test('inherently protected deployment paths deny even if not listed', () => {
  for (const path of ['deploy/prod.yaml', 'infra/main.tf', 'Dockerfile', '.env.local', 'config/settings.yml']) {
    assert.equal(evaluatePolicy(basePolicy, { changedPaths: [path] }).action, 'DENY', path);
  }
});

test('disabled or observe-only never mutates', () => {
  for (const policy of [
    { ...basePolicy, autopilot_enabled: false },
    { ...basePolicy, promotion_lane: 'observe_only' },
  ]) {
    const decision = evaluatePolicy(policy, { changedPaths: ['src/app.ts'] });
    assert.equal(decision.action, 'OBSERVE');
  }
});

test('constitution violation denies everything', () => {
  const decision = evaluatePolicy(basePolicy, { changedPaths: ['src/app.ts'], constitutionViolated: true });
  assert.equal(decision.action, 'DENY');
});

test('parser rejects duplicates, unknown keys, unsafe values, and missing keys', () => {
  assert.throws(() => parseFlatYaml('risk_level: L\nrisk_level: M\n', 'p', ['risk_level']), ParseError);
  assert.throws(() => parseFlatYaml('unknown: x\n', 'p', ['risk_level']), ParseError);
  assert.throws(() => parseFlatYaml('risk_level: L; rm -rf\n', 'p', ['risk_level']), ParseError);
  assert.throws(() => parseFlatYaml('schema_version: 1\n', 'p', ['schema_version', 'risk_level']), ParseError);
});

test('parser accepts well-formed flat data', () => {
  const data = parseFlatYaml('schema_version: 1\nrisk_level: M\n', 'p', ['schema_version', 'risk_level']);
  assert.equal(data.risk_level, 'M');
});
