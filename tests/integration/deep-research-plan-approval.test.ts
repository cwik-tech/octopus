import { requiredValue } from '../../core/required-value.js'
import { whenDefined } from '../../core/optional-properties.js'
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { startApiServer } from "../../server/api-server.js";
import {
  enforceDeepResearchPlanReadiness,
} from "../../domains/run-orchestrator/deep-research.js";
import { createRunPlan } from "../../domains/run-orchestrator/orchestrator.js";
import {
  appendApprovedResearchPlanToBrief,
  applyRunPlanService,
} from "../../services/run-orchestrator-service.js";
import {
  approveDeepResearchPlanService,
  generateDeepResearchPlanService,
  getDeepResearchPlanAttemptEventsService,
  getDeepResearchPlanAttemptService,
  startDeepResearchPlanService,
  type DeepResearchPlanRunner,
} from "../../services/deep-research-plan-service.js";
import {
  createDeepResearchPlanAttemptRecorder,
  markInterruptedDeepResearchPlanAttempt,
  readDeepResearchPlanAttempt,
} from "../../services/deep-research-plan-attempt-recorder.js";
import { DeepResearchSettingsService } from "../../services/deep-research-settings-service.js";
import { ServiceError } from "../../services/service-errors.js";
import { FileSystemSessionStore } from "../../domains/sessions/session-store.js";
import { SessionTaskRunnerLauncher } from "../../domains/sessions/session-task-launcher.js";
import {
  defaultIsProcessAlive,
  taskProcessTarget,
} from "../../domains/sessions/task-process-supervisor.js";
import { FileSystemRunStore } from "../../domains/run/run-store.js";
import { isResearchPlanApprovalValid } from "../../domains/deep-research/deep-research-approval.js";
import { createAmendedDeepResearchPlanningRevision } from "../../domains/deep-research/deep-research-plan-review.js";
import { assertResearchPlanPromptBudgets } from "../../domains/deep-research/deep-research-prompt-budget.js";
import type { DeepResearchJourneySnapshot } from "../../contracts/deep-research-journey.js";
import type { DeepResearchPlanningAttemptSnapshot } from "../../contracts/deep-research-planning.js";
import type { RunPlan } from "../../contracts/run-plan.js";
import type { SessionTask } from "../../contracts/sessions.js";
import { ProviderError } from "../../domains/provider/provider-error.js";
import { ProviderSettingsService } from "../../services/provider-settings-service.js";
import { TimeoutError } from "../../core/timeout-manager.js";

const WORKFLOW_ID = "deep-research-report";

test("a reviewer whose provider options were refused stops the review, not the draft", async () => {
  // The refusal is per Agent. A reviewer nobody can use must not be dispatched;
  // the planner that is perfectly usable must still do its work, and the
  // proposal already agreed must survive. A blanket "nothing ran" would hide
  // which Agent the problem is in and would throw away a good draft with it.
  //
  // The reviewer is only reached on an amendment, so the first proposal is
  // made with both Agents intact and the reviewer is broken afterwards.
  const fixture = await createFixture("deep-research-plan-reviewer-options-");
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    const firstProposal = await generateDeepResearchPlanService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      repoRootPath: fixture.repoRoot,
      expectedPlanId: intakeComplete.id,
      settings: fixture.settings,
      runner: async () => ({ text: JSON.stringify(plannerOutput()) }),
    });
    const amendment = enforceDeepResearchPlanReadiness({
      ...firstProposal,
      id: `${firstProposal.id}-amendment`,
      brief: `${firstProposal.brief ?? ""}\n\nAdd a separate risk comparison.`,
      deepResearchPlanning: createAmendedDeepResearchPlanningRevision({
        previous: firstProposal.deepResearchPlanning,
        previousPlan: firstProposal.researchPlan,
        previousProposalHash: firstProposal.researchPlanProposalHash,
        messageId: "message-amendment-1",
      }),
    });
    const revision = await fixture.store.reviseRunPlan(
      fixture.sessionId,
      firstProposal.id,
      amendment,
    );
    assert.equal(revision?.revised, true);

    fs.writeFileSync(
      path.join(
        fixture.repoRoot,
        "agents",
        "research-plan-reviewer",
        "research-plan-reviewer.md",
      ),
      [
        "---",
        "name: research-plan-reviewer",
        "provider: codex",
        "model: gpt-5.6-sol",
        "thinking: high",
        "ui_hidden: true",
        "provider_options: 'not-json-at-all'",
        "---",
        "Review and amend a Deep Research plan. Return JSON only.",
      ].join("\n"),
    );

    const calls: string[] = [];
    await assert.rejects(
      generateDeepResearchPlanService({
        sessionId: fixture.sessionId,
        sessionStore: fixture.store,
        repoRootPath: fixture.repoRoot,
        expectedPlanId: amendment.id,
        settings: fixture.settings,
        runner: async (options) => {
          calls.push(options.agentName ?? "");
          return { text: JSON.stringify(plannerOutput()) };
        },
      }),
      /plain provider settings/,
    );

    // The planner ran; the reviewer never did.
    assert.deepEqual(calls, ["research-planner"]);

    // The proposal already agreed is untouched — the same content and the same
    // proposal hash it had before this generation, not merely a plan that
    // still exists. A refusal must not cost the user work they already have.
    const stored = await fixture.store.getRunPlan(fixture.sessionId);
    assert.ok(stored);
    assert.deepEqual(stored.researchPlan, amendment.researchPlan);
    assert.equal(
      stored.researchPlanProposalHash,
      amendment.researchPlanProposalHash,
    );

    // Recorded as a configuration problem, and not retried: nothing about
    // these options changes between attempts. One new attempt, after the
    // successful first proposal.
    const attempts = readPlanningAttempts(fixture.workspace, fixture.sessionId);
    assert.equal(attempts.length, 2, "one new attempt, with no automatic retry");
    const summaries = attempts.map(
      (entry) =>
        readOnlyPlanningAttempt(
          fixture.workspace,
          fixture.sessionId,
          entry.attemptId,
        ).summary,
    );
    // Selected by the plan it was for, not by the outcome it had. Finding the
    // attempt by looking for a failure would assert that some attempt failed
    // and then describe it — the amendment's attempt is the one this test is
    // about, and it has to be that one that failed.
    const amended = summaries.find(
      (summary) => summary.expectedPlanId === amendment.id,
    );
    assert.ok(amended, "the amendment's own planning attempt was recorded");
    assert.equal(amended.status, "failed");
    assert.equal(amended.errorCategory, "configuration");
    assert.equal(amended.retryable, false);
    assert.match(String(amended.error), /plain provider settings/);
    // And the first proposal's attempt still stands.
    const original = summaries.find(
      (summary) => summary.expectedPlanId === intakeComplete.id,
    );
    assert.equal(original?.status, "succeeded");
  } finally {
    fixture.cleanup();
  }
});

test("a planner whose provider options were refused never runs", async () => {
  // Deep Research loads its own Agents rather than going through Team startup,
  // so the refusal Team startup performs has to be asked here too. Without it
  // the planner runs with its settings silently dropped, and a credential
  // written into the Agent file is ignored rather than reported.
  const fixture = await createFixture("deep-research-plan-refused-options-");
  try {
    fs.writeFileSync(
      path.join(
        fixture.repoRoot,
        "agents",
        "research-planner",
        "research-planner.md",
      ),
      [
        "---",
        "name: research-planner",
        "provider: codex",
        "model: gpt-5.6-terra",
        "thinking: medium",
        "ui_hidden: true",
        'provider_options: \'{"api_key":"sk-should-never-be-here"}\'',
        "---",
        "Create a strict Deep Research plan. Return JSON only.",
      ].join("\n"),
    );
    const initial = await saveInitialPlan(fixture.store);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });

    let runnerCalls = 0;
    const runner: DeepResearchPlanRunner = async () => {
      runnerCalls += 1;
      return { text: JSON.stringify(plannerOutput()) };
    };

    await assert.rejects(
      generateDeepResearchPlanService({
        sessionId: fixture.sessionId,
        sessionStore: fixture.store,
        repoRootPath: fixture.repoRoot,
        expectedPlanId: intakeComplete.id,
        settings: fixture.settings,
        runner,
      }),
      /Credentials belong in Settings/,
    );
    assert.equal(runnerCalls, 0, "the planner was never dispatched");
    // Recorded as what it is. An untyped failure is normalised to "unknown,
    // retryable", which would retry a configuration nothing about the retry
    // can change and would record a reason that never names the options.
    const attempts = readPlanningAttempts(fixture.workspace, fixture.sessionId);
    assert.equal(attempts.length, 1, "one attempt, and no retry of it");
    const attempt = readOnlyPlanningAttempt(
      fixture.workspace,
      fixture.sessionId,
      attempts[0]!.attemptId,
    );
    assert.equal(attempt.summary.expectedPlanId, intakeComplete.id);
    assert.equal(attempt.summary.status, "failed");
    assert.equal(attempt.summary.errorCategory, "configuration");
    assert.equal(attempt.summary.retryable, false);
    assert.match(String(attempt.summary.error), /Credentials belong in Settings/);
  } finally {
    fixture.cleanup();
  }
});

