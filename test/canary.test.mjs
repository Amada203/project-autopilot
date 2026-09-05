import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCanary, promotionDecision } from '../src/canary.mjs';

const good = {
  baseline: { errorRate: 0.01, observations: 500 },
  candidate: { errorRate: 0.011, observations: 500 },
  minObservations: 100,
  maxErrorRate: 0.02,
  rollbackThreshold: 0.01,
  windowExpiresAt: '2099-01-01T00:00:00Z',
};

test('healthy canary passes', () => {
  assert.equal(evaluateCanary(good).result, 'PASS');
});

test('rollback signal wins over any promotion signal', () => {
  const verdict = evaluateCanary({
    ...good,
    candidate: { errorRate: 0.05, observations: 900 },
  });
  assert.equal(verdict.result, 'ROLLBACK');
});

test('missing, insufficient, or expired inputs are inconclusive — never promoted', () => {
  assert.equal(evaluateCanary({}).result, 'INCONCLUSIVE');
  assert.equal(
    evaluateCanary({ ...good, candidate: { ...good.candidate, observations: 10 } }).result,
    'INCONCLUSIVE',
  );
  assert.equal(
    evaluateCanary({ ...good, windowExpiresAt: '2020-01-01T00:00:00Z' }).result,
    'INCONCLUSIVE',
  );
  assert.equal(evaluateCanary({ ...good, baseline: null }).result, 'INCONCLUSIVE');
  assert.equal(
    evaluateCanary({ ...good, candidate: { ...good.candidate, errorRate: NaN } }).result,
    'INCONCLUSIVE',
  );
});

test('inconclusive M canary pauses without merging', () => {
  const decision = promotionDecision('OPEN_CANDIDATE_PR_THEN_CANARY', { result: 'INCONCLUSIVE', reason: 'x' }, {});
  assert.equal(decision.action, 'PAUSE');
  assert.equal(decision.requiresHumanApproval, true);
});

test('promotion lanes respect policy opt-ins', () => {
  assert.equal(
    promotionDecision('OPEN_CANDIDATE_PR_WITH_AUTO_MERGE', { result: 'PASS' }, { auto_merge_l: true }).action,
    'AUTO_MERGE',
  );
  assert.equal(
    promotionDecision('OPEN_CANDIDATE_PR_WITH_AUTO_MERGE', { result: 'PASS' }, { auto_merge_l: false }).action,
    'WAIT_HUMAN_APPROVAL',
  );
  assert.equal(
    promotionDecision('OPEN_CANDIDATE_PR_THEN_CANARY', { result: 'PASS' }, { auto_promote_m: true }).action,
    'AUTO_PROMOTE',
  );
  assert.equal(
    promotionDecision('OPEN_CANDIDATE_PR', { result: 'PASS' }, {}).action,
    'WAIT_HUMAN_APPROVAL',
  );
});

test('rollback decision never requires or waits for automation', () => {
  const decision = promotionDecision('OPEN_CANDIDATE_PR_THEN_CANARY', { result: 'ROLLBACK', reason: 'regression' }, {});
  assert.equal(decision.action, 'ROLLBACK');
});
