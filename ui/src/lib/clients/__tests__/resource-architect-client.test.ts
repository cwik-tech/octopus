import { afterEach, expect, test, vi } from "vitest";

import {
  listResourceArchitectMetrics,
  listResourceBuildJobs,
  postResourceArchitectTurn,
  readResourceBuildJob,
  retryResourceBuildJob,
  startResourceBuildJob,
} from "@/lib/clients/resource-architect-client";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeMeta() {
  return {
    provider: "openai",
    model: "test-model",
    fallback: false,
    reasoning: "low",
    timing: {
      contextAssemblyMs: 1,
      providerDurationMs: 2,
      processSpawnMs: null,
      firstProviderEventMs: null,
      firstTextMs: null,
      parseDurationMs: 0,
      repairOccurred: false,
      repairDurationMs: 0,
      totalDurationMs: 3,
      context: {
        instructionsChars: 1,
        operationChars: 1,
        uploadedDocumentPolicyChars: 1,
        visualizationPolicyChars: 1,
        teamLibraryChars: 1,
        agentLibraryChars: 1,
        totalChars: 6,
        historyChars: 1,
      },
    },
  };
}

function stubTurnResponse(payload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    ),
  );
}

async function postWithPayload(payload: unknown) {
  stubTurnResponse(payload);
  return postResourceArchitectTurn({
    jobId: "job-1",
    operation: "conversation",
    history: [{ role: "user", text: "build it" }],
    currentPlan: null,
  });
}

function notReviewedDiagnostics() {
  return {
    reviewStatus: "not_reviewed", reviewerId: "reviewer-of-agent-architect",
    defaultFallbackAttempted: false, failureReason: "review_output_invalid",
    failedPhase: "review", phases: [],
  };
}

test("keeps validated review diagnostics across the response boundary", async () => {
  const review = notReviewedDiagnostics();
  const result = await postWithPayload({
    jobId: "job-1", operation: "conversation", message: "Draft answer.",
    warnings: ["Not reviewed. Reviewer of Agent Architect could not complete review."],
    meta: { ...makeMeta(), review },
  });
  expect(result).toMatchObject({ meta: { review } });
});

test("bounds the authoring HTTP request with an abort signal", async () => {
  await postWithPayload({
    jobId: "job-1", operation: "conversation", message: "Final answer.",
    warnings: [], meta: makeMeta(),
  });
  const call = vi.mocked(fetch).mock.lastCall;
  expect(call?.[0]).toBeTypeOf("string");
  expect(call?.[1]?.signal).toBeInstanceOf(AbortSignal);
});

test("keeps review diagnostics in records loaded after reopening Create", async () => {
  const review = notReviewedDiagnostics();
  stubJson({ metrics: [{ ...validMetric(), review }] });
  expect(await listResourceArchitectMetrics()).toMatchObject([{ review }]);
});

test("rejects unvalidated review status and private review payload fields", async () => {
  await expect(postWithPayload({
    jobId: "job-1", operation: "conversation", message: "Draft answer.", warnings: [],
    meta: { ...makeMeta(), review: { ...notReviewedDiagnostics(), draft: "private" } },
  })).rejects.toThrow(/ResourceArchitectFeedbackDiagnostics/);
  stubJson({ metrics: [{ ...validMetric(), review: { reviewStatus: "approved" } }] });
  await expect(listResourceArchitectMetrics()).rejects.toThrow(/ResourceArchitectFeedbackDiagnostics/);
});

test("keeps the turn's recorded selection so a Create surface can disclose it", async () => {
  // The server records how the model was decided; the browser is the only place
  // that shows it. A validator that rebuilds meta field by field and omits this
  // one silently ends the disclosure at the network boundary.
  const result = await postWithPayload({
    jobId: "job-1",
    operation: "conversation",
    message: "Understood.",
    warnings: [],
    meta: {
      ...makeMeta(),
      selection: {
        provider: "openai",
        model: "test-model",
        source: "app-default",
        reason: "agent-default",
        caller: "authoring",
      },
    },
  });

  expect("cancelled" in result).toBe(false);
  if ("cancelled" in result) return;
  expect(result.meta.selection).toEqual({
    provider: "openai",
    model: "test-model",
    source: "app-default",
    reason: "agent-default",
    caller: "authoring",
  });
});

test("refuses a selection it cannot read whole rather than showing half of one", async () => {
  const result = await postWithPayload({
    jobId: "job-1",
    operation: "conversation",
    message: "Understood.",
    warnings: [],
    meta: { ...makeMeta(), selection: { provider: "openai", source: "app-default" } },
  });

  expect("cancelled" in result).toBe(false);
  if ("cancelled" in result) return;
  expect(result.meta.selection).toBeUndefined();
});

