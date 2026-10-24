/**
 * A plan whose saved shape is not one this app can build.
 *
 * The build refuses it by name, so pressing Create spends a round trip to be
 * told what the card is already showing. The gate only looked at whether a
 * shape was present, and a rejected shape is absent — so the button stayed
 * live and the answer was a 422 nobody needed to ask for.
 *
 * Only `fetch` is stubbed, so this drives the real hook and the real client.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useResourceArchitectChat } from "@/components/create/agents-and-teams/use-resource-architect-chat";

const BEFORE = `sha256:${"b".repeat(64)}`;
const AFTER = `sha256:${"c".repeat(64)}`;

function meta() {
  return {
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
  };
}

const repaired = {
  kind: "discussion" as const,
  rationale: "They disagree usefully.",
  depth: "standard" as const,
  coordinator: "risk-lead",
  participants: ["risk-spotter"],
};

function teamPlan(options: { rejected: boolean }) {
  return {
    id: "plan-1",
    kind: "team" as const,
    team: {
      teamId: "contract-review",
      description: "Reviews contracts.",
      tags: [],
      existingAgents: [
        { name: "risk-lead", role: "Lead", rationale: "Already available." },
        { name: "risk-spotter", role: "Spotter", rationale: "Already available." },
      ],
      newAgents: [],
      questionsResolved: [],
      // A rejected shape is an absent one with a reason. Both halves matter:
      // the plan carries no buildable shape, and it says why.
      ...(options.rejected ? { shapeRejected: true as const } : { shape: repaired }),
    },
  };
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

interface Recorded {
  url: string;
  method: string;
}

function stubServer(options: { repairFails?: boolean } = {}): Recorded[] {
  const calls: Recorded[] = [];
  let repairedYet = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      const path = new URL(url, "http://localhost").pathname;
      if (path.endsWith("/create/resource-architect/turn")) {
        if (method === "GET") return new Response(null, { status: 404 });
        return json({
          jobId: "job-1",
          operation: "proposal",
          message: "Proposal ready.",
          warnings: [],
          outcome: teamPlan({ rejected: true }),
          meta: meta(),
        });
      }
      if (/\/plans\/[^/]+\/shape$/u.test(path)) {
        if (method === "POST") {
          if (options.repairFails) {
            return json({ error: "invalid_shape", reason: "Not a way a team can work." }, 422);
          }
          repairedYet = true;
          return json({
            planId: "plan-1",
            revision: AFTER,
            shape: repaired,
            plan: teamPlan({ rejected: false }),
          });
        }
        return json({
          planId: "plan-1",
          revision: repairedYet ? AFTER : BEFORE,
          plan: teamPlan({ rejected: !repairedYet }),
          ...(repairedYet ? { shape: repaired } : { shapeRejected: true }),
        });
      }
      if (/\/resource-architect\/jobs$/u.test(path) && method === "POST") {
        return json({
          jobId: "job-build",
          job: {
            jobId: "job-build",
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

const builds = (calls: Recorded[]): Recorded[] =>
  calls.filter(
    (call) => call.method === "POST" && /\/resource-architect\/jobs$/u.test(call.url),
  );

afterEach(() => vi.unstubAllGlobals());

describe("a plan whose saved shape cannot be built", () => {
  it("is not submitted before the shape has been chosen again", async () => {
    const calls = stubServer();
    const { result } = renderHook(() =>
      useResourceArchitectChat({ model: { provider: "local", model: "fixture" } }),
    );

    await act(async () => {
      await result.current.submit("Build a contract review team.");
    });
    await waitFor(() => expect(result.current.canChangeShape).toBe(true));
    expect(result.current.pendingPlan?.kind).toBe("team");

    await act(async () => {
      await result.current.createPlan();
    });

    expect(builds(calls)).toHaveLength(0);
  });

  it("stays unsubmittable when the repair is refused", async () => {
    const calls = stubServer({ repairFails: true });
    const { result } = renderHook(() =>
      useResourceArchitectChat({ model: { provider: "local", model: "fixture" } }),
    );

    await act(async () => {
      await result.current.submit("Build a contract review team.");
    });
    await waitFor(() => expect(result.current.canChangeShape).toBe(true));

    await act(async () => {
      const notice = await result.current.changeShape(repaired);
      expect(notice).toBeTruthy();
    });
    await act(async () => {
      await result.current.createPlan();
    });

    expect(builds(calls)).toHaveLength(0);
  });

  it("is submitted once the shape has been chosen again", async () => {
    const calls = stubServer();
    const { result } = renderHook(() =>
      useResourceArchitectChat({ model: { provider: "local", model: "fixture" } }),
    );

    await act(async () => {
      await result.current.submit("Build a contract review team.");
    });
    await waitFor(() => expect(result.current.canChangeShape).toBe(true));

    await act(async () => {
      await result.current.changeShape(repaired);
    });
    await act(async () => {
      await result.current.createPlan();
    });

    // The repair persisted, so the plan is buildable and carries the revision
    // the repair returned.
    expect(builds(calls)).toHaveLength(1);
  });
});
