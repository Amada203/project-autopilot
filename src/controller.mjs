// Observe/run orchestrator. Order of gates is the security boundary:
// constitution -> controller pin -> kill switches -> state -> grant/ledger ->
// policy decision -> candidate execution (dry-run unless fully authorized).

import { verifyConstitution, verifyControllerRef, evaluateKillSwitches } from './safety.mjs';
import { verifyGrantAgainstLedger, parseLedger } from './ledger.mjs';
import { evaluatePolicy } from './policy-evaluate.mjs';
import { prepareCandidate } from './candidate.mjs';

export async function run(context) {
  const summary = {
    decision: 'DENY',
    state: context.currentState ?? 'NEW',
    prNumber: null,
    requiresHumanApproval: true,
    failureReason: null,
    dryRun: true,
  };

  try {
    verifyConstitution(context.constitutionText);
    verifyControllerRef(context.controllerSha);

    const killSwitch = evaluateKillSwitches(context);
    if (killSwitch.halted) {
      return { ...summary, decision: 'HALT', state: killSwitch.state, failureReason: killSwitch.reason };
    }

    const policy = context.policy;
    if (policy.autopilot_enabled !== true || policy.promotion_lane === 'observe_only') {
      return { ...summary, decision: 'OBSERVE', requiresHumanApproval: false, failureReason: null };
    }
    if (context.currentState !== 'ACTIVE') {
      return {
        ...summary,
        decision: 'OBSERVE',
        failureReason: `controller mutations require ACTIVE state; current state is ${context.currentState}`,
      };
    }

    const lane = evaluatePolicy(policy, { changedPaths: context.changedPaths ?? [] });
    if (lane.action === 'DENY') {
      return { ...summary, failureReason: lane.reason };
    }

    const mutatingLane = lane.action !== 'OBSERVE' && lane.action !== 'PREPARE_PLAN_ONLY';
    if (mutatingLane) {
      if (!context.grant) {
        return { ...summary, failureReason: 'no grant present; remote candidate operations are disabled' };
      }
      if (!context.ledgerText) {
        return { ...summary, failureReason: 'no ledger snapshot; issuer provenance cannot be verified' };
      }
      const ledgerEntries = parseLedger(context.ledgerText);
      const ledgerVerdict = verifyGrantAgainstLedger(ledgerEntries, context.grant);
      if (!ledgerVerdict.ok) {
        return { ...summary, failureReason: `ledger verification denied: ${ledgerVerdict.reason}` };
      }
    }

    if (context.dryRun === true && mutatingLane) {
      return {
        ...summary,
        decision: lane.action,
        requiresHumanApproval: lane.requiresHumanApproval,
        dryRun: true,
        failureReason: null,
        planNote: 'dry-run: decision computed, zero GitHub mutations',
      };
    }

    if (!mutatingLane) {
      return { ...summary, decision: lane.action, requiresHumanApproval: lane.requiresHumanApproval, failureReason: null };
    }

    const candidate = await prepareCandidate({
      client: context.client,
      repositoryId: context.repositoryId,
      projectSlug: context.projectSlug,
      runId: context.runId,
      objectiveDigest: context.objectiveDigest,
      changes: context.changes ?? [],
      evidence: context.evidence ?? {},
      lane,
    });

    return {
      ...summary,
      decision: lane.action,
      state: context.currentState,
      prNumber: candidate.pr?.number ?? null,
      requiresHumanApproval: lane.requiresHumanApproval,
      dryRun: false,
      failureReason: null,
    };
  } catch (error) {
    return { ...summary, decision: 'DENY', failureReason: error.message };
  }
}