test("accepts a conversation response carrying a literal proposalRequested true", async () => {
  const result = await postWithPayload({
    jobId: "job-1",
    operation: "conversation",
    message: "Understood — preparing the proposal for your review.",
    warnings: [],
    proposalRequested: true,
    meta: makeMeta(),
  });

  expect("cancelled" in result).toBe(false);
  if ("cancelled" in result) return;
  expect(result.operation).toBe("conversation");
  if (result.operation !== "conversation") return;
  expect(result.proposalRequested).toBe(true);
});

test("accepts a conversation response without the proposal-request signal", async () => {
  const result = await postWithPayload({
    jobId: "job-1",
    operation: "conversation",
    message: "Just say the word.",
    warnings: [],
    meta: makeMeta(),
  });

  expect("cancelled" in result).toBe(false);
  if ("cancelled" in result || result.operation !== "conversation") return;
  expect(result.proposalRequested).toBeUndefined();
});

test("accepts a proposal response with nested outcome and meta", async () => {
  const result = await postWithPayload({
    jobId: "job-1",
    operation: "proposal",
    message: "Proposal ready for review.",
    warnings: ["heads up"],
    outcome: {
      id: "plan-1",
      kind: "standalone_agents",
      agents: [{
        name: "contract-reviewer",
        role: "Reviewer",
        tier: "specialist",
        description: "Reviews contracts.",
        rationale: "Requested by the user.",
      }],
    },
    meta: makeMeta(),
  });

  expect("cancelled" in result).toBe(false);
  if ("cancelled" in result || result.operation !== "proposal") return;
  expect(result.outcome.kind).toBe("standalone_agents");
  expect(result.warnings).toEqual(["heads up"]);
});

test("accepts a cancelled response with and without an operation", async () => {
  const withOperation = await postWithPayload({
    jobId: "job-1",
    operation: "conversation",
    cancelled: true,
  });
  expect(withOperation).toEqual({
    jobId: "job-1",
    operation: "conversation",
    cancelled: true,
  });

  const withoutOperation = await postWithPayload({ jobId: "job-1", cancelled: true });
  expect(withoutOperation).toEqual({ jobId: "job-1", cancelled: true });
});

test("accepts a team proposal preserving document domains and specializations", async () => {
  const team = {
    teamId: "knowledge-systems-crew",
    description: "Runs knowledge-base projects.",
    tags: ["rag"],
    documentDomains: [{
      domain: "retrieval evaluation",
      evidenceAnchors: ["section 2"],
    }],
    existingAgents: [{
      name: "pragmatist",
      role: "Feasibility",
      rationale: "Scope check.",
    }],
    newAgents: [{
      name: "retrieval-architect",
      role: "Retrieval",
      description: "Owns retrieval evaluation.",
      rationale: "Needed for WP3.",
      documentSpecialization: {
        expertiseDomain: "retrieval evaluation",
        focus: "labelled question sets",
        evidenceAnchors: ["section 2"],
        assessmentTargets: ["citation quality"],
        outOfScope: ["training"],
      },
    }],
    questionsResolved: ["roster shape"],
  };
  const result = await postWithPayload({
    jobId: "job-1",
    operation: "proposal",
    message: "Proposal ready for review.",
    warnings: [],
    outcome: { id: "plan-team", kind: "team", team },
    meta: makeMeta(),
  });

  expect("cancelled" in result).toBe(false);
  if ("cancelled" in result || result.operation !== "proposal") return;
  expect(result.outcome).toEqual({ id: "plan-team", kind: "team", team });
});

test("accepts a standalone proposal whose Agents declare no grade", async () => {
  // What the server now sends. Authoring produces no grade, so a client that
  // still required one would reject every valid proposal and the Create surface
  // would show a contract error instead of the plan.
  const result = await postWithPayload({
    jobId: "job-1",
    operation: "proposal",
    message: "Proposal ready for review.",
    warnings: [],
    outcome: {
      id: "plan-1",
      kind: "standalone_agents",
      agents: [{
        name: "contract-reviewer",
        role: "Reviewer",
        description: "Reviews contracts.",
        rationale: "Requested by the user.",
      }],
    },
    meta: makeMeta(),
  });

  // The whole result, unconditionally. An early return on a wrong operation
  // would skip every check below and pass silently.
  expect(result).toEqual({
    jobId: "job-1",
    operation: "proposal",
    message: "Proposal ready for review.",
    warnings: [],
    outcome: {
      id: "plan-1",
      kind: "standalone_agents",
      agents: [{
        name: "contract-reviewer",
        role: "Reviewer",
        description: "Reviews contracts.",
        rationale: "Requested by the user.",
      }],
    },
    meta: makeMeta(),
  });
});

test("accepts a Team proposal whose roster declares no grade", async () => {
  const team = {
    teamId: "knowledge-systems-crew",
    description: "Runs knowledge-base projects.",
    tags: ["rag"],
    existingAgents: [{
      name: "pragmatist",
      role: "Feasibility",
      rationale: "Scope check.",
    }],
    newAgents: [{
      name: "retrieval-architect",
      role: "Retrieval",
      description: "Owns retrieval evaluation.",
      rationale: "Needed for WP3.",
    }],
    questionsResolved: ["roster shape"],
  };
  const result = await postWithPayload({
    jobId: "job-1",
    operation: "proposal",
    message: "Proposal ready for review.",
    warnings: [],
    outcome: { id: "plan-team", kind: "team", team },
    meta: makeMeta(),
  });

  expect(result).toEqual({
    jobId: "job-1",
    operation: "proposal",
    message: "Proposal ready for review.",
    warnings: [],
    outcome: { id: "plan-team", kind: "team", team },
    meta: makeMeta(),
  });
});

