import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode, useState } from "react";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeepResearchJourneySnapshot } from "@/lib/clients/deep-research-journey-client";
import type {
  DeepResearchPlanningAttemptSnapshot,
  ResearchPlan,
  ResearchTask,
  ResearchWorkerSpec,
  RunPlan,
  SessionTask,
} from "@/lib/models/session-model";

import { DeepResearchDeliveryStage } from "../deep-research-stages";
import { DeepResearchWorkspace } from "../deep-research-workspace";

const fetchMock = vi.fn<typeof fetch>();

describe("DeepResearchWorkspace", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps planning controls hidden while Deep Research intake is unresolved", () => {
    renderPlanningWorkspace(
      bareRunPlan({
        deepResearchIntakeComplete: false,
        requiredInputs: ["audience", "jurisdiction", "research plan"],
        status: "needs_input",
      }),
      "Who is the report for, and which geography should it cover?",
    );

    expect(
      screen.getByText(
        "Who is the report for, and which geography should it cover?",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Canonical Research Brief"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Generate research plan" }),
    ).not.toBeInTheDocument();
  });

  it("automatically generates a plan and explains the wait once intake is complete", async () => {
    const generation = deferred<Response>();
    const onRunPlanUpdated = vi.fn();
    servePlanGeneration((expectedPlanId) => {
      expect(expectedPlanId).toBe("run-plan-auto-generation");
      return generation.promise;
    });

    renderPlanningWorkspace(
      bareRunPlan({
        id: "run-plan-auto-generation",
        deepResearchIntakeComplete: true,
        requiredInputs: ["research plan"],
        status: "needs_input",
      }),
      "The research intake is ready.",
      { configureJourney: false, onRunPlanUpdated },
    );

    expect(
      await screen.findByText(
        "Preparing your research plan",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Generate research plan/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Regenerate plan/i }),
    ).not.toBeInTheDocument();
    expect(researchPlanGenerationCalls()).toHaveLength(1);

    const generated = runPlan({ id: "run-plan-generated" });
    await act(async () => {
      generation.resolve(jsonResponse({ plan: generated }));
      await generation.promise;
    });
    await waitFor(() => expect(onRunPlanUpdated).toHaveBeenCalledWith(generated));
  });

  it("surfaces an SSE final-plan refetch failure and retries without starting another attempt", async () => {
    const onRunPlanUpdated = vi.fn();
    const pending = planningAttempt({
      attemptId: "attempt-stream",
      expectedPlanId: "run-plan-stream",
    });
    const terminal = planningAttempt({
      ...pending,
      revision: 4,
      status: "succeeded",
      phase: "ready",
      finalProposalHash: "a".repeat(64),
      finalRunPlanId: "run-plan-after-stream",
      retryable: false,
    });
    const generated = runPlan({ id: "run-plan-after-stream" });
    let runPlanFetches = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url === "/api/sessions/session-1/tasks") {
        return jsonResponse({ tasks: [] });
      }
      if (
        method === "POST" &&
        url === "/api/sessions/session-1/run-plan/research-plan"
      ) {
        return jsonResponse({ attempt: pending }, 202);
      }
      if (
        method === "GET" &&
        url.includes("/attempt-stream/events")
      ) {
        const event = {
          sequence: terminal.revision,
          type: "planning.status",
          timestamp: terminal.updatedAt,
          snapshot: terminal,
        };
        return new Response(
          `event: planning.status\ndata: ${JSON.stringify(event)}\n\n`,
          {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          },
        );
      }
      if (
        method === "GET" &&
        url === "/api/sessions/session-1/run-plan"
      ) {
        runPlanFetches += 1;
        if (runPlanFetches === 1) {
          throw new TypeError("final plan network unavailable");
        }
        return jsonResponse({ plan: generated });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    renderPlanningWorkspace(
      pendingResearchPlan("run-plan-stream"),
      "The research intake is ready.",
      { configureJourney: false, onRunPlanUpdated },
    );

    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent("final plan network unavailable");
    expect(onRunPlanUpdated).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(onRunPlanUpdated).toHaveBeenCalledWith(generated),
    );
    expect(researchPlanGenerationCalls()).toHaveLength(1);
    expect(runPlanFetches).toBe(2);
  });

  it("restores the latest durable planning attempt without creating a duplicate", async () => {
    const onRunPlanUpdated = vi.fn();
    const generated = runPlan({ id: "run-plan-restored" });
    const restored = planningAttempt({
      attemptId: "attempt-restored",
      expectedPlanId: "run-plan-awaiting-restore",
      revision: 7,
      status: "succeeded",
      phase: "ready",
      finalProposalHash: "a".repeat(64),
      finalRunPlanId: generated.id,
      retryable: false,
    });
    fetchMock.mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url === "/api/sessions/session-1/tasks") {
        return jsonResponse({ tasks: [] });
      }
      if (
        method === "GET" &&
        url.endsWith("/attempts/attempt-restored")
      ) {
        return jsonResponse({ attempt: restored });
      }
      if (method === "GET" && url === "/api/sessions/session-1/run-plan") {
        return jsonResponse({ plan: generated });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    const pendingPlan = pendingResearchPlan("run-plan-awaiting-restore");
    pendingPlan.deepResearchPlanning = {
      schemaVersion: 1,
      planningRevisionId: "planning-revision-restored",
      revisionNumber: 1,
      origin: "initial",
      requiresSolReview: false,
      amendmentMessageIds: [],
      latestAttemptId: restored.attemptId,
      createdAt: "2026-07-25T12:00:00.000Z",
    };

    renderPlanningWorkspace(
      pendingPlan,
      "The research intake is ready.",
      { configureJourney: false, onRunPlanUpdated },
    );
    await waitFor(() =>
      expect(onRunPlanUpdated).toHaveBeenCalledWith(generated),
    );
    expect(researchPlanGenerationCalls()).toHaveLength(0);
  });

  it("guards cancellation against double submission while the stream is active", async () => {
    const queued = planningAttempt({
      attemptId: "attempt-cancel",
      expectedPlanId: "run-plan-cancel",
      status: "running",
      phase: "drafting",
      revision: 1,
    });
    const cancelling = planningAttempt({
      ...queued,
      status: "cancelling",
      revision: 2,
      cancellationRequestedAt: "2026-07-25T12:00:01.000Z",
    });
    fetchMock.mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url === "/api/sessions/session-1/tasks") {
        return jsonResponse({ tasks: [] });
      }
      if (
        method === "POST" &&
        url === "/api/sessions/session-1/run-plan/research-plan"
      ) {
        return jsonResponse({ attempt: queued }, 202);
      }
      if (method === "GET" && url.includes("/attempt-cancel/events")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      if (
        method === "DELETE" &&
        url.endsWith("/attempts/attempt-cancel")
      ) {
        return jsonResponse({ attempt: cancelling }, 202);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    renderPlanningWorkspace(
      pendingResearchPlan("run-plan-cancel"),
      "The research intake is ready.",
      { configureJourney: false },
    );
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    fireEvent.click(cancel);
    fireEvent.click(cancel);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Cancelling…" }),
      ).toBeDisabled(),
    );
    const cancellationCalls = fetchMock.mock.calls.filter(([input, init]) =>
      (init?.method ?? "GET") === "DELETE" &&
      requestUrl(input).endsWith("/attempts/attempt-cancel"),
    );
    expect(cancellationCalls).toHaveLength(1);
  });

  it("deduplicates automatic generation across StrictMode and a same-plan rerender", async () => {
    const generation = deferred<Response>();
    const onRunPlanUpdated = vi.fn();
    servePlanGeneration(() => generation.promise);
    const pendingPlan = bareRunPlan({
      id: "run-plan-strict-mode",
      deepResearchIntakeComplete: true,
      requiredInputs: ["research plan"],
      status: "needs_input",
    });

    const view = render(
      <StrictMode>
        <DeepResearchWorkspace
          onRunPlanUpdated={onRunPlanUpdated}
          onTaskStarted={vi.fn()}
          renderPlanningChat={(append) => <main>{append}</main>}
          runPlan={pendingPlan}
          sessionId="session-1"
          taskRefreshKey={0}
        />
      </StrictMode>,
    );

    await screen.findByTestId("deep-research-plan-generating");
    await waitFor(() => expect(researchPlanGenerationCalls()).toHaveLength(1));

    view.rerender(
      <StrictMode>
        <DeepResearchWorkspace
          onRunPlanUpdated={onRunPlanUpdated}
          onTaskStarted={vi.fn()}
          renderPlanningChat={(append) => <main>{append}</main>}
          runPlan={{ ...pendingPlan }}
          sessionId="session-1"
          taskRefreshKey={0}
        />
      </StrictMode>,
    );
    await waitFor(() => expect(researchPlanGenerationCalls()).toHaveLength(1));

    const generated = runPlan({ id: "run-plan-strict-mode-generated" });
    await act(async () => {
      generation.resolve(jsonResponse({ plan: generated }));
      await generation.promise;
    });
    await waitFor(() => expect(onRunPlanUpdated).toHaveBeenCalledTimes(1));
    expect(onRunPlanUpdated).toHaveBeenCalledWith(generated);
  });

  it("regenerates for a revised RunPlan and ignores the stale prior result", async () => {
    const firstGeneration = deferred<Response>();
    const revisedGeneration = deferred<Response>();
    const onRunPlanUpdated = vi.fn();
    servePlanGeneration((expectedPlanId) => {
      if (expectedPlanId === "run-plan-before-revision") {
        return firstGeneration.promise;
      }
      if (expectedPlanId === "run-plan-after-revision") {
        return revisedGeneration.promise;
      }
      throw new Error(`Unexpected generation plan: ${expectedPlanId}`);
    });

    const view = render(
      <DeepResearchWorkspace
        onRunPlanUpdated={onRunPlanUpdated}
        onTaskStarted={vi.fn()}
        renderPlanningChat={(append) => <main>{append}</main>}
        runPlan={pendingResearchPlan("run-plan-before-revision")}
        sessionId="session-1"
        taskRefreshKey={0}
      />,
    );
    await waitFor(() => expect(researchPlanGenerationCalls()).toHaveLength(1));

    view.rerender(
      <DeepResearchWorkspace
        onRunPlanUpdated={onRunPlanUpdated}
        onTaskStarted={vi.fn()}
        renderPlanningChat={(append) => <main>{append}</main>}
        runPlan={pendingResearchPlan("run-plan-after-revision")}
        sessionId="session-1"
        taskRefreshKey={0}
      />,
    );
    await waitFor(() => expect(researchPlanGenerationCalls()).toHaveLength(2));

    await act(async () => {
      firstGeneration.resolve(
        jsonResponse({ plan: runPlan({ id: "stale-generated-plan" }) }),
      );
      await firstGeneration.promise;
    });
    expect(onRunPlanUpdated).not.toHaveBeenCalled();

    const revised = runPlan({ id: "revised-generated-plan" });
    await act(async () => {
      revisedGeneration.resolve(jsonResponse({ plan: revised }));
      await revisedGeneration.promise;
    });
    await waitFor(() => expect(onRunPlanUpdated).toHaveBeenCalledTimes(1));
    expect(onRunPlanUpdated).toHaveBeenCalledWith(revised);
    expect(
      screen.queryByRole("button", { name: /Generate research plan/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Regenerate plan/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps a legacy generated brief hidden until intake is explicitly reconfirmed", () => {
    const generatedPlan = researchPlan();
    renderPlanningWorkspace(
      bareRunPlan({
        researchPlan: {
          ...generatedPlan,
          request: {
            ...generatedPlan.request,
            excludedScope: [],
            includedScope: [],
            jurisdictions: [],
            sourceRequirements: [],
          },
        },
        researchPlanProposalHash: "a".repeat(64),
      }),
    );

    expect(screen.queryByText("Canonical Research Brief")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Generate research plan" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Not geographically constrained")).not.toBeInTheDocument();
  });

  it("shows the brief only after intake is explicitly confirmed", () => {
    const generatedPlan = researchPlan();
    renderPlanningWorkspace(
      runPlan({
        deepResearchIntakeComplete: true,
        researchPlan: {
          ...generatedPlan,
          request: {
            ...generatedPlan.request,
            excludedScope: [],
            includedScope: [],
            jurisdictions: [],
            sourceRequirements: [],
          },
        },
      }),
    );

    expect(screen.getByText("Canonical Research Brief")).toBeInTheDocument();
    expect(screen.getByText("Proposed Research Plan")).toBeInTheDocument();
    expect(screen.queryByText("To be confirmed")).not.toBeInTheDocument();
  });

  it("keeps the journey rail inside the center workspace and renders the brief, AI Plan, and AI Tasks in chat", async () => {
    serveJourney({ tasks: [] });

    render(
      <DeepResearchWorkspace
        onRunPlanUpdated={vi.fn()}
        onTaskStarted={vi.fn()}
        renderPlanningChat={(append) => (
          <main data-testid="planning-chat">
            <p>Compare the enterprise research platforms.</p>
            {append}
          </main>
        )}
        runPlan={runPlan()}
        sessionId="session-1"
        taskRefreshKey={0}
      />,
    );

    const workspace = screen.getByTestId("deep-research-workspace");
    const rail = within(workspace).getByLabelText("Deep Research Journey");
    expect(rail.parentElement).toBe(workspace);
    expect(
      within(rail).queryByText(
        "Synthesis and quality criticism run automatically inside Research.",
      ),
    ).not.toBeInTheDocument();
    expect(within(workspace).getByTestId("planning-chat")).toHaveTextContent(
      "Compare the enterprise research platforms.",
    );
    const brief = within(workspace).getByRole("region", {
      name: "Which enterprise research platform should we adopt?",
    });
    expect(within(brief).getByText("Canonical Research Brief")).toBeInTheDocument();
    expect(within(brief).getByText("Proposed Research Plan")).toBeInTheDocument();
    const taskRow = within(workspace).getByRole("button", {
      name: "Task 1. Verify market signals",
    });
    expect(taskRow).toBeInTheDocument();
    expect(
      within(workspace).queryByText("Which primary sources establish adoption?"),
    ).not.toBeInTheDocument();
    expect(within(taskRow).getByText("Enterprise market analyst")).toBeInTheDocument();
    expect(within(workspace).queryByText("general-research-v1")).not.toBeInTheDocument();
    expect(within(workspace).queryByText("Independent")).not.toBeInTheDocument();
    expect(
      within(workspace).queryByRole("button", {
        name: /Inspect assignment details/i,
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(taskRow);
    expect(
      await screen.findByRole("heading", {
        name: "Task 1. Verify market signals",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Enterprise market analyst").length,
    ).toBeGreaterThan(1);
    expect(
      screen.getByText("Which primary sources establish adoption?"),
    ).toBeInTheDocument();
    const generatedPrompt = screen.getByTestId("generated-research-agent-prompt");
    expect(generatedPrompt).toHaveTextContent(
      "You are the Enterprise market analyst, a task-scoped deep research specialist for Enterprise software.",
    );
    expect(generatedPrompt).toHaveTextContent(
      "Approach this assignment as an enterprise adoption evidence analyst. Separate vendor claims from independently corroborated deployment evidence.",
    );
    expect(generatedPrompt).toHaveTextContent("WORKING DEFINITIONS");
    expect(generatedPrompt).toHaveTextContent("DECISION USE");
    expect(generatedPrompt).toHaveTextContent("ACCEPTANCE CRITERIA");
    expect(generatedPrompt).toHaveTextContent("BOUNDARIES");
    expect(screen.queryByText("Agent description")).not.toBeInTheDocument();
    expectNoManualStageAdvance(workspace);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/tasks");
    });
  });

  it("keeps a task-start failure visible after approval changes the RunPlan ID", async () => {
    const unapprovedResearchPlan = draftResearchPlan();
    const initialPlan = runPlan({
      id: "run-plan-before-approval",
      researchPlan: unapprovedResearchPlan,
      researchPlanProposalHash: "proposal-hash",
      requiredInputs: ["research plan approval"],
      status: "needs_input",
    });
    const approvedPlan = runPlan({
      id: "run-plan-after-approval",
      researchPlan: {
        ...unapprovedResearchPlan,
        approvedAt: "2026-07-17T14:02:00.000Z",
        approvalHash: "approved-hash",
      },
      researchPlanProposalHash: "approved-hash",
      requiredInputs: [],
      status: "ready",
    });
    fetchMock.mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url === "/api/sessions/session-1/tasks") {
        return jsonResponse({ tasks: [] });
      }
      if (
        method === "POST" &&
        url ===
          "/api/sessions/session-1/run-plan/research-plan/approve"
      ) {
        return jsonResponse({ plan: approvedPlan });
      }
      if (method === "POST" && url === "/api/sessions/session-1/tasks") {
        return new Response(JSON.stringify({ error: "Worker launch failed" }), {
          headers: { "content-type": "application/json" },
          status: 500,
        });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    function ApprovalHarness() {
      const [plan, setPlan] = useState(initialPlan);
      return (
        <DeepResearchWorkspace
          onRunPlanUpdated={setPlan}
          onTaskStarted={vi.fn()}
          renderPlanningChat={(append) => <main>{append}</main>}
          runPlan={plan}
          sessionId="session-1"
          taskRefreshKey={0}
        />
      );
    }
    render(<ApprovalHarness />);

    fireEvent.click(
      screen.getByRole("button", { name: "Approve & start research" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Worker launch failed",
    );
    expect(screen.getByText("Approved")).toBeInTheDocument();
  });

  /**
   * The composer beside this workspace can show a result as attached, and
   * approving the plan starts the same kind of run Begin workflow does. It
   * launched with none of them.
   */
  it("carries the selected results into the approved research run", async () => {
    const task = sessionTask({ status: "queued" });
    let launchBody: Record<string, unknown> | undefined;
    fetchMock.mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url === "/api/sessions/session-1/tasks") {
        return jsonResponse({ tasks: [] });
      }
      if (method === "POST" && url === "/api/sessions/session-1/tasks") {
        launchBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse(task);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    render(
      <DeepResearchWorkspace
        contextResultIds={["team:board:attempt-1"]}
        onRunPlanUpdated={vi.fn()}
        onTaskStarted={vi.fn()}
        renderPlanningChat={(append) => <main>{append}</main>}
        runPlan={runPlan()}
        sessionId="session-1"
        taskRefreshKey={0}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start research" }));

    await waitFor(() => expect(launchBody).toBeDefined());
    expect(launchBody?.contextResultIds).toEqual(["team:board:attempt-1"]);
  });

  it("sends no context when the composer attached none", async () => {
    const task = sessionTask({ status: "queued" });
    let launchBody: Record<string, unknown> | undefined;
    fetchMock.mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url === "/api/sessions/session-1/tasks") {
        return jsonResponse({ tasks: [] });
      }
      if (method === "POST" && url === "/api/sessions/session-1/tasks") {
        launchBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse(task);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    renderPlanningWorkspace(runPlan(), undefined, {
      configureJourney: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "Start research" }));

    await waitFor(() => expect(launchBody).toBeDefined());
    expect(launchBody?.contextResultIds).toBeUndefined();
  });

  it("reports a successful research start for shell auto-collapse", async () => {
    const task = sessionTask({ status: "queued" });
    const onTaskStarted = vi.fn();
    let taskStarted = false;
    fetchMock.mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url === "/api/sessions/session-1/tasks") {
        return jsonResponse({ tasks: taskStarted ? [task] : [] });
      }
      if (method === "POST" && url === "/api/sessions/session-1/tasks") {
        taskStarted = true;
        return jsonResponse(task);
      }
      if (
        method === "GET" &&
        url === "/api/sessions/session-1/tasks/task-1/deep-research"
      ) {
        return jsonResponse(journeySnapshot({ taskStatus: "queued" }));
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    render(
      <DeepResearchWorkspace
        onRunPlanUpdated={vi.fn()}
        onTaskStarted={onTaskStarted}
        renderPlanningChat={(append) => <main>{append}</main>}
        runPlan={runPlan()}
        sessionId="session-1"
        taskRefreshKey={0}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start research" }));

    await waitFor(() => expect(onTaskStarted).toHaveBeenCalledWith(task));
  });

  it("does not let an older Deep Research task override a newly selected planning flow", async () => {
    serveJourney({
      tasks: [
        sessionTask({
          status: "done",
          completedAt: "2026-07-17T14:10:00.000Z",
        }),
        sessionTask({
          id: "task-2",
          runId: "other-run",
          workflowId: "clarify-debate-write",
          status: "done",
          createdAt: "2026-07-17T15:00:00.000Z",
          updatedAt: "2026-07-17T15:10:00.000Z",
          completedAt: "2026-07-17T15:10:00.000Z",
        }),
      ],
    });

    renderWorkspace();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/tasks");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(
      screen.getByTestId("deep-research-planning-block"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start research" }),
    ).toBeEnabled();
  });

  it("does not let a terminal Deep Research task block a newer plan revision", async () => {
    const generation = deferred<Response>();
    const onRunPlanUpdated = vi.fn();
    servePlanGeneration(
      () => generation.promise,
      [
        unlinkedSessionTask({
          status: "done",
          completedAt: "2026-07-17T14:10:00.000Z",
        }),
      ],
    );

    renderPlanningWorkspace(
      pendingResearchPlan("run-plan-new-research"),
      "Start a new Deep Research request.",
      { configureJourney: false, onRunPlanUpdated },
    );

    expect(
      await screen.findByText(
        "Preparing your research plan",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(researchPlanGenerationCalls()).toHaveLength(1));

    const generated = runPlan({ id: "run-plan-new-research-generated" });
    await act(async () => {
      generation.resolve(jsonResponse({ plan: generated }));
      await generation.promise;
    });
    await waitFor(() => expect(onRunPlanUpdated).toHaveBeenCalledWith(generated));
  });

  it("keeps a reviewer correction wave in Research without exposing Attention required", async () => {
    const task = sessionTask({ status: "interrupted" });
    serveJourney({
      tasks: [task],
      snapshot: journeySnapshot({
        phase: "research",
        taskStatus: "interrupted",
        research: {
          status: "correcting",
          correctionWave: 2,
          block: null,
          workers: [
            {
              taskId: "T1",
              displayRole: "Enterprise market analyst",
              status: "running",
              attempt: 3,
            },
          ],
        },
        quality: qualityVerdict("REVISE", 1),
      }),
    });

    renderWorkspace();

    const researchStage = await screen.findByTestId(
      "deep-research-stage-research-in-progress",
    );
    await waitFor(() =>
      expect(researchStage).toHaveTextContent("Targeted Correction Wave 2"),
    );
    expect(researchStage).toHaveTextContent(
      "This remains part of Research and will be audited again automatically.",
    );
    expect(researchStage).toHaveTextContent(
      "The quality audit requested targeted corrections · Wave 2",
    );
    const qualityHeading = within(researchStage).getByRole("heading", {
      name: "Quality Audit",
    });
    const correctionHeading = within(researchStage).getByText(
      "Targeted Correction Wave 2",
    );
    expect(
      qualityHeading.compareDocumentPosition(correctionHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(screen.getByLabelText("Deep Research Journey")).queryByRole(
        "button",
        { name: /Attention required/i },
      ),
    ).not.toBeInTheDocument();
    expectNoManualStageAdvance(researchStage);
  });

  it.each([
    [
      "drafting" as const,
      "Evidence-bound section dossiers are being drafted in bounded parallel",
    ],
    [
      "synthesizing" as const,
      "Validated evidence is being synthesized into the research package",
    ],
    [
      "reviewing" as const,
      "The evidence critic is reviewing synthesis and source quality · Wave 0",
    ],
  ])("shows the active %s phase below Research in Progress", async (status, message) => {
    const task = sessionTask({ status: "running" });
    serveJourney({
      tasks: [task],
      snapshot: journeySnapshot({
        research: {
          status,
          correctionWave: 0,
          block: null,
          workers: [],
        },
      }),
    });

    renderWorkspace();

    const researchStage = await screen.findByTestId(
      "deep-research-stage-research-in-progress",
    );
    await waitFor(() => expect(researchStage).toHaveTextContent(message));
  });

  it.each([
    ["collecting" as const, "Researching", "1"],
    ["drafting" as const, "Drafting sections", "2"],
    ["synthesizing" as const, "Synthesizing", "3"],
    ["reviewing" as const, "Reviewing", "4"],
    ["correcting" as const, "Researching", "1"],
  ])("highlights and pulses the active %s research step", async (status, label, number) => {
    const task = sessionTask({ status: "running" });
    serveJourney({
      tasks: [task],
      snapshot: journeySnapshot({
        research: {
          status,
          correctionWave: status === "correcting" ? 1 : 0,
          block: null,
          workers: [],
        },
      }),
    });

    renderWorkspace();

    const researchStage = await screen.findByTestId(
      "deep-research-stage-research-in-progress",
    );
    const progress = within(researchStage).getByRole("list", {
      name: "Research progress steps",
    });
    const activeStep = await within(progress).findByRole("listitem", {
      name: `${label}: active`,
    });
    expect(activeStep).toHaveAttribute("aria-current", "step");
    expect(within(activeStep).getByText(number)).toHaveClass(
      "animate-pulse",
      "border-orange-500/60",
    );
    expect(within(progress).getAllByRole("listitem")).toHaveLength(5);
  });

  it("shows all five research states as complete after approval", async () => {
    serveJourney({
      tasks: [sessionTask({ status: "done" })],
      snapshot: journeySnapshot({
        taskStatus: "done",
        research: {
          status: "approved",
          correctionWave: 0,
          block: null,
          workers: [],
        },
      }),
    });

    renderWorkspace();

    const researchStage = await screen.findByTestId(
      "deep-research-stage-research-in-progress",
    );
    const progress = within(researchStage).getByRole("list", {
      name: "Research progress steps",
    });
    await within(progress).findByRole("listitem", {
      name: "Approved: complete",
    });
    expect(
      within(progress).getAllByRole("listitem", { name: /: complete$/ }),
    ).toHaveLength(5);
    expect(within(progress).getByRole("listitem", { name: "Approved: complete" }))
      .toHaveAttribute("aria-current", "step");
    expect(within(progress).getByText("5")).not.toHaveClass("animate-pulse");
  });

  it("shows durable progress for each researcher without exposing orchestration IDs", async () => {
    const task = sessionTask({ status: "running" });
    serveJourney({
      tasks: [task],
      snapshot: journeySnapshot({
        research: {
          status: "collecting",
          correctionWave: 0,
          block: null,
          workers: [
            {
              taskId: "T1",
              displayRole: "Enterprise market analyst",
              status: "running",
              attempt: 1,
            },
          ],
        },
      }),
    });

    renderWorkspace();

    const stage = await screen.findByTestId(
      "deep-research-stage-research-in-progress",
    );
    await waitFor(() =>
      expect(
        within(stage).getByText("Task 1. Verify market signals"),
      ).toBeInTheDocument(),
    );
    expect(within(stage).getByRole("button", {
      name: "View research activity for Task 1. Verify market signals: running",
    })).toBeInTheDocument();
    expect(within(stage).getByText("Which primary sources establish adoption?")).toBeInTheDocument();
    expect(within(stage).queryByText("general-research-v1")).not.toBeInTheDocument();
    expect(within(stage).queryByText("Enterprise software")).not.toBeInTheDocument();

    fireEvent.click(
      within(stage).getByRole("button", {
        name: "Assigned Agent: Enterprise market analyst",
      }),
    );
    expect(await screen.findByRole("heading", {
      name: "Enterprise market analyst",
    })).toBeInTheDocument();
    const generatedPrompt = screen.getByTestId("generated-research-agent-prompt");
    expect(generatedPrompt).toHaveTextContent(
      "You are the Enterprise market analyst, a task-scoped deep research specialist for Enterprise software.",
    );
    expect(generatedPrompt).toHaveTextContent(
      "Approach this assignment as an enterprise adoption evidence analyst. Separate vendor claims from independently corroborated deployment evidence.",
    );
    expect(generatedPrompt).toHaveTextContent("WORKING DEFINITIONS");
    expect(generatedPrompt).toHaveTextContent("ACCEPTANCE CRITERIA");
  });

  it("opens a task-scoped research activity sheet from the worker status", async () => {
    serveJourney({
      tasks: [sessionTask()],
      snapshot: journeySnapshot({
        research: {
          status: "collecting",
          correctionWave: 0,
          block: null,
          workers: [{
            taskId: "T1",
            displayRole: "Enterprise market analyst",
            status: "running",
            attempt: 1,
          }],
        },
      }),
      researchActivities: [
        researchActivity({ title: "Matching lane source" }),
        researchActivity({
          activityId: "wrong-lane",
          activityScopeId: "lane-2",
          title: "Wrong lane source",
        }),
        researchActivity({
          activityId: "wrong-root-run",
          runId: "older-root-run",
          title: "Older run source",
        }),
        researchActivity({
          activityId: "wrong-assignment",
          assignmentId: "editorial-run",
          title: "Wrong assignment source",
        }),
      ],
    });

    renderWorkspace();

    const stage = await screen.findByTestId(
      "deep-research-stage-research-in-progress",
    );
    fireEvent.click(await within(stage).findByRole("button", {
      name: "View research activity for Task 1. Verify market signals: running",
    }));

    expect(await screen.findByRole("heading", {
      name: "Enterprise market analyst research activity",
    })).toBeInTheDocument();
    expect(await screen.findByText("Matching lane source")).toBeInTheDocument();
    expect(screen.queryByText("Wrong lane source")).not.toBeInTheDocument();
    expect(screen.queryByText("Older run source")).not.toBeInTheDocument();
    expect(screen.queryByText("Wrong assignment source")).not.toBeInTheDocument();
  });

  it("keeps terminal worker status activity inspectable with an empty state", async () => {
    serveJourney({
      tasks: [sessionTask({ status: "done" })],
      snapshot: journeySnapshot({
        taskStatus: "done",
        research: {
          status: "approved",
          correctionWave: 0,
          block: null,
          workers: [{
            taskId: "T1",
            displayRole: "Enterprise market analyst",
            status: "completed",
            attempt: 1,
          }],
        },
      }),
      researchActivities: [],
    });

    renderWorkspace();

    const stage = await screen.findByTestId(
      "deep-research-stage-research-in-progress",
    );
    fireEvent.click(await within(stage).findByRole("button", {
      name: "View research activity for Task 1. Verify market signals: completed",
    }));

    expect(await screen.findByText(
      "No research activity was recorded for this research task.",
    )).toBeInTheDocument();
  });

  it("polls and updates multiple researcher states independently", async () => {
    const task = sessionTask({ status: "running" });
    const initialPlan = researchPlan();
    const secondWorker = {
      ...researchWorkerSpec(),
      id: "worker-2",
      laneId: "lane-2",
      displayRole: "Security evidence analyst",
      question: "Which primary sources establish the security controls?",
      decisionUse: "Verify the security case for adoption.",
    };
    const plan: ResearchPlan = {
      ...initialPlan,
      sections: initialPlan.sections.map((section) => ({
        ...section,
        taskIds: ["T1", "T2"],
      })),
      tasks: [
        ...initialPlan.tasks,
        {
          ...researchTask(),
          id: "T2",
          title: "Verify security controls",
          question: secondWorker.question,
          workerSpecId: secondWorker.id,
        },
      ],
      workerSpecs: [...initialPlan.workerSpecs, secondWorker],
      expectedPeakWorkers: 2,
    };
    let snapshot = journeySnapshot({
      plan,
      research: {
        status: "collecting",
        correctionWave: 0,
        block: null,
        workers: [
          {
            taskId: "T1",
            displayRole: "Enterprise market analyst",
            status: "running",
            attempt: 1,
          },
          {
            taskId: "T2",
            displayRole: "Security evidence analyst",
            status: "pending",
            attempt: 1,
          },
        ],
      },
    });
    let journeyRequests = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url === "/api/sessions/session-1/tasks") {
        return jsonResponse({ tasks: [task] });
      }
      if (
        method === "GET" &&
        url === "/api/sessions/session-1/tasks/task-1/deep-research"
      ) {
        journeyRequests += 1;
        return jsonResponse(snapshot);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });

    renderWorkspace();

    const stage = await screen.findByTestId(
      "deep-research-stage-research-in-progress",
    );
    const firstCard = (
      await within(stage).findByText("Task 1. Verify market signals")
    ).closest('[data-slot="collapsible"]');
    const secondCard = (
      await within(stage).findByText("Task 2. Verify security controls")
    ).closest('[data-slot="collapsible"]');
    expect(firstCard).not.toBeNull();
    expect(secondCard).not.toBeNull();
    expect(
      within(firstCard as HTMLElement).getByRole("button", {
        name: "View research activity for Task 1. Verify market signals: running",
      }),
    ).toHaveClass(
      "border-orange-500/40",
      "bg-orange-500/10",
      "text-orange-500",
    );
    expect(
      within(secondCard as HTMLElement).getByRole("button", {
        name: "View research activity for Task 2. Verify security controls: pending",
      }),
    ).toBeInTheDocument();

    snapshot = journeySnapshot({
      plan,
      research: {
        status: "collecting",
        correctionWave: 0,
        block: null,
        workers: [
          {
            taskId: "T1",
            displayRole: "Enterprise market analyst",
            status: "completed",
            attempt: 1,
          },
          {
            taskId: "T2",
            displayRole: "Security evidence analyst",
            status: "failed",
            attempt: 1,
          },
        ],
      },
    });

    await waitFor(
      () => {
        expect(
          within(firstCard as HTMLElement).getByRole("button", {
            name: "View research activity for Task 1. Verify market signals: completed",
          }),
        ).toBeInTheDocument();
        expect(
          within(secondCard as HTMLElement).getByRole("button", {
            name: "View research activity for Task 2. Verify security controls: failed",
          }),
        ).toHaveClass(
          "border-destructive/40",
          "bg-destructive/10",
          "text-destructive",
        );
      },
      { timeout: 2_500 },
    );
    expect(
      within(stage).queryByText(/There are no manual advance controls/i),
    ).not.toBeInTheDocument();
    expect(journeyRequests).toBeGreaterThanOrEqual(2);
  });

  it("adds Attention required only when the durable snapshot escalates", async () => {
    const task = sessionTask({ status: "blocked" });
    serveJourney({
      tasks: [task],
      snapshot: journeySnapshot({
        phase: "escalation",
        taskStatus: "blocked",
        workflow: {
          status: "blocked",
          revision: 7,
          currentStepId: "research",
          steps: [
            { id: "research", status: "blocked", runId: "research-run" },
          ],
        },
        research: {
          status: "blocked",
          correctionWave: 2,
          block: {
            kind: "quality",
            message: "The bounded quality policy could not resolve the evidence gap.",
          },
          workers: [
            {
              taskId: "T1",
              displayRole: "Enterprise market analyst",
              status: "pending",
              attempt: 3,
            },
          ],
        },
        quality: qualityVerdict("ESCALATE", 2),
        escalation: {
          runId: "research-run",
          relativePath: "research/quality/escalation.md",
        },
        artifacts: [
          {
            kind: "escalation",
            label: "Escalation brief",
            runId: "research-run",
            relativePath: "research/quality/escalation.md",
            mediaType: "text/markdown",
          },
        ],
      }),
    });

    renderWorkspace();

    const escalationStage = await screen.findByTestId(
      "deep-research-stage-attention-required",
    );
    expect(screen.queryByText("Live Stage")).not.toBeInTheDocument();
    expect(screen.queryByText("Live Now")).not.toBeInTheDocument();
    expect(screen.getAllByText("Attention Required").length).toBeGreaterThan(0);
    expect(
      screen.queryByTestId("deep-research-stage-research-in-progress"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Enterprise market analyst")).not.toBeInTheDocument();
    expect(
      within(screen.getByLabelText("Deep Research Journey")).getByRole(
        "button",
        { name: /Attention required/i },
      ),
    ).toHaveAttribute("aria-current", "step");
    expect(
      within(
        within(screen.getByLabelText("Deep Research Journey")).getByRole(
          "button",
          { name: /Attention required/i },
        ),
      ).getByText("Action Required"),
    ).toBeInTheDocument();
    expect(escalationStage).toHaveTextContent("Quality decision · ESCALATE");
    expect(
      within(screen.getByLabelText("Deep Research Journey")).getByRole(
        "button",
        { name: /Research.*blocked/i },
      ),
    ).toBeInTheDocument();
    expect(escalationStage).toHaveTextContent(
      "The approved scope cannot support a safe conclusion.",
    );
    expect(
      within(escalationStage).getByRole("button", {
        name: /Open escalation brief/i,
      }),
    ).toHaveAttribute(
      "href",
      "/api/runs/research-run/assignments/research/quality/escalation.md",
    );
    expectNoManualStageAdvance(escalationStage);
  });

  it("leads an execution block with its runtime cause instead of the stale critic verdict", async () => {
    const task = sessionTask({ status: "blocked" });
    serveJourney({
      tasks: [task],
      snapshot: journeySnapshot({
        phase: "escalation",
        taskStatus: "blocked",
        workflow: {
          status: "blocked",
          revision: 8,
          currentStepId: "research",
          steps: [{ id: "research", status: "blocked", runId: "research-run" }],
        },
        research: {
          status: "blocked",
          correctionWave: 1,
          block: {
            kind: "execution",
            message: "Insufficient remaining execution budget to start T4 safely.",
          },
          workers: [],
        },
        quality: qualityVerdict("REVISE", 0),
        escalation: {
          runId: "research-run",
          relativePath: "research/quality/escalation.md",
        },
      }),
    });

    renderWorkspace();

    const stage = await screen.findByTestId(
      "deep-research-stage-attention-required",
    );
    expect(stage).toHaveTextContent("Execution decision · BLOCKED");
    expect(stage).toHaveTextContent(
      "Insufficient remaining execution budget to start T4 safely.",
    );
    expect(stage).not.toHaveTextContent("Quality decision · REVISE");
  });

  it("restores an active publication without presenting unfinished files as delivered", async () => {
    const task = sessionTask({ status: "running" });
    serveJourney({
      tasks: [task],
      snapshot: journeySnapshot({
        phase: "delivery",
        taskStatus: "running",
        workflow: {
          status: "running",
          revision: 8,
          currentStepId: "publish",
          steps: [
            { id: "research", status: "completed", runId: "research-run" },
            { id: "editorial", status: "completed", runId: "editorial-run" },
            { id: "publish", status: "running", runId: "publish-run" },
          ],
        },
        artifacts: deliveryArtifacts().slice(0, 1),
      }),
    });

    renderWorkspace();

    const deliveryStage = await screen.findByTestId(
      "deep-research-stage-final-documentation",
    );
    expect(within(deliveryStage).getByText("Publishing")).toBeInTheDocument();
    expect(within(deliveryStage).queryByText("Delivered")).not.toBeInTheDocument();
    expect(within(deliveryStage).getAllByText("Not available yet")).toHaveLength(2);
  });
});

describe("DeepResearchDeliveryStage", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the AI Elements FileTree and provides working report, artifact, and DOCX actions", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/final-report.md")) {
        return textResponse("# Final recommendation\n\nAdopt with controls.");
      }
      if (url.endsWith("/research-report.md")) {
        return textResponse("# Audited research package\n\nEvidence is traceable.");
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(
      <DeepResearchDeliveryStage
        snapshot={journeySnapshot({
          phase: "delivery",
          taskStatus: "done",
          workflow: {
            status: "completed",
            revision: 9,
            currentStepId: null,
            steps: [
              { id: "research", status: "completed", runId: "research-run" },
              { id: "editorial", status: "completed", runId: "editorial-run" },
              { id: "publish", status: "completed", runId: "publish-run" },
            ],
          },
          artifacts: deliveryArtifacts(),
        })}
      />,
    );

    const stage = screen.getByTestId(
      "deep-research-stage-final-documentation",
    );
    expect(within(stage).getByRole("tree")).toBeInTheDocument();
    expect(
      within(stage).getByRole("treeitem", { name: "final-report.md" }),
    ).toBeInTheDocument();
    expect(
      within(stage).getByRole("treeitem", { name: "research-report.md" }),
    ).toBeInTheDocument();
    expect(
      within(stage).getByRole("button", { name: /Download/i }),
    ).toHaveAttribute(
      "href",
      "/api/runs/publish-run/assignments/final-report.docx",
    );

    fireEvent.click(within(stage).getByRole("button", { name: /Open report/i }));
    expect(
      await screen.findByRole("heading", { name: "final-report.md" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Adopt with controls.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs/publish-run/assignments/final-report.md",
    );

    const [closeSheetButton] = screen.getAllByLabelText("Close artifact sheet", {
      selector: "button",
    });
    assert.isDefined(closeSheetButton);
    fireEvent.click(closeSheetButton);
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "final-report.md" }),
      ).not.toBeInTheDocument();
    });

    fireEvent.click(
      within(stage).getByRole("treeitem", { name: "research-report.md" }),
    );
    expect(
      await screen.findByRole("heading", { name: "research-report.md" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Evidence is traceable."),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs/research-run/assignments/research-report.md",
    );
    expectNoManualStageAdvance(stage);
  });
});

function renderWorkspace() {
  return render(
    <DeepResearchWorkspace
      onRunPlanUpdated={vi.fn()}
      onTaskStarted={vi.fn()}
      renderPlanningChat={(append) => <main>{append}</main>}
      runPlan={runPlan()}
      sessionId="session-1"
      taskRefreshKey={0}
    />,
  );
}

function renderPlanningWorkspace(
  plan: RunPlan,
  conversationText = "The research intake is ready.",
  options: {
    configureJourney?: boolean;
    onRunPlanUpdated?: (plan: RunPlan) => void;
  } = {},
) {
  if (options.configureJourney !== false) serveJourney({ tasks: [] });
  return render(
    <DeepResearchWorkspace
      onRunPlanUpdated={options.onRunPlanUpdated ?? vi.fn()}
      onTaskStarted={vi.fn()}
      renderPlanningChat={(append) => (
        <main>
          <p>{conversationText}</p>
          {append}
        </main>
      )}
      runPlan={plan}
      sessionId="session-1"
      taskRefreshKey={0}
    />,
  );
}

function servePlanGeneration(
  generate: (expectedPlanId: string) => Promise<Response>,
  tasks: SessionTask[] = [],
) {
  let generatedPlan: RunPlan | null = null;
  fetchMock.mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "/api/sessions/session-1/tasks") {
      return jsonResponse({ tasks });
    }
    if (
      method === "POST" &&
      url === "/api/sessions/session-1/run-plan/research-plan"
    ) {
      const body = JSON.parse(String(init?.body)) as {
        expectedPlanId: string;
      };
      const generated = await generate(body.expectedPlanId);
      if (!generated.ok) return generated;
      const payload = (await generated.json()) as { plan: RunPlan };
      generatedPlan = payload.plan;
      return jsonResponse({
        attempt: completedPlanningAttempt(
          body.expectedPlanId,
          payload.plan.id,
        ),
      }, 202);
    }
    if (
      method === "GET" &&
      url === "/api/sessions/session-1/run-plan" &&
      generatedPlan
    ) {
      return jsonResponse({ plan: generatedPlan });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
}

function completedPlanningAttempt(
  expectedPlanId: string,
  finalRunPlanId: string,
) {
  const now = "2026-07-25T12:00:00.000Z";
  return {
    schemaVersion: 3,
    attemptId: `attempt-${expectedPlanId}`,
    planningRevisionId: `planning-revision-${expectedPlanId}`,
    expectedPlanId,
    revision: 0,
    retryCount: 0,
    status: "succeeded",
    phase: "ready",
    route: "terra_only",
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    stages: {
      terra: {
        startedAt: now,
        completedAt: now,
        durationMs: 1,
        provider: "codex",
        model: "gpt-5.6-terra",
        thinking: "medium",
      },
    },
    candidates: {},
    findings: [],
    finalProposalHash: "a".repeat(64),
    finalRunPlanId,
    retryable: false,
  };
}

function planningAttempt(
  overrides: Partial<DeepResearchPlanningAttemptSnapshot> = {},
): DeepResearchPlanningAttemptSnapshot {
  const now = "2026-07-25T12:00:00.000Z";
  return {
    schemaVersion: 3 as const,
    attemptId: "attempt-1",
    planningRevisionId: "planning-revision-1",
    expectedPlanId: "run-plan-1",
    revision: 0,
    retryCount: 0,
    status: "queued" as const,
    phase: "accepted" as const,
    route: "terra_only" as const,
    createdAt: now,
    updatedAt: now,
    stages: {},
    candidates: {},
    findings: [],
    ...overrides,
  };
}

function researchPlanGenerationCalls() {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const method = init?.method ?? "GET";
    return (
      method === "POST" &&
      requestUrl(input) ===
        "/api/sessions/session-1/run-plan/research-plan"
    );
  });
}

function pendingResearchPlan(id: string): RunPlan {
  return bareRunPlan({
    id,
    deepResearchIntakeComplete: true,
    requiredInputs: ["research plan"],
    status: "needs_input",
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function serveJourney({
  researchActivities,
  snapshot,
  tasks,
}: {
  researchActivities?: readonly unknown[];
  snapshot?: DeepResearchJourneySnapshot;
  tasks: SessionTask[];
}) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "/api/sessions/session-1/tasks") {
      return jsonResponse({ tasks });
    }
    if (
      method === "GET" &&
      url === "/api/sessions/session-1/tasks/task-1/deep-research" &&
      snapshot
    ) {
      return jsonResponse(snapshot);
    }
    if (
      method === "GET" &&
      url === "/api/sessions/session-1/research-activity" &&
      researchActivities
    ) {
      return jsonResponse({ activities: researchActivities });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
}

function researchActivity(overrides: Record<string, unknown> = {}) {
  return {
    activityId: "matching-activity",
    source: "browser",
    sessionId: "session-1",
    runId: "root-run",
    assignmentId: "research-run",
    activityScopeId: "lane-1",
    agentPath: "agents/web-researcher",
    toolCallId: "matching-call",
    action: "open",
    kind: "page",
    state: "completed",
    createdAt: "2026-08-18T12:00:00.000Z",
    updatedAt: "2026-08-18T12:00:01.000Z",
    url: "https://example.com/source",
    title: "Matching lane source",
    ...overrides,
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function textResponse(payload: string): Response {
  return new Response(payload, {
    headers: { "content-type": "text/plain" },
    status: 200,
  });
}

function expectNoManualStageAdvance(container: HTMLElement) {
  expect(
    within(container).queryByRole("button", { name: /^Advance$/i }),
  ).not.toBeInTheDocument();
  expect(
    within(container).queryByRole("button", { name: /^Continue$/i }),
  ).not.toBeInTheDocument();
}

function sessionTask(overrides: Partial<SessionTask> = {}): SessionTask {
  return unlinkedSessionTask({ runPlanId: "run-plan-1", ...overrides });
}

function unlinkedSessionTask(
  overrides: Partial<SessionTask> = {},
): SessionTask {
  return {
    id: "task-1",
    sessionId: "session-1",
    runId: "root-run",
    workflowId: "deep-research-report",
    brief: "Compare enterprise research platforms.",
    status: "running",
    createdAt: "2026-07-17T14:00:00.000Z",
    updatedAt: "2026-07-17T14:05:00.000Z",
    cwd: "/workspace",
    ...overrides,
  };
}

function runPlan(overrides: Partial<RunPlan> = {}): RunPlan {
  return bareRunPlan({
    deepResearchIntakeComplete: true,
    researchPlan: researchPlan(),
    researchPlanProposalHash: "a".repeat(64),
    ...overrides,
  });
}

function bareRunPlan(overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    id: "run-plan-1",
    goal: "Compare enterprise research platforms.",
    summary: "Produce an evidence-backed adoption recommendation.",
    status: "ready",
    selectedWorkflow: {
      id: "deep-research-report",
      rationale: "The request needs parallel, source-traceable research.",
      confidence: "high",
    },
    requiredInputs: [],
    actions: [],
    warnings: [],
    createdAt: "2026-07-17T14:00:00.000Z",
    ...overrides,
  };
}

function researchPlan(): ResearchPlan {
  return {
    ...draftResearchPlan(),
    approvedAt: "2026-07-17T14:02:00.000Z",
    approvalHash: "a".repeat(64),
  };
}

function draftResearchPlan(): ResearchPlan {
  return {
    schemaVersion: 1,
    planId: "research-plan-1",
    requestId: "request-1",
    request: {
      schemaVersion: 1,
      requestId: "request-1",
      question: "Which enterprise research platform should we adopt?",
      objective: "Produce an evidence-backed adoption recommendation.",
      audience: "Product leadership",
      includedScope: ["Enterprise research workflows"],
      excludedScope: ["Consumer search products"],
      desiredSections: ["Market evidence"],
      jurisdictions: ["United States"],
      freshnessAsOf: "2026-07-17T00:00:00.000Z",
      authenticatedDomains: [],
      sourceRequirements: ["Prefer primary sources"],
      maxDurationMinutes: 20,
      maxResearcherAgents: 6,
      outputFormats: ["markdown", "docx"],
    },
    sections: [
      {
        schemaVersion: 1,
        id: "market",
        title: "Market evidence",
        objective: "Establish adoption and product evidence.",
        taskIds: ["T1"],
      },
    ],
    tasks: [researchTask()],
    workerSpecs: [researchWorkerSpec()],
    maxDurationMinutes: 20,
    maxResearcherAgents: 6,
    expectedPeakWorkers: 1,
    authenticatedDomains: [],
  };
}

function researchTask(): ResearchTask {
  return {
    schemaVersion: 1,
    id: "T1",
    sectionId: "market",
    title: "Verify market signals",
    question: "Which primary sources establish adoption?",
    purpose: "evidence_verification",
    workerSpecId: "worker-1",
    dependsOn: [],
    correctionWave: 0,
  };
}

function researchWorkerSpec(): ResearchWorkerSpec {
  return {
    schemaVersion: 1,
    id: "worker-1",
    laneId: "lane-1",
    sectionId: "market",
    baseAgent: "web-researcher",
    displayRole: "Enterprise market analyst",
    domain: "Enterprise software",
    lens: "market",
    methodCardIds: ["general-research-v1"],
    specialistStance:
      "Approach this assignment as an enterprise adoption evidence analyst. Separate vendor claims from independently corroborated deployment evidence.",
    question: "Which primary sources establish adoption?",
    decisionUse: "Support the adoption decision.",
    workingDefinitions: [
      "Treat adoption as verified only when an observed source identifies actual organizational use.",
    ],
    dependencyClaimIds: [],
    sourceRequirements: {
      preferredTypes: ["primary"],
      requiredAuthorityTypes: ["vendor", "regulatory"],
      queryHints: [],
    },
    requiredMetrics: ["enterprise customers"],
    prohibitedAssumptions: ["Do not infer adoption from web traffic."],
    stopRule: {
      minimumPrimarySources: 1,
      minimumIndependentSources: 2,
      maximumSources: 8,
    },
    limits: { deadlineMs: 1_200_000 },
  };
}

function journeySnapshot(
  overrides: Partial<DeepResearchJourneySnapshot> = {},
): DeepResearchJourneySnapshot {
  return {
    version: 1,
    sessionId: "session-1",
    taskId: "task-1",
    workflowId: "deep-research-report",
    taskStatus: "running",
    phase: "research",
    updatedAt: "2026-07-17T14:05:00.000Z",
    integrity: "complete",
    workflow: {
      status: "running",
      revision: 3,
      currentStepId: "research",
      steps: [
        { id: "research", status: "running", runId: "research-run" },
      ],
    },
    plan: researchPlan(),
    research: {
      status: "collecting",
      correctionWave: 0,
      block: null,
      workers: [],
    },
    quality: null,
    escalation: null,
    artifacts: [],
    ...overrides,
  };
}

function qualityVerdict(
  decision: "REVISE" | "ESCALATE",
  correctionWave: 0 | 1 | 2,
): NonNullable<DeepResearchJourneySnapshot["quality"]> {
  return {
    decision,
    correctionWave,
    reviewedAt: "2026-07-17T14:04:00.000Z",
    findings: [
      {
        code: "required_authority_missing",
        severity: decision === "ESCALATE" ? "blocking" : "warning",
        message:
          decision === "ESCALATE"
            ? "The approved scope cannot support a safe conclusion."
            : "One adoption claim needs stronger authority.",
        taskIds: ["T1"],
        sectionIds: ["market"],
        claimIds: ["claim-1"],
        sourceIds: [],
      },
    ],
    correctionRequests: [
      {
        schemaVersion: 1,
        id: "correction-1",
        type: "verify_source",
        claimIds: ["claim-1"],
        taskIds: ["T1"],
        sectionIds: ["market"],
        question: "Find an authoritative source for the adoption claim.",
        acceptanceCriteria: ["Cite one authoritative primary source."],
        impactScope: "local",
      },
    ],
  };
}

function deliveryArtifacts(): DeepResearchJourneySnapshot["artifacts"] {
  return [
    {
      kind: "research_report",
      label: "Audited research package",
      runId: "research-run",
      relativePath: "research-report.md",
      mediaType: "text/markdown",
    },
    {
      kind: "final_markdown",
      label: "Final Markdown report",
      runId: "publish-run",
      relativePath: "final-report.md",
      mediaType: "text/markdown",
    },
    {
      kind: "final_docx",
      label: "Final Word document",
      runId: "publish-run",
      relativePath: "final-report.docx",
      mediaType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  ];
}
