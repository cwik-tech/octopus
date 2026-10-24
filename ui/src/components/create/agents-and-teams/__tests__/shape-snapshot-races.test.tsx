/**
 * What the card shows when requests overlap.
 *
 * The shape and the revision describe one plan at one moment. Read or written
 * independently, a slow answer about an older plan can land on a newer one, and
 * the card then shows a shape the stored plan does not have while offering a
 * revision that does not describe it. Only `fetch` is stubbed, so these drive
 * the real hook and the real client.
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

/** The proposal POST, as opposed to the text-stream GET on the same path. */
function isProposalPost(url: string, init?: RequestInit): boolean {
  return (
    (init?.method ?? "GET") === "POST" &&
    new URL(url, "http://localhost").pathname.endsWith(
      "/create/resource-architect/turn",
    )
  );
}

/**
 * The text-stream subscription opened on the same path.
 *
 * Answered 404, which the stream client documents as "the turn is gone, or was
 * never ours" and returns from cleanly. Matching it as a proposal consumed the
 * fixture counter, so the second turn served the first turn plan and the test
 * was measuring the harness instead of the hook.
 */
function isTextStreamGet(url: string, init?: RequestInit): boolean {
  return (
    (init?.method ?? "GET") === "GET" &&
    new URL(url, "http://localhost").pathname.endsWith(
      "/create/resource-architect/turn",
    )
  );
}

const streamUnavailable = (): Response =>
  new Response(null, { status: 404 });

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

describe("overlapping shape requests", () => {
  // The corruption a bound snapshot prevents is in the revision, not in the
  // plan on screen. So the assertion is on the revision actually sent: a late
  // answer about plan-1 must not be what authorizes a build of plan-2.
  it("builds plan-2 with plan-2's revision after plan-1's answer arrives late", async () => {
    let releaseFirstGet = (): void => {};
    const firstGetHeld = new Promise<void>((resolve) => {
      releaseFirstGet = resolve;
    });
    /** Every in-flight response, so a test can wait for one to be consumed. */
    const settled: Promise<unknown>[] = [];
    const builds: Record<string, unknown>[] = [];
    let turn = 0;
    const revisions = new Map([
      ["plan-1", `sha256:${"1".repeat(64)}`],
      ["plan-2", `sha256:${"2".repeat(64)}`],
    ]);

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
            if (planId === "plan-1") await firstGetHeld;
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
        settled.push(answer);
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

    // Release plan-1's answer and wait for every response to be consumed, so
    // the assertion cannot run before the late one has had its chance.
    await act(async () => {
      releaseFirstGet();
      await Promise.all(settled);
    });

    await act(async () => {
      await result.current.createPlan();
    });

    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatchObject({
      planId: "plan-2",
      expectedRevision: revisions.get("plan-2"),
    });
  });

  // A failure answering about a plan the card has replaced must not clear the
  // readiness of the plan it is actually showing.
  it("keeps plan-2 ready when plan-1's revision read fails late", async () => {
    let failFirstGet = (): void => {};
    const firstGetHeld = new Promise<void>((_resolve, reject) => {
      failFirstGet = () => reject(new Error("network went away"));
    });
    firstGetHeld.catch(() => {});
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
            if (planId === "plan-1") await firstGetHeld;
            return json({
              planId,
              revision: `sha256:${"2".repeat(64)}`,
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

    await act(async () => {
      failFirstGet();
      await Promise.all(settled);
    });

    expect(result.current.canChangeShape).toBe(true);
    expect(result.current.pendingPlan?.id).toBe("plan-2");
  });

  // A refused amendment is characterization of a branch that already works.
  // What is new here is a transport failure: the card must keep the plan it is
  // showing and say something, rather than blanking or throwing unhandled.
  it("keeps the plan and reports a reason when the amendment request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
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
          if (init?.method === "POST") throw new Error("network went away");
          return json({
            planId: "plan-1",
            revision: `sha256:${"1".repeat(64)}`,
            plan: teamPlan("plan-1", "risk-lead"),
          });
        }
        return json([]);
      }),
    );

    const { result } = renderHook(() =>
      useResourceArchitectChat({ model: { provider: "local", model: "fixture" } }),
    );
    await act(async () => {
      await result.current.submit("Build a contract review team.");
    });
    await waitFor(() => expect(result.current.canChangeShape).toBe(true));

    let notice: string | undefined;
    await act(async () => {
      notice = await result.current.changeShape({
        kind: "chain",
        rationale: "you chose it.",
        depth: "standard",
        order: ["risk-lead", "risk-spotter"],
      });
    });

    expect(notice).toBeTruthy();
    const shape = result.current.pendingPlan?.kind === "team"
      ? result.current.pendingPlan.team.shape
      : undefined;
    expect(shape?.kind).toBe("discussion");
  });
});

