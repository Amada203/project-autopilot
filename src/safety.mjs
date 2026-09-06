// Constitution pinning, controller ref pinning, kill switches, and
// repeated-failure safe-stop. Every check fails closed before any write.

import { parseFlatYaml, parseBool, ParseError } from './parse.mjs';

export const CONSTITUTION_KEYS = [
  'schema_version',
  'direct_default_branch_write',
  'self_approve_pull_request',
  'modify_autopilot_contract',
  'modify_harness_controls',
  'read_or_export_secrets',
  'run_candidate_code_with_secrets',
  'auto_promote_high_risk',
];

export function verifyConstitution(text, file = 'CONSTITUTION.yml') {
  const data = parseFlatYaml(text, file, CONSTITUTION_KEYS);
  if (data.schema_version !== '1') {
    throw new ParseError(file, 'schema_version', 'unsupported constitution schema');
  }
  for (const key of CONSTITUTION_KEYS.slice(1)) {
    if (parseBool(file, key, data[key]) !== false) {
      throw new ParseError(file, key, 'immutable constitution capability must remain false');
    }
  }
  return true;
}

export function verifyControllerRef(ref, expectedRef = null) {
  if (!/^[0-9a-f]{40}$/.test(ref)) {
    throw new Error(`controller ref must be a full 40-character SHA; got ${ref}`);
  }
  if (expectedRef !== null && ref !== expectedRef) {
    throw new Error('running controller ref does not match the trusted enrollment reference');
  }
  return true;
}

export function evaluateKillSwitches({ pauseSignal = false, revokeSignal = false, consecutiveFailures = 0 }) {
  if (revokeSignal) return { halted: true, state: 'REVOKED', reason: 'external revoke signal' };
  if (pauseSignal) return { halted: true, state: 'PAUSED', reason: 'external pause signal' };
  if (consecutiveFailures >= 3) {
    return { halted: true, state: 'SAFE_STOP', reason: 'three consecutive failed or rejected runs' };
  }
  return { halted: false };
}
