/**
 * What Create actually sends when the user presses it.
 *
 * The client module is deliberately not mocked here. A test that hands
 * `expectedRevision` straight to `startResourceBuildJob` proves only that the
 * client serializes its own argument, and stays green against a card that never
 * passes one. The boundary that matters is the HTTP request the renderer makes,
 * so `fetch` is the only thing stubbed.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useResourceArchitectChat } from "@/components/create/agents-and-teams/use-resource-architect-chat";

const REVISION = `sha256:${"b".repeat(64)}`;

const teamPlan = {
  id: "plan-1",
  kind: "team" as const,
  team: {
    teamId: "contract-review-team",
    description: "Reviews contracts.",
    tags: [],
    existingAgents: [
      { name: "risk-lead", role: "Lead", rationale: "Already available." },
    ],
    newAgents: [{
      name: "risk-spotter",
      role: "Risk reviewer",
      description: "Finds risky clauses.",
      rationale: "Needed.",
    }],
    questionsResolved: [],
    shape: {
      kind: "discussion" as const,
      rationale: "They disagree usefully.",
      depth: "standard" as const,
      coordinator: "risk-lead",
      participants: ["risk-spotter"],
    },
  },
};

interface Recorded {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON object a request carried, or null when it carried no body. */
function jsonBody(init: RequestInit | undefined): Record<string, unknown> | null {
  if (!init?.body) return null;
  const parsed: unknown = JSON.parse(String(init.body));
  if (!isRecord(parsed)) {
    throw new Error(`Expected a JSON object body, got ${String(init.body)}`);
  }
  return parsed;
}

/** Serves the Architect routes, recording every request the renderer makes. */
function stubServer(options: { holdShapeGet?: Promise<void> } = {}): Recorded[] {
  const calls: Recorded[] = [];
  const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = jsonBody(init);
      calls.push({ url, method, body });

      if (url.includes("/resource-architect/turn")) {
        return json({
          jobId: "job-1",
          operation: "proposal",
          message: "Proposal ready.",
          warnings: [],
          outcome: teamPlan,
          meta: {
            provider: "local",
            model: "fixture",
            fallback: false,
            reasoning: "low",
            timing: {
              contextAssemblyMs: 0,
              providerDurationMs: 0,
              processSpawnMs: null,
              firstProviderEventMs: null,
              firstTextMs: null,
              parseDurationMs: 0,
              repairOccurred: false,
              repairDurationMs: 0,
              totalDurationMs: 0,
              context: {
                instructionsChars: 0,
                operationChars: 0,
                uploadedDocumentPolicyChars: 0,
                visualizationPolicyChars: 0,
                teamLibraryChars: 0,
                agentLibraryChars: 0,
                totalChars: 0,
                historyChars: 0,
              },
            },
          },
        });
      }
      if (url.includes("/plans/") && url.endsWith("/shape")) {
        if (options.holdShapeGet) await options.holdShapeGet;
        // The whole plan, because a snapshot answer that carries only a
        // revision is refused: it would advance the card's authority while
        // leaving it showing whatever it already had.
        return json({
          planId: "plan-1",
          revision: REVISION,
          shape: teamPlan.team.shape,
          plan: teamPlan,
        });
      }
      if (url.includes("/resource-architect/jobs")) {
        return json({
          jobId: "job-1",
          job: {
            jobId: "job-1",
            planId: "plan-1",
            status: "running",
            items: [],
            events: [],
            selectedResource: null,
          },
        }, 202);
      }
      return json([]);
    }),
  );
  return calls;
}

function buildRequests(calls: Recorded[]): Recorded[] {
  return calls.filter(
    (call) => call.method === "POST" && /\/resource-architect\/jobs$/.test(call.url),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("pressing Create", () => {
  it("sends the plan revision the card was showing", async () => {
    const calls = stubServer();
    const { result } = renderHook(() =>
      useResourceArchitectChat({ model: { provider: "local", model: "fixture" } }),
    );

    await act(async () => {
      await result.current.submit("Build a contract review team.");
    });
    await waitFor(() => expect(result.current.canChangeShape).toBe(true));

    await act(async () => {
      await result.current.createPlan();
    });

    const builds = buildRequests(calls);
    expect(builds).toHaveLength(1);
    expect(builds[0]?.body).toMatchObject({
      planId: "plan-1",
      expectedRevision: REVISION,
    });
  });

  // The revision is read after the proposal arrives. Building in that window
  // with no revision is exactly the stale-card admission the revision exists to
  // prevent, so a shaped plan does not start a build until it is known.
  it("does not start a shaped build before the revision is known", async () => {
    let releaseGet = (): void => {};
    const held = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    const calls = stubServer({ holdShapeGet: held });
    const { result } = renderHook(() =>
      useResourceArchitectChat({ model: { provider: "local", model: "fixture" } }),
    );

    await act(async () => {
      await result.current.submit("Build a contract review team.");
    });
    await waitFor(() => expect(result.current.pendingPlan).not.toBeNull());
    expect(result.current.canChangeShape).toBe(false);

    await act(async () => {
      await result.current.createPlan();
    });
    expect(buildRequests(calls)).toHaveLength(0);

    releaseGet();
    await waitFor(() => expect(result.current.canChangeShape).toBe(true));

    await act(async () => {
      await result.current.createPlan();
    });
    const builds = buildRequests(calls);
    expect(builds).toHaveLength(1);
    expect(builds[0]?.body).toMatchObject({ expectedRevision: REVISION });
  });
});