describe("both revision reads in flight at once", () => {
  // The ordering the id guard alone does not cover. With plan-2 on screen and
  // its own read still pending, `existing` is null, so a plan-1 answer released
  // first has nothing to be compared against and was admitted.
  it("never lets plan-1's answer make plan-2 buildable", async () => {
    const gates = new Map<string, { held: Promise<void>; release: () => void }>();
    for (const planId of ["plan-1", "plan-2"]) {
      let release = (): void => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      gates.set(planId, { held, release });
    }
    /**
     * One completion promise per held read.
     *
     * Awaiting every response would wait on the read still deliberately held,
     * so each release is awaited on its own. That is the barrier: the answer
     * has been consumed before anything is asserted about it.
     */
    const reads = new Map<string, Promise<unknown>>();
    const settled: Promise<unknown>[] = [];
    const builds: Record<string, unknown>[] = [];
    let turn = 0;
    const revisions = new Map([
      ["plan-1", `sha256:${"1".repeat(64)}`],
      ["plan-2", `sha256:${"2".repeat(64)}`],
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: RequestInit) => {
        const url = String(input);
        const answer = (async () => {
          if (isTextStreamGet(url, init)) return streamUnavailable();
          if (isProposalPost(url, init)) {
            turn += 1;
            const planId = turn === 1 ? "plan-1" : "plan-2";
            return json({
              jobId: `job-${turn}`,
              operation: "proposal",
              message: "Proposal ready.",
              warnings: [],
              outcome: teamPlan(planId, turn === 1 ? "risk-lead" : "risk-spotter"),
              meta: meta(),
            });
          }
          const match = url.match(/\/plans\/([^/]+)\/shape$/u);
          if (match) {
            const planId = String(match[1]);
            await gates.get(planId)?.held;
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
        const shapeRead = url.match(/\/plans\/([^/]+)\/shape$/u);
        if (shapeRead) reads.set(String(shapeRead[1]), answer.catch(() => undefined));
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
    await waitFor(() => expect(result.current.pendingPlan?.id).toBe("plan-2"));

    // plan-1 answers first, while plan-2's own read is still outstanding.
    await act(async () => {
      gates.get("plan-1")?.release();
      await reads.get("plan-1");
    });

    expect(result.current.canChangeShape).toBe(false);
    await act(async () => {
      await result.current.createPlan();
    });
    expect(builds).toHaveLength(0);

    // plan-2's own answer is what makes it buildable, with its own revision.
    await act(async () => {
      gates.get("plan-2")?.release();
      await reads.get("plan-2");
    });
    await waitFor(() => expect(result.current.canChangeShape).toBe(true));

    await act(async () => {
      await result.current.createPlan();
    });
    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatchObject({
      planId: "plan-2",
      expectedRevision: revisions.get("plan-2"),
    });
  });

  // `createPlan` accepts a plan argument, so a caller can submit something
  // other than the one on screen. The snapshot is authority over exactly one
  // plan, and must not authorize a build of a different one.
  it("refuses to build a plan the snapshot does not describe", async () => {
    const builds: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
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
          return json({
            planId: "plan-1",
            revision: `sha256:${"1".repeat(64)}`,
            plan: teamPlan("plan-1", "risk-lead"),
          });
        }
        if (/\/resource-architect\/jobs$/u.test(url) && init?.method === "POST") {
          builds.push(parseJsonObject(String(init.body ?? "{}")));
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

    const { result } = renderHook(() =>
      useResourceArchitectChat({ model: { provider: "local", model: "fixture" } }),
    );
    await act(async () => {
      await result.current.submit("Build a contract review team.");
    });
    await waitFor(() => expect(result.current.canChangeShape).toBe(true));

    // A different plan than the one the snapshot describes.
    await act(async () => {
      await result.current.createPlan(teamPlan("plan-9", "risk-lead"));
    });
    expect(builds).toHaveLength(0);

    // The plan the snapshot does describe still builds.
    await act(async () => {
      await result.current.createPlan();
    });
    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatchObject({ planId: "plan-1" });
  });
});

describe("an amendment while it is in flight", () => {
  /** A shape amendment held open until the test releases it. */
  function heldAmendmentServer(): {
    release: (body?: unknown) => void;
    builds: Record<string, unknown>[];
  } {
    let release: (body?: unknown) => void = () => {};
    const held = new Promise<unknown>((resolve) => {
      release = (body?: unknown) => resolve(body);
    });
    const builds: Record<string, unknown>[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
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
          if (init?.method === "POST") {
            const answer = await held;
            return json(
              answer ?? {
                planId: "plan-1",
                revision: `sha256:${"3".repeat(64)}`,
                shape: teamPlan("plan-1", "risk-spotter").team.shape,
                plan: teamPlan("plan-1", "risk-spotter"),
              },
            );
          }
          return json({
            planId: "plan-1",
            revision: `sha256:${"1".repeat(64)}`,
            plan: teamPlan("plan-1", "risk-lead"),
          });
        }
        if (/\/resource-architect\/jobs$/u.test(url) && init?.method === "POST") {
          builds.push(parseJsonObject(String(init.body ?? "{}")));
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
    return { release, builds };
  }

  async function readyHook() {
    const { result } = renderHook(() =>
      useResourceArchitectChat({ model: { provider: "local", model: "fixture" } }),
    );
    await act(async () => {
      await result.current.submit("Build a contract review team.");
    });
    await waitFor(() => expect(result.current.canChangeShape).toBe(true));
    return result;
  }

  const chain = {
    kind: "chain" as const,
    rationale: "you chose it.",
    depth: "standard" as const,
    order: ["risk-lead", "risk-spotter"],
  };

  // A build started while the shape is being changed would be admitted against
  // the revision the card had before the change, and the two answers would race
  // for the same plan.
  it("does not build while a shape change is still in flight", async () => {
    const server = heldAmendmentServer();
    const result = await readyHook();

    let amending: Promise<string | undefined> | undefined;
    await act(async () => {
      amending = result.current.changeShape(chain);
      await Promise.resolve();
    });
    expect(result.current.shapeChangePending).toBe(true);

    await act(async () => {
      await result.current.createPlan();
    });
    expect(server.builds).toHaveLength(0);

    await act(async () => {
      server.release();
      await amending;
    });
    expect(result.current.shapeChangePending).toBe(false);

    await act(async () => {
      await result.current.createPlan();
    });
    expect(server.builds).toHaveLength(1);
    expect(server.builds[0]).toMatchObject({
      expectedRevision: `sha256:${"3".repeat(64)}`,
    });
  });

  // A second change started while the first is outstanding would resolve in an
  // unknown order, and the later answer could be the earlier request's.
  it("refuses a second change while one is outstanding", async () => {
    const server = heldAmendmentServer();
    const result = await readyHook();

    let first: Promise<string | undefined> | undefined;
    await act(async () => {
      first = result.current.changeShape(chain);
      await Promise.resolve();
    });

    let second: string | undefined;
    await act(async () => {
      second = await result.current.changeShape(chain);
    });
    expect(second).toMatch(/already being changed/i);

    await act(async () => {
      server.release();
      await first;
    });
    expect(result.current.shapeChangePending).toBe(false);
  });
});

describe("an amendment that fails after the plan has been replaced", () => {
  // The failure belongs to a plan the user is no longer looking at. Painting it
  // on the newer one describes something that did not happen to it.
  it("reports nothing, and leaves the newer plan usable", async () => {
    let failAmendment = (): void => {};
    const amendmentHeld = new Promise<never>((_resolve, reject) => {
      failAmendment = () => reject(new Error("network went away"));
    });
    amendmentHeld.catch(() => {});
    let turn = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (isTextStreamGet(url, init)) return streamUnavailable();
        if (isProposalPost(url, init)) {
          turn += 1;
          const planId = turn === 1 ? "plan-1" : "plan-2";
          return json({
            jobId: `job-${turn}`,
            operation: "proposal",
            message: "Proposal ready.",
            warnings: [],
            outcome: teamPlan(planId, turn === 1 ? "risk-lead" : "risk-spotter"),
            meta: meta(),
          });
        }
        const match = url.match(/\/plans\/([^/]+)\/shape$/u);
        if (match) {
          const planId = String(match[1]);
          if (init?.method === "POST") await amendmentHeld;
          return json({
            planId,
            revision: `sha256:${planId === "plan-1" ? "1" : "2"}`.padEnd(71, "a"),
            plan: teamPlan(planId, planId === "plan-1" ? "risk-lead" : "risk-spotter"),
          });
        }
        return json([]);
      }),
    );

    const { result } = renderHook(() =>
      useResourceArchitectChat({ model: { provider: "local", model: "fixture" } }),
    );
    await act(async () => {
      await result.current.submit("Build a contract review team.");
    });
    await waitFor(() => expect(result.current.canChangeShape).toBe(true));

    let amending: Promise<string | undefined> | undefined;
    await act(async () => {
      amending = result.current.changeShape({
        kind: "chain",
        rationale: "you chose it.",
        depth: "standard",
        order: ["risk-lead", "risk-spotter"],
      });
      await Promise.resolve();
    });

    // A new proposal replaces the plan while that change is outstanding.
    await act(async () => {
      await result.current.submit("Actually, make the spotter lead it.");
    });
    await waitFor(() => expect(result.current.pendingPlan?.id).toBe("plan-2"));

    // The new plan is usable immediately. Waiting for a request that belongs to
    // a plan the user has left would hold this one hostage for the whole
    // request timeout.
    expect(result.current.shapeChangePending).toBe(false);
    await waitFor(() => expect(result.current.canChangeShape).toBe(true));

    await act(async () => {
      failAmendment();
      await amending;
    });

    // No message about a plan that is gone, and the new plan is not held by a
    // request that belonged to the old one.
    await expect(amending).resolves.toBeUndefined();
    expect(result.current.shapeChangePending).toBe(false);
    await waitFor(() => expect(result.current.canChangeShape).toBe(true));
  });
});
