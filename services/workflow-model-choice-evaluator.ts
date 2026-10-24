/**
 * Whether a failed workflow step earned a model-choice offer.
 *
 * The runner declares this as a port and cannot implement it: deciding needs
 * the step's own durable evidence, which lives here. That evidence is the
 * assignment's run log — the records a Team dispatch actually writes. An
 * earlier version of this read the `agent.turn` journal, which is the
 * selected-agent *chat* stream that Team dispatch never writes to.
 *
 * One dispatch's `start` says which agent ran and on what; its `fail` says
 * why, and whether anything could have run a tool. The two are joined by
 * dispatch id, so a step where one agent spoke twice cannot have one attempt's
 * pair attributed to the other's failure.
 *
 * Three things must all hold before a user is asked anything: the agent was on
 * its *own* explicit pair, the failure is one a different model could fix, and
 * the attempt is proven to have been unable to run a tool. Anything less
 * refuses — an unreadable record is never evidence that a repeat is safe.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { AgentRunEvent, AgentRunFailure } from "../core/types.js";
import { readModelSelectionRecord } from "../contracts/agent-model-selection.js";
import type { ModelSelectionRecord } from "../contracts/agent-model-selection.js";
import {
  deriveExecutionToolEffectEvidence,
  evaluateModelChoiceEligibility,
  modelChoiceOfferId,
} from "../contracts/model-choice.js";
import type { ModelChoiceOffer } from "../contracts/model-choice.js";
import { getRuntimeDefaultModelState } from "../domains/provider/default-model-selection.js";
import type { WorkflowModelChoiceEvaluator } from "../workflows/runner.js";

export function createWorkflowModelChoiceEvaluator(): WorkflowModelChoiceEvaluator {
  return {
    async evaluate(input) {
      const attempt = await readFailedAttempt(input.childAssignmentPath);
      // Only an explicit choice can fail *as a choice*: a step that inherited
      // the application default has nothing to be displaced.
      if (!attempt || attempt.selection.source !== "agent") return undefined;

      const eligibility = evaluateModelChoiceEligibility({
        failedChoice: {
          provider: attempt.selection.provider,
          model: attempt.selection.model,
        },
        failureKind:
          attempt.failure.providerKind ?? attempt.failure.serviceCode,
        // The runner reaches this only after the attempt was given up on.
        remainingSameModelRetries: 0,
        toolEffectEvidence: deriveExecutionToolEffectEvidence({
          failurePhase: attempt.failure.phase,
          ...(attempt.failure.dispatched === false
            ? { dispatched: false }
            : {}),
        }),
        appDefault: getRuntimeDefaultModelState(),
      });
      if (!eligibility.eligible) return undefined;

      const scope = {
        kind: "task" as const,
        sessionId: input.sessionId,
        taskId: input.taskId,
      };
      return {
        offerId: modelChoiceOfferId({
          scope,
          agentName: attempt.agentName,
          expectedRevision: input.expectedRevision,
          proposedDefault: eligibility.proposedDefault,
        }),
        scope,
        agentName: attempt.agentName,
        // Carried so the approval, and the authorization it becomes, cover the
        // one invocation the user was asked about.
        logicalInvocationId: attempt.invocationId,
        expectedRevision: input.expectedRevision,
        failedChoice: {
          provider: attempt.selection.provider,
          model: attempt.selection.model,
        },
        proposedDefault: eligibility.proposedDefault,
        reason: eligibility.reason,
      } satisfies ModelChoiceOffer;
    },
  };
}

interface FailedAttempt {
  readonly agentName: string;
  /** The invocation the offer covers, so consent stays per attempt. */
  readonly invocationId: string;
  readonly selection: ModelSelectionRecord;
  readonly failure: AgentRunFailure;
}

/**
 * The attempt that failed, and the pair *that* attempt ran on.
 *
 * Joined by dispatch id rather than by taking the newest start: a step where
 * one agent spoke twice has two pairs, and attributing the wrong one would
 * offer to replace a model that did not fail. A failure with no dispatch id,
 * or one whose start recorded no selection, is not attributable and earns
 * nothing.
 */
