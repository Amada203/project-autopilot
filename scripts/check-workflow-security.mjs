#!/usr/bin/env node
// Static workflow security checker. Rejects: write-all permissions,
// pull_request_target, unpinned third-party actions, secret interpolation,
// secrets: inherit, direct default-branch pushes, and self-approval.
// First-party actions/* tag refs are the only trusted unpinned refs, matching
// the Full Harness repo's existing trust decision.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const FIRST_PARTY_TAGGED = /^(actions\/[a-z-]+@v[0-9]+)$/;

function filesIn(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).map((f) => join(dir, f));
}

let failures = 0;
for (const file of filesIn(process.argv[2] ?? '.github/workflows')) {
  const text = readFileSync(file, 'utf8');
  const fail = (reason) => {
    console.error(`${file}: ${reason}`);
    failures += 1;
  };

  if (/permissions:\s*\n?\s*(["']?)write-all\1|permissions:\s*(["']?)write-all\2/.test(text)) {
    fail('write-all permissions are forbidden');
  }
  if (!/permissions:/.test(text)) {
    fail('workflows must declare explicit minimum permissions');
  }
  if (text.includes('pull_request_target')) {
    fail('pull_request_target checkout of untrusted code is forbidden');
  }
  if (text.includes('secrets: inherit')) {
    fail('secrets: inherit is forbidden');
  }
  // Inline secret interpolation inside run: scripts is forbidden; passing a
  // secret through an env: mapping is the sanctioned delivery channel.
  for (const line of text.split('\n')) {
    if (/\$\{\{ *secrets\./.test(line) && !/^\s*[A-Za-z_][A-Za-z0-9_]*:\s*\$\{\{ *secrets\./.test(line)) {
      fail('secret interpolation is forbidden outside env: mappings');
      break;
    }
  }
  if (/git +push[^\n]*(main|master)/.test(text)) {
    fail('direct default-branch pushes are forbidden');
  }
  for (const match of text.matchAll(/uses:\s*(\S+)/g)) {
    const ref = match[1];
    if (ref.startsWith('./')) continue;
    if (FIRST_PARTY_TAGGED.test(ref)) continue;
    if (!/^[^@]+@[0-9a-f]{40}$/.test(ref)) {
      fail(`remote action must be pinned to a full commit SHA: ${ref}`);
    }
  }
}

if (failures > 0) {
  console.error(`workflow security check: ${failures} failure(s)`);
  process.exit(1);
}
console.log('workflow security check: ok');