test("Deep Research generation uses the runtime planner, clamps settings, and requires exact approval", async () => {
  const fixture = await createFixture("deep-research-plan-service-");
  try {
    const initial = await saveInitialPlan(fixture.store);
    assert.equal(initial.status, "needs_input");
    assert.equal(initial.deepResearchIntakeComplete, false);
    assert.deepEqual(initial.requiredInputs, [
      "deep research brief details",
      "research plan",
    ]);

    let observedOptions: Parameters<DeepResearchPlanRunner>[0] | undefined;
    let runnerCalls = 0;
    const runner: DeepResearchPlanRunner = async (options) => {
      runnerCalls += 1;
      observedOptions = options;
      return { text: JSON.stringify(plannerOutput()) };
    };

    await assert.rejects(
      generateDeepResearchPlanService({
        sessionId: fixture.sessionId,
        sessionStore: fixture.store,
        repoRootPath: fixture.repoRoot,
        expectedPlanId: initial.id,
        settings: fixture.settings,
        runner,
      }),
      /Answer the Deep Research intake questions/i,
    );
    assert.equal(runnerCalls, 0);

    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    assert.equal(intakeComplete.deepResearchIntakeComplete, true);
    assert.deepEqual(intakeComplete.requiredInputs, ["research plan"]);

    const generated = await generateDeepResearchPlanService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      repoRootPath: fixture.repoRoot,
      expectedPlanId: intakeComplete.id,
      settings: fixture.settings,
      runner,
    });

    assert.equal(runnerCalls, 1);
    assert.equal(observedOptions?.agentName, "research-planner");
    assert.equal(observedOptions?.model, "gpt-5.6-terra");
    assert.equal(observedOptions?.thinking, "medium");
    assert.equal(observedOptions?.timeoutMinutes, 1.5);
    assert.match(observedOptions?.systemPrompt ?? "", /strict Deep Research plan/i);
    assert.match(
      observedOptions?.userMessage ?? "",
      /Jurisdictions may be empty only when the user explicitly chose no geographic constraint/i,
    );
    assert.match(
      observedOptions?.userMessage ?? "",
      /never treat omission as an unconstrained decision/i,
    );
    assert.match(
      observedOptions?.userMessage ?? "",
      /when the user does not specify freshness, use the latest 24 months ending at the planning date/i,
    );
    assert.match(
      observedOptions?.userMessage ?? "",
      /undated living documentation.*version observed during the run.*satisfies.*default current-state freshness/is,
    );
    assert.match(
      observedOptions?.userMessage ?? "",
      /publication or update dates.*only.*chronology.*historical cutoff/is,
    );
    assert.match(
      observedOptions?.userMessage ?? "",
      /an explicit user-supplied period overrides this default/i,
    );
    assert.match(observedOptions?.userMessage ?? "", /evidence-lane task count as small/i);
    assert.match(
      observedOptions?.userMessage ?? "",
      /regional task as communities outside the core city/i,
    );
    assert.match(
      observedOptions?.userMessage ?? "",
      /prohibit core-city subjects from satisfying that lane/i,
    );
    assert.match(observedOptions?.userMessage ?? "", /approximately 500 tokens/i);
    assert.match(observedOptions?.userMessage ?? "", /six complementary layers/i);
    assert.match(observedOptions?.userMessage ?? "", /specialistStance/i);
    assert.match(observedOptions?.userMessage ?? "", /workingDefinitions/i);
    assert.match(
      observedOptions?.userMessage ?? "",
      /only purpose is cross-lane synthesis, comparison, or report writing/i,
    );
    assert.match(
      observedOptions?.userMessage ?? "",
      /Set task\.purpose to evidence_acquisition or evidence_verification/i,
    );
    assert.match(
      JSON.stringify(observedOptions?.outputSchema),
      /"purpose":\{"type":"string","enum":\["evidence_acquisition","evidence_verification"\]\}/u,
    );
    assert.match(
      observedOptions?.userMessage ?? "",
      /Set it to 1 for a task restricted to one vendor's or authority's official sources/i,
    );
    assert.match(
      observedOptions?.userMessage ?? "",
      /never create a stop rule that the approved source scope makes impossible/i,
    );
    assert.deepEqual(observedOptions?.tools, []);
    assert.equal(observedOptions?.provider, "codex");
    assert.equal(generated.status, "needs_input");
    assert.deepEqual(generated.requiredInputs, ["research plan approval"]);
    assert.match(generated.researchPlanProposalHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(generated.researchPlan?.maxDurationMinutes, 12);
    assert.equal(generated.researchPlan?.maxResearcherAgents, 3);
    assert.equal(generated.researchPlan?.expectedPeakWorkers, 2);
    assert.equal(generated.researchPlan?.tasks[0]?.purpose, "evidence_acquisition");
    assert.equal(generated.researchPlan?.workerSpecs[0]?.limits.deadlineMs, 720_000);
    assert.deepEqual(generated.researchPlan?.authenticatedDomains, []);
    assert.equal(generated.researchPlan?.request.maxDurationMinutes, 12);
    assert.equal(generated.researchPlan?.request.maxResearcherAgents, 3);
    assert.deepEqual(generated.researchPlan?.request.authenticatedDomains, []);
    assert.equal(generated.researchPlan?.request.audience, "Enterprise technology leaders");
    const initialAttempt = readOnlyPlanningAttempt(
      fixture.workspace,
      fixture.sessionId,
    );
    assert.equal(initialAttempt.summary.retryCount, 0);
    assert.equal(initialAttempt.summary.reviewOutcome, "not_run");
    assert.equal(initialAttempt.summary.complexityClass, "simple");
    assert.ok((initialAttempt.summary.totalDurationMs ?? -1) >= 0);

    await assert.rejects(
      approveDeepResearchPlanService({
        sessionId: fixture.sessionId,
        sessionStore: fixture.store,
        expectedPlanId: generated.id,
        expectedResearchPlanHash: "0".repeat(64),
      }),
      /changed; review/i,
    );

    const approved = await approveDeepResearchPlanService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      expectedPlanId: generated.id,
      expectedResearchPlanHash: generated.researchPlanProposalHash!,
      approvedAt: "2026-07-17T12:00:00.000Z",
    });
    assert.equal(approved.status, "ready");
    assert.deepEqual(approved.requiredInputs, []);
    assert.equal(approved.researchPlan?.approvedAt, "2026-07-17T12:00:00.000Z");
    assert.equal(isResearchPlanApprovalValid(approved.researchPlan), true);
    assert.deepEqual(await fixture.store.getRunPlan(fixture.sessionId), approved);
    const launchBrief = appendApprovedResearchPlanToBrief(
      "# User brief",
      approved.researchPlan!,
    );
    assert.equal(
      launchBrief,
      `# User brief\n\n## Approved Deep Research Plan\n\n<!-- pipeline-runtime:approved-deep-research-plan:v1 -->\n${JSON.stringify(approved.researchPlan, null, 2)}\n`,
    );

    const {
      deepResearchIntakeComplete: _confirmedIntake,
      ...legacyUnconfirmed
    } = approved;
    assert.equal(
      await fixture.store.saveRunPlan(fixture.sessionId, legacyUnconfirmed),
      true,
    );
    await assert.rejects(
      generateDeepResearchPlanService({
        sessionId: fixture.sessionId,
        sessionStore: fixture.store,
        repoRootPath: fixture.repoRoot,
        expectedPlanId: legacyUnconfirmed.id,
        settings: fixture.settings,
        runner,
      }),
      /Answer the Deep Research intake questions/i,
    );
    await assert.rejects(
      approveDeepResearchPlanService({
        sessionId: fixture.sessionId,
        sessionStore: fixture.store,
        expectedPlanId: legacyUnconfirmed.id,
        expectedResearchPlanHash: legacyUnconfirmed.researchPlanProposalHash!,
      }),
      /Answer the Deep Research intake questions/i,
    );
    await assert.rejects(
      applyRunPlanService({
        sessionId: fixture.sessionId,
        sessionStore: fixture.store,
        plan: legacyUnconfirmed,
      }),
      /intake must be confirmed/i,
    );
    assert.equal(runnerCalls, 1);
    assert.equal(await fixture.store.saveRunPlan(fixture.sessionId, approved), true);

    const tampered: RunPlan = {
      ...approved,
      researchPlan: {
        ...approved.researchPlan!,
        sections: approved.researchPlan!.sections.map((section, index) =>
          index === 0 ? { ...section, title: "Changed after approval" } : section,
        ),
      },
    };
    assert.equal(await fixture.store.saveRunPlan(fixture.sessionId, tampered), true);
    await assert.rejects(
      applyRunPlanService({
        sessionId: fixture.sessionId,
        sessionStore: fixture.store,
        plan: tampered,
      }),
      /unapproved or changed/i,
    );
  } finally {
    fixture.cleanup();
  }
});

