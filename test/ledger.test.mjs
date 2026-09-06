import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLedger, verifyGrantAgainstLedger } from '../src/ledger.mjs';
import { buildLedger, ledgerText, grant } from './helpers.mjs';

test('valid ledger chain verifies and grants match', () => {
  const entries = parseLedger(ledgerText([{ type: 'issue', ...grant }]));
  const verdict = verifyGrantAgainstLedger(entries, grant);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.consumed, 0);
});

test('tampered payload fails digest verification', () => {
  const lines = ledgerText([{ type: 'issue', ...grant }]).split('\n');
  const tampered = { ...JSON.parse(lines[0]), max_runs: 99 };
  const rebuilt = buildLedger([{ type: 'issue', ...grant }])[0];
  assert.notEqual(JSON.stringify(tampered), JSON.stringify(rebuilt));
  assert.throws(() => parseLedger(JSON.stringify(tampered)), /digest verification/);
});

test('broken chain linkage fails', () => {
  const lines = ledgerText([{ type: 'issue', ...grant }]).split('\n');
  const bogus = { type: 'consume', grant_id: 'GRANT-1', run_id: 'r1', prev_hash: 'WRONG', entry_hash: 'x' };
  assert.throws(() => parseLedger([lines[0], JSON.stringify(bogus)].join('\n')), /chain/);
});

test('empty ledger fails closed', () => {
  assert.throws(() => parseLedger(''), /empty/);
});

test('never-issued, revoked, exhausted, replayed, and mismatched grants deny', () => {
  const entries = parseLedger(
    ledgerText([
      { type: 'issue', ...grant },
      { type: 'consume', grant_id: 'GRANT-1', run_id: 'r1' },
      { type: 'consume', grant_id: 'GRANT-1', run_id: 'r2' },
      { type: 'consume', grant_id: 'GRANT-1', run_id: 'r3' },
    ]),
  );
  assert.equal(verifyGrantAgainstLedger(entries, { ...grant, grant_id: 'GRANT-9' }).ok, false);
  assert.match(verifyGrantAgainstLedger(entries, grant).reason, /exhausted/);
  assert.match(verifyGrantAgainstLedger(entries, { ...grant, repository_id: "other/repo" }).reason, /repositor/);
  assert.match(verifyGrantAgainstLedger(entries, { ...grant, max_runs: 99 }).reason, /budget/);

  const partiallyConsumed = parseLedger(
    ledgerText([{ type: 'issue', ...grant }, { type: 'consume', grant_id: 'GRANT-1', run_id: 'r1' }]),
  );
  assert.match(
    verifyGrantAgainstLedger(partiallyConsumed, { ...grant, run_id: 'r1' }).reason,
    /replay/,
  );

  const revoked = parseLedger(
    ledgerText([
      { type: 'issue', ...grant },
      { type: 'revoke', grant_id: 'GRANT-1', revocation_epoch: 5, reason_ref: 'owner' },
    ]),
  );
  // F3: a revoke entry is permanent; raising the holder epoch cannot undo it.
  assert.match(verifyGrantAgainstLedger(revoked, { ...grant, revocation_epoch: 2 }).reason, /revoked by ledger entry/);
  assert.match(verifyGrantAgainstLedger(revoked, { ...grant, revocation_epoch: 5 }).reason, /revoked by ledger entry/);
  assert.match(verifyGrantAgainstLedger(revoked, { ...grant, revocation_epoch: 9 }).reason, /revoked by ledger entry/);
});

test('partial consumption stays within budget', () => {
  const entries = parseLedger(
    ledgerText([{ type: 'issue', ...grant }, { type: 'consume', grant_id: 'GRANT-1', run_id: 'r1' }]),
  );
  assert.equal(verifyGrantAgainstLedger(entries, grant).ok, true);
});

test('duplicate issuance denies', () => {
  const entries = parseLedger(ledgerText([{ type: 'issue', ...grant }, { type: 'issue', ...grant }]));
  assert.match(verifyGrantAgainstLedger(entries, grant).reason, /duplicate issuance/);
});
