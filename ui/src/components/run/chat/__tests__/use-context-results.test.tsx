import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResultReference } from "@contracts/schemas/result-reference";

const clientMocks = vi.hoisted(() => ({ listSessionResults: vi.fn() }));
vi.mock("@/lib/clients/session-client", () => clientMocks);

const { describeResultDetail, describeResultDetails, useContextResults } =
  await import("../use-context-results");

/**
 * Clearing the only result is a decision. Persisting ids alone could not tell
 * it from "I have not chosen yet", so the next load preselected the very
 * result the user had just removed.
 */

function reference(id: string): ResultReference {
  return {
    schemaVersion: 1,
    id,
    sessionId: "sess-1",
    producer: { kind: "team", id: "board", label: "Board" },
    status: "done",
    completedAt: "2026-09-09T10:00:00.000Z",
    source: { kind: "run-summary", runId: `run-${id}` },
  };
}

/**
 * A real one. This environment supplies a `localStorage` object with no
 * methods, which is what the hook's try/catch is for, but these cases are
 * about what survives a reload and need storage that works.
 */
function installStorage(): void {
  const entries = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
    clear: () => entries.clear(),
  });
}

describe("useContextResults", () => {
  beforeEach(() => {
    installStorage();
    clientMocks.listSessionResults.mockReset();
  });

  it("preselects the only result and shows it", async () => {
    clientMocks.listSessionResults.mockResolvedValue([reference("a")]);

    const { result } = renderHook(() => useContextResults("sess-1"));

    await waitFor(() => expect(result.current.selectedIds).toEqual(["a"]));
  });

  it("attaches nothing when several results are plausible", async () => {
    clientMocks.listSessionResults.mockResolvedValue([
      reference("a"),
      reference("b"),
    ]);

    const { result } = renderHook(() => useContextResults("sess-1"));

    await waitFor(() => expect(result.current.available).toHaveLength(2));
    expect(result.current.selectedIds).toEqual([]);
  });

  it("keeps a cleared result cleared across a reload", async () => {
    clientMocks.listSessionResults.mockResolvedValue([reference("a")]);

    const first = renderHook(() => useContextResults("sess-1"));
    await waitFor(() => expect(first.result.current.selectedIds).toEqual(["a"]));
    act(() => first.result.current.clear("a"));
    expect(first.result.current.selectedIds).toEqual([]);
    first.unmount();

    const second = renderHook(() => useContextResults("sess-1"));
    await waitFor(() => expect(second.result.current.available).toHaveLength(1));
    expect(second.result.current.selectedIds).toEqual([]);
  });

  it("restores an explicit selection across a reload", async () => {
    clientMocks.listSessionResults.mockResolvedValue([
      reference("a"),
      reference("b"),
    ]);

    const first = renderHook(() => useContextResults("sess-1"));
    await waitFor(() => expect(first.result.current.available).toHaveLength(2));
    act(() => first.result.current.select("b"));
    first.unmount();

    const second = renderHook(() => useContextResults("sess-1"));
    await waitFor(() => expect(second.result.current.selectedIds).toEqual(["b"]));
  });

  it("refuses a fourth result rather than building an unsendable turn", async () => {
    const results = ["a", "b", "c", "d"].map(reference);
    clientMocks.listSessionResults.mockResolvedValue(results);

    const { result } = renderHook(() => useContextResults("sess-1"));
    await waitFor(() => expect(result.current.available).toHaveLength(4));

    act(() => {
      result.current.select("a");
      result.current.select("b");
      result.current.select("c");
    });
    expect(result.current.canSelectMore).toBe(false);

    act(() => result.current.select("d"));
    expect(result.current.selectedIds).toEqual(["a", "b", "c"]);
  });

  it("drops a selection the session no longer offers", async () => {
    clientMocks.listSessionResults.mockResolvedValue([reference("a")]);
    localStorage.setItem(
      "pipeline-context-results:sess-1",
      JSON.stringify({ selectedIds: ["gone"], decided: true, dismissed: [] }),
    );

    const { result } = renderHook(() => useContextResults("sess-1"));

    await waitFor(() => expect(result.current.available).toHaveLength(1));
    expect(result.current.selectedIds).toEqual([]);
  });

  it("reads the older stored shape as a choice nobody has made", async () => {
    clientMocks.listSessionResults.mockResolvedValue([reference("a")]);
    localStorage.setItem(
      "pipeline-context-results:sess-1",
      JSON.stringify(["a"]),
    );

    const { result } = renderHook(() => useContextResults("sess-1"));

    await waitFor(() => expect(result.current.selectedIds).toEqual(["a"]));
  });

  /**
   * A chip stands for something Send will carry. Emptying the list on a failed
   * refresh hid the chips while their ids stayed in the payload, so the
   * composer showed a turn carrying nothing and sent one carrying a result.
   */
  it("keeps a selected result visible when a refresh fails", async () => {
    clientMocks.listSessionResults.mockResolvedValueOnce([reference("a")]);

    const { result } = renderHook(() => useContextResults("sess-1"));
    await waitFor(() => expect(result.current.selectedIds).toEqual(["a"]));

    clientMocks.listSessionResults.mockRejectedValueOnce(
      new Error("workspace unavailable"),
    );
    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.selectedIds).toEqual(["a"]);
    expect(result.current.selected.map((entry) => entry.id)).toEqual(["a"]);
  });

  it("clears the error once a refresh succeeds", async () => {
    clientMocks.listSessionResults.mockRejectedValueOnce(new Error("nope"));

    const { result } = renderHook(() => useContextResults("sess-1"));
    await waitFor(() => expect(result.current.error).not.toBeNull());

    clientMocks.listSessionResults.mockResolvedValueOnce([reference("a")]);
    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.error).toBeNull());
  });
});

