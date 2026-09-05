// Sanitized, review-only feedback. Feedback is REVIEW by construction;
// sensitive content is rejected for owner confirmation rather than guessed.

export const FEEDBACK_FIELDS = [
  'project_id',
  'controller_sha',
  'observed_failure',
  'violated_invariant',
  'proposed_test',
  'risk',
];

const SECRET_PATTERNS = [
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /[A-Za-z0-9+/=_-]{40,}(?=[^A-Za-z0-9+/=_-]|$)/g,
];

export class SensitiveFeedbackError extends Error {}

export function sanitizeFeedback(input, { maxLength = 500 } = {}) {
  const sanitized = {};
  for (const field of FEEDBACK_FIELDS) {
    if (!(field in input)) throw new SensitiveFeedbackError(`feedback is missing required field: ${field}`);
    sanitized[field] = truncate(redact(String(input[field])), maxLength);
  }
  if (looksSensitive(input)) {
    throw new SensitiveFeedbackError('feedback may contain sensitive material; owner confirmation required before submission');
  }
  return { ...sanitized, decision: 'REVIEW' };
}

function redact(text) {
  let output = text.replaceAll(/\r\n/g, '\n');
  for (const pattern of SECRET_PATTERNS) {
    output = output.replaceAll(pattern, '[REDACTED]');
  }
  return output;
}

function truncate(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…[truncated]` : text;
}

function looksSensitive(input) {
  const decision = String(input.decision ?? 'REVIEW').toUpperCase();
  if (decision === 'APPLIED' || decision === 'APPROVED') {
    throw new SensitiveFeedbackError('feedback can never be submitted as APPLIED or APPROVED');
  }
  const blob = JSON.stringify(input);
  if (/password|token|secret|customer|personal|exploit|credential/i.test(blob)) {
    return true;
  }
  if (/BEGIN [A-Z ]*PRIVATE KEY/.test(blob)) {
    return true;
  }
  return false;
}
