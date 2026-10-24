/**
 * Site icons are fetched, not linked.
 *
 * The desktop CSP allows images only from 'self', data: and blob:, and the API
 * lives on a separate loopback origin, so an <img> pointed at it is blocked.
 * The hook fetches over connect-src and hands back blob URLs instead.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { useSiteIcons } from "@/hooks/use-site-icons";

/** A promise plus the handle that settles it, with no timer involved. */
function createGate(): { gate: Promise<void>; open: () => void } {
  let open: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  // A Promise executor runs synchronously, so this is already assigned.
  if (!open) throw new Error("Gate was not initialized");
  return { gate, open };
}

beforeEach(() => {
  Object.assign(URL, {
    createObjectURL: vi.fn(() => "blob:icon"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function iconResponse(): Response {
  return new Response("icon-bytes", {
    status: 200,
    headers: { "content-type": "image/png" },
  });
}

it("fetches each origin once and picks up one that appears later", async () => {
  const fetchMock = vi.fn(async () => iconResponse());
  vi.stubGlobal("fetch", fetchMock);

  const { result, rerender } = renderHook(
    ({ origins }: { origins: string[] }) => useSiteIcons("session-1", origins),
    { initialProps: { origins: ["https://a.example"] } },
  );

  await waitFor(() =>
    expect(result.current.get("https://a.example")).toBe("blob:icon"));
  expect(fetchMock).toHaveBeenCalledTimes(1);

  // A fresh array with one new entry: only the new origin is fetched, and the
  // changed array identity alone must not restart the known one.
  rerender({ origins: ["https://a.example", "https://b.example"] });

  await waitFor(() =>
    expect(result.current.get("https://b.example")).toBe("blob:icon"));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("leaves an origin iconless when the app has no icon for it", async () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
  vi.stubGlobal("fetch", fetchMock);

  const { result } = renderHook(() =>
    useSiteIcons("session-1", ["https://a.example"]));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(result.current.get("https://a.example")).toBeUndefined();
});

it("shows nothing from the previous session while the new session is still loading", async () => {
  // The second session's fetch is held open, so the window between switching
  // sessions and its first icon arriving is observable rather than closing
  // inside the same act() as the rerender.
  const { gate, open } = createGate();
  let calls = 0;
  const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => {
    calls += 1;
    if (calls > 1) await gate;
    return iconResponse();
  });
  vi.stubGlobal("fetch", fetchMock);

  const { result, rerender } = renderHook(
    ({ sessionId }: { sessionId: string }) =>
      useSiteIcons(sessionId, ["https://a.example"]),
    { initialProps: { sessionId: "session-1" } },
  );
  await waitFor(() =>
    expect(result.current.get("https://a.example")).toBe("blob:icon"));

  rerender({ sessionId: "session-2" });

  // The refetch has started for the new session and has not answered yet.
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  const secondCall = fetchMock.mock.calls[1];
  expect(secondCall?.[0]).toContain("session-2");
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:icon");

  // While it is pending, session-1's icon must not be on screen.
  expect(result.current.size).toBe(0);

  await act(async () => {
    open();
    await gate;
  });
  await waitFor(() =>
    expect(result.current.get("https://a.example")).toBe("blob:icon"));
});

it("aborts an in-flight icon request when the view goes away", async () => {
  const signals: (AbortSignal | null | undefined)[] = [];
  const { gate } = createGate();
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async (_url, init) => {
      signals.push(init?.signal);
      await gate;
      return iconResponse();
    },
  );
  vi.stubGlobal("fetch", fetchMock);

  const { unmount } = renderHook(() =>
    useSiteIcons("session-1", ["https://a.example"]));
  await waitFor(() => expect(signals).toHaveLength(1));
  expect(signals[0]?.aborted).toBe(false);

  unmount();

  expect(signals[0]?.aborted).toBe(true);
});

it("abandons an icon request that never answers", async () => {
  vi.useFakeTimers();
  try {
    const signals: (AbortSignal | null | undefined)[] = [];
    const { gate } = createGate();
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async (_url, init) => {
        signals.push(init?.signal);
        await gate;
        return iconResponse();
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useSiteIcons("session-1", ["https://a.example"]));
    await vi.advanceTimersByTimeAsync(0);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);

    // A hung request must not hold a concurrency slot for the whole session.
    // Advancing to whatever deadline the hook scheduled keeps the expected
    // value independent of the implementation's constant.
    await vi.advanceTimersToNextTimerAsync();

    expect(signals[0]?.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("does not fetch anything without a session", async () => {
  const fetchMock = vi.fn(async () => iconResponse());
  vi.stubGlobal("fetch", fetchMock);

  renderHook(() => useSiteIcons(null, ["https://a.example"]));

  await Promise.resolve();
  expect(fetchMock).not.toHaveBeenCalled();
});
