import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeFeedback, SensitiveFeedbackError } from '../src/feedback.mjs';

const base = {
  project_id: 'demo',
  controller_sha: 'a'.repeat(40),
  observed_failure: 'canary error rate exceeded threshold',
  violated_invariant: 'rollback signal must win',
  proposed_test: 'assert evaluateCanary returns ROLLBACK',
  risk: 'M',
};

test('clean feedback is sanitized and stays REVIEW', () => {
  const feedback = sanitizeFeedback(base);
  assert.equal(feedback.decision, 'REVIEW');
  assert.equal(feedback.observed_failure, base.observed_failure);
});

test('secrets are redacted and long fields truncated', () => {
  const feedback = sanitizeFeedback({
    ...base,
    observed_failure: `leaked: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 ${'x'.repeat(900)}`,
  });
  assert.doesNotMatch(feedback.observed_failure, /ghp_/);
  assert.match(feedback.observed_failure, /\[REDACTED\]/);
  assert.ok(feedback.observed_failure.length <= 520);
});

test('private keys and credentials are rejected, not guessed', () => {
  assert.throws(
    () => sanitizeFeedback({ ...base, observed_failure: '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----' }),
    SensitiveFeedbackError,
  );
  assert.throws(
    () => sanitizeFeedback({ ...base, observed_failure: 'customer email exposed' }),
    SensitiveFeedbackError,
  );
});

test('feedback can never claim APPROVED or APPLIED', () => {
  assert.throws(() => sanitizeFeedback({ ...base, decision: 'APPLIED' }), SensitiveFeedbackError);
  assert.throws(() => sanitizeFeedback({ ...base, decision: 'APPROVED' }), SensitiveFeedbackError);
});

test('missing required fields reject', () => {
  const { risk, ...incomplete } = base;
  assert.throws(() => sanitizeFeedback(incomplete), /risk/);
});