test("Deep Research plan generation and approval work through real session HTTP and filesystem storage", async () => {
  const fixture = await createFixture("deep-research-plan-http-");
  let runnerCalls = 0;
  const server = await startApiServer({
    store: new FileSystemRunStore(fixture.workspace),
    launcher: {
      async startRun(request) {
        return { launched: true, pid: 1, cwd: request.cwd };
      },
    },
    sessionStore: fixture.store,
    repoRootPath: fixture.repoRoot,
    deepResearchSettingsService: fixture.settings,
    deepResearchPlanRunner: async () => {
      runnerCalls += 1;
      return { text: JSON.stringify(plannerOutput()) };
    },
  });
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const blockedGenerationResponse = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/run-plan/research-plan`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedPlanId: initial.id }),
      },
    );
    assert.equal(blockedGenerationResponse.status, 409);
    assert.match(
      JSON.stringify(await blockedGenerationResponse.json()),
      /Answer the Deep Research intake questions/i,
    );
    assert.equal(runnerCalls, 0);

    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    const generationResponse = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/run-plan/research-plan`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedPlanId: intakeComplete.id }),
      },
    );
    assert.equal(generationResponse.status, 202);
    assert.equal(generationResponse.headers.get("cache-control"), "no-store");
    const generationPayload = (await generationResponse.json()) as {
      attempt: DeepResearchPlanningAttemptSnapshot;
    };
    assert.equal(generationPayload.attempt.status, "queued");
    const completedAttempt = await waitForTerminalPlanningAttempt(
      server.url,
      fixture.sessionId,
      generationPayload.attempt.attemptId,
    );
    assert.equal(completedAttempt.status, "succeeded");
    assert.equal(runnerCalls, 1);
    const eventsResponse = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/run-plan/research-plan/attempts/${generationPayload.attempt.attemptId}/events`,
      { headers: { accept: "text/event-stream" } },
    );
    assert.equal(eventsResponse.status, 200);
    assert.match(
      eventsResponse.headers.get("content-type") ?? "",
      /text\/event-stream/u,
    );
    const eventStream = await eventsResponse.text();
    assert.match(eventStream, /event: planning\.status/u);
    assert.match(eventStream, /"status":"succeeded"/u);
    assert.match(eventStream, /"model":"gpt-5\.6-terra"/u);
    const replayResponse = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/run-plan/research-plan/attempts/${generationPayload.attempt.attemptId}/events?from=1`,
    );
    assert.equal(replayResponse.status, 200);
    const replayStream = await replayResponse.text();
    const replaySequences = [...replayStream.matchAll(/"sequence":(\d+)/gu)]
      .map((match) => Number(match[1]));
    assert.ok(replaySequences.length > 0);
    assert.ok(replaySequences.every((sequence) => sequence >= 1));

    const beyondTailResponse = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/run-plan/research-plan/attempts/${generationPayload.attempt.attemptId}/events?from=99999`,
    );
    assert.equal(beyondTailResponse.status, 200);
    const beyondTailStream = await beyondTailResponse.text();
    assert.match(beyondTailStream, /: connected/u);
    assert.doesNotMatch(beyondTailStream, /event: planning\.status/u);

    const unknownAttemptResponse = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/run-plan/research-plan/attempts/attempt-unknown`,
    );
    assert.equal(unknownAttemptResponse.status, 404);
    const invalidSessionResponse = await fetch(
      `${server.url}/sessions/not-a-session-id/run-plan/research-plan/attempts/${generationPayload.attempt.attemptId}`,
    );
    assert.equal(invalidSessionResponse.status, 400);
    const wrongAttemptMethodResponse = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/run-plan/research-plan/attempts/${generationPayload.attempt.attemptId}`,
      { method: "POST" },
    );
    assert.equal(wrongAttemptMethodResponse.status, 405);
    const wrongEventsMethodResponse = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/run-plan/research-plan/attempts/${generationPayload.attempt.attemptId}/events`,
      { method: "POST" },
    );
    assert.equal(wrongEventsMethodResponse.status, 405);
    const generatedPlanResponse = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/run-plan`,
    );
    assert.equal(generatedPlanResponse.status, 200);
    const generatedPlanPayload = (await generatedPlanResponse.json()) as {
      plan: RunPlan;
    };
    assert.equal(generatedPlanPayload.plan.status, "needs_input");

    const staleApprovalResponse = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/run-plan/research-plan/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedPlanId: intakeComplete.id,
          expectedResearchPlanHash:
            generatedPlanPayload.plan.researchPlanProposalHash,
        }),
      },
    );
    assert.equal(staleApprovalResponse.status, 409);

    const approvalResponse = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/run-plan/research-plan/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedPlanId: generatedPlanPayload.plan.id,
          expectedResearchPlanHash:
            generatedPlanPayload.plan.researchPlanProposalHash,
        }),
      },
    );
    assert.equal(approvalResponse.status, 200);
    assert.equal(approvalResponse.headers.get("cache-control"), "no-store");
    const approvalPayload = (await approvalResponse.json()) as { plan: RunPlan };
    assert.equal(approvalPayload.plan.status, "ready");
    assert.equal(isResearchPlanApprovalValid(approvalPayload.plan.researchPlan), true);
  } finally {
    await server.close();
    fixture.cleanup();
  }
});

test("the HTTP request returns before planning completes and explicit cancellation stops the attempt", async () => {
  const fixture = await createFixture("deep-research-plan-http-cancel-");
  let markRunnerStarted!: () => void;
  const runnerStarted = new Promise<void>((resolve) => {
    markRunnerStarted = resolve;
  });
  const server = await startApiServer({
    store: new FileSystemRunStore(fixture.workspace),
    launcher: {
      async startRun(request) {
        return { launched: true, pid: 1, cwd: request.cwd };
      },
    },
    sessionStore: fixture.store,
    repoRootPath: fixture.repoRoot,
    deepResearchSettingsService: fixture.settings,
    deepResearchPlanRunner: async (options) => {
      markRunnerStarted();
      return new Promise<never>((_resolve, reject) => {
        const stop = () =>
          reject(options.signal?.reason ?? new Error("Planning cancelled"));
        if (options.signal?.aborted) {
          stop();
          return;
        }
        options.signal?.addEventListener("abort", stop, { once: true });
      });
    },
  });
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    const response = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/run-plan/research-plan`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedPlanId: intakeComplete.id }),
      },
    );
    assert.equal(response.status, 202);
    const payload = (await response.json()) as {
      attempt: DeepResearchPlanningAttemptSnapshot;
    };
    assert.equal(payload.attempt.status, "queued");
    await runnerStarted;

    const cancelResponse = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/run-plan/research-plan/attempts/${payload.attempt.attemptId}`,
      { method: "DELETE" },
    );
    assert.equal(cancelResponse.status, 202);
    const cancellationRequested = (await cancelResponse.json()) as {
      attempt: DeepResearchPlanningAttemptSnapshot;
    };
    assert.equal(cancellationRequested.attempt.status, "cancelling");
    assert.ok(cancellationRequested.attempt.cancellationRequestedAt);
    const cancelled = await waitForTerminalPlanningAttempt(
      server.url,
      fixture.sessionId,
      payload.attempt.attemptId,
    );
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.errorCategory, "cancelled");
    assert.equal(cancelled.retryable, true);
    assert.equal(
      (await fixture.store.getRunPlan(fixture.sessionId))?.researchPlan,
      undefined,
    );
  } finally {
    await server.close();
    fixture.cleanup();
  }
});

test("cancellation returns immediately and SSE stays observable when a provider ignores abort", async () => {
  const fixture = await createFixture("deep-research-plan-http-stubborn-cancel-");
  let markRunnerStarted!: () => void;
  let releaseRunner!: () => void;
  const runnerStarted = new Promise<void>((resolve) => {
    markRunnerStarted = resolve;
  });
  const runnerMayFinish = new Promise<void>((resolve) => {
    releaseRunner = resolve;
  });
  const server = await startApiServer({
    store: new FileSystemRunStore(fixture.workspace),
    launcher: {
      async startRun(request) {
        return { launched: true, pid: 1, cwd: request.cwd };
      },
    },
    sessionStore: fixture.store,
    repoRootPath: fixture.repoRoot,
    deepResearchSettingsService: fixture.settings,
    deepResearchPlanningHeartbeatMs: 10,
    deepResearchPlanRunner: async () => {
      markRunnerStarted();
      await runnerMayFinish;
      return { text: JSON.stringify(plannerOutput()) };
    },
  });
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    const generationResponse = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/run-plan/research-plan`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedPlanId: intakeComplete.id }),
      },
    );
    const generation = (await generationResponse.json()) as {
      attempt: DeepResearchPlanningAttemptSnapshot;
    };
    await runnerStarted;

    const streamController = new AbortController();
    const eventsResponse = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/run-plan/research-plan/attempts/${generation.attempt.attemptId}/events`,
      { signal: streamController.signal },
    );
    assert.equal(eventsResponse.status, 200);
    assert.ok(eventsResponse.body);
    const reader = eventsResponse.body.getReader();
    let streamText = "";
    while (!streamText.includes(": keep-alive")) {
      const chunk = await readStreamChunkWithTimeout(reader, 2_000);
      if (chunk.done) break;
      streamText += new TextDecoder().decode(chunk.value);
    }
    assert.match(streamText, /: keep-alive/u);

    const cancelStartedAt = Date.now();
    const cancelResponse = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/run-plan/research-plan/attempts/${generation.attempt.attemptId}`,
      { method: "DELETE" },
    );
    assert.equal(cancelResponse.status, 202);
    assert.ok(Date.now() - cancelStartedAt < 1_000);
    const requested = (await cancelResponse.json()) as {
      attempt: DeepResearchPlanningAttemptSnapshot;
    };
    assert.equal(requested.attempt.status, "cancelling");

    const repeatedCancelResponse = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/run-plan/research-plan/attempts/${generation.attempt.attemptId}`,
      { method: "DELETE" },
    );
    assert.equal(repeatedCancelResponse.status, 202);
    releaseRunner();
    const cancelled = await waitForTerminalPlanningAttempt(
      server.url,
      fixture.sessionId,
      generation.attempt.attemptId,
    );
    assert.equal(cancelled.status, "cancelled");
    streamController.abort();
    await reader.cancel().catch(() => undefined);
  } finally {
    releaseRunner();
    await server.close();
    fixture.cleanup();
  }
});

test("an orphaned durable attempt becomes retryable after backend restart", async () => {
  const fixture = await createFixture("deep-research-plan-restart-");
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    const recorder = await createDeepResearchPlanAttemptRecorder({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      expectedPlanId: intakeComplete.id,
      planningRevisionId: "planning-revision-before-restart",
      retryCount: 0,
    });
    await recorder.beginStage("terra", "drafting", {
      provider: "codex",
      model: "gpt-5.6-terra",
      thinking: "medium",
    });

    const recovered = await getDeepResearchPlanAttemptService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      attemptId: recorder.attemptId,
    });

    assert.equal(recovered.status, "failed");
    assert.equal(recovered.retryable, true);
    assert.equal(recovered.errorCategory, "unknown");
    assert.match(recovered.error ?? "", /application restart/u);
  } finally {
    fixture.cleanup();
  }
});

test("durable planning attempts migrate v2 snapshots and keep terminal transitions immutable", async () => {
  const fixture = await createFixture("deep-research-plan-attempt-v3-");
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    const recorder = await createDeepResearchPlanAttemptRecorder({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      expectedPlanId: intakeComplete.id,
      planningRevisionId: "planning-revision-v2",
      retryCount: 0,
    });
    await recorder.beginStage("terra", "drafting");
    const attemptFile = path.join(
      fixture.workspace,
      "sessions",
      fixture.sessionId,
      recorder.relativePath,
      "attempt.json",
    );
    const legacy = JSON.parse(fs.readFileSync(attemptFile, "utf8")) as {
      schemaVersion: number;
      revision?: number;
      events: Array<{
        sequence: number;
        snapshot: { schemaVersion: number; revision?: number };
      }>;
    };
    legacy.schemaVersion = 2;
    delete legacy.revision;
    for (const event of legacy.events) {
      event.snapshot.schemaVersion = 2;
      delete event.snapshot.revision;
    }
    fs.writeFileSync(attemptFile, `${JSON.stringify(legacy, null, 2)}\n`);

    const migrated = await readDeepResearchPlanAttempt({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      attemptId: recorder.attemptId,
    });
    assert.equal(migrated?.schemaVersion, 3);
    assert.equal(migrated?.revision, legacy.events.at(-1)?.sequence);

    await recorder.complete("superseded", {
      error: "Planning was superseded by newer user changes.",
      errorCategory: "superseded",
      retryable: false,
    });
    const terminal = await readDeepResearchPlanAttempt({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      attemptId: recorder.attemptId,
    });
    assert.equal(terminal?.status, "superseded");
    const terminalRevision = terminal?.revision;

    await Promise.all([
      recorder.complete("failed", {
        error: "Late recorder failure.",
        errorCategory: "unknown",
        retryable: true,
      }),
      recorder.completeStage("terra"),
      markInterruptedDeepResearchPlanAttempt({
        sessionId: fixture.sessionId,
        sessionStore: fixture.store,
        attemptId: recorder.attemptId,
      }),
    ]);
    const stable = await readDeepResearchPlanAttempt({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      attemptId: recorder.attemptId,
    });
    assert.equal(stable?.schemaVersion, 3);
    assert.equal(stable?.status, "superseded");
    assert.equal(stable?.retryable, false);
    assert.equal(stable?.revision, terminalRevision);
    const persisted = JSON.parse(fs.readFileSync(attemptFile, "utf8")) as {
      schemaVersion: number;
    };
    assert.equal(persisted.schemaVersion, 3);
  } finally {
    fixture.cleanup();
  }
});

test("Deep Research completes the approved HTTP lifecycle through launch, journey projection, and artifact download", async () => {
  const fixture = await createFixture("deep-research-http-lifecycle-");
  const repoRootPath = process.cwd();
  const previousDryRun = process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN;
  const previousPath = process.env.PATH;
  const previousCliPathFallback = process.env.PIPELINE_CLI_PATH_FALLBACK;
  const binDirectory = path.join(fixture.workspace, "test-bin");
  writeCodexPreflightFixture(binDirectory);
  process.env.PATH = `${binDirectory}${path.delimiter}${previousPath ?? ""}`;
  process.env.PIPELINE_CLI_PATH_FALLBACK = "0";
  process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN = "1";
  const providerSettingsService = new ProviderSettingsService({
    storagePath: path.join(fixture.workspace, "provider-settings.json"),
  });
  await providerSettingsService.listCliAgents(true);
  await providerSettingsService.setCliModelEnabled("codex", "gpt-5.5", true);
  const server = await startApiServer({
    store: new FileSystemRunStore(fixture.workspace),
    launcher: {
      async startRun(request) {
        return { launched: true, pid: process.pid, cwd: request.cwd };
      },
    },
    taskLauncher: new SessionTaskRunnerLauncher(repoRootPath),
    sessionStore: fixture.store,
    repoRootPath,
    workspacePath: fixture.workspace,
    workflowsRegistryPath: path.join(
      repoRootPath,
      "workflows",
      "registry.yaml",
    ),
    deepResearchSettingsService: fixture.settings,
    providerSettingsService,
    deepResearchPlanRunner: async () => ({
      text: JSON.stringify(plannerOutput()),
    }),
  });
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    const generationResponse = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/run-plan/research-plan`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedPlanId: intakeComplete.id }),
      },
    );
    assert.equal(generationResponse.status, 202);
    const generationPayload = (await generationResponse.json()) as {
      attempt: DeepResearchPlanningAttemptSnapshot;
    };
    const completedAttempt = await waitForTerminalPlanningAttempt(
      server.url,
      fixture.sessionId,
      generationPayload.attempt.attemptId,
    );
    assert.equal(completedAttempt.status, "succeeded");
    const generatedResponse = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/run-plan`,
    );
    assert.equal(generatedResponse.status, 200);
    const generated = (await generatedResponse.json()) as { plan: RunPlan };

    const approvalResponse = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/run-plan/research-plan/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedPlanId: generated.plan.id,
          expectedResearchPlanHash:
            generated.plan.researchPlanProposalHash,
        }),
      },
    );
    assert.equal(approvalResponse.status, 200);
    const approved = (await approvalResponse.json()) as { plan: RunPlan };
    assert.equal(approved.plan.status, "ready");

    const launchResponse = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/tasks`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflowId: WORKFLOW_ID }),
      },
    );
    const launchBody = await launchResponse.text();
    assert.equal(launchResponse.status, 202, launchBody);
    const launched = JSON.parse(launchBody) as SessionTask;
    assert.equal(launched.runPlanId, approved.plan.id);
    assert.equal(launched.workflowId, WORKFLOW_ID);

    const completed = await waitForTerminalTask(
      server.url,
      fixture.sessionId,
      launched.id,
    );
    assert.equal(completed.status, "done", completed.error);
    const completedProcessTarget = requiredValue(
      taskProcessTarget(completed),
      "completed Deep Research task process target",
    );
    assert.ok(completed.assignmentPath);
    assert.match(
      fs.readFileSync(
        path.join(completed.assignmentPath, "job-request.md"),
        "utf8",
      ),
      /pipeline-runtime:approved-deep-research-plan:v1/u,
    );
    assert.match(
      fs.readFileSync(
        path.join(completed.assignmentPath, "job-request.md"),
        "utf8",
      ),
      new RegExp(approved.plan.researchPlan!.approvalHash!),
    );

    const journeyResponse = await fetch(
      `${server.url}/sessions/${fixture.sessionId}/tasks/${launched.id}/deep-research`,
    );
    assert.equal(journeyResponse.status, 200);
    assert.equal(journeyResponse.headers.get("cache-control"), "no-store");
    const journey =
      (await journeyResponse.json()) as DeepResearchJourneySnapshot;
    assert.equal(journey.taskId, launched.id);
    assert.equal(journey.plan?.approvalHash, approved.plan.researchPlan?.approvalHash);

    const resultName = `workflow-${WORKFLOW_ID}-result.md`;
    const artifactResponse = await fetch(
      `${server.url}/runs/${completed.runId}/assignments/${resultName}`,
    );
    assert.equal(artifactResponse.status, 200);
    assert.match(
      await artifactResponse.text(),
      /Dry-run task runner completed for deep-research-report/u,
    );
    await waitForProcessStop(completedProcessTarget);
  } finally {
    await server.close();
    if (previousDryRun === undefined) {
      delete process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN;
    } else {
      process.env.TEAM_RUNTIME_TASK_RUNNER_DRY_RUN = previousDryRun;
    }
    restoreEnvironment("PATH", previousPath);
    restoreEnvironment("PIPELINE_CLI_PATH_FALLBACK", previousCliPathFallback);
    fixture.cleanup();
  }
});

