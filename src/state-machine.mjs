// Exact enrollment state machine from the Full Harness contract.
// Identical transition table to templates/scripts/transition-autopilot.sh.

const TRANSITIONS = new Set([
  'NEW:STAGE0_PASSED',
  'STAGE0_PASSED:GITHUB_CONNECTED',
  'GITHUB_CONNECTED:REGISTERED',
  'REGISTERED:OBSERVE_ONLY',
  'OBSERVE_ONLY:ACTIVE',
  'ACTIVE:PAUSED',
  'ACTIVE:REVOKED',
  'ACTIVE:SAFE_STOP',
  'PAUSED:ACTIVE',
  'PAUSED:REVOKED',
  'SAFE_STOP:PAUSED',
  'SAFE_STOP:REVOKED',
]);

const REASON_REQUIRED = new Set(['GITHUB_CONNECTED', 'REGISTERED', 'ACTIVE', 'REVOKED']);

export class IllegalTransitionError extends Error {
  constructor(from, to) {
    super(`illegal transition: ${from} -> ${to}`);
  }
}

export function assertTransition(from, to, { reason = '', enabled = true } = {}) {
  if (from === to) throw new IllegalTransitionError(from, to);
  if (!TRANSITIONS.has(`${from}:${to}`)) throw new IllegalTransitionError(from, to);
  if (to === 'ACTIVE' && enabled !== true) {
    throw new Error('cannot enter ACTIVE while enrollment is disabled');
  }
  if (REASON_REQUIRED.has(to) || from === 'SAFE_STOP') {
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new Error(`transition to ${to} requires a non-empty owner reason`);
    }
  }
  return { from, to, reason: reason.trim() };
}

export const MAX_CONSECUTIVE_FAILURES = 3;

export function nextStateAfterFailure(currentState, consecutiveFailures) {
  return consecutiveFailures + 1 >= MAX_CONSECUTIVE_FAILURES ? 'SAFE_STOP' : currentState;
}

export function assertRecoveryFromSafeStop(from, to, reason) {
  if (from === 'SAFE_STOP' && reason.trim() === '') {
    throw new Error('recovery from SAFE_STOP requires an owner action reason');
  }
  return assertTransition(from, to, { reason });
}
