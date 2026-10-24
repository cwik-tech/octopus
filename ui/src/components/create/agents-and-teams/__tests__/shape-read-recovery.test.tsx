/**
 * What Create offers when the plan's revision cannot be read.
 *
 * A team plan is built against the revision the card was rendered from, so
 * until that revision has been read there is nothing safe to build and nothing
 * safe to change. When the read failed, the card said nothing and Create stayed
 * disabled for good: the only way out was to describe the team again, which
 * throws away a proposal that was never the thing at fault.
 *
 * So the failure is now something the user can see and answer. Only `fetch` is
 * stubbed, so these drive the real hook and the real client.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useResourceArchitectChat } from "@/components/create/agents-and-teams/use-resource-architect-chat";

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

function teamPlan(id: string, coordinator: string) {
  return {
    id,
    kind: "team" as const,
    team: {
      teamId: `team-${id}`,
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
        coordinator,
        participants: coordinator === "risk-lead" ? ["risk-spotter"] : ["risk-lead"],
      },
    },
  };
}

const REVISION = `sha256:${"a".repeat(64)}`;

function isProposalPost(url: string, init?: RequestInit): boolean {
  return (
    (init?.method ?? "GET") === "POST" &&
    new URL(url, "http://localhost").pathname.endsWith(
      "/create/resource-architect/turn",
    )
  );
}

function isTextStreamGet(url: string, init?: RequestInit): boolean {
  return (
    (init?.method ?? "GET") === "GET" &&
    new URL(url, "http://localhost").pathname.endsWith(
      "/create/resource-architect/turn",
    )
  );
}

const streamUnavailable = (): Response => new Response(null, { status: 404 });

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A request body, parsed as the JSON object the hook sends. */
function parseJsonObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error(`Expected a JSON object, got ${text}`);
  return parsed;
}

afterEach(() => vi.unstubAllGlobals());