test("every user amendment receives one mandatory Sol review", async () => {
  const fixture = await createFixture("deep-research-plan-amendment-review-");
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    const firstProposal = await generateDeepResearchPlanService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      repoRootPath: fixture.repoRoot,
      expectedPlanId: intakeComplete.id,
      settings: fixture.settings,
      runner: async () => ({ text: JSON.stringify(plannerOutput()) }),
    });
    const amendment = enforceDeepResearchPlanReadiness({
      ...firstProposal,
      id: `${firstProposal.id}-amendment`,
      brief: `${firstProposal.brief ?? ""}\n\nAdd a separate risk comparison.`,
      
      
      deepResearchPlanning: createAmendedDeepResearchPlanningRevision({
        previous: firstProposal.deepResearchPlanning,
        previousPlan: firstProposal.researchPlan,
        previousProposalHash: firstProposal.researchPlanProposalHash,
        messageId: "message-amendment-1",
      }),
    });
    const revision = await fixture.store.reviseRunPlan(
      fixture.sessionId,
      firstProposal.id,
      amendment,
    );
    assert.equal(revision?.revised, true);

    const calls: Parameters<DeepResearchPlanRunner>[0][] = [];
    const reviewedOutput = plannerOutput();
    requiredValue(reviewedOutput.sections[0], 'tests/integration/deep-research-plan-approval.test.ts:896').title = "Reviewed market evidence";
    const generated = await generateDeepResearchPlanService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      repoRootPath: fixture.repoRoot,
      expectedPlanId: amendment.id,
      settings: fixture.settings,
      runner: async (options) => {
        calls.push(options);
        return {
          text: JSON.stringify(
            options.agentName === "research-plan-reviewer"
              ? reviewedOutput
              : plannerOutput(),
          ),
        };
      },
    });

    assert.deepEqual(
      calls.map((call) => call.agentName),
      ["research-planner", "research-plan-reviewer"],
    );
    assert.equal(calls[1]?.model, "gpt-5.6-sol");
    assert.equal(calls[1]?.thinking, "high");
    assert.match(calls[1]?.userMessage ?? "", /message-amendment-1/u);
    assert.equal(
      generated.researchPlan?.sections[0]?.title,
      "Reviewed market evidence",
    );
    const attempt = readOnlyPlanningAttempt(
      fixture.workspace,
      fixture.sessionId,
      generated.deepResearchPlanning?.latestAttemptId,
    );
    assert.equal(attempt.summary.route, "sol_amendment_review");
    assert.equal(attempt.summary.reviewOutcome, "changed");
  } finally {
    fixture.cleanup();
  }
});

test("Sol review is affirmed when only runtime plan identity changes", async () => {
  const fixture = await createFixture("deep-research-plan-affirmed-review-");
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    const firstProposal = await generateDeepResearchPlanService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      repoRootPath: fixture.repoRoot,
      expectedPlanId: intakeComplete.id,
      settings: fixture.settings,
      runner: async () => ({ text: JSON.stringify(plannerOutput()) }),
    });
    const amendment = enforceDeepResearchPlanReadiness({
      ...firstProposal,
      id: `${firstProposal.id}-affirmed-amendment`,
      brief: `${firstProposal.brief ?? ""}\n\nKeep the same evidence lanes.`,
      
      
      deepResearchPlanning: createAmendedDeepResearchPlanningRevision({
        previous: firstProposal.deepResearchPlanning,
        previousPlan: firstProposal.researchPlan,
        previousProposalHash: firstProposal.researchPlanProposalHash,
        messageId: "message-affirmed-amendment",
      }),
    });
    const revision = await fixture.store.reviseRunPlan(
      fixture.sessionId,
      firstProposal.id,
      amendment,
    );
    assert.equal(revision?.revised, true);

    const generated = await generateDeepResearchPlanService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      repoRootPath: fixture.repoRoot,
      expectedPlanId: amendment.id,
      settings: fixture.settings,
      runner: async () => ({ text: JSON.stringify(plannerOutput()) }),
    });
    const attempt = readOnlyPlanningAttempt(
      fixture.workspace,
      fixture.sessionId,
      generated.deepResearchPlanning?.latestAttemptId,
    );
    assert.equal(attempt.summary.route, "sol_amendment_review");
    assert.equal(attempt.summary.reviewOutcome, "affirmed");
  } finally {
    fixture.cleanup();
  }
});

test("Deep Research routes one strict Terra schema failure through Sol review", async () => {
  const fixture = await createFixture("deep-research-plan-repair-");
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    const calls: Parameters<DeepResearchPlanRunner>[0][] = [];
    const runner: DeepResearchPlanRunner = async (options) => {
      calls.push(options);
      return {
        text: JSON.stringify(
          calls.length === 1
            ? { ...plannerOutput(), unsupportedField: true }
            : plannerOutput(),
        ),
      };
    };

    const generated = await generateDeepResearchPlanService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      repoRootPath: fixture.repoRoot,
      expectedPlanId: intakeComplete.id,
      settings: fixture.settings,
      runner,
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.agentName, "research-planner");
    assert.equal(calls[0]?.model, "gpt-5.6-terra");
    assert.equal(calls[1]?.agentName, "research-plan-reviewer");
    assert.equal(calls[1]?.model, "gpt-5.6-sol");
    assert.equal(calls[1]?.thinking, "high");
    assert.equal(calls[1]?.timeoutMinutes, 6);
    assert.match(calls[1]?.userMessage ?? "", /validator-findings/i);
    assert.match(calls[1]?.userMessage ?? "", /unsupportedField/i);
    assert.match(calls[1]?.userMessage ?? "", /Required JSON shape:/u);
    assert.match(calls[1]?.userMessage ?? "", /"schemaVersion":1/u);
    assert.match(
      calls[1]?.userMessage ?? "",
      /Set task\.purpose to evidence_acquisition or evidence_verification/i,
    );
    assert.equal(calls[0]?.outputSchema?.additionalProperties, false);
    assert.match(calls[0]?.outputPath ?? "", /research-planning.*terra/);
    assert.match(calls[1]?.outputPath ?? "", /research-planning.*sol/);
    assert.match(generated.researchPlanProposalHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(
      (await fixture.store.getRunPlan(fixture.sessionId))?.id,
      generated.id,
    );

    const attempt = readOnlyPlanningAttempt(fixture.workspace, fixture.sessionId);
    assert.equal(attempt.summary.status, "succeeded");
    assert.equal(attempt.summary.route, "sol_validation_fallback");
    assert.equal(attempt.summary.reviewOutcome, "replaced");
    assert.match(
      JSON.stringify(attempt.summary.findings),
      /unknown_field.*unsupportedField/i,
    );
    assert.equal(fs.existsSync(path.join(attempt.path, "terra", "candidate.txt")), true);
    assert.equal(fs.existsSync(path.join(attempt.path, "sol", "candidate.txt")), true);
  } finally {
    fixture.cleanup();
  }
});

test("Deep Research repairs a valid-shape plan whose worker assignment exceeds the runtime budget", async () => {
  const fixture = await createFixture("deep-research-plan-budget-repair-");
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    const oversized = plannerOutput();
    requiredValue(oversized.workerSpecs[0], 'tests/integration/deep-research-plan-approval.test.ts:1070').requiredMetrics = Array.from(
      { length: 30 },
      (_, index) => `Required observed metric ${index + 1} with direct source support`,
    );
    const calls: Parameters<DeepResearchPlanRunner>[0][] = [];

    const generated = await generateDeepResearchPlanService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      repoRootPath: fixture.repoRoot,
      expectedPlanId: intakeComplete.id,
      settings: fixture.settings,
      runner: async (options) => {
        calls.push(options);
        return {
          text: JSON.stringify(calls.length === 1 ? oversized : plannerOutput()),
        };
      },
    });

    assert.equal(calls.length, 2);
    assert.match(calls[1]?.userMessage ?? "", /750-token limit/i);
    assert.match(generated.researchPlanProposalHash ?? "", /^[a-f0-9]{64}$/);
  } finally {
    fixture.cleanup();
  }
});

