// Observe/run orchestrator. Order of gates is the security boundary:
// constitution -> controller pin -> kill switches -> state -> grant+ledger
// bound to the ACTUAL request -> policy on ACTUAL paths -> evidence gate ->
// candidate execution (per-side-effect halt checks; dry-run unless fully
// authorized).
//
// Round-4 hardening (independent review F1/F2/F4/F8): the ledger check now
// receives the real repositoryId/objectiveDigest/paths/action/branch/runId
// and a trusted clock; the candidate path set is derived from the actual
// changes; the stop state is re-evaluated before every external side
// effect; promotion lanes require bound PASS evidence.

import { verifyConstitution, verifyControllerRef, evaluateKillSwitches } from './safety.mjs';
import { verifyGrantAgainstLedger, parseLedger } from './ledger.mjs';
import { evaluatePolicy } from './policy-evaluate.mjs';
import { prepareCandidate, HaltedError, actualCandidatePaths } from './candidate.mjs';
import { promotionDecision, evaluateCanary } from './canary.mjs';
import { RealGithubClient } from './github-client.mjs';

const MUTATING_ACTIONS = new Set([
  'OPEN_CANDIDATE_PR',
  'OPEN_CANDIDATE_PR_THEN_CANARY',
  'OPEN_CANDIDATE_PR_WITH_AUTO_MERGE',
]);

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
    // The pinned ref must match the trusted enrollment reference, not just
    // the shape of a SHA. Observe-only contexts may run without a ref; a
    // mutating run may not (checked again at the mutating gate).
    if (context.controllerSha !== undefined) {
      verifyControllerRef(context.controllerSha, context.expectedControllerSha);
    }

    // F4: kill switches are evaluated from live context state via a thunk,
    // and candidate execution re-checks before each side effect.
    const killSwitch = evaluateKillSwitches(context);
    if (killSwitch.halted) {
      return { ...summary, decision: 'HALT', state: killSwitch.state, failureReason: killSwitch.reason };
    }
    const checkHalted = async () => {
      const current = evaluateKillSwitches(context);
      return current.halted ? current.state : null;
    };

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

    // F2: one authoritative path set from the ACTUAL candidate content.
    const actualPaths = actualCandidatePaths(context.changes ?? []);
    const lane = evaluatePolicy(policy, { changedPaths: actualPaths });
    if (lane.action === 'DENY') {
      return { ...summary, failureReason: lane.reason };
    }

    const mutatingLane = MUTATING_ACTIONS.has(lane.action);
    if (mutatingLane) {
      if (!context.controllerSha) {
        return { ...summary, failureReason: 'a pinned controller ref is required for mutating runs' };
      }
      if (!context.grant) {
        return { ...summary, failureReason: 'no grant present; remote candidate operations are disabled' };
      }
      if (!context.ledgerText) {
        return { ...summary, failureReason: 'no ledger snapshot; issuer provenance cannot be verified' };
      }
      const ledgerEntries = parseLedger(context.ledgerText);
      const branchName = `autopilot/${context.projectSlug}-${String(context.objectiveDigest).slice(0, 12)}-${context.runId}`;
      // F1: authorization is bound to THIS execution request.
      const verdict = verifyGrantAgainstLedger(ledgerEntries, context.grant, {
        repositoryId: context.repositoryId,
        taskDigest: context.objectiveDigest,
        paths: actualPaths,
        action: 'candidate_branch',
        branch: branchName,
        runId: context.runId,
        now: context.now,
        requireReservation: context.requireRunReservation === true,
      });
      if (!verdict.ok) {
        return { ...summary, failureReason: `ledger verification denied: ${verdict.reason}` };
      }
    }

    if (context.dryRun !== true && !context.client && context.repositoryToken && context.repositoryId
      && String(context.repositoryId).includes('/')) {
      const [owner, repo] = String(context.repositoryId).split('/');
      context.client = new RealGithubClient({ token: context.repositoryToken, owner, repo });
    }
    if (context.dryRun !== true && mutatingLane && !context.client) {
      return { ...summary, failureReason: 'a repository token (repositoryToken) is required for a non-dry-run candidate run' };
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
      policy,
      checkHalted,
    });

    // F8: promotion semantics flow through the canary/promotion evaluator,
    // never from the bare lane name.
    let decision = candidate.lane.action;
    let requiresHumanApproval = candidate.lane.requiresHumanApproval;
    if (candidate.lane.action === 'OPEN_CANDIDATE_PR_THEN_CANARY' || candidate.lane.action === 'OPEN_CANDIDATE_PR_WITH_AUTO_MERGE') {
      // Either promotion lane needs positive verification evidence at
      // candidate time; without it the PR stays diagnostic and human-gated.
      const canaryVerdict = context.evidence?.canary
        ? context.evidence.canary
        : { result: 'INCONCLUSIVE', reason: 'no canary evidence at candidate time' };
      const promotion = promotionDecision(candidate.lane.action, canaryVerdict, policy);
      decision = promotion.action === 'AUTO_MERGE' || promotion.action === 'AUTO_PROMOTE'
        ? 'PR_READY_FOR_PROMOTION'
        : promotion.action === 'PAUSE' ? 'OPEN_CANDIDATE_PR' : decision;
      requiresHumanApproval = promotion.requiresHumanApproval;
    }

    return {
      ...summary,
      decision,
      state: context.currentState,
      prNumber: candidate.pr?.number ?? null,
      requiresHumanApproval,
      dryRun: false,
      failureReason: null,
    };
  } catch (error) {
    if (error instanceof HaltedError) {
      return { ...summary, decision: 'HALT', state: error.haltState, failureReason: error.message };
    }
    return { ...summary, decision: 'DENY', failureReason: error.message };
  }
}