test("reads a plan recovered from before grades were retired, without one", async () => {
  // A plan file written before the field was retired still carries it, and the
  // server hands that back as context. It has to remain readable — but the
  // value the browser works with is the authoring shape, so a retired grade
  // cannot travel back out of the UI as if somebody had chosen it.
  const result = await postWithPayload({
    jobId: "job-1",
    operation: "proposal",
    message: "Proposal ready for review.",
    warnings: [],
    outcome: {
      id: "legacy-plan",
      kind: "standalone_agents",
      agents: [{
        name: "contract-reviewer",
        role: "Reviewer",
        tier: "specialist",
        description: "Reviews contracts.",
        rationale: "Requested by the user.",
      }],
    },
    meta: makeMeta(),
  });

  // Named exactly: the Agent survived, and the grade did not.
  expect(result).toEqual({
    jobId: "job-1",
    operation: "proposal",
    message: "Proposal ready for review.",
    warnings: [],
    outcome: {
      id: "legacy-plan",
      kind: "standalone_agents",
      agents: [{
        name: "contract-reviewer",
        role: "Reviewer",
        description: "Reviews contracts.",
        rationale: "Requested by the user.",
      }],
    },
    meta: makeMeta(),
  });

  // The same for a recovered Team plan, whose roster carries grades on both
  // sides: the members it already had and the ones it planned to create.
  const teamResult = await postWithPayload({
    jobId: "job-1",
    operation: "proposal",
    message: "Proposal ready for review.",
    warnings: [],
    outcome: {
      id: "legacy-team-plan",
      kind: "team",
      team: {
        teamId: "knowledge-systems-crew",
        description: "Runs knowledge-base projects.",
        tags: ["rag"],
        existingAgents: [{
          name: "pragmatist",
          role: "Feasibility",
          tier: "strategic",
          rationale: "Scope check.",
        }],
        newAgents: [{
          name: "retrieval-architect",
          role: "Retrieval",
          tier: "strategic",
          description: "Owns retrieval evaluation.",
          rationale: "Needed for WP3.",
        }],
        questionsResolved: [],
      },
    },
    meta: makeMeta(),
  });

  expect(teamResult).toEqual({
    jobId: "job-1",
    operation: "proposal",
    message: "Proposal ready for review.",
    warnings: [],
    outcome: {
      id: "legacy-team-plan",
      kind: "team",
      team: {
        teamId: "knowledge-systems-crew",
        description: "Runs knowledge-base projects.",
        tags: ["rag"],
        existingAgents: [{
          name: "pragmatist",
          role: "Feasibility",
          rationale: "Scope check.",
        }],
        newAgents: [{
          name: "retrieval-architect",
          role: "Retrieval",
          description: "Owns retrieval evaluation.",
          rationale: "Needed for WP3.",
        }],
        questionsResolved: [],
      },
    },
    meta: makeMeta(),
  });
});

const malformedPayloads: Array<[string, unknown]> = [
  ["proposalRequested false", {
    jobId: "job-1",
    operation: "conversation",
    message: "Hi.",
    warnings: [],
    proposalRequested: false,
    meta: makeMeta(),
  }],
  ["proposalRequested as a string", {
    jobId: "job-1",
    operation: "conversation",
    message: "Hi.",
    warnings: [],
    proposalRequested: "true",
    meta: makeMeta(),
  }],
  ["proposalRequested on a proposal response", {
    jobId: "job-1",
    operation: "proposal",
    message: "Proposal ready.",
    warnings: [],
    proposalRequested: true,
    outcome: { kind: "discussion" },
    meta: makeMeta(),
  }],
  ["proposalRequested on a cancelled response", {
    jobId: "job-1",
    cancelled: true,
    proposalRequested: true,
  }],
  ["missing operation discriminant", {
    jobId: "job-1",
    message: "Hi.",
    warnings: [],
    meta: makeMeta(),
  }],
  ["unknown operation value", {
    jobId: "job-1",
    operation: "build",
    message: "Hi.",
    warnings: [],
    meta: makeMeta(),
  }],
  ["non-string message", {
    jobId: "job-1",
    operation: "conversation",
    message: 42,
    warnings: [],
    meta: makeMeta(),
  }],
  ["cancelled without a jobId", { cancelled: true }],
  ["cancelled false", { jobId: "job-1", cancelled: false }],
  ["cancelled with an invalid operation", {
    jobId: "job-1",
    operation: "build",
    cancelled: true,
  }],
];

