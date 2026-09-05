import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertTransition, nextStateAfterFailure, assertRecoveryFromSafeStop, MAX_CONSECUTIVE_FAILURES,
} from '../src/state-machine.mjs';
import { verifyConstitution, verifyControllerRef, evaluateKillSwitches } from '../src/safety.mjs';

const constitutionText = (overrides = {}) => `schema_version: 1
direct_default_branch_write: ${overrides.direct_default_branch_write ?? 'false'}
self_approve_pull_request: false
modify_autopilot_contract: false
modify_harness_controls: false
read_or_export_secrets: false
run_candidate_code_with_secrets: false
auto_promote_high_risk: false
`;

test('full legal transition path', () => {
  const path = ['NEW', 'STAGE0_PASSED', 'GITHUB_CONNECTED', 'REGISTERED', 'OBSERVE_ONLY', 'ACTIVE'];
  for (const [i, from] of path.entries()) {
    const to = path[i + 1];
    if (!to) break;
    assertTransition(from, to, { reason: `step to ${to}` });
  }
  for (const to of ['PAUSED', 'SAFE_STOP']) assertTransition('ACTIVE', to);
  assertTransition('ACTIVE', 'REVOKED', { reason: 'owner revoke' });
  assertTransition('PAUSED', 'ACTIVE', { reason: 'resume' });
  assertTransition('SAFE_STOP', 'PAUSED', { reason: 'owner recovery' });
});

test('skips, reversals, duplicates, and disabled activation fail', () => {
  assert.throws(() => assertTransition('NEW', 'GITHUB_CONNECTED'));
  assert.throws(() => assertTransition('ACTIVE', 'OBSERVE_ONLY'));
  assert.throws(() => assertTransition('PAUSED', 'SAFE_STOP'));
  assert.throws(() => assertTransition('REVOKED', 'ACTIVE'));
  assert.throws(() => assertTransition('OBSERVE_ONLY', 'ACTIVE', { enabled: false }));
  assert.throws(() => assertTransition('ACTIVE', 'ACTIVE'));
});

test('privileged transitions require a reason', () => {
  assert.throws(() => assertTransition('OBSERVE_ONLY', 'ACTIVE'), /reason/);
  assert.throws(() => assertTransition('ACTIVE', 'REVOKED'), /reason/);
  assert.throws(() => assertRecoveryFromSafeStop('SAFE_STOP', 'PAUSED', '   '), /owner action reason/);
});

test('three consecutive failures trigger SAFE_STOP', () => {
  assert.equal(MAX_CONSECUTIVE_FAILURES, 3);
  assert.equal(nextStateAfterFailure('ACTIVE', 0), 'ACTIVE');
  assert.equal(nextStateAfterFailure('ACTIVE', 2), 'SAFE_STOP');
});

test('constitution pins every capability to false', () => {
  assert.equal(verifyConstitution(constitutionText()), true);
  assert.throws(() => verifyConstitution(constitutionText({ direct_default_branch_write: 'true' })), /must remain false/);
  assert.throws(
    () => verifyConstitution(constitutionText().replace('schema_version: 1', 'schema_version: 2')),
    /schema/,
  );
  assert.throws(
    () => verifyConstitution(constitutionText().replace('read_or_export_secrets: false', '')),
    /missing required key/,
  );
});

test('controller ref must be a full SHA', () => {
  verifyControllerRef('a'.repeat(40));
  assert.throws(() => verifyControllerRef('main'), /40-character/);
  assert.throws(() => verifyControllerRef('v1.2.3'), /40-character/);
});

test('kill switches halt before any action', () => {
  assert.equal(evaluateKillSwitches({}).halted, false);
  assert.equal(evaluateKillSwitches({ pauseSignal: true }).state, 'PAUSED');
  assert.equal(evaluateKillSwitches({ revokeSignal: true }).state, 'REVOKED');
  assert.equal(evaluateKillSwitches({ consecutiveFailures: 3 }).state, 'SAFE_STOP');
});