describe("describeResultDetail", () => {
  it("distinguishes two replies from one producer in the same minute", () => {
    const base = reference("a");
    const first = {
      ...base,
      id: "agent:analyst:turn-1",
      completedAt: "2026-09-09T11:00:01.000Z",
      brief: "What is the market doing?",
    };
    const second = {
      ...base,
      id: "agent:analyst:turn-2",
      completedAt: "2026-09-09T11:00:30.000Z",
      brief: "And the regulatory picture?",
    };

    expect(describeResultDetail(first)).not.toBe(describeResultDetail(second));
  });

  it("falls back to the excerpt, then to the id", () => {
    const base = reference("a");
    expect(
      describeResultDetail({ ...base, excerpt: "It is consolidating." }),
    ).toContain("It is consolidating.");
    expect(describeResultDetail({ ...base, id: "agent:analyst:abcdef12" })).toContain(
      "#abcdef12",
    );
  });

  it("keeps colliding records distinct with a stable suffix", () => {
    const base = reference("a");
    // Same producer, same minute, same question. Nothing in the per-record
    // text can tell these apart, so the list-wide pass has to.
    const first = {
      ...base,
      id: "agent:analyst:turn-1",
      completedAt: "2026-09-09T11:00:01.000Z",
      brief: "What is the market doing?",
    };
    const second = {
      ...base,
      id: "agent:analyst:turn-2",
      completedAt: "2026-09-09T11:00:30.000Z",
      brief: "What is the market doing?",
    };

    const labels = describeResultDetails([first, second]);

    expect(labels.get(first.id)).not.toBe(labels.get(second.id));
    expect(labels.get(first.id)).toContain("#");
  });

  it("adds no suffix when the records already differ", () => {
    const base = reference("a");
    const labels = describeResultDetails([
      { ...base, id: "agent:analyst:turn-1", brief: "One question." },
      { ...base, id: "agent:analyst:turn-2", brief: "Another question." },
    ]);

    expect(labels.get("agent:analyst:turn-1")).not.toContain("#");
  });

  it("still separates questions sharing their first 79 characters", () => {
    const shared = "x".repeat(90);
    const base = reference("a");
    const labels = describeResultDetails([
      { ...base, id: "agent:analyst:turn-1", brief: `${shared}A` },
      { ...base, id: "agent:analyst:turn-2", brief: `${shared}B` },
    ]);

    expect(labels.get("agent:analyst:turn-1")).not.toBe(
      labels.get("agent:analyst:turn-2"),
    );
  });
});