for (const [name, payload] of malformedPayloads) {
  test(`rejects ${name}`, async () => {
    await expect(postWithPayload(payload)).rejects.toThrow(/Invalid API response/);
  });
}

test("accepts an update proposal carrying the server-calculated revision", async () => {
  const result = await postWithPayload({
    jobId: "job-1",
    operation: "proposal",
    message: "I will add two Agents to contract-review-team.",
    warnings: [],
    outcome: {
      id: "update-plan-1",
      kind: "resource_updates",
      operations: [{
        kind: "add_team_agents",
        target: { kind: "team", id: "contract-review-team" },
        expectedRevision: "sha256:abc",
        libraryAgentsToAdd: [{
          name: "scoping-lawyer",
          role: "Scope reviewer",
          tier: "strategic",
          rationale: "Reuse the existing scope specialist.",
        }],
        newAgentsToCreate: [{
          name: "drafting-completeness-lawyer",
          role: "Drafting reviewer",
          tier: "strategic",
          description: "Checks drafting completeness.",
          rationale: "No existing Agent covers drafting gaps.",
        }],
      }],
    },
    meta: makeMeta(),
  });

  expect("cancelled" in result).toBe(false);
  if ("cancelled" in result || result.operation !== "proposal") return;
  expect(result.outcome.kind).toBe("resource_updates");
  if (result.outcome.kind !== "resource_updates") return;
  const operation = result.outcome.operations[0];
  expect(operation?.kind).toBe("add_team_agents");
  expect(operation?.target).toEqual({ kind: "team", id: "contract-review-team" });
  expect(operation?.expectedRevision).toBe("sha256:abc");
  if (operation?.kind !== "add_team_agents") return;
  expect(operation.libraryAgentsToAdd.map((agent) => agent.name)).toEqual([
    "scoping-lawyer",
  ]);
  expect(operation.newAgentsToCreate.map((agent) => agent.name)).toEqual([
    "drafting-completeness-lawyer",
  ]);
});

test("rejects an update proposal whose operation omits the server revision", async () => {
  await expect(
    postWithPayload({
      jobId: "job-1",
      operation: "proposal",
      message: "I will add an Agent.",
      warnings: [],
      outcome: {
        id: "update-plan-2",
        kind: "resource_updates",
        operations: [{
          kind: "add_team_agents",
          target: { kind: "team", id: "contract-review-team" },
          libraryAgentsToAdd: [],
          newAgentsToCreate: [],
        }],
      },
      meta: makeMeta(),
    }),
  ).rejects.toThrow(/ResourceUpdateOperation/);
});

/** A new Agent as a current proposal carries it: card summary beside the brief. */
function agentWithCardSummary(name: string) {
  return {
    name,
    role: "Reviewer",
    summary: `CARD-SUMMARY for ${name}.`,
    description: `BUILD-BRIEF for ${name}: every step the generator needs.`,
    rationale: "Requested by the user.",
  };
}

/** The same Agent in each place a plan can propose one. */
function outcomesWithCardSummaries(summary: unknown) {
  const agent = (name: string) => ({ ...agentWithCardSummary(name), summary });
  return [
    { id: "plan-standalone", kind: "standalone_agents", agents: [agent("renewal-reviewer")] },
    {
      id: "plan-team",
      kind: "team",
      team: {
        teamId: "renewal-team",
        description: "Reviews renewals.",
        tags: [],
        existingAgents: [],
        newAgents: [agent("renewal-reviewer")],
        questionsResolved: [],
      },
    },
    {
      id: "plan-update",
      kind: "resource_updates",
      operations: [{
        kind: "add_team_agents",
        target: { kind: "team", id: "renewal-team" },
        expectedRevision: "sha256:abc",
        libraryAgentsToAdd: [],
        newAgentsToCreate: [agent("renewal-reviewer")],
      }],
    },
  ];
}

function proposalWith(outcome: unknown) {
  return {
    jobId: "job-1",
    operation: "proposal",
    message: "Proposal ready for review.",
    warnings: [],
    outcome,
    meta: makeMeta(),
  };
}

test("keeps the card summary of every proposed new Agent beside its build brief", async () => {
  for (const outcome of outcomesWithCardSummaries("CARD-SUMMARY for renewal-reviewer.")) {
    const result = await postWithPayload(proposalWith(outcome));

    expect(result).toEqual(proposalWith(outcome));
  }
});

test("refuses a proposed Agent whose card summary is present but not text", async () => {
  for (const summary of [7, null, { text: "Reviews renewals." }]) {
    for (const outcome of outcomesWithCardSummaries(summary)) {
      await expect(postWithPayload(proposalWith(outcome))).rejects.toThrow(/Invalid API response/);
    }
  }
});

// The next turn echoes the plan back as `currentPlan`, and the server refuses a
// blank summary there. Adopting one here would stop the conversation later.
test("refuses a proposed Agent whose card summary is blank", async () => {
  for (const summary of ["", "   "]) {
    for (const outcome of outcomesWithCardSummaries(summary)) {
      await expect(postWithPayload(proposalWith(outcome))).rejects.toThrow(/Invalid API response/);
    }
  }
});