test("Deep Research deterministically compacts descriptive planner text before requesting a repair", async () => {
  const fixture = await createFixture("deep-research-plan-budget-compaction-");
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    const candidate = plannerOutput();
    const originalQuestion = requiredValue(candidate.tasks[0], 'tests/integration/deep-research-plan-approval.test.ts:1108').question;
    requiredValue(candidate.workerSpecs[0], 'tests/integration/deep-research-plan-approval.test.ts:1109').decisionUse =
      "Support the final adoption decision with evidence traceability and explicit uncertainty. ".repeat(40);
    let runnerCalls = 0;

    const generated = await generateDeepResearchPlanService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      repoRootPath: fixture.repoRoot,
      expectedPlanId: intakeComplete.id,
      settings: fixture.settings,
      runner: async () => {
        runnerCalls += 1;
        return { text: JSON.stringify(candidate) };
      },
    });

    assert.equal(runnerCalls, 1);
    assert.ok(generated.researchPlan);
    assert.equal(generated.researchPlan.tasks[0]?.question, originalQuestion);
    assert.equal(generated.researchPlan.workerSpecs[0]?.question, originalQuestion);
    assert.ok(
      (generated.researchPlan.workerSpecs[0]?.decisionUse.length ?? 0) <
      requiredValue(candidate.workerSpecs[0], 'tests/integration/deep-research-plan-approval.test.ts:1131').decisionUse.length,
    );
    assert.match(generated.researchPlan.workerSpecs[0]?.decisionUse ?? "", /…$/u);
    assert.doesNotThrow(() => assertResearchPlanPromptBudgets(generated.researchPlan!));
  } finally {
    fixture.cleanup();
  }
});

test("Deep Research compacts a dense seven-requirement visitor lane without a repair call", async () => {
  const fixture = await createFixture("deep-research-plan-dense-compaction-");
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    const candidate = plannerOutput();
    const question =
      "Which currently operating ice-cream destinations in nearby Metro Detroit merit inclusion in a tourist guide because their distinctive offerings and practical visitor fit are supported by official and independent evidence?";
    requiredValue(candidate.tasks[0], 'tests/integration/deep-research-plan-approval.test.ts:1152').question = question;
    const workerSpec = candidate.workerSpecs[0] as Record<string, unknown>;
    delete workerSpec.requiredMetrics;
    Object.assign(workerSpec, {
      question,
      displayRole: "Metro Detroit Dessert Destination Researcher",
      domain: "Nearby Metro Detroit ice-cream destinations",
      decisionUse:
        "Select evidence-backed nearby metro entries and supply traceable details for the visitor guide without imposing an ordinal ranking.",
      sourceRequirements: {
        preferredTypes: ["primary", "secondary", "industry", "news"],
        requiredAuthorityTypes: ["primary", "secondary"],
        queryHints: [
          "Metro Detroit ice cream shops official menu hours",
          "Metro Detroit distinctive ice cream local visitor guide",
        ],
      },
      coverageRequirements: [
        coverage("current-status", "Current operating status, municipality, and location for each candidate", "fact", "claim_support"),
        coverage("offerings", "Distinctive flavors, products, or serving formats for each included candidate", "fact", "claim_support"),
        coverage("tourist-logistics", "Current practical visit information and tourist-relevant fit", "fact", "claim_support"),
        coverage("distinctiveness", "Evidence-based distinctiveness relative to other observed metro options", "comparison", "independent_comparison"),
        coverage("source-authority", "Official evidence plus independent local or destination corroboration", "source_authority", "source_authority"),
        coverage("boundary-conflicts", "Nearby-area boundary, dated-source conflicts, resolutions, and unresolved limitations", "caveat", "explicit_caveat"),
        coverage("inclusion", "Non-ranked inclusion judgment based on distinctiveness and tourist fit", "decision", "decision_support"),
      ],
      prohibitedAssumptions: [
        "Do not include Detroit-proper locations in this lane.",
        "Do not infer current operation from dated coverage alone.",
        "Do not treat self-described uniqueness as independently established.",
        "Do not equate popularity with tourist suitability.",
        "Do not produce a numbered ranking or unsupported single-best claim.",
      ],
    });
    let runnerCalls = 0;

    const generated = await generateDeepResearchPlanService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      repoRootPath: fixture.repoRoot,
      expectedPlanId: intakeComplete.id,
      settings: fixture.settings,
      runner: async () => {
        runnerCalls += 1;
        return { text: JSON.stringify(candidate) };
      },
    });

    assert.equal(runnerCalls, 1);
    assert.doesNotThrow(() => assertResearchPlanPromptBudgets(generated.researchPlan!));
    assert.equal(
      generated.researchPlan?.workerSpecs[0]?.question,
      generated.researchPlan?.tasks[0]?.question,
    );
  } finally {
    fixture.cleanup();
  }
});

test("Deep Research canonicalizes runtime-owned planner fields before strict validation", async () => {
  const fixture = await createFixture("deep-research-plan-runtime-fields-");
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    const candidate = plannerOutput();
    candidate.planId = "../model-owned-plan";
    candidate.requestId = "model-request-mismatch";
    candidate.request.requestId = "another-request";
    candidate.request.desiredSections = ["Model mirror mismatch"];
    candidate.request.authenticatedDomains = ["unapproved.example.com"];
    candidate.request.outputFormats = ["docx", "markdown"];
    Object.assign(candidate, {
      approvedAt: "2026-07-17T12:00:00.000Z",
      approvalHash: "a".repeat(64),
    });
    requiredValue(candidate.tasks[0], 'tests/integration/deep-research-plan-approval.test.ts:1231').id = "market-task";
    requiredValue(candidate.tasks[1], 'tests/integration/deep-research-plan-approval.test.ts:1232').id = "risk-task";
    requiredValue(candidate.tasks[1], 'tests/integration/deep-research-plan-approval.test.ts:1233').dependsOn = ["market-task"];
    requiredValue(candidate.sections[0], 'tests/integration/deep-research-plan-approval.test.ts:1234').taskIds = ["wrong-task"];
    requiredValue(candidate.sections[1], 'tests/integration/deep-research-plan-approval.test.ts:1235').taskIds = [];
    requiredValue(candidate.workerSpecs[0], 'tests/integration/deep-research-plan-approval.test.ts:1236').baseAgent = "untrusted-researcher";
    requiredValue(candidate.workerSpecs[0], 'tests/integration/deep-research-plan-approval.test.ts:1237').question = "Mismatched duplicate question";
    requiredValue(candidate.workerSpecs[0], 'tests/integration/deep-research-plan-approval.test.ts:1238').sectionId = "wrong-section";
    requiredValue(candidate.workerSpecs[0], 'tests/integration/deep-research-plan-approval.test.ts:1239').limits.deadlineMs = 7_200_000;

    let runnerCalls = 0;
    const generated = await generateDeepResearchPlanService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      repoRootPath: fixture.repoRoot,
      expectedPlanId: intakeComplete.id,
      settings: fixture.settings,
      runner: async () => {
        runnerCalls += 1;
        return { text: JSON.stringify(candidate) };
      },
    });

    assert.equal(runnerCalls, 1);
    assert.equal(generated.researchPlan?.requestId, `request-${fixture.sessionId}`);
    assert.deepEqual(generated.researchPlan?.tasks.map((task) => task.id), ["T1", "T2"]);
    assert.deepEqual(generated.researchPlan?.tasks[1]?.dependsOn, ["T1"]);
    assert.deepEqual(generated.researchPlan?.sections[0]?.taskIds, ["T1"]);
    assert.equal(generated.researchPlan?.workerSpecs[0]?.baseAgent, "web-researcher");
    assert.equal(
      generated.researchPlan?.workerSpecs[0]?.question,
      generated.researchPlan?.tasks[0]?.question,
    );
    assert.equal(generated.researchPlan?.approvedAt, undefined);
    assert.equal(generated.researchPlan?.approvalHash, undefined);
    assert.deepEqual(generated.researchPlan?.authenticatedDomains, []);
    assert.deepEqual(generated.researchPlan?.request.outputFormats, ["markdown", "docx"]);
    assert.equal(generated.researchPlan?.maxDurationMinutes, 12);
    assert.equal(generated.researchPlan?.maxResearcherAgents, 3);
  } finally {
    fixture.cleanup();
  }
});

test("Deep Research bounds a failed Sol fallback and preserves the planning revision", async () => {
  const fixture = await createFixture("deep-research-plan-repair-failure-");
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    let runnerCalls = 0;

    await assert.rejects(
      generateDeepResearchPlanService({
        sessionId: fixture.sessionId,
        sessionStore: fixture.store,
        repoRootPath: fixture.repoRoot,
        expectedPlanId: intakeComplete.id,
        settings: fixture.settings,
        runner: async () => {
          runnerCalls += 1;
          return {
            text: JSON.stringify({
              ...plannerOutput(),
              unsupportedField: runnerCalls,
            }),
          };
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ServiceError);
        assert.match(error.message, /reviewed plan could not pass final checks/i);
        assert.match(
          JSON.stringify(error.details),
          /research-planning\/attempts\/attempt-/,
        );
        return true;
      },
    );

    assert.equal(runnerCalls, 2);
    const persisted = await fixture.store.getRunPlan(fixture.sessionId);
    assert.equal(persisted?.id, intakeComplete.id);
    assert.equal(persisted?.researchPlan, undefined);
    assert.match(
      persisted?.deepResearchPlanning?.latestAttemptId ?? "",
      /^attempt-/u,
    );
    const attempt = readOnlyPlanningAttempt(fixture.workspace, fixture.sessionId);
    assert.equal(attempt.summary.status, "failed");
    assert.equal(attempt.summary.route, "sol_validation_fallback");
    assert.match(
      JSON.stringify(attempt.summary.findings),
      /unknown_field.*unsupportedField/i,
    );
    assert.match(attempt.summary.diagnosticError ?? "", /"code":"unknown_field"/u);
    assert.doesNotMatch(
      attempt.summary.diagnosticError ?? "",
      /\[object Object\]/u,
    );
    const publicAttempt = await getDeepResearchPlanAttemptService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      attemptId: persisted!.deepResearchPlanning!.latestAttemptId!,
    });
    assert.equal("diagnosticError" in publicAttempt, false);
    assert.ok(
      publicAttempt.findings.every(
        (finding) => !("diagnostic" in finding),
      ),
    );

    const recovered = await generateDeepResearchPlanService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      repoRootPath: fixture.repoRoot,
      expectedPlanId: intakeComplete.id,
      settings: fixture.settings,
      runner: async () => ({ text: JSON.stringify(plannerOutput()) }),
    });
    const retryAttempt = readOnlyPlanningAttempt(
      fixture.workspace,
      fixture.sessionId,
      recovered.deepResearchPlanning?.latestAttemptId,
    );
    assert.notEqual(
      recovered.deepResearchPlanning?.latestAttemptId,
      persisted?.deepResearchPlanning?.latestAttemptId,
    );
    assert.equal(retryAttempt.summary.retryCount, 1);
    assert.equal(retryAttempt.summary.status, "succeeded");
  } finally {
    fixture.cleanup();
  }
});

