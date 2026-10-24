import { act, getConfig, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ResourceArchitectPlan,
  ResourceArchitectTurnMetric,
  ResourceBuildJobSnapshot,
} from "@contracts/resource-architect";
import { useResourceArchitectChat } from "../use-resource-architect-chat";

function makeBuild(kind: "agent" | "team") {
  const resource = { kind, id: "completed-reviewer" };
  const plan: ResourceArchitectPlan = kind === "agent"
    ? {
      id: "completed-plan", kind: "standalone_agents",
      agents: [{ name: resource.id, role: "Reviewer", description: "Reviews products.", rationale: "Requested." }],
    }
    : {
      id: "completed-plan", kind: "team",
      team: { teamId: resource.id, description: "Reviews products.", tags: [], existingAgents: [], newAgents: [], questionsResolved: [] },
    };
  const job: ResourceBuildJobSnapshot = {
    jobId: "completed-job", planId: plan.id,
    startedAt: "2026-09-20T10:00:00.000Z", status: "completed",
    items: [{ plannedResource: resource, resource, planIndex: 0, status: "created" }],
    selectedResource: resource, events: [],
  };
  return { plan, job };
}

function makeMetric(): ResourceArchitectTurnMetric {
  return {
    schemaVersion: 1, recordedAt: "2026-09-20T09:59:00.000Z",
    jobId: "old-proposal", operation: "proposal", status: "completed",
    provider: "local", model: "fixture", reasoning: "low",
    outcomeKind: "standalone_agents", fallback: false,
    selection: { provider: "local", model: "fixture", source: "app-default", reason: "agent-default", caller: "authoring" },
    review: {
      reviewStatus: "not_reviewed", reviewerId: "reviewer-of-agent-architect",
      defaultFallbackAttempted: false, failureReason: "reviewer_unavailable", phases: [],
    },
    timing: {
      contextAssemblyMs: 0, providerDurationMs: 0, processSpawnMs: null,
      firstProviderEventMs: null, firstTextMs: null, parseDurationMs: 0,
      repairOccurred: false, repairDurationMs: 0, totalDurationMs: 0,
      context: {
        instructionsChars: 0, operationChars: 0, uploadedDocumentPolicyChars: 0,
        visualizationPolicyChars: 0, teamLibraryChars: 0, agentLibraryChars: 0,
        totalChars: 0, historyChars: 0,
      },
    },
  };
}

function deferredResponse() {
  let resolve: (response: Response) => void = () => { throw new Error("Response not initialized"); };
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

const json = (value: unknown) => new Response(JSON.stringify(value), {
  headers: { "content-type": "application/json" },
});

function serveBuild(build: ReturnType<typeof makeBuild>) {
  const jobs = deferredResponse();
  const metrics = deferredResponse();
  // Intercept only HTTP to control the otherwise nondeterministic order of
  // recovery and telemetry replies. Electron covers the real API and stores.
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/resource-architect/conversation")) return Promise.resolve(json(null));
    if (url.endsWith("/resource-architect/jobs")) return jobs.promise.then((response) => response.clone());
    if (url.includes("/resource-architect/metrics")) return metrics.promise.then((response) => response.clone());
    if (url.endsWith("/shape")) return Promise.resolve(json({
      planId: build.plan.id, revision: "sha256:fixture", plan: build.plan,
    }));
    if (url.includes("/resource-architect/jobs/")) return Promise.resolve(json({ job: build.job }));
    if (url.endsWith("/team-builder/teams")) return Promise.resolve(json({ teams: [{
      id: "completed-reviewer", name: "Completed Reviewer", tags: [], agentCount: 0,
      health: { status: "ok", errors: [], warnings: [] },
    }] }));
    throw new Error(`Unexpected restoration request: ${url}`);
  }));
  return { jobs, metrics };
}

afterEach(() => vi.unstubAllGlobals());

describe("completed build restoration", () => {
  it.each(["agent", "team"] as const)("reopens a completed %s build as an empty chat", async (kind) => {
    const build = makeBuild(kind);
    const server = serveBuild(build);
    const selected: unknown[] = [];
    const onSelectResource = (resource: unknown) => { selected.push(resource); };
    // Resolved by the render in which restoration reports it has settled, so
    // the assertions below cannot run before an older attempt could be restored.
    let settle = (): void => {};
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const { result } = renderHook(() => {
      const chat = useResourceArchitectChat({
        model: { provider: "local", model: "fixture" },
        onSelectResource,
      });
      if (!chat.restoring) settle();
      return chat;
    });
    await act(async () => { server.metrics.resolve(json({ metrics: [makeMetric()] })); });
    expect(result.current.restoredReviewNotices).toHaveLength(1);

    // The older attempt is interrupted, which Create would restore on its own.
    // Only the completed attempt in front of it can keep it off the screen.
    await act(async () => {
      server.jobs.resolve(json({ jobs: [
        { ...build.job, jobId: "older-interrupted-attempt", status: "interrupted", startedAt: "2026-09-19T10:00:00.000Z" },
        build.job,
      ] }));
    });
    // React defers rendering inside act(), so the signal is awaited outside it.
    await getConfig().asyncWrapper(() => settled);

    expect(result.current.pendingPlan).toBeNull();
    expect(result.current.buildJob).toBeNull();
    expect(result.current.history).toEqual([]);
    expect(result.current.modelSelections).toEqual([]);
    expect(result.current.restoredReviewNotices).toEqual([]);
    expect(result.current.submitting).toBe(false);
    expect(selected).toEqual([]);
  });

  it("keeps the completed chat empty when old telemetry arrives after recovery", async () => {
    const build = makeBuild("agent");
    const server = serveBuild(build);
    const { result } = renderHook(() => useResourceArchitectChat({ model: { provider: "local", model: "fixture" } }));

    await act(async () => { server.jobs.resolve(json({ jobs: [build.job] })); });
    await act(async () => { server.metrics.resolve(json({ metrics: [makeMetric()] })); });

    expect(result.current.history).toEqual([]);
    expect(result.current.modelSelections).toEqual([]);
    expect(result.current.restoredReviewNotices).toEqual([]);
  });

  it("restores a build that is still running with its pending state", async () => {
    const build = makeBuild("agent");
    build.job.status = "running";
    build.job.selectedResource = null;
    build.job.items = [{ plannedResource: { kind: "agent", id: "completed-reviewer" }, planIndex: 0, status: "generating" }];
    const server = serveBuild(build);
    const { result } = renderHook(() => useResourceArchitectChat({ model: { provider: "local", model: "fixture" } }));

    await act(async () => {
      server.jobs.resolve(json({ jobs: [build.job] }));
      server.metrics.resolve(json({ metrics: [] }));
    });

    await waitFor(() => expect(result.current.buildJob?.status).toBe("running"));
    expect(result.current.pendingPlan?.id).toBe("completed-plan");
    expect(result.current.submitting).toBe(true);
  });
});