/**
 * Every boundary below reads a response this renderer did not write.
 *
 * A cast at any of them is a promise the runtime never checks: the value flows
 * on as though it had the declared shape, and the first thing that reads
 * through it fails somewhere far away with a message about the symptom rather
 * than the cause. These cases hold each public method to the same rule the
 * turn parser already follows — build the value from named fields, or refuse
 * the response here.
 */
function stubJson(payload: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
        status,
      }),
    ),
  );
}

function validSnapshot() {
  return {
    jobId: "job-1",
    planId: "plan-1",
    status: "completed",
    items: [{
      plannedResource: { kind: "team", id: "contract-review-team" },
      resource: { kind: "team", id: "contract-review-team" },
      planIndex: 0,
      status: "updated",
    }],
    selectedResource: { kind: "team", id: "contract-review-team" },
    events: [{
      id: 1,
      type: "resource_update_applied",
      plannedResource: { kind: "team", id: "contract-review-team" },
      resource: { kind: "team", id: "contract-review-team" },
      planIndex: 0,
      message: "Updated Team `contract-review-team`.",
    }],
  };
}

test("a turn still running is a readable record, not a malformed one", async () => {
  // The browser reads these to rebuild history, and the record written before
  // the provider answered is the one describing a turn in flight. A reader that
  // refuses its status makes the pending disclosure unreadable.
  stubJson({ metrics: [{ ...validMetric(), status: "running" }] });

  const [metric] = await listResourceArchitectMetrics();

  expect(metric?.status).toBe("running");
});

test("a recorded metric keeps how its model was chosen, so a reopened Create can say so", async () => {
  // The metric is the only record of a past turn that survives a reload. A
  // validator that rebuilds it field by field and omits the selection makes
  // every restored disclosure impossible, however well the turn recorded it.
  stubJson({
    metrics: [
      {
        ...validMetric(),
        selection: {
          provider: "openai",
          model: "test-model",
          source: "app-default",
          reason: "agent-default",
          caller: "authoring",
        },
      },
    ],
  });

  const [metric] = await listResourceArchitectMetrics();

  expect(metric?.selection).toEqual({
    provider: "openai",
    model: "test-model",
    source: "app-default",
    reason: "agent-default",
    caller: "authoring",
  });
});

test("a metric whose selection cannot be read whole keeps the rest of the record", async () => {
  // The timing record is still worth having. Refusing the whole metric would
  // lose history for a field that is only ever a disclosure.
  stubJson({
    metrics: [{ ...validMetric(), selection: { provider: "openai" } }],
  });

  const [metric] = await listResourceArchitectMetrics();

  expect(metric?.jobId).toBe(validMetric().jobId);
  expect(metric?.selection).toBeUndefined();
});

function validMetric() {
  return {
    schemaVersion: 1,
    recordedAt: "2026-09-01T00:00:00.000Z",
    jobId: "job-1",
    operation: "proposal",
    status: "completed",
    provider: "openai",
    model: "test-model",
    reasoning: "low",
    outcomeKind: "resource_updates",
    fallback: false,
    timing: makeMeta().timing,
  };
}

test("an error payload that is not an error report still reports the HTTP failure", async () => {
  stubJson({ error: 42, details: "not a list" }, 500);

  await expect(
    listResourceBuildJobs(),
  ).rejects.toThrow(/500/);
});

test("an error payload naming the failure is preferred over the status line", async () => {
  stubJson({ error: "Resource plan is stale", details: ["create a new plan"] }, 409);

  await expect(
    listResourceBuildJobs(),
  ).rejects.toThrow("Resource plan is stale: create a new plan");
});

test("a metrics response is refused unless every metric is one", async () => {
  stubJson({ metrics: [validMetric()] });
  await expect(listResourceArchitectMetrics()).resolves.toHaveLength(1);

  for (
    const payload of [
      {},
      { metrics: "none" },
      { metrics: [{ ...validMetric(), schemaVersion: 2 }] },
      { metrics: [{ ...validMetric(), status: "elsewhere" }] },
      { metrics: [{ ...validMetric(), timing: { ...makeMeta().timing, totalDurationMs: "3" } }] },
      { metrics: [{ ...validMetric(), provider: 7 }] },
    ]
  ) {
    stubJson(payload);
    await expect(
      listResourceArchitectMetrics(),
      `expected ${JSON.stringify(payload).slice(0, 60)} to be refused`,
    ).rejects.toThrow(/Invalid API response/);
  }
});