test("Deep Research does not retry provider failures as schema repairs", async () => {
  const fixture = await createFixture("deep-research-plan-provider-failure-");
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    let runnerCalls = 0;

    await assert.rejects(
      generateDeepResearchPlanService({
        sessionId: fixture.sessionId,
        sessionStore: fixture.store,
        repoRootPath: fixture.repoRoot,
        expectedPlanId: intakeComplete.id,
        settings: fixture.settings,
        runner: async () => {
          runnerCalls += 1;
          throw new Error("Planner provider unavailable");
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ServiceError);
        // The message now comes from the shared provider formatter, so it
        // names what actually happened instead of blaming configuration.
        assert.match(error.message, /provider is temporarily unavailable/i);
        assert.doesNotMatch(error.message, /not configured/i);
        assert.match(
          JSON.stringify(error.details),
          /research-planning\/attempts\/attempt-/,
        );
        return true;
      },
    );

    // One bounded automatic retry: transient provider loss is the single most
    // common planning failure, and it stopped the run before any research ran.
    assert.equal(runnerCalls, 2);
    const persisted = await fixture.store.getRunPlan(fixture.sessionId);
    assert.equal(persisted?.id, intakeComplete.id);
    assert.equal(persisted?.researchPlan, undefined);
    const attempts = readPlanningAttempts(fixture.workspace, fixture.sessionId);
    assert.equal(attempts.length, 2, "each attempt keeps its own record");
    assert.deepEqual(
      attempts.map((attempt) => attempt.summary.retryCount),
      [0, 1],
    );
    assert.deepEqual(
      attempts.map((attempt) => attempt.summary.status),
      ["failed", "failed"],
    );
    assert.equal(
      persisted?.deepResearchPlanning?.latestAttemptId,
      attempts[1]?.attemptId,
      "the latest attempt points at the retry, not the exhausted first try",
    );
  } finally {
    fixture.cleanup();
  }
});

test("Deep Research routes a Terra timeout to the Sol fallback", async () => {
  const fixture = await createFixture("deep-research-plan-timeout-retry-");
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    const calls: Parameters<DeepResearchPlanRunner>[0][] = [];

    const generated = await generateDeepResearchPlanService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      repoRootPath: fixture.repoRoot,
      expectedPlanId: intakeComplete.id,
      settings: fixture.settings,
      runner: async (options) => {
        calls.push(options);
        if (calls.length === 1) {
          throw new TimeoutError("research-planner", 600_000, 600_000);
        }
        return { text: JSON.stringify(plannerOutput()) };
      },
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.timeoutMinutes, 1.5);
    assert.equal(calls[1]?.timeoutMinutes, 6);
    assert.equal(calls[0]?.agentName, "research-planner");
    assert.equal(calls[1]?.agentName, "research-plan-reviewer");
    assert.equal(calls[0]?.thinking, "medium");
    assert.equal(calls[1]?.thinking, "high");
    assert.match(generated.researchPlanProposalHash ?? "", /^[a-f0-9]{64}$/);
    const attempt = readOnlyPlanningAttempt(fixture.workspace, fixture.sessionId);
    assert.equal(attempt.summary.status, "succeeded");
    assert.equal(attempt.summary.route, "sol_timeout_fallback");
    assert.equal(fs.existsSync(path.join(attempt.path, "repair")), false);
  } finally {
    fixture.cleanup();
  }
});

for (const reviewerFailure of [
  {
    name: "timeout",
    error: () =>
      new TimeoutError("research-plan-reviewer", 180_000, 180_000),
    expectedCategory: "timeout",
    expectedMessage: /Advanced quality review timed out/u,
  },
  {
    name: "provider failure",
    error: () => new Error("Reviewer provider unavailable"),
    expectedCategory: "provider",
    expectedMessage: /provider is temporarily unavailable/u,
  },
] as const) {
  test(`Deep Research records a Sol reviewer ${reviewerFailure.name} as retryable`, async () => {
    const fixture = await createFixture(
      `deep-research-plan-reviewer-${reviewerFailure.expectedCategory}-`,
    );
    try {
      const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
      const intakeComplete = await reviseIntakeCompletePlan({
        plan: initial,
        sessionId: fixture.sessionId,
        store: fixture.store,
      });
      let runnerCalls = 0;
      await assert.rejects(
        generateDeepResearchPlanService({
          sessionId: fixture.sessionId,
          sessionStore: fixture.store,
          repoRootPath: fixture.repoRoot,
          expectedPlanId: intakeComplete.id,
          settings: fixture.settings,
          runner: async () => {
            runnerCalls += 1;
            // Odd calls are Terra, even calls are Sol, so the automatic retry
            // reaches the reviewer again rather than failing at the draft.
            if (runnerCalls % 2 === 1) {
              return {
                text: JSON.stringify({
                  ...plannerOutput(),
                  unsupportedField: true,
                }),
              };
            }
            throw reviewerFailure.error();
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof ServiceError);
          assert.match(error.message, reviewerFailure.expectedMessage);
          return true;
        },
      );
      // Two runner calls per attempt (Terra then Sol), across the first
      // attempt and its one automatic retry.
      assert.equal(runnerCalls, 4);
      const attempts = readPlanningAttempts(fixture.workspace, fixture.sessionId);
      assert.equal(attempts.length, 2);
      const attempt = readOnlyPlanningAttempt(
        fixture.workspace,
        fixture.sessionId,
        attempts[1]!.attemptId,
      );
      assert.equal(attempt.summary.status, "failed");
      assert.equal(
        attempt.summary.errorCategory,
        reviewerFailure.expectedCategory,
      );
      assert.equal(attempt.summary.retryable, true);
    } finally {
      fixture.cleanup();
    }
  });
}

test("Deep Research does not reverse a persisted plan when attempt diagnostics cannot be updated", async () => {
  const fixture = await createFixture("deep-research-plan-diagnostic-failure-");
  let attemptPath: string | undefined;
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });

    const generated = await generateDeepResearchPlanService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      repoRootPath: fixture.repoRoot,
      expectedPlanId: intakeComplete.id,
      settings: fixture.settings,
      runner: async (options) => {
        assert.ok(options.outputPath);
        attemptPath = path.dirname(options.outputPath);
        fs.chmodSync(attemptPath, 0o500);
        return { text: JSON.stringify(plannerOutput()) };
      },
    });

    assert.ok(generated.researchPlan);
    assert.equal(
      (await fixture.store.getRunPlan(fixture.sessionId))?.id,
      generated.id,
    );
    assert.ok(attemptPath);
    const attemptId = generated.deepResearchPlanning?.latestAttemptId;
    assert.ok(attemptId);
    const recoveredWhileReadOnly = await getDeepResearchPlanAttemptService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      attemptId,
    });
    assert.equal(recoveredWhileReadOnly.status, "succeeded");
    assert.equal(recoveredWhileReadOnly.finalRunPlanId, generated.id);
    const recoveredEventPage =
      await getDeepResearchPlanAttemptEventsService({
        sessionId: fixture.sessionId,
        sessionStore: fixture.store,
        attemptId,
        fromSequence: 99999,
      });
    assert.equal(recoveredEventPage.events.length, 0);
    assert.equal(recoveredEventPage.snapshot.status, "succeeded");
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(attemptPath, "attempt.json"), "utf8"),
      ).status,
      "running",
    );

    fs.chmodSync(attemptPath, 0o700);
    const persistedRecovery = await getDeepResearchPlanAttemptService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      attemptId,
    });
    assert.equal(persistedRecovery.status, "succeeded");
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(attemptPath, "attempt.json"), "utf8"),
      ).status,
      "succeeded",
    );
  } finally {
    if (attemptPath && fs.existsSync(attemptPath)) {
      fs.chmodSync(attemptPath, 0o700);
    }
    fixture.cleanup();
  }
});

test("Deep Research rejects a generated plan when the brief changes in flight", async () => {
  const fixture = await createFixture("deep-research-plan-stale-revision-");
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    let markRunnerStarted!: () => void;
    let releaseRunner!: () => void;
    const runnerStarted = new Promise<void>((resolve) => {
      markRunnerStarted = resolve;
    });
    const runnerMayFinish = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const generation = generateDeepResearchPlanService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      repoRootPath: fixture.repoRoot,
      expectedPlanId: intakeComplete.id,
      settings: fixture.settings,
      runner: async () => {
        markRunnerStarted();
        await runnerMayFinish;
        return { text: JSON.stringify(plannerOutput()) };
      },
    });
    await runnerStarted;

    const amended = enforceDeepResearchPlanReadiness({
      ...intakeComplete,
      id: `${intakeComplete.id}-dog-treat-amendment`,
      brief: `${intakeComplete.brief ?? ""}\n\nAdd a separate dog-safe frozen treats task.`,
      updatedAt: new Date().toISOString(),
    });
    const amendment = await fixture.store.reviseRunPlan(
      fixture.sessionId,
      intakeComplete.id,
      amended,
    );
    assert.equal(amendment?.revised, true);
    releaseRunner();

    await assert.rejects(generation, (error: unknown) => {
      assert.ok(error instanceof ServiceError);
      assert.equal(error.code, "conflict");
      assert.match(error.message, /changed; refresh/i);
      return true;
    });
    assert.deepEqual(
      await fixture.store.getRunPlan(fixture.sessionId),
      amendment?.plan,
    );
  } finally {
    fixture.cleanup();
  }
});

test("a newer Deep Research brief cancels superseded planner work", async () => {
  const fixture = await createFixture("deep-research-plan-superseded-");
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    let runnerCalls = 0;
    let markFirstRunnerStarted!: () => void;
    const firstRunnerStarted = new Promise<void>((resolve) => {
      markFirstRunnerStarted = resolve;
    });
    const runner: DeepResearchPlanRunner = async (options) => {
      runnerCalls += 1;
      if (runnerCalls > 1) {
        return { text: JSON.stringify(plannerOutput()) };
      }
      markFirstRunnerStarted();
      return new Promise<never>((_resolve, reject) => {
        const rejectForAbort = () =>
          reject(options.signal?.reason ?? new Error("Planner cancelled"));
        if (options.signal?.aborted) {
          rejectForAbort();
          return;
        }
        options.signal?.addEventListener("abort", rejectForAbort, {
          once: true,
        });
      });
    };
    const supersededGeneration = generateDeepResearchPlanService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      repoRootPath: fixture.repoRoot,
      expectedPlanId: intakeComplete.id,
      settings: fixture.settings,
      runner,
    });
    const supersededRejection = assert.rejects(
      supersededGeneration,
      (error: unknown) => {
        assert.ok(error instanceof ServiceError);
        assert.equal(error.code, "conflict");
        assert.match(error.message, /superseded by a newer brief/i);
        return true;
      },
    );
    await firstRunnerStarted;

    const amended = enforceDeepResearchPlanReadiness({
      ...intakeComplete,
      id: `${intakeComplete.id}-new-brief`,
      brief: `${intakeComplete.brief ?? ""}\n\nAdd dog-safe frozen treats.`,
    });
    const amendment = await fixture.store.reviseRunPlan(
      fixture.sessionId,
      intakeComplete.id,
      amended,
    );
    assert.equal(amendment?.revised, true);

    const generated = await generateDeepResearchPlanService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      repoRootPath: fixture.repoRoot,
      expectedPlanId: amendment!.plan.id,
      settings: fixture.settings,
      runner,
    });
    await supersededRejection;

    assert.equal(runnerCalls, 2);
    assert.match(generated.researchPlanProposalHash ?? "", /^[a-f0-9]{64}$/);
  } finally {
    fixture.cleanup();
  }
});

