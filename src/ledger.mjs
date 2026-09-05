// Central control ledger verification (docs/superpowers/specs/
// 2026-09-06-control-ledger-design.md in ai-full-harness).
// Append-only JSONL with a SHA-256 entry chain. This module only verifies;
// it never creates, repairs, or extends ledger data.

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

// Verifies a locally present grant against a verified ledger snapshot.
// Returns { ok: true } or { ok: false, reason } — never throws for a
// business rejection; throws only for a structurally broken ledger.
export function verifyGrantAgainstLedger(entries, grant) {
  const issues = entries.filter((e) => e.type === 'issue' && e.grant_id === grant.grant_id);
  if (issues.length === 0) return { ok: false, reason: `grant ${grant.grant_id} was never issued by the ledger` };
  if (issues.length > 1) return { ok: false, reason: `grant ${grant.grant_id} has duplicate issuance entries` };
  const issue = issues[0];

  for (const [grantKey, ledgerKey] of [
    ['repository_id', 'repository_id'],
    ['task_digest', 'task_digest'],
    ['approval_digest', 'approval_digest'],
    ['branch_prefix', 'branch_prefix'],
    ['expires_at', 'expires_at'],
  ]) {
    if (grant[grantKey] !== issue[ledgerKey]) {
      return { ok: false, reason: `grant ${grantKey} does not match the issued ledger entry` };
    }
  }
  for (const listKey of ['allowed_paths', 'allowed_actions']) {
    const grantList = JSON.stringify([...(grant[listKey] ?? [])].sort());
    const ledgerList = JSON.stringify([...(issue[listKey] ?? [])].sort());
    if (grantList !== ledgerList) {
      return { ok: false, reason: `grant ${listKey} does not match the issued ledger entry` };
    }
  }
  if (grant.max_runs !== issue.max_runs) {
    return { ok: false, reason: 'grant budget does not match the issued ledger entry' };
  }

  const revocations = entries.filter((e) => e.type === 'revoke' && e.grant_id === grant.grant_id);
  for (const revocation of revocations) {
    if (revocation.revocation_epoch > grant.revocation_epoch) {
      return { ok: false, reason: `grant was revoked at epoch ${revocation.revocation_epoch}` };
    }
  }

  const consumed = entries.filter((e) => e.type === 'consume' && e.grant_id === grant.grant_id);
  if (consumed.length >= grant.max_runs) {
    return { ok: false, reason: `ledger budget exhausted (${consumed.length}/${grant.max_runs})` };
  }
  if (grant.run_id && consumed.some((e) => e.run_id === grant.run_id)) {
    return { ok: false, reason: 'run id was already consumed (replay)' };
  }

  return { ok: true, consumed: consumed.length };
}