test("starting a build accepts a snapshot and refuses anything that is not one", async () => {
  stubJson({ jobId: "job-1", job: validSnapshot() });
  await expect(startResourceBuildJob({ planId: "plan-1" })).resolves.toEqual({
    jobId: "job-1",
    job: validSnapshot(),
  });

  stubJson({ jobId: "job-1", cancelled: true });
  await expect(startResourceBuildJob({ planId: "plan-1" })).resolves.toEqual({
    jobId: "job-1",
    cancelled: true,
  });

  for (
    const payload of [
      {},
      { job: validSnapshot() },
      { jobId: "job-1" },
      { jobId: 1, job: validSnapshot() },
      { jobId: "job-1", cancelled: "yes" },
      { jobId: "job-1", job: { ...validSnapshot(), status: "elsewhere" } },
      { jobId: "job-1", job: { ...validSnapshot(), items: "none" } },
    ]
  ) {
    stubJson(payload);
    await expect(
      startResourceBuildJob({ planId: "plan-1" }),
      `expected ${JSON.stringify(payload).slice(0, 60)} to be refused`,
    ).rejects.toThrow(/Invalid API response/);
  }
});

test("reading a job accepts a snapshot and refuses a malformed one", async () => {
  stubJson({ job: validSnapshot() });
  await expect(readResourceBuildJob("job-1")).resolves.toEqual(validSnapshot());

  for (
    const payload of [
      {},
      { job: null },
      { job: { ...validSnapshot(), planId: 3 } },
      { job: { ...validSnapshot(), selectedResource: { kind: "workflow", id: "x" } } },
      { job: { ...validSnapshot(), items: [{ ...validSnapshot().items[0], status: "elsewhere" }] } },
      { job: { ...validSnapshot(), items: [{ ...validSnapshot().items[0], planIndex: "0" }] } },
      { job: { ...validSnapshot(), events: [{ ...validSnapshot().events[0], type: "unknown" }] } },
      { job: { ...validSnapshot(), events: [{ ...validSnapshot().events[0], id: "1" }] } },
      { job: { ...validSnapshot(), events: [{ ...validSnapshot().events[0], resource: { id: "x" } }] } },
    ]
  ) {
    stubJson(payload);
    await expect(
      readResourceBuildJob("job-1"),
      `expected ${JSON.stringify(payload).slice(0, 70)} to be refused`,
    ).rejects.toThrow(/Invalid API response/);
  }
});

/**
 * An event type the client does not know refuses the whole snapshot, so a
 * build that repaired a skill would take its own card down with it.
 */
test("a job snapshot that reports a repaired skill is read back whole", async () => {
  const repaired = {
    ...validSnapshot(),
    events: [{
      id: 1,
      type: "skill_repaired",
      plannedResource: { kind: "agent", id: "crypto-risk-compliance-analyst" },
      planIndex: 0,
      message:
        "Repaired skill `crypto-scam-and-security-hygiene` to satisfy the Agent Skills specification.",
    }],
  };
  stubJson({ job: repaired });

  await expect(readResourceBuildJob("job-1")).resolves.toEqual(repaired);
});

function skillUpdateSnapshot(events: unknown[]) {
  return {
    jobId: "job-3",
    planId: "plan-3",
    status: "failed",
    items: [{
      plannedResource: { kind: "agent", id: "michigan-contract-lawyer" },
      planIndex: 0,
      status: "failed",
      error: "The skill author did not answer.",
    }],
    selectedResource: null,
    events,
  };
}

function skillEvent(id: number, type: string, skill?: unknown) {
  return {
    id,
    type,
    plannedResource: { kind: "agent", id: "michigan-contract-lawyer" },
    planIndex: 0,
    ...(skill === undefined ? {} : { skill }),
    message: `${type}.`,
  };
}

// Each row of an Agent update is resolved from these events, so the card
// needs every one of them, with the skill it names, or none of the job.
test("a job snapshot reads back every skill event with the skill it names", async () => {
  const snapshot = skillUpdateSnapshot([
    skillEvent(1, "skill_generating", { name: "termination-clause-review", action: "create" }),
    skillEvent(2, "skill_staged", { name: "termination-clause-review", action: "create" }),
    skillEvent(3, "skill_updated", { name: "termination-clause-review", action: "create" }),
    skillEvent(4, "skill_failed", { name: "indemnity-clause-review", action: "update" }),
    skillEvent(5, "skill_cancelled", { name: "cure-period-review", action: "create" }),
  ]);
  stubJson({ job: snapshot });

  await expect(readResourceBuildJob("job-3")).resolves.toEqual(snapshot);
});

test("a job snapshot refuses a skill event without a readable skill, and a skill on any other event", async () => {
  const skill = { name: "termination-clause-review", action: "create" };
  for (
    const events of [
      [skillEvent(1, "skill_staged")],
      [skillEvent(1, "skill_staged", "termination-clause-review")],
      [skillEvent(1, "skill_staged", { name: "", action: "create" })],
      [skillEvent(1, "skill_staged", { name: "termination-clause-review", action: "delete" })],
      [skillEvent(1, "resource_update_failed", skill)],
    ]
  ) {
    stubJson({ job: skillUpdateSnapshot(events) });
    await expect(
      readResourceBuildJob("job-3"),
      `expected ${JSON.stringify(events).slice(0, 90)} to be refused`,
    ).rejects.toThrow(/Invalid API response/);
  }
});

