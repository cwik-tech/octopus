/**
 * Changing one saved team's shape while opening another.
 *
 * The client module is deliberately not mocked: only `fetch` is stubbed, so the
 * real reader, the real request and the real hook all run. A test handed
 * already-typed answers would stay green against a hook that applies whichever
 * one arrives last.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useTeamEditor } from "../use-team-editor";

function detail(id: string) {
  return {
    id,
    name: id,
    description: `${id} description.`,
    tags: [],
    agentCount: 2,
    health: { status: "ok", errors: [], warnings: [] },
    teamPath: `teams/${id}`,
    yaml: `team:\n  name: ${id}\n`,
    revision: `sha256:${id}`,
    agents: ["risk-lead", "risk-spotter"].map((name) => ({
      name,
      type: "agent" as const,
      role: "Member.",
      tier: "strategic",
      tools: [],
      referenced: true,
    })),
    warnings: [],
    shape: {
      kind: "chain" as const,
      rationale: "this is how the team is set up now.",
      depth: "quick" as const,
      order: ["risk-lead", "risk-spotter"],
    },
  };
}

const discussion = {
  kind: "discussion" as const,
  rationale: "They disagree usefully.",
  depth: "standard" as const,
  coordinator: "risk-lead",
  participants: ["risk-spotter"],
};

/** The server, with team A's shape change held until it is released. */
function stubServer(): { releaseTeamA: () => void } {
  let releaseTeamA = (): void => {};
  const held = new Promise<void>((resolve) => {
    releaseTeamA = resolve;
  });
  const json = (value: unknown): Response =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/shape")) {
        if (url.includes("team-a")) await held;
        const id = url.includes("team-a") ? "team-a" : "team-b";
        return json({ team: { ...detail(id), shape: discussion } });
      }
      const match = /\/teams\/([^/]+)$/u.exec(new URL(url, "http://x").pathname);
      if (match) return json({ team: detail(match[1] ?? "team-a") });
      // The Agent catalog the editor reads, served here rather than mocked, so
      // the whole hook runs against one boundary.
      if (url.includes("/create/agents")) return json({ agents: [] });
      return json({ teams: [] });
    }),
  );
  return { releaseTeamA };
}

afterEach(() => vi.unstubAllGlobals());

describe("changing a saved team's shape while opening another", () => {
  it("leaves the newly opened team usable, and lets no late answer touch it", async () => {
    const { releaseTeamA } = stubServer();
    let changing: Promise<void> = Promise.resolve();
    const { result } = renderHook(() => useTeamEditor({}));

    await act(async () => {
      result.current.setSelectedTeamId("team-a");
    });
    await waitFor(() => expect(result.current.detail?.id).toBe("team-a"));

    await act(async () => {
      changing = result.current.changeShape(discussion);
      await Promise.resolve();
    });
    expect(result.current.shapeChangePending).toBe(true);

    // The user opens another team while that change is still out.
    await act(async () => {
      result.current.setSelectedTeamId("team-b");
    });
    await waitFor(() => expect(result.current.detail?.id).toBe("team-b"));

    // The team they are now looking at is usable straight away: the change
    // they are waiting on belongs to the team they left.
    expect(result.current.shapeChangePending).toBe(false);

    // Awaited, so the answer has genuinely been dealt with rather than merely
    // scheduled.
    await act(async () => {
      releaseTeamA();
      await changing;
    });

    // And the late answer touches nothing here.
    expect(result.current.detail?.id).toBe("team-b");
    expect(result.current.shapeChangePending).toBe(false);
    expect(result.current.shapeNotice).toBeNull();
  });

  // The same reply, for the team still on screen, is applied. Without this the
  // test above would pass against a hook that ignored every answer.
  it("applies the same answer when its team is still the one open", async () => {
    const { releaseTeamA } = stubServer();
    const { result } = renderHook(() => useTeamEditor({}));

    await act(async () => {
      result.current.setSelectedTeamId("team-a");
    });
    await waitFor(() => expect(result.current.detail?.id).toBe("team-a"));

    let changing: Promise<void> = Promise.resolve();
    await act(async () => {
      changing = result.current.changeShape(discussion);
      await Promise.resolve();
    });
    await act(async () => {
      releaseTeamA();
      await changing;
    });

    expect(result.current.detail?.shape?.kind).toBe("discussion");
    expect(result.current.shapeChangePending).toBe(false);
    expect(result.current.shapeNotice).toBeNull();
  });

  // And coming back to the team they left. The change they abandoned is over,
  // so its control works: a pending state that outlived its request disables
  // the team for good.
  it("leaves the abandoned team usable when the user returns to it", async () => {
    const { releaseTeamA } = stubServer();
    const { result } = renderHook(() => useTeamEditor({}));

    await act(async () => {
      result.current.setSelectedTeamId("team-a");
    });
    await waitFor(() => expect(result.current.detail?.id).toBe("team-a"));

    let changing: Promise<void> = Promise.resolve();
    await act(async () => {
      changing = result.current.changeShape(discussion);
      await Promise.resolve();
    });
    await act(async () => {
      result.current.setSelectedTeamId("team-b");
    });
    await waitFor(() => expect(result.current.detail?.id).toBe("team-b"));

    await act(async () => {
      releaseTeamA();
      await changing;
    });

    await act(async () => {
      result.current.setSelectedTeamId("team-a");
    });
    await waitFor(() => expect(result.current.detail?.id).toBe("team-a"));

    expect(result.current.shapeChangePending).toBe(false);
  });

  // Returning to the team, and only then the old answer arrives. It is about a
  // request the user walked away from, so it says nothing about the team they
  // have just reopened — even though that is the same team.
  it("lets an abandoned answer say nothing about the team reopened since", async () => {
    const { releaseTeamA } = stubServer();
    const { result } = renderHook(() => useTeamEditor({}));

    await act(async () => {
      result.current.setSelectedTeamId("team-a");
    });
    await waitFor(() => expect(result.current.detail?.id).toBe("team-a"));

    let changing: Promise<void> = Promise.resolve();
    await act(async () => {
      changing = result.current.changeShape(discussion);
      await Promise.resolve();
    });
    await act(async () => {
      result.current.setSelectedTeamId("team-b");
    });
    await waitFor(() => expect(result.current.detail?.id).toBe("team-b"));

    // Back to A, freshly read. The team is waited for by identity first: B is
    // a chain too, so waiting only for the shape would not establish that A's
    // own read had finished.
    await act(async () => {
      result.current.setSelectedTeamId("team-a");
    });
    await waitFor(() => expect(result.current.detail?.id).toBe("team-a"));
    expect(result.current.detail?.shape?.kind).toBe("chain");

    await act(async () => {
      releaseTeamA();
      await changing;
    });

    expect(result.current.detail?.shape?.kind).toBe("chain");
    expect(result.current.shapeChangePending).toBe(false);
    expect(result.current.shapeNotice).toBeNull();
  });
});