async function readFailedAttempt(
  assignmentPath: string,
): Promise<FailedAttempt | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(
      path.join(assignmentPath, "logs", "agent-runs.jsonl"),
      "utf8",
    );
  } catch {
    return undefined;
  }

  interface Attempt {
    readonly dispatchId: string;
    readonly invocationId: string;
    agentName?: string;
    selection?: ModelSelectionRecord;
    /** Set by the attempt's first `start`; a second is contradictory. */
    started?: boolean;
    /** `undefined` until a terminal arrives; `null` for one this build cannot read. */
    terminal?: AgentRunFailure | null;
    succeeded?: boolean;
  }
  const attempts: Attempt[] = [];
  const byDispatch = new Map<string, Attempt>();

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A line this build cannot read means the history is incomplete, and an
      // incomplete history cannot show that the last attempt is the one being
      // read. Skipping it would let an older eligible failure stand in for a
      // later one nobody can see.
      return undefined;
    }
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const event = parsed as Record<string, unknown>;
    const dispatchId =
      typeof event.dispatch_id === "string" ? event.dispatch_id : undefined;
    if (!dispatchId) continue;
    const invocationId =
      typeof event.logical_invocation_id === "string"
        ? event.logical_invocation_id
        : dispatchId;

    let attempt = byDispatch.get(dispatchId);
    if (!attempt) {
      attempt = { dispatchId, invocationId };
      byDispatch.set(dispatchId, attempt);
      attempts.push(attempt);
    }

    if (event.event === "start") {
      // A stage slot re-executes under the same concrete identity — a resumed
      // chain reuses the slot, the invocation is stable, and attempts restart
      // at one. A second start under that identity is a *new* attempt whether
      // or not the first one finished: if it did, the old terminal must not
      // stand in for the new one, and if it did not, the first execution's
      // unknown effects would disappear. Clearing the old record would throw
      // that evidence away, so this refuses instead.
      if (attempt.started) return undefined;
      attempt.started = true;
      const selection = readModelSelectionRecord(event.model_selection);
      const agentName = event.agent_name;
      if (selection && typeof agentName === "string" && agentName) {
        attempt.agentName = agentName;
        attempt.selection = selection;
      }
      continue;
    }
    if (event.event === "end") {
      attempt.succeeded = true;
      continue;
    }
    if (event.event !== "fail") continue;
    // Dispatch ids repeat by design — a re-executed stage slot restarts at
    // attempt 1 with the same identity — so a second terminal under one id is
    // contradictory evidence, not an update. Overwriting would let a
    // `dispatched: false` record erase a dispatched one.
    if (attempt.terminal !== undefined) return undefined;
    // Unreadable terminals are kept as `null`, never skipped: skipping one
    // would let an older failure stand in as this step's outcome.
    attempt.terminal = readAgentRunFailure(event.failure) ?? null;
  }

  // The step's outcome belongs to its last attempt, whatever that was. An
  // attempt that succeeded, never finished, or ended in a record this build
  // cannot read is not a failure anyone may be offered a retry for.
  // Attribution is by invocation, never by log order. A pipeline wave runs its
  // members concurrently into one log, so the records interleave: taking
  // whichever dispatch appeared last would pick a member that succeeded and
  // lose the one that failed.
  const invocations = new Map<string, Attempt[]>();
  for (const attempt of attempts) {
    const existing = invocations.get(attempt.invocationId);
    if (existing) existing.push(attempt);
    else invocations.set(attempt.invocationId, [attempt]);
  }

  const failed: { attempt: Attempt; proven: boolean }[] = [];
  for (const invocation of invocations.values()) {
    // An invocation with an unfinished or unreadable attempt has no outcome
    // this build can state, so the step's history is incomplete.
    if (
      invocation.some((entry) => entry.terminal === undefined && !entry.succeeded)
    ) {
      return undefined;
    }
    if (invocation.some((entry) => entry.succeeded)) continue;
    const terminal = invocation[invocation.length - 1];
    if (!terminal?.terminal) return undefined;
    failed.push({
      attempt: terminal,
      // Retrying releases the whole invocation, so the last attempt refusing
      // before it sent anything says nothing about what an earlier one did.
      proven: invocation.every((entry) => entry.terminal?.dispatched === false),
    });
  }

  // Consent is per invocation. One offer cannot say which of two failed
  // attempts it authorizes, and approving both from one click is not consent.
  if (failed.length !== 1) return undefined;
  const [only] = failed;
  if (!only?.attempt.terminal || !only.attempt.agentName || !only.attempt.selection) {
    return undefined;
  }

  return {
    agentName: only.attempt.agentName,
    invocationId: only.attempt.invocationId,
    selection: only.attempt.selection,
    failure: only.proven
      ? only.attempt.terminal
      : { ...only.attempt.terminal, dispatched: true },
  };
}

/**
 * A recorded failure, read back rather than trusted.
 *
 * Refused whole: a half-read failure would either invent an eligibility this
 * build never decided, or lose the one fact that proves nothing ran.
 */
function readAgentRunFailure(value: unknown): AgentRunFailure | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const phase = record.phase;
  const serviceCode = record.serviceCode;
  if (typeof phase !== "string" || !PHASES.has(phase)) return undefined;
  if (typeof serviceCode !== "string" || !serviceCode) return undefined;
  return {
    phase: phase as AgentRunFailure["phase"],
    serviceCode,
    ...(typeof record.providerKind === "string"
      ? { providerKind: record.providerKind }
      : {}),
    ...(typeof record.providerCode === "string"
      ? { providerCode: record.providerCode }
      : {}),
    ...(typeof record.httpStatus === "number"
      ? { httpStatus: record.httpStatus }
      : {}),
    retryable: record.retryable === true,
    // A positive claim only. Anything that is not exactly `false` reads as
    // unknown, so a malformed record can never authorize a retry.
    ...(record.dispatched === false ? { dispatched: false } : {}),
  };
}

const PHASES = new Set<string>([
  "provider-resolution",
  "tool-discovery",
  "provider-request",
  "tool-execution",
  "artifact-publication",
]);