// A row is found by plan index and skill name, so a skill event without the
// index reaches no row and the job cannot say where that skill stands.
test("a job snapshot refuses a skill event that names no operation", async () => {
  const event: Record<string, unknown> = {
    ...skillEvent(1, "skill_failed", { name: "termination-clause-review", action: "create" }),
  };
  delete event.planIndex;
  stubJson({ job: skillUpdateSnapshot([event]) });

  await expect(readResourceBuildJob("job-3")).rejects.toThrow(/Invalid API response/);
});

test("a job snapshot keeps the optional fields it legitimately omits", async () => {
  const minimal = {
    jobId: "job-2",
    planId: "plan-2",
    status: "running",
    items: [{
      plannedResource: { kind: "agent", id: "scoping-lawyer" },
      planIndex: 0,
      status: "planned",
    }],
    selectedResource: null,
    events: [{ id: 1, type: "build_started", message: "Started." }],
  };
  stubJson({ job: minimal });

  await expect(readResourceBuildJob("job-2")).resolves.toEqual(minimal);
});

/**
 * Two fields a reopened Create depends on.
 *
 * `startedAt` decides which stopped build is put back on screen, and
 * `admittedRevision` is what its team's publication evidence is checked
 * against. A reader that rebuilds the snapshot without them hands the card a
 * record that cannot answer either question, and nothing says so.
 */
test("a job snapshot carries when it started and what it was admitted against", async () => {
  const recorded = {
    ...validSnapshot(),
    startedAt: "2026-09-13T10:00:00.000Z",
    admittedRevision: `sha256:${"a".repeat(64)}`,
  };
  stubJson({ job: recorded });

  await expect(readResourceBuildJob("job-1")).resolves.toEqual(recorded);
});

// Present but not readable is not the same as absent. A blank instant would
// sort as the oldest build rather than being reported as unusable.
test("a job snapshot refuses metadata that is present and malformed", async () => {
  for (
    const broken of [
      { startedAt: "" },
      { startedAt: 17 },
      { admittedRevision: "" },
      { admittedRevision: { revision: "sha256:x" } },
    ]
  ) {
    stubJson({ job: { ...validSnapshot(), ...broken } });
    await expect(
      readResourceBuildJob("job-1"),
      `expected ${JSON.stringify(broken)} to be refused`,
    ).rejects.toThrow(/Invalid API response/);
  }
});

// A build the user threw away. The card must know, or it offers to finish
// something that is gone.
test("a job snapshot carries that its build was discarded", async () => {
  const discarded = { ...validSnapshot(), discarded: true };
  stubJson({ job: discarded });

  await expect(readResourceBuildJob("job-1")).resolves.toEqual(discarded);
});

test("a job snapshot refuses a discarded flag that is not a flag", async () => {
  stubJson({ job: { ...validSnapshot(), discarded: "yes" } });
  await expect(readResourceBuildJob("job-1")).rejects.toThrow(/Invalid API response/);
});

test("listing jobs accepts a list of snapshots and refuses anything else", async () => {
  stubJson({ jobs: [validSnapshot()] });
  await expect(listResourceBuildJobs()).resolves.toEqual([validSnapshot()]);

  for (
    const payload of [
      {},
      { jobs: validSnapshot() },
      { jobs: [validSnapshot(), { ...validSnapshot(), jobId: null }] },
    ]
  ) {
    stubJson(payload);
    await expect(
      listResourceBuildJobs(),
      `expected ${JSON.stringify(payload).slice(0, 60)} to be refused`,
    ).rejects.toThrow(/Invalid API response/);
  }
});

test("retrying a build reads the same start response and refuses a malformed one", async () => {
  stubJson({ jobId: "job-1", job: validSnapshot() });
  await expect(retryResourceBuildJob({ jobId: "job-1" })).resolves.toEqual({
    jobId: "job-1",
    job: validSnapshot(),
  });

  stubJson({ jobId: "job-1", job: { ...validSnapshot(), events: "none" } });
  await expect(retryResourceBuildJob({ jobId: "job-1" }))
    .rejects.toThrow(/Invalid API response/);
});

test("a history with no turns is sent as no turns", async () => {
  stubJson({
    jobId: "job-1",
    operation: "conversation",
    message: "Hello.",
    warnings: [],
    meta: makeMeta(),
  });

  await expect(
    postResourceArchitectTurn({
      jobId: "job-1",
      operation: "conversation",
      history: [],
      currentPlan: null,
    }),
  ).resolves.toMatchObject({ operation: "conversation" });
});