test("restart recovery does not overwrite a live superseded attempt", async () => {
  const fixture = await createFixture("deep-research-plan-supersede-race-");
  let releaseFirstRunner!: () => void;
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    let markFirstRunnerStarted!: () => void;
    const firstRunnerStarted = new Promise<void>((resolve) => {
      markFirstRunnerStarted = resolve;
    });
    const firstRunnerMayFinish = new Promise<void>((resolve) => {
      releaseFirstRunner = resolve;
    });
    let runnerCalls = 0;
    const runner: DeepResearchPlanRunner = async () => {
      runnerCalls += 1;
      if (runnerCalls === 1) {
        markFirstRunnerStarted();
        await firstRunnerMayFinish;
      }
      return { text: JSON.stringify(plannerOutput()) };
    };
    const firstAttempt = await startDeepResearchPlanService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      repoRootPath: fixture.repoRoot,
      expectedPlanId: intakeComplete.id,
      settings: fixture.settings,
      runner,
    });
    await firstRunnerStarted;
    const planning = await fixture.store.getRunPlan(fixture.sessionId);
    assert.ok(planning?.deepResearchPlanning);
    const amended = enforceDeepResearchPlanReadiness({
      ...planning,
      id: `${planning.id}-new-revision`,
      brief: `${planning.brief ?? ""}\n\nAdd a separate risk lane.`,
      
      
      deepResearchPlanning: createAmendedDeepResearchPlanningRevision({
        previous: planning.deepResearchPlanning,
        previousPlan: planning.researchPlan,
        previousProposalHash: planning.researchPlanProposalHash,
        messageId: "message-supersede-race",
      }),
    });
    const amendment = await fixture.store.reviseRunPlan(
      fixture.sessionId,
      planning.id,
      amended,
    );
    assert.equal(amendment?.revised, true);

    const secondAttempt = await startDeepResearchPlanService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      repoRootPath: fixture.repoRoot,
      expectedPlanId: amended.id,
      settings: fixture.settings,
      runner,
    });
    assert.notEqual(secondAttempt.attemptId, firstAttempt.attemptId);
    const oldWhileAborted = await getDeepResearchPlanAttemptService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      attemptId: firstAttempt.attemptId,
    });
    assert.equal(oldWhileAborted.status, "running");

    releaseFirstRunner();
    const superseded = await waitForPlanningAttemptStatus({
      sessionStore: fixture.store,
      sessionId: fixture.sessionId,
      attemptId: firstAttempt.attemptId,
      status: "superseded",
    });
    assert.equal(superseded.retryable, false);
    const newAttempt = await waitForPlanningAttemptStatus({
      sessionStore: fixture.store,
      sessionId: fixture.sessionId,
      attemptId: secondAttempt.attemptId,
      status: "succeeded",
    });
    assert.equal(newAttempt.status, "succeeded");
  } finally {
    releaseFirstRunner?.();
    fixture.cleanup();
  }
});

test("caller cancellation stops waiting without cancelling durable planning", async () => {
  const fixture = await createFixture("deep-research-plan-detached-caller-");
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    let runnerCalls = 0;
    let markFirstRunnerStarted!: () => void;
    let releaseRunner!: () => void;
    const firstRunnerStarted = new Promise<void>((resolve) => {
      markFirstRunnerStarted = resolve;
    });
    const runnerMayFinish = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const runner: DeepResearchPlanRunner = async () => {
      runnerCalls += 1;
      markFirstRunnerStarted();
      await runnerMayFinish;
      return { text: JSON.stringify(plannerOutput()) };
    };
    const caller = new AbortController();
    const cancelled = generateDeepResearchPlanService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      repoRootPath: fixture.repoRoot,
      expectedPlanId: intakeComplete.id,
      settings: fixture.settings,
      runner,
      signal: caller.signal,
    });
    const cancellation = assert.rejects(cancelled, /Caller stopped waiting/i);
    await firstRunnerStarted;
    caller.abort(new Error("Caller stopped waiting"));
    await cancellation;

    const resumed = generateDeepResearchPlanService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      repoRootPath: fixture.repoRoot,
      expectedPlanId: intakeComplete.id,
      settings: fixture.settings,
      runner,
    });
    releaseRunner();
    const generated = await resumed;

    assert.equal(runnerCalls, 1);
    assert.match(generated.researchPlanProposalHash ?? "", /^[a-f0-9]{64}$/);
  } finally {
    fixture.cleanup();
  }
});

test("concurrent Deep Research generation requests share one planner execution", async () => {
  const fixture = await createFixture("deep-research-plan-coalescing-");
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    let runnerCalls = 0;
    let markRunnerStarted!: () => void;
    let releaseRunner!: () => void;
    const runnerStarted = new Promise<void>((resolve) => {
      markRunnerStarted = resolve;
    });
    const runnerMayFinish = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const runner: DeepResearchPlanRunner = async () => {
      runnerCalls += 1;
      markRunnerStarted();
      await runnerMayFinish;
      return { text: JSON.stringify(plannerOutput()) };
    };
    const params = {
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      repoRootPath: fixture.repoRoot,
      expectedPlanId: intakeComplete.id,
      settings: fixture.settings,
      runner,
    };

    const first = generateDeepResearchPlanService(params);
    const second = generateDeepResearchPlanService(params);
    await runnerStarted;
    assert.equal(runnerCalls, 1);
    releaseRunner();
    const [firstPlan, secondPlan] = await Promise.all([first, second]);

    assert.equal(runnerCalls, 1);
    assert.deepEqual(secondPlan, firstPlan);
    assert.equal(
      (await fixture.store.getRunPlan(fixture.sessionId))?.id,
      firstPlan.id,
    );
    const attemptsPath = path.join(
      fixture.workspace,
      "sessions",
      fixture.sessionId,
      "research-planning",
      "attempts",
    );
    assert.equal(
      fs.readdirSync(attemptsPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).length,
      1,
    );
  } finally {
    fixture.cleanup();
  }
});

async function waitForTerminalTask(
  apiUrl: string,
  sessionId: string,
  taskId: string,
  timeoutMs = 10_000,
): Promise<SessionTask> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${apiUrl}/sessions/${sessionId}/tasks/${taskId}`,
    );
    assert.equal(response.status, 200);
    const task = (await response.json()) as SessionTask;
    if (["done", "failed", "blocked", "cancelled"].includes(task.status)) {
      return task;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Task ${taskId} did not finish within ${timeoutMs}ms`);
}

async function waitForProcessStop(
  target: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (defaultIsProcessAlive(target) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(
    defaultIsProcessAlive(target),
    false,
    `Deep Research task process ${target} was still alive after ${timeoutMs}ms`,
  );
}

async function waitForTerminalPlanningAttempt(
  apiUrl: string,
  sessionId: string,
  attemptId: string,
  timeoutMs = 10_000,
): Promise<DeepResearchPlanningAttemptSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${apiUrl}/sessions/${sessionId}/run-plan/research-plan/attempts/${attemptId}`,
    );
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      attempt: DeepResearchPlanningAttemptSnapshot;
    };
    if (
      ["succeeded", "failed", "cancelled", "superseded"].includes(
        payload.attempt.status,
      )
    ) {
      return payload.attempt;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Planning attempt ${attemptId} did not finish within ${timeoutMs}ms`,
  );
}

