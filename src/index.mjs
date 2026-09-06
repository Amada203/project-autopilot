#!/usr/bin/env node
// CLI/action adapter. Reads JSON context from stdin or --context <file> and
// prints the run summary JSON. Never accepts private keys or raw
// organization credentials as input.
//
// Mirrors the generated project layout: autopilot_enabled comes from
// ENROLLMENT.yml, protected_paths from PROTECTED_PATHS.yml, and the
// promotion policy from POLICY.yml. A context may inline these as
// enrollmentText / protectedPathsText; defaults keep observe-only behavior.

import { readFileSync } from 'node:fs';
import { run } from './controller.mjs';
import { parseFlatYaml, parseBool, parseStringList } from './parse.mjs';

function usage() {
  console.error('Usage: autopilot --context <context.json> [--dry-run]');
  process.exit(2);
}

const args = process.argv.slice(2);
const contextFlag = args.indexOf('--context');
if (contextFlag === -1 || !args[contextFlag + 1]) usage();
const contextPath = args[contextFlag + 1];
const dryRun = args.includes('--dry-run');

const context = JSON.parse(readFileSync(contextPath, 'utf8'));
const policy = parsePolicyText(context.policyText ?? '');
policy.autopilot_enabled = context.enrollmentText
  ? parseBool('ENROLLMENT.yml', 'autopilot_enabled',
      parseFlatYaml(context.enrollmentText, 'ENROLLMENT.yml', ['schema_version', 'autopilot_enabled']).autopilot_enabled)
  : policy.autopilot_enabled;
policy.protected_paths = context.protectedPathsText
  ? parseStringList('PROTECTED_PATHS.yml', 'protected_paths',
      parseFlatYaml(context.protectedPathsText, 'PROTECTED_PATHS.yml', ['schema_version', 'protected_paths']).protected_paths)
  : policy.protected_paths;
context.policy = policy;
context.dryRun = context.dryRun ?? dryRun;

const summary = await run(context);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exitCode = summary.decision === 'DENY' || summary.decision === 'HALT' ? 1 : 0;

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