// The shape is the whole of the feature the card shows. A reader that rebuilds
// the plan field by field and forgets it leaves the renderer with nothing to
// draw, and `TeamShapeBlock` returns null rather than reporting anything.
test("carries the proposed interaction shape through to the renderer", async () => {
  const team = {
    teamId: "contract-review-team",
    description: "Reviews contracts.",
    tags: [],
    existingAgents: [{
      name: "risk-lead",
      role: "Lead",
      rationale: "Already available.",
    }],
    newAgents: [{
      name: "risk-spotter",
      role: "Risk reviewer",
      description: "Finds clauses that expose you.",
      rationale: "No existing Agent covers this.",
    }],
    questionsResolved: [],
    shape: {
      kind: "discussion",
      rationale: "These agents disagree usefully.",
      depth: "standard",
      coordinator: "risk-lead",
      participants: ["risk-spotter"],
    },
  };
  const result = await postWithPayload({
    jobId: "job-1",
    operation: "proposal",
    message: "Proposal ready for review.",
    warnings: [],
    outcome: { id: "plan-team", kind: "team", team },
    meta: makeMeta(),
  });

  expect("cancelled" in result).toBe(false);
  if ("cancelled" in result || result.operation !== "proposal") return;
  expect(result.outcome).toEqual({ id: "plan-team", kind: "team", team });
});

// A wire value that is not a shape this app can build must not become a plan
// that silently builds the legacy chain instead. The reader rebuilds from the
// contract, so an unknown kind is refused rather than dropped.
test("refuses a team proposal whose shape is not one this app can build", async () => {
  const team = {
    teamId: "contract-review-team",
    description: "Reviews contracts.",
    tags: [],
    existingAgents: [],
    newAgents: [{
      name: "risk-spotter",
      role: "Risk reviewer",
      description: "Finds risky clauses.",
      rationale: "Needed.",
    }],
    questionsResolved: [],
    shape: { kind: "broadcast", rationale: "Everyone at once.", depth: "quick" },
  };

  await expect(
    postWithPayload({
      jobId: "job-1",
      operation: "proposal",
      message: "Proposal ready for review.",
      warnings: [],
      outcome: { id: "plan-team", kind: "team", team },
      meta: makeMeta(),
    }),
  ).rejects.toThrow();
});

/**
 * What a refusal reads like when it reaches the user.
 *
 * The server answers a refused build with a machine code and a sentence: the
 * code is what the card branches on, the sentence is what a person can act on.
 * Only the code was being used, so a user who pressed Create on a discarded
 * plan was shown `build_discarded`.
 */
test("a refusal is reported in the words the server wrote, not its code", async () => {
  stubJson(
    {
      error: "build_discarded",
      reason: "What this build made was discarded. Start a new plan to build it again.",
    },
    409,
  );
  await expect(startResourceBuildJob({ planId: "plan-1" })).rejects.toThrow(
    /What this build made was discarded\. Start a new plan to build it again\./,
  );
  await expect(startResourceBuildJob({ planId: "plan-1" })).rejects.not.toThrow(
    /build_discarded/,
  );
});

test("a refusal with no sentence still says what it can", async () => {
  // The code alone, which is what some refusals carry.
  stubJson({ error: "Create job 'job-1' is already running" }, 409);
  await expect(startResourceBuildJob({ planId: "plan-1" })).rejects.toThrow(
    /Create job 'job-1' is already running/,
  );

  // Neither, so the status line is the only truthful thing left.
  stubJson({ nothing: "useful" }, 503);
  await expect(startResourceBuildJob({ planId: "plan-1" })).rejects.toThrow(/503/);

  // A `reason` that is not a sentence is not one, and the code still shows.
  stubJson({ error: "invalid_shape", reason: { not: "a string" } }, 422);
  await expect(startResourceBuildJob({ planId: "plan-1" })).rejects.toThrow(
    /invalid_shape/,
  );
});

test("a refusal keeps the details it listed", async () => {
  stubJson(
    {
      error: "invalid_shape",
      reason: "Every team member must appear in exactly one role.",
      details: ["risk-lead", "risk-spotter"],
    },
    422,
  );
  await expect(startResourceBuildJob({ planId: "plan-1" })).rejects.toThrow(
    /Every team member must appear in exactly one role\.: risk-lead; risk-spotter/,
  );
});

test("accepts an Architect reply that ran at a level beyond the original three", async () => {
  // The Architect loader now honours the level its own persona names, so a
  // successful reply can report `xhigh`. Rejecting it here would turn a turn
  // that worked into a contract error, and the user would see the authoring
  // request fail for a setting they chose in the editor.
  const review = notReviewedDiagnostics();
  for (const reasoning of ["xhigh", "max", "provider-default"]) {
    const result = await postWithPayload({
      jobId: "job-1", operation: "conversation", message: "Draft answer.",
      warnings: [],
      meta: { ...makeMeta(), reasoning, review },
    });
    // The level is carried, and the diagnostics beside it are untouched.
    expect(result).toMatchObject({ meta: { reasoning, review } });
  }
});

test("still rejects a reasoning level that is not one of ours", async () => {
  await expect(postWithPayload({
    jobId: "job-1", operation: "conversation", message: "Draft answer.", warnings: [],
    meta: { ...makeMeta(), reasoning: "adaptive" },
  })).rejects.toThrow(/ResourceArchitectTurnMeta/);
});
