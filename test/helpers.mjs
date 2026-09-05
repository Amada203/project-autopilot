import { createHash } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function hashEntry(prev, entry) {
  const copy = { ...entry };
  delete copy.entry_hash;
  const keys = Object.keys(copy).sort();
  return sha256(prev + JSON.stringify(Object.fromEntries(keys.map((k) => [k, copy[k]]))));
}

export function buildLedger(entries) {
  let prev = 'GENESIS';
  return entries.map((entry) => {
    const withPrev = { ...entry, prev_hash: prev };
    const entryHash = hashEntry(prev, withPrev);
    prev = entryHash;
    return { ...withPrev, entry_hash: entryHash };
  });
}

export function ledgerText(entries) {
  return buildLedger(entries).map((e) => JSON.stringify(e)).join('\n');
}

export const grant = {
  grant_id: 'GRANT-1',
  repository_id: 'Amada203/demo',
  task_digest: 'a'.repeat(64),
  approval_digest: 'b'.repeat(64),
  allowed_paths: ['src/'],
  branch_prefix: 'autopilot',
  allowed_actions: ['candidate_branch', 'draft_pr'],
  expires_at: '2099-01-01T00:00:00Z',
  max_runs: 3,
  revocation_epoch: 1,
};

export const issue = { type: 'issue', ...grant };

export const constitutionText = `schema_version: 1
direct_default_branch_write: false
self_approve_pull_request: false
modify_autopilot_contract: false
modify_harness_controls: false
read_or_export_secrets: false
run_candidate_code_with_secrets: false
auto_promote_high_risk: false
`;

export const activeLpolicy = {
  autopilot_enabled: true,
  risk_level: 'L',
  promotion_lane: 'auto_merge',
  auto_merge_l: true,
  auto_promote_m: false,
  production_deploy: false,
  protected_paths: ['.autopilot/', '.ai/', '.env'],
};

export const objectiveDigest = 'c'.repeat(64);
