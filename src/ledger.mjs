// Central control ledger verification (docs/superpowers/specs/
// 2026-09-06-control-ledger-design.md in ai-full-harness).
// Append-only JSONL with a SHA-256 entry chain. This module only verifies;
// it never creates, repairs, or extends ledger data.
//
// Round-4 hardening (independent review F1/F3/F4):
// - verification binds the grant to the ACTUAL request (repository,
//   objective digest, candidate paths, action, branch, reserved run id,
//   trusted clock) — an internally consistent grant alone authorizes nothing;
// - revocation is decided solely by revoke entries in the ledger. A holder
//   copy can never undo a revocation by raising its own epoch; renewed
//   authority requires a new issuance event with a new grant id.

import { createHash } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function canonical(value) {
  const keys = Object.keys(value).filter((k) => k !== 'entry_hash').sort();
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, value[k]])));
}

export function parseLedger(text) {
  const entries = [];
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new Error('ledger snapshot is empty');
  let prevHash = 'GENESIS';
  for (const [index, line] of lines.entries()) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`ledger line ${index + 1} is not valid JSON`);
    }
    const { entry_hash: entryHash, ...rest } = entry;
    if (typeof entryHash !== 'string') throw new Error(`ledger line ${index + 1} lacks entry_hash`);
    if (entry.prev_hash !== prevHash) {
      throw new Error(`ledger line ${index + 1} breaks the chain (prev_hash mismatch)`);
    }
    if (sha256(entry.prev_hash + canonical(entry)) !== entryHash) {
      throw new Error(`ledger line ${index + 1} fails digest verification`);
    }
    prevHash = entryHash;
    entries.push(entry);
  }
  return entries;
}

// Verifies a locally present grant against a verified ledger snapshot AND
// the actual execution request. Returns { ok: true } or { ok: false,
// reason } — never throws for a business rejection; throws only for a
// structurally broken ledger.
//
// request: { repositoryId, taskDigest, paths, action, branch, runId, now }
// - repositoryId/taskDigest/paths/action/branch are mandatory for a
//   mutating request; omitting them yields a DENY, never an allow.
// - runId must reference a consume entry (reservation) when
//   requireReservation is true.
// - now defaults to the current time; expiry is always enforced.
export function verifyGrantAgainstLedger(entries, grant, request = {}) {
  const {
    repositoryId = null,
    taskDigest = null,
    paths = null,
    action = null,
    branch = null,
    runId = null,
    now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    requireReservation = false,
  } = request;

  // F1: the request itself must match the grant before any grant/ledger
  // comparison matters.
  if (repositoryId !== null && repositoryId !== grant.repository_id) {
    return deny(`request targets repository ${repositoryId}; grant was issued for ${grant.repository_id}`);
  }
  if (taskDigest !== null && taskDigest !== grant.task_digest) {
    return deny('request objective digest does not match the granted task objective');
  }
  // F1: a mutating request must carry the full binding; a read-only status
  // check (no request) may still verify grant/ledger consistency alone.
  const mutating = repositoryId !== null || taskDigest !== null || paths !== null
    || action !== null || branch !== null || requireReservation;
  if (mutating && (repositoryId === null || taskDigest === null || paths === null || action === null || branch === null)) {
    return deny('mutating request is missing repository, objective, paths, action, or branch binding');
  }

  const issues = entries.filter((e) => e.type === 'issue' && e.grant_id === grant.grant_id);
  if (issues.length === 0) return deny(`grant ${grant.grant_id} was never issued by the ledger`);
  if (issues.length > 1) return deny(`grant ${grant.grant_id} has duplicate issuance entries`);
  const issue = issues[0];

  for (const [grantKey, ledgerKey, label] of [
    ['repository_id', 'repository_id', 'repository identity'],
    ['task_digest', 'task_digest', 'task objective digest'],
    ['approval_digest', 'approval_digest', 'approval artifact digest'],
    ['branch_prefix', 'branch_prefix', 'branch prefix'],
    ['expires_at', 'expires_at', 'expiry'],
  ]) {
    if (grant[grantKey] !== issue[ledgerKey]) {
      return deny(`grant ${label} does not match the issued ledger entry`);
    }
  }

  const grantBudget = Number(grant.max_runs);
  const issuedBudget = Number(issue.max_runs);
  if (!Number.isInteger(grantBudget) || !Number.isInteger(issuedBudget) || grantBudget !== issuedBudget) {
    return deny('grant budget (max_runs) does not match the issued ledger entry');
  }

  const issuedEpoch = Number(issue.revocation_epoch);
  const grantEpoch = Number(grant.revocation_epoch);
  if (!Number.isInteger(issuedEpoch) || !Number.isInteger(grantEpoch) || grantEpoch < issuedEpoch) {
    return deny('grant revocation_epoch cannot predate the issued ledger entry');
  }

  // Revocation is permanent and decided only by ledger entries.
  for (const revocation of entries.filter((e) => e.type === 'revoke' && e.grant_id === grant.grant_id)) {
    if (Number(revocation.revocation_epoch) >= issuedEpoch) {
      return deny(`grant was revoked by ledger entry at epoch ${revocation.revocation_epoch}; renewed authority requires a new issuance`);
    }
  }

  // Trusted-clock expiry.
  if (typeof grant.expires_at !== 'string' || Number.isNaN(Date.parse(grant.expires_at))) {
    return deny('grant expiry is not a valid timestamp');
  }
  if (Date.parse(now) >= Date.parse(grant.expires_at)) {
    return deny(`grant expired at ${grant.expires_at}`);
  }

  const grantPaths = grant.allowed_paths ?? [];
  const grantActions = grant.allowed_actions ?? [];
  if (paths !== null) {
    for (const candidatePath of paths) {
      if (typeof candidatePath !== 'string' || candidatePath === '') {
        return deny('candidate path is empty');
      }
      const normalized = candidatePath.replaceAll('//', '/').replace(/^\.\//, '');
      if (normalized.includes('..')) return deny(`candidate path escapes the project: ${candidatePath}`);
      const inScope = grantPaths.some((scope) => {
        if (scope.endsWith('/')) return normalized === scope.slice(0, -1) || normalized.startsWith(scope);
        return normalized === scope;
      });
      if (!inScope) return deny(`candidate path is outside the granted scope: ${normalized}`);
    }
  }
  if (action !== null && !grantActions.includes(action)) {
    return deny(`action is not granted: ${action}`);
  }
  if (branch !== null) {
    const prefix = grant.branch_prefix;
    if (branch === 'main' || branch === 'master' || !branch.startsWith(`${prefix}/`)) {
      return deny(`branch is outside the granted ${prefix}/ namespace: ${branch}`);
    }
  }

  const consumed = entries.filter((e) => e.type === 'consume' && e.grant_id === grant.grant_id);
  if (consumed.length >= grantBudget) {
    return deny(`ledger budget exhausted (${consumed.length}/${grantBudget})`);
  }
  const requestRunId = runId ?? grant.run_id ?? null;
  if (requireReservation) {
    if (!requestRunId) return deny('a reserved run id is required before any external write');
    const reservation = consumed.find((e) => e.run_id === requestRunId);
    if (!reservation) return deny(`run ${requestRunId} has no ledger reservation; coordinator must reserve budget first`);
  } else if (requestRunId && consumed.some((e) => e.run_id === requestRunId)) {
    return deny(`run id was already consumed (replay): ${requestRunId}`);
  }

  return { ok: true, consumed: consumed.length };
}

function deny(reason) {
  return { ok: false, reason };
}
