#!/usr/bin/env node
// CLI / GitHub Action adapter.
//
// Round-4 hardening (independent review F5/F6):
// - accepts the FULL generated ENROLLMENT.yml (all keys) and the real
//   three-file contract layout;
// - runs as a GitHub Action by reading INPUT_* environment variables and
//   writing GITHUB_OUTPUT;
// - --dry-run accepts --dry-run, --dry-run=true/false/1/0, and an explicit
//   CLI dry-run can never be downgraded by the JSON context.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './controller.mjs';
import { parseFlatYaml, parseBool, parseStringList } from './parse.mjs';

function usage() {
  console.error('Usage: autopilot --context <context.json> [--dry-run[=true|false|1|0]]');
  console.error('       (as a GitHub Action: INPUT_PROJECT-DIRECTORY and INPUT_DRY-RUN are read)');
  process.exit(2);
}

const args = process.argv.slice(2);

function parseDryRunFlag(value) {
  if (value === undefined || value === '') return true;
  const normalized = String(value).toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  usage();
}

let contextPath = null;
let cliDryRun = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--context') {
    contextPath = args[i + 1];
    i += 1;
  } else if (args[i] === '--dry-run' || args[i].startsWith('--dry-run=')) {
    cliDryRun = parseDryRunFlag(args[i].includes('=') ? args[i].split('=')[1] : undefined);
  } else {
    usage();
  }
}

let context;
const actionProjectDir = process.env['INPUT_PROJECT-DIRECTORY'];
if (contextPath) {
  context = JSON.parse(readFileSync(contextPath, 'utf8'));
  context.repositoryToken = context.repositoryToken
    ?? process.env.AUTOPILOT_REPOSITORY_TOKEN
    ?? process.env['INPUT_REPOSITORY-TOKEN'];
} else if (actionProjectDir) {
  context = buildContextFromProject(actionProjectDir);
} else {
  usage();
}

const policy = parsePolicyText(context.policyText ?? '');
// autopilot_enabled is the security-relevant key and is mandatory; the
// remaining enrollment fields are optional and used only when present.
// Truncated owner data still fails closed on the one key that decides
// whether the controller may act at all.
if (context.enrollmentText) {
  const enrollment = parseFlatYaml(context.enrollmentText, 'ENROLLMENT.yml', [
    'schema_version', 'autopilot_enabled', 'controller_repository', 'controller_ref',
    'auto_activate_after_stage0', 'requested_by',
  ], { requireAll: false });
  const required = ['schema_version', 'autopilot_enabled'];
  for (const key of required) {
    if (!(key in enrollment)) {
      console.error(`ParseError: ENROLLMENT.yml: missing required key: ${key}`);
      process.exit(2);
    }
  }
  policy.autopilot_enabled = parseBool('ENROLLMENT.yml', 'autopilot_enabled', enrollment.autopilot_enabled);
  if (/^[0-9a-f]{40}$/.test(enrollment.controller_ref ?? '')) {
    context.expectedControllerSha = enrollment.controller_ref;
  }
}
policy.protected_paths = context.protectedPathsText
  ? parseStringList('PROTECTED_PATHS.yml', 'protected_paths',
      parseFlatYaml(context.protectedPathsText, 'PROTECTED_PATHS.yml', ['schema_version', 'protected_paths']).protected_paths)
  : policy.protected_paths;
context.policy = policy;

// F6: an explicit CLI/Action dry-run is authoritative and cannot be
// downgraded by the JSON context.
if (cliDryRun !== null) {
  context.dryRun = cliDryRun;
} else if (process.env['INPUT_DRY-RUN'] !== undefined) {
  context.dryRun = parseDryRunFlag(process.env['INPUT_DRY-RUN']);
} else if (context.dryRun === undefined) {
  context.dryRun = true;
}

const summary = await run(context);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

if (process.env.GITHUB_OUTPUT) {
  const lines = [
    `decision=${summary.decision}`,
    `state=${summary.state}`,
    `pr-number=${summary.prNumber ?? ''}`,
    `requires-human-approval=${summary.requiresHumanApproval}`,
    `failure-reason=${summary.failureReason ?? ''}`,
  ];
  writeFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`, { flag: 'a' });
}

process.exitCode = summary.decision === 'DENY' || summary.decision === 'HALT' ? 1 : 0;

function buildContextFromProject(projectDir) {
  const read = (relative) => readFileSync(join(projectDir, relative), 'utf8');
  return {
    constitutionText: read('.autopilot/CONSTITUTION.yml'),
    policyText: read('.autopilot/POLICY.yml'),
    enrollmentText: read('.autopilot/ENROLLMENT.yml'),
    protectedPathsText: read('.autopilot/PROTECTED_PATHS.yml'),
    currentState: process.env.AUTOPILOT_STATE ?? 'ACTIVE',
    repositoryId: process.env.GITHUB_REPOSITORY ?? null,
    projectSlug: process.env.GITHUB_REPOSITORY?.split('/').pop() ?? 'project',
    runId: process.env.AUTOPILOT_RUN_ID ?? process.env.GITHUB_RUN_ID ?? 'action-run',
    objectiveDigest: process.env.AUTOPILOT_OBJECTIVE_DIGEST ?? null,
  };
}

function parsePolicyText(text) {
  const data = parseFlatYaml(text, 'POLICY.yml', [
    'schema_version', 'risk_level', 'promotion_lane', 'auto_merge_l', 'auto_promote_m',
    'production_deploy', 'daily_budget', 'approved_test_commands', 'allowed_paths',
  ]);
  return {
    schema_version: data.schema_version,
    risk_level: data.risk_level,
    promotion_lane: data.promotion_lane,
    auto_merge_l: parseBool('POLICY.yml', 'auto_merge_l', data.auto_merge_l),
    auto_promote_m: parseBool('POLICY.yml', 'auto_promote_m', data.auto_promote_m),
    production_deploy: parseBool('POLICY.yml', 'production_deploy', data.production_deploy),
    daily_budget: Number(data.daily_budget),
    approved_test_commands: parseStringList('POLICY.yml', 'approved_test_commands', data.approved_test_commands),
    allowed_paths: parseStringList('POLICY.yml', 'allowed_paths', data.allowed_paths),
    autopilot_enabled: false,
    protected_paths: [],
  };
}