describe("a plan whose revision could not be read", () => {
  it("says so, and the same proposal becomes usable when the read is retried", async () => {
    let shapeReads = 0;
    let proposals = 0;
    const settled: Promise<unknown>[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: RequestInit) => {
        const url = String(input);
        const answer = (async () => {
          if (isTextStreamGet(url, init)) return streamUnavailable();
          if (isProposalPost(url, init)) {
            proposals += 1;
            return json({
              jobId: `job-${proposals}`,
              operation: "proposal",
              message: "Proposal ready.",
              warnings: [],
              outcome: teamPlan("plan-1", "risk-lead"),
              meta: meta(),
            });
          }
          if (/\/plans\/[^/]+\/shape$/u.test(url)) {
            shapeReads += 1;
            // Down once, then back. A revision read that failed says nothing
            // about whether the plan is buildable.
            if (shapeReads === 1) return json({ error: "upstream" }, 503);
            return json({
              planId: "plan-1",
              revision: REVISION,
              plan: teamPlan("plan-1", "risk-lead"),
            });
          }
          return json([]);
        })();
        settled.push(answer.catch(() => undefined));
        return answer;
      }),
    );

    const { result } = renderHook(() =>
      useResourceArchitectChat({ model: { provider: "local", model: "fixture" } }),
    );

    await act(async () => {
      await result.current.submit("Build a contract review team.");
    });

    // The card is showing a team plan it cannot yet build.
    await waitFor(() => expect(result.current.shapeReadFailed).toBe(true));
    expect(result.current.pendingPlan?.id).toBe("plan-1");
    expect(result.current.canChangeShape).toBe(false);

    await act(async () => {
      result.current.retryShapeRead();
      await Promise.all(settled);
    });

    // Usable again, and without asking the Architect for anything: the same
    // proposal is what became buildable.
    await waitFor(() => expect(result.current.canChangeShape).toBe(true));
    expect(result.current.shapeReadFailed).toBe(false);
    expect(result.current.pendingPlan?.id).toBe("plan-1");
    expect(proposals).toBe(1);
    expect(shapeReads).toBe(2);
  });

  it("does not report a failure about a plan the card has replaced", async () => {
    let failFirstRead = (): void => {};
    const firstReadHeld = new Promise<void>((_resolve, reject) => {
      failFirstRead = () => reject(new Error("network went away"));
    });
    firstReadHeld.catch(() => {});
    const settled: Promise<unknown>[] = [];
    let turn = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: RequestInit) => {
        const url = String(input);
        const answer = (async () => {
          if (isTextStreamGet(url, init)) return streamUnavailable();
          if (isProposalPost(url, init)) {
            turn += 1;
            return json({
              jobId: `job-${turn}`,
              operation: "proposal",
              message: "Proposal ready.",
              warnings: [],
              outcome: turn === 1
                ? teamPlan("plan-1", "risk-lead")
                : teamPlan("plan-2", "risk-spotter"),
              meta: meta(),
            });
          }
          const match = url.match(/\/plans\/([^/]+)\/shape$/u);
          if (match) {
            const planId = String(match[1]);
            if (planId === "plan-1") await firstReadHeld;
            return json({
              planId,
              revision: REVISION,
              plan: teamPlan(planId, planId === "plan-1" ? "risk-lead" : "risk-spotter"),
            });
          }
          return json([]);
        })();
        settled.push(answer.catch(() => undefined));
        return answer;
      }),
    );

    const { result } = renderHook(() =>
      useResourceArchitectChat({ model: { provider: "local", model: "fixture" } }),
    );

    await act(async () => {
      await result.current.submit("Build a contract review team.");
    });
    await act(async () => {
      await result.current.submit("Actually, make the spotter lead it.");
    });
    await waitFor(() => expect(result.current.canChangeShape).toBe(true));
    expect(result.current.pendingPlan?.id).toBe("plan-2");

    // Plan-1's read now fails, long after the card moved on. The plan on
    // screen was read successfully and stays buildable.
    await act(async () => {
      failFirstRead();
      await Promise.all(settled);
    });

    expect(result.current.shapeReadFailed).toBe(false);
    expect(result.current.canChangeShape).toBe(true);
    expect(result.current.pendingPlan?.id).toBe("plan-2");
  });

  it("says nothing while the first read is still in flight", async () => {
    let releaseRead = (): void => {};
    const readHeld = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const settled: Promise<unknown>[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: RequestInit) => {
        const url = String(input);
        const answer = (async () => {
          if (isTextStreamGet(url, init)) return streamUnavailable();
          if (isProposalPost(url, init)) {
            return json({
              jobId: "job-1",
              operation: "proposal",
              message: "Proposal ready.",
              warnings: [],
              outcome: teamPlan("plan-1", "risk-lead"),
              meta: meta(),
            });
          }
          if (/\/plans\/[^/]+\/shape$/u.test(url)) {
            await readHeld;
            return json({
              planId: "plan-1",
              revision: REVISION,
              plan: teamPlan("plan-1", "risk-lead"),
            });
          }
          return json([]);
        })();
        settled.push(answer.catch(() => undefined));
        return answer;
      }),
    );

    const { result } = renderHook(() =>
      useResourceArchitectChat({ model: { provider: "local", model: "fixture" } }),
    );

    await act(async () => {
      await result.current.submit("Build a contract review team.");
    });

    // Waiting is not failing. Announcing a problem here, or offering to try
    // again before anything has gone wrong, describes a state the user is not
    // in.
    expect(result.current.pendingPlan?.id).toBe("plan-1");
    expect(result.current.shapeReadFailed).toBe(false);
    expect(result.current.shapeReadRetrying).toBe(false);
    expect(result.current.canChangeShape).toBe(false);

    await act(async () => {
      releaseRead();
      await Promise.all(settled);
    });
    await waitFor(() => expect(result.current.canChangeShape).toBe(true));
  });

  it("does not let a stale retry cancel the read a newer plan is waiting on", async () => {
    let releaseSecondRead = (): void => {};
    const secondReadHeld = new Promise<void>((resolve) => {
      releaseSecondRead = resolve;
    });
    const settled: Promise<unknown>[] = [];
    let turn = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: RequestInit) => {
        const url = String(input);
        const answer = (async () => {
          if (isTextStreamGet(url, init)) return streamUnavailable();
          if (isProposalPost(url, init)) {
            turn += 1;
            return json({
              jobId: `job-${turn}`,
              operation: "proposal",
              message: "Proposal ready.",
              warnings: [],
              outcome: turn === 1
                ? teamPlan("plan-1", "risk-lead")
                : teamPlan("plan-2", "risk-spotter"),
              meta: meta(),
            });
          }
          const match = url.match(/\/plans\/([^/]+)\/shape$/u);
          if (match) {
            const planId = String(match[1]);
            // Plan-1 has nothing to offer; plan-2's read is held so a stale
            // handler has something live to interfere with.
            if (planId === "plan-1") return json({ error: "upstream" }, 503);
            await secondReadHeld;
            return json({
              planId,
              revision: REVISION,
              plan: teamPlan(planId, "risk-spotter"),
            });
          }
          return json([]);
        })();
        settled.push(answer.catch(() => undefined));
        return answer;
      }),
    );

    const { result } = renderHook(() =>
      useResourceArchitectChat({ model: { provider: "local", model: "fixture" } }),
    );

    await act(async () => {
      await result.current.submit("Build a contract review team.");
    });
    await waitFor(() => expect(result.current.shapeReadFailed).toBe(true));
    // The handler as it stood while plan-1 was on screen. A button rendered
    // then, pressed now, calls exactly this.
    const staleRetry = result.current.retryShapeRead;

    await act(async () => {
      await result.current.submit("Actually, make the spotter lead it.");
    });
    expect(result.current.pendingPlan?.id).toBe("plan-2");

    act(() => {
      staleRetry();
    });

    await act(async () => {
      releaseSecondRead();
      await Promise.all(settled);
    });

    // Plan-2's own read was never cancelled, so it landed.
    await waitFor(() => expect(result.current.canChangeShape).toBe(true));
    expect(result.current.shapeReadFailed).toBe(false);
    expect(result.current.pendingPlan?.id).toBe("plan-2");
  });

  it("does not let a retry of a replaced plan land on the plan now shown", async () => {
    let releaseRetry = (): void => {};
    const retryHeld = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const settled: Promise<unknown>[] = [];
    const revisions = new Map([
      ["plan-1", `sha256:${"1".repeat(64)}`],
      ["plan-2", `sha256:${"2".repeat(64)}`],
    ]);
    const builds: Record<string, unknown>[] = [];
    let turn = 0;
    let planOneReads = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: RequestInit) => {
        const url = String(input);
        const answer = (async () => {
          if (isTextStreamGet(url, init)) return streamUnavailable();
          if (isProposalPost(url, init)) {
            turn += 1;
            return json({
              jobId: `job-${turn}`,
              operation: "proposal",
              message: "Proposal ready.",
              warnings: [],
              outcome: turn === 1
                ? teamPlan("plan-1", "risk-lead")
                : teamPlan("plan-2", "risk-spotter"),
              meta: meta(),
            });
          }
          const match = url.match(/\/plans\/([^/]+)\/shape$/u);
          if (match) {
            const planId = String(match[1]);
            if (planId === "plan-1") {
              planOneReads += 1;
              // The first read fails, so there is something to retry. The
              // retry is then held open while the user moves on.
              if (planOneReads === 1) return json({ error: "upstream" }, 503);
              await retryHeld;
            }
            return json({
              planId,
              revision: revisions.get(planId),
              plan: teamPlan(planId, planId === "plan-1" ? "risk-lead" : "risk-spotter"),
            });
          }
          if (/\/resource-architect\/jobs$/u.test(url) && init?.method === "POST") {
            builds.push(parseJsonObject(String(init.body ?? "{}")));
            return json({
              jobId: "job-build",
              job: {
                jobId: "job-build",
                planId: "plan-2",
                status: "running",
                items: [],
                events: [],
                selectedResource: null,
              },
            }, 202);
          }
          return json([]);
        })();
        settled.push(answer.catch(() => undefined));
        return answer;
      }),
    );

    const { result } = renderHook(() =>
      useResourceArchitectChat({ model: { provider: "local", model: "fixture" } }),
    );

    await act(async () => {
      await result.current.submit("Build a contract review team.");
    });
    await waitFor(() => expect(result.current.shapeReadFailed).toBe(true));

    // Retried, then abandoned: the user describes a different team instead.
    act(() => {
      result.current.retryShapeRead();
    });
    await act(async () => {
      await result.current.submit("Actually, make the spotter lead it.");
    });
    await waitFor(() => expect(result.current.canChangeShape).toBe(true));
    expect(result.current.pendingPlan?.id).toBe("plan-2");

    // The abandoned retry answers now, about a plan nobody is looking at.
    await act(async () => {
      releaseRetry();
      await Promise.all(settled);
    });

    expect(result.current.pendingPlan?.id).toBe("plan-2");
    expect(result.current.shapeReadFailed).toBe(false);

    // The revision that authorizes the build is plan-2's, not the one the
    // late retry carried.
    await act(async () => {
      await result.current.createPlan();
    });
    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatchObject({
      planId: "plan-2",
      expectedRevision: revisions.get("plan-2"),
    });
  });
});
