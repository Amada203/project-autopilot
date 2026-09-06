// L/M/H promotion evaluation. Unknown risk is H. H never auto-promotes.
// Protected paths always require human review. Disabled or observe-only
// projects never mutate GitHub.

export const RISK_LEVELS = ['L', 'M', 'H'];
export const LANES = ['observe_only', 'candidate_pr', 'canary', 'auto_merge'];

export function evaluatePolicy(policy, context) {
  const { changedPaths = [], constitutionViolated = false } = context ?? {};
  const risk = RISK_LEVELS.includes(policy.risk_level) ? policy.risk_level : 'H';
  const touchedProtectedPath = changedPaths.some((p) => isProtectedPath(p, policy));

  if (constitutionViolated) {
    return deny('constitution invariant violated; refusing every action', touchedProtectedPath);
  }
  if (policy.autopilot_enabled === false || policy.promotion_lane === 'observe_only') {
    return {
      action: 'OBSERVE',
      requiresHumanApproval: false,
      reason: 'enrollment disabled or observe-only lane; no GitHub mutation',
      touchedProtectedPath,
      risk,
    };
  }
  if (touchedProtectedPath) {
    return deny('changed paths touch protected paths; human review required', true, risk);
  }
  if (risk === 'H' || policy.risk_level === undefined) {
    return {
      action: 'PREPARE_PLAN_ONLY',
      requiresHumanApproval: true,
      reason: policy.risk_level === undefined
        ? 'unknown risk is treated as H'
        : 'high-risk work always requires a named human approval',
      touchedProtectedPath,
      risk: 'H',
    };
  }
  if (policy.promotion_lane === 'auto_merge') {
    if (risk !== 'L' || policy.auto_merge_l !== true) {
      return {
        action: 'OPEN_CANDIDATE_PR',
        requiresHumanApproval: true,
        reason: 'auto-merge lane requires risk L and an explicit policy opt-in',
        touchedProtectedPath,
        risk,
      };
    }
    return {
      action: 'OPEN_CANDIDATE_PR_WITH_AUTO_MERGE',
      requiresHumanApproval: false,
      reason: 'L lane with explicit auto-merge opt-in and all checks green',
      touchedProtectedPath,
      risk,
    };
  }
  if (policy.promotion_lane === 'canary') {
    if (risk === 'M' && policy.auto_promote_m !== true) {
      return {
        action: 'OPEN_CANDIDATE_PR',
        requiresHumanApproval: true,
        reason: 'M canary promotion requires an explicit policy opt-in',
        touchedProtectedPath,
        risk,
      };
    }
    return {
      action: 'OPEN_CANDIDATE_PR_THEN_CANARY',
      requiresHumanApproval: false,
      reason: 'candidate PR followed by the defined canary and rollback window',
      touchedProtectedPath,
      risk,
    };
  }
  return {
    action: 'OPEN_CANDIDATE_PR',
    requiresHumanApproval: true,
    reason: 'candidate PR requires human merge approval',
    touchedProtectedPath,
    risk,
  };
}

function deny(reason, touchedProtectedPath, risk = 'H') {
  return { action: 'DENY', requiresHumanApproval: true, reason, touchedProtectedPath, risk };
}

// Mirrors the inherent protected-path rules enforced by the generated
// project's check-autopilot-contract.sh protected-diff mode. Directory
// segments match at ANY depth (harness case patterns are */dir/*), not only
// at the repository root.
export function isProtectedPath(path, policy) {
  const normalized = path.replaceAll('//', '/');
  const base = normalized.split('/').pop();
  const segments = normalized.split('/');
  const protectedDirs = new Set([
    'config', 'secrets', 'deploy', 'deployment', 'infra', 'k8s', 'helm', 'terraform', '.terraform',
  ]);
  if (segments.slice(0, -1).some((segment) => protectedDirs.has(segment))) {
    return true;
  }
  const inherent = [
    /^\.env(\..+)?$/, /^Dockerfile/, /^docker-compose(\..+)?\.yml$/, /^vercel\.json$/,
    /^fly\.toml$/, /^netlify\.toml$/, /^render\.yaml$/, /^.*\.pem$/, /^.*\.key$/,
    /^.*\.p12$/, /^.*\.pfx$/, /^.*\.tf$/, /^.*\.tfvars$/, /^credentials\..*$/, /^secrets\..*$/,
  ];
  if (inherent.some((re) => re.test(base))) return true;
  for (const protectedPath of policy.protected_paths ?? []) {
    if (protectedPath.endsWith('/')) {
      if (normalized === protectedPath.slice(0, -1) || normalized.startsWith(protectedPath)) return true;
    } else if (normalized === protectedPath) {
      return true;
    }
  }
  return false;
}