async function waitForPlanningAttemptStatus(params: {
  sessionStore: FileSystemSessionStore;
  sessionId: string;
  attemptId: string;
  status: DeepResearchPlanningAttemptSnapshot["status"];
  timeoutMs?: number;
}): Promise<DeepResearchPlanningAttemptSnapshot> {
  const deadline = Date.now() + (params.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    const attempt = await readDeepResearchPlanAttempt(params);
    if (attempt?.status === params.status) return attempt;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Planning attempt ${params.attemptId} did not reach ${params.status}`,
  );
}

async function readStreamChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("SSE heartbeat was not emitted")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function createFixture(prefix: string): Promise<{
  workspace: string;
  repoRoot: string;
  store: FileSystemSessionStore;
  settings: DeepResearchSettingsService;
  sessionId: string;
  cleanup(): void;
}> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, "workspace");
  const repoRoot = path.join(root, "repo");
  const agentDir = path.join(repoRoot, "agents", "research-planner");
  const reviewerDir = path.join(
    repoRoot,
    "agents",
    "research-plan-reviewer",
  );
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(reviewerDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "research-planner.md"),
    [
      "---",
      "name: research-planner",
      "provider: codex",
      "model: gpt-5.6-terra",
      "thinking: medium",
      "ui_hidden: true",
      "---",
      "Create a strict Deep Research plan. Return JSON only.",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(reviewerDir, "research-plan-reviewer.md"),
    [
      "---",
      "name: research-plan-reviewer",
      "provider: codex",
      "model: gpt-5.6-sol",
      "thinking: high",
      "ui_hidden: true",
      "---",
      "Review and amend a Deep Research plan. Return JSON only.",
    ].join("\n"),
  );
  const store = new FileSystemSessionStore(workspace);
  const session = await store.createSession({ title: "Deep Research" });
  const settings = new DeepResearchSettingsService({
    storagePath: path.join(workspace, "deep-research", "settings.json"),
  });
  await settings.update({ maxDurationMinutes: 12, maxResearcherAgents: 3 });
  return {
    workspace,
    repoRoot,
    store,
    settings,
    sessionId: session.id,
    cleanup: () => fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    }),
  };
}

async function saveInitialPlan(
  store: FileSystemSessionStore,
  sessionId?: string,
): Promise<RunPlan> {
  const targetSessionId = sessionId ?? (await store.listSessions())[0]!.id;
  const plan = createRunPlan({
    goal: "Compare the evidence for enterprise adoption and produce a sourced decision report.",
    workflowId: WORKFLOW_ID,
    workflows: [{
      id: WORKFLOW_ID,
      description: "Deep Research",
      tags: ["research"],
      capabilities: ["deep_research"],
    }],
  });
  assert.equal(await store.saveRunPlan(targetSessionId, plan), true);
  return (await store.getRunPlan(targetSessionId))!;
}

async function reviseIntakeCompletePlan(params: {
  plan: RunPlan;
  sessionId: string;
  store: FileSystemSessionStore;
}): Promise<RunPlan> {
  const next = enforceDeepResearchPlanReadiness({
    ...params.plan,
    id: `${params.plan.id}-intake-complete`,
    deepResearchIntakeComplete: true,
  });
  const revision = await params.store.reviseRunPlan(
    params.sessionId,
    params.plan.id,
    next,
  );
  assert.equal(revision?.revised, true);
  assert.equal(revision?.plan.id, next.id);
  return revision!.plan;
}

function plannerOutput() {
  const sections = [
    section("market", "Market evidence", "Establish adoption evidence", ["T1"]),
    section("risk", "Risk evidence", "Establish contrary evidence", ["T2"]),
  ];
  const tasks = [
    task("T1", "market", "Research adoption", "What primary evidence shows adoption?", "adoption-worker"),
    task("T2", "risk", "Research risks", "What evidence contradicts adoption claims?", "risk-worker"),
  ];
  return {
    schemaVersion: 1,
    planId: "model-plan",
    requestId: "model-request",
    request: {
      schemaVersion: 1,
      requestId: "model-request",
      question: "Should enterprises adopt the product?",
      objective: "Produce a sourced enterprise adoption decision.",
      audience: "Enterprise technology leaders",
      includedScope: ["Enterprise adoption evidence"],
      excludedScope: ["Consumer adoption"],
      desiredSections: sections.map((candidate) => candidate.title),
      jurisdictions: ["United States"],
      freshnessAsOf: "2026-07-16T12:00:00.000Z",
      authenticatedDomains: ["private.example.com"],
      sourceRequirements: ["Prefer directly observed primary sources."],
      maxDurationMinutes: 120,
      maxResearcherAgents: 8,
      outputFormats: ["markdown", "docx"],
    },
    sections,
    tasks,
    workerSpecs: [
      worker("adoption-worker", "market", requiredValue(tasks[0], 'tests/integration/deep-research-plan-approval.test.ts:2190').question, "Enterprise adoption analyst", "market"),
      worker("risk-worker", "risk", requiredValue(tasks[1], 'tests/integration/deep-research-plan-approval.test.ts:2191').question, "Contrarian evidence analyst", "source_verification"),
    ],
    maxDurationMinutes: 120,
    maxResearcherAgents: 8,
    expectedPeakWorkers: 8,
    authenticatedDomains: ["private.example.com"],
  };
}

function readOnlyPlanningAttempt(
  workspace: string,
  sessionId: string,
  attemptId?: string,
): {
  path: string;
  summary: {
    status: string;
    retryCount: number;
    /** The plan revision this attempt was for, so it can be found by identity. */
    expectedPlanId?: string;
    route: string;
    totalDurationMs?: number;
    complexityClass?: string;
    reviewOutcome?: string;
    error?: string;
    diagnosticError?: string;
    errorCategory?: string;
    retryable?: boolean;
    findings: Array<{
      code: string;
      field: string;
      severity: string;
      summary: string;
      diagnostic?: string;
    }>;
    stages: Record<string, { model?: string; thinking?: string }>;
  };
} {
  const attemptsPath = path.join(
    workspace,
    "sessions",
    sessionId,
    "research-planning",
    "attempts",
  );
  const entries = fs.readdirSync(attemptsPath, { withFileTypes: true });
  const entry = attemptId
    ? entries.find((candidate) => candidate.name === attemptId)
    : entries[0];
  if (!attemptId) assert.equal(entries.length, 1);
  assert.equal(entry?.isDirectory(), true);
  const attemptPath = path.join(attemptsPath, entry!.name);
  return {
    path: attemptPath,
    summary: JSON.parse(
      fs.readFileSync(path.join(attemptPath, "attempt.json"), "utf8"),
    ) as {
      status: string;
      retryCount: number;
      route: string;
      totalDurationMs?: number;
      complexityClass?: string;
      reviewOutcome?: string;
      diagnosticError?: string;
      errorCategory?: string;
      retryable?: boolean;
      findings: Array<{
        code: string;
        field: string;
        severity: string;
        summary: string;
        diagnostic?: string;
      }>;
      stages: Record<string, { model?: string; thinking?: string }>;
    },
  };
}

function section(id: string, title: string, objective: string, taskIds: string[]) {
  return { schemaVersion: 1, id, title, objective, taskIds };
}

function task(
  id: string,
  sectionId: string,
  title: string,
  question: string,
  workerSpecId: string,
) {
  return {
    schemaVersion: 1,
    id,
    sectionId,
    title,
    question,
    purpose: "evidence_acquisition" as const,
    workerSpecId,
    dependsOn: [] as string[],
    correctionWave: 0,
  };
}

function worker(
  id: string,
  sectionId: string,
  question: string,
  displayRole: string,
  lens: string,
) {
  return {
    schemaVersion: 1,
    id,
    laneId: `${id}-lane`,
    sectionId,
    baseAgent: "web-researcher",
    displayRole,
    domain: "Enterprise software",
    lens,
    methodCardIds: lens === "source_verification"
      ? ["source-verification-v1"]
      : ["marketing-channel-analysis-v1"],
    specialistStance:
      "Approach this assignment as an enterprise software evidence analyst. Separate vendor assertions, independently corroborated facts, and analytical inferences.",
    question,
    decisionUse: "Support the final adoption decision.",
    workingDefinitions: [
      "Treat adoption as verified only when an observed source identifies actual organizational use rather than interest or web traffic.",
    ],
    dependencyClaimIds: [],
    sourceRequirements: {
      preferredTypes: ["primary", "secondary"],
      requiredAuthorityTypes: ["primary"],
      queryHints: [],
    },
    requiredMetrics: [] as string[],
    prohibitedAssumptions: [],
    stopRule: {
      minimumPrimarySources: 1,
      minimumIndependentSources: 2,
      maximumSources: 8,
    },
    limits: { deadlineMs: 7_200_000 },
  };
}

function writeCodexPreflightFixture(binDirectory: string): void {
  fs.mkdirSync(binDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(binDirectory, "codex"),
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "codex fixture 1.0.0"; exit 0; fi',
      'if [ "$1 $2" = "debug models" ]; then echo \'{"models":[{"slug":"gpt-5.5","display_name":"GPT-5.5","visibility":"list","context_window":200000}]}\'; exit 0; fi',
      'if [ "$1 $2" = "exec --help" ]; then echo "--config --disable --ephemeral --ignore-rules --strict-config --ignore-user-config"; exit 0; fi',
      'if [ "$1 $2 $3" = "mcp add --help" ]; then echo "--url --bearer-token-env-var"; exit 0; fi',
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function coverage(
  id: string,
  label: string,
  kind: string,
  validation: string,
) {
  return { schemaVersion: 2, id, label, kind, validation, required: true };
}

test("Deep Research recovers when one transient provider failure is retried", async () => {
  const fixture = await createFixture("deep-research-plan-retry-recovers-");
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    let runnerCalls = 0;

    const generated = await generateDeepResearchPlanService({
      sessionId: fixture.sessionId,
      sessionStore: fixture.store,
      repoRootPath: fixture.repoRoot,
      expectedPlanId: intakeComplete.id,
      settings: fixture.settings,
      runner: async () => {
        runnerCalls += 1;
        if (runnerCalls === 1) throw new Error("Planner provider unavailable");
        return { text: JSON.stringify(plannerOutput()) };
      },
    });

    assert.equal(runnerCalls, 2);
    assert.ok(generated.researchPlan, "the retry produced a usable plan");
    const attempts = readPlanningAttempts(fixture.workspace, fixture.sessionId);
    assert.deepEqual(
      attempts.map((attempt) => attempt.summary.status),
      ["failed", "succeeded"],
    );
    assert.equal(
      generated.deepResearchPlanning?.latestAttemptId,
      attempts[1]?.attemptId,
    );
  } finally {
    fixture.cleanup();
  }
});

test("Deep Research never auto-retries an unclassified planning failure", async () => {
  const fixture = await createFixture("deep-research-plan-retry-unknown-");
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    let snapshots = 0;

    await assert.rejects(
      generateDeepResearchPlanService({
        sessionId: fixture.sessionId,
        sessionStore: fixture.store,
        repoRootPath: fixture.repoRoot,
        expectedPlanId: intakeComplete.id,
        // An unclassified failure lands in the `unknown` category, which is
        // marked `retryable: true` for the *operator*. Auto-retrying on that
        // flag would silently re-run every genuine planner defect.
        settings: {
          snapshot: async () => {
            snapshots += 1;
            throw new Error("Settings backend is broken.");
          },
        },
        runner: async () => ({ text: JSON.stringify(plannerOutput()) }),
      }),
    );

    assert.equal(snapshots, 1, "only transient categories are auto-retried");
    assert.equal(
      readPlanningAttempts(fixture.workspace, fixture.sessionId).length,
      1,
    );
  } finally {
    fixture.cleanup();
  }
});

function readPlanningAttempts(
  workspace: string,
  sessionId: string,
): Array<{ attemptId: string; summary: { status: string; retryCount: number } }> {
  const attemptsPath = path.join(
    workspace,
    "sessions",
    sessionId,
    "research-planning",
    "attempts",
  );
  return fs
    .readdirSync(attemptsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      attemptId: entry.name,
      summary: JSON.parse(
        fs.readFileSync(
          path.join(attemptsPath, entry.name, "attempt.json"),
          "utf8",
        ),
      ) as { status: string; retryCount: number },
    }))
    .sort((a, b) => a.summary.retryCount - b.summary.retryCount);
}

/**
 * An exhausted provider quota is not a configuration problem and is not
 * transient. The user must be told when it resets, and the run must not spend a
 * second call against a provider that has already said it has nothing left.
 */
test("Deep Research surfaces an exhausted provider quota with its reset time and does not retry", async () => {
  const fixture = await createFixture("deep-research-plan-usage-limit-");
  try {
    const initial = await saveInitialPlan(fixture.store, fixture.sessionId);
    const intakeComplete = await reviseIntakeCompletePlan({
      plan: initial,
      sessionId: fixture.sessionId,
      store: fixture.store,
    });
    let runnerCalls = 0;

    await assert.rejects(
      generateDeepResearchPlanService({
        sessionId: fixture.sessionId,
        sessionStore: fixture.store,
        repoRootPath: fixture.repoRoot,
        expectedPlanId: intakeComplete.id,
        settings: fixture.settings,
        runner: async () => {
          runnerCalls += 1;
          throw new ProviderError({
            provider: "codex",
            message:
              "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage " +
              "to purchase more credits or try again at Aug 19th, 2026 11:32 PM.",
            retryable: false,
          });
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ServiceError);
        assert.match(error.message, /usage limit/i);
        assert.match(error.message, /Aug 19, 2026/);
        assert.doesNotMatch(
          error.message,
          /unavailable or not configured/i,
          "a quota block is not a configuration problem",
        );
        return true;
      },
    );

    assert.equal(
      runnerCalls,
      1,
      "retrying before the stated reset cannot succeed and wastes the budget",
    );
    const attempt = readOnlyPlanningAttempt(fixture.workspace, fixture.sessionId);
    assert.match(attempt.summary.error ?? "", /usage limit/i);
    assert.match(attempt.summary.error ?? "", /Aug 19, 2026/);
    assert.equal(
      attempt.summary.retryable,
      false,
      "a non-retryable provider failure must not offer the user a Retry button",
    );
  } finally {
    fixture.cleanup();
  }
});
