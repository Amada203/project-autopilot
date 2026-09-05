// Fail-closed canary evaluation. Missing, stale, contradictory, or
// insufficient metrics never promote. A rollback signal wins over any
// promotion signal.

export function evaluateCanary(input, now = Date.now()) {
  const required = ['baseline', 'candidate', 'minObservations', 'maxErrorRate', 'rollbackThreshold', 'windowExpiresAt'];
  for (const key of required) {
    if (input[key] === undefined) {
      return verdict('INCONCLUSIVE', `missing canary input: ${key}`);
    }
  }
  const { baseline, candidate, minObservations, maxErrorRate, rollbackThreshold, windowExpiresAt } = input;

  if (Date.parse(windowExpiresAt) < now) {
    return verdict('INCONCLUSIVE', 'canary window expired without a decision');
  }
  for (const [label, metric] of [['baseline', baseline], ['candidate', candidate]]) {
    if (typeof metric !== 'object' || metric === null) {
      return verdict('INCONCLUSIVE', `${label} metric is missing`);
    }
    if (!Number.isFinite(metric.errorRate) || !Number.isFinite(metric.observations)) {
      return verdict('INCONCLUSIVE', `${label} metric values are not numeric`);
    }
    if (metric.observations < minObservations) {
      return verdict('INCONCLUSIVE', `${label} observations below the minimum (${metric.observations}/${minObservations})`);
    }
  }
  if (candidate.errorRate > baseline.errorRate + rollbackThreshold) {
    return verdict('ROLLBACK', `candidate error rate ${candidate.errorRate} exceeded the rollback threshold`);
  }
  if (candidate.errorRate <= maxErrorRate && candidate.errorRate <= baseline.errorRate + rollbackThreshold) {
    return verdict('PASS', `candidate error rate ${candidate.errorRate} within bounds`);
  }
  return verdict('INCONCLUSIVE', 'candidate within rollback bounds but above max error rate');
}

function verdict(result, reason) {
  return { result, reason };
}

// Lane enforcement after a canary. H and unknown risk never auto-promote.
export function promotionDecision(laneAction, canaryVerdict, policy) {
  if (canaryVerdict.result === 'ROLLBACK') {
    return { action: 'ROLLBACK', requiresHumanApproval: false, reason: canaryVerdict.reason };
  }
  if (canaryVerdict.result === 'INCONCLUSIVE') {
    return { action: 'PAUSE', requiresHumanApproval: true, reason: `${canaryVerdict.reason}; M canary paused without merge` };
  }
  if (laneAction === 'OPEN_CANDIDATE_PR_WITH_AUTO_MERGE' && policy.auto_merge_l === true) {
    return { action: 'AUTO_MERGE', requiresHumanApproval: false, reason: 'all required checks and canary passed in L lane' };
  }
  if (laneAction === 'OPEN_CANDIDATE_PR_THEN_CANARY' && policy.auto_promote_m === true) {
    return { action: 'AUTO_PROMOTE', requiresHumanApproval: false, reason: 'PASS canary with explicit M opt-in' };
  }
  return { action: 'WAIT_HUMAN_APPROVAL', requiresHumanApproval: true, reason: 'canary passed but policy requires human promotion' };
}
