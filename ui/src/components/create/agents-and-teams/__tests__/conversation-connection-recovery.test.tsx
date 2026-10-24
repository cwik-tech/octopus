import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { resourceArchitectConversationSchema, type ResourceArchitectConversation } from "@contracts/schemas/resource-architect-conversation";
import { useResourceArchitectChat } from "../use-resource-architect-chat";
import { postResourceArchitectTurn } from "@/lib/clients/resource-architect-client";

const requestSchema = resourceArchitectConversationSchema.pick({ draftId: true, history: true }).extend({
  jobId: z.string(),
});
const ANSWER = "Use one harness-design agent first.";
const MESSAGE = "Help me design a harness.";
const UNAVAILABLE = "We couldn't check your request. Your message is still here.";
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Deferred is not initialized"); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function server(options: {
  read?: (saved: ResourceArchitectConversation, signal: AbortSignal | null | undefined) => Promise<ResourceArchitectConversation | null>;
  failure?: Error;
  stream?: () => Promise<Response>;
  postResponse?: Response;
} = {}) {
  let saved: ResourceArchitectConversation | null = null;
  let posts = 0;
  // Simulate connection loss only at the HTTP boundary. Real clients and hook
  // run here; Electron covers the real local API and durable store separately.
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/conversation")) {
      return json(saved && options.read ? await options.read(saved, init?.signal) : saved);
    }
    if (url.pathname.endsWith("/turn")) {
      if (init?.method !== "POST") return saved && options.stream ? options.stream() : new Response(null, { status: 404 });
      const request = requestSchema.parse(JSON.parse(String(init.body)));
      posts += 1;
      if (options.postResponse) return options.postResponse;
      saved = {
        schemaVersion: 1, draftId: request.draftId,
        history: [...request.history, { role: "assistant", text: ANSWER }],
        planId: null, buildJobId: null, selectedResource: null, documentReader: null,
        updatedAt: "2026-09-27T03:00:00.000Z",
        turn: { jobId: request.jobId, operation: "conversation", status: "completed" },
      };
      throw options.failure ?? new TypeError("Failed to fetch");
    }
    if (url.pathname.endsWith("/metrics")) return json({ metrics: [] });
    if (url.pathname.endsWith("/jobs")) return json({ jobs: [] });
    if (url.pathname.endsWith("/cancel")) return json({ cancelled: true });
    throw new Error(`Unexpected request: ${url.pathname}`);
  }));
  return { posts: () => posts };
}

async function openChat() {
  const hook = renderHook(() => useResourceArchitectChat({ model: { provider: "openai", model: "test-model" } }));
  await waitFor(() => expect(hook.result.current.restoring).toBe(false));
  return hook;
}

afterEach(() => vi.unstubAllGlobals());

describe("Create conversation connection recovery", () => {
  it("does not claim to recover proposal requests", async () => {
    server();
    await expect(postResourceArchitectTurn({
      draftId: "proposal-draft", jobId: "proposal-job", operation: "proposal",
      history: [{ role: "user", text: "Build it." }], currentPlan: null,
    })).rejects.toThrow("Failed to fetch");
  });

  it("restores a saved reply once without submitting generation again", async () => {
    const api = server();
    const { result } = await openChat();
    await act(() => result.current.submit(MESSAGE));
    expect(result.current.history.map((turn) => turn.text)).toEqual([MESSAGE, ANSWER]);
    expect(result.current.error).toBeNull();
    expect(result.current.submitting).toBe(false);
    expect(api.posts()).toBe(1);
  });

  it.each(["draft", "job", "operation"])("does not recover a different %s", async (field) => {
    server({ read: async (saved) => ({ ...saved,
      draftId: field === "draft" ? "other-draft" : saved.draftId,
      turn: { ...saved.turn, jobId: field === "job" ? "other-job" : saved.turn.jobId,
        operation: field === "operation" ? "proposal" : "conversation" },
    }) });
    const { result } = await openChat();
    await act(() => result.current.submit(MESSAGE));
    expect(result.current.history.map((turn) => turn.text)).toEqual([MESSAGE]);
    expect(result.current.error).toBe(UNAVAILABLE);
  });

  it("preserves the message when the saved request is missing", async () => {
    server({ read: async () => null });
    const { result } = await openChat();
    await act(() => result.current.submit(MESSAGE));
    expect(result.current.history.map((turn) => turn.text)).toEqual([MESSAGE]);
    expect(result.current.error).toBe(UNAVAILABLE);
  });

  it("does not publish a recovery read that finishes after Stop", async () => {
    const reading = deferred<ResourceArchitectConversation>();
    const release = deferred<ResourceArchitectConversation>();
    server({ read: async (saved) => { reading.resolve(saved); return release.promise; } });
    const { result } = await openChat();
    let submitted: Promise<void> = Promise.resolve();
    act(() => { submitted = result.current.submit(MESSAGE); });
    const saved = await reading.promise;
    await act(() => result.current.stop());
    await act(async () => { release.resolve(saved); await submitted; });
    expect(result.current.history.map((turn) => turn.text)).toEqual([MESSAGE]);
    expect(result.current.submitting).toBe(false);
  });

  it("checks again after a failed recovery read without generating again", async () => {
    let reachable = false;
    const api = server({ read: async (saved) => {
      if (!reachable) throw new TypeError("Failed to fetch");
      return saved;
    } });
    const { result } = await openChat();
    await act(() => result.current.submit(MESSAGE));
    expect(result.current.error).toBe(UNAVAILABLE);
    expect(result.current.connectionStatus).toBe("unavailable");
    reachable = true;
    await act(() => result.current.checkConnection());
    expect(result.current.history.map((turn) => turn.text)).toEqual([MESSAGE, ANSWER]);
    expect(result.current.connectionStatus).toBeNull();
    expect(result.current.error).toBeNull();
    expect(api.posts()).toBe(1);
  });

  it("waits for the running request and then reads its saved reply", async () => {
    const release = deferred<Response>();
    let completed = false;
    const api = server({
      read: async (saved) => completed ? saved : { ...saved, history: saved.history.slice(0, 1), turn: { ...saved.turn, status: "running" } },
      stream: async () => release.promise,
    });
    const { result } = await openChat();
    let submitted: Promise<void> = Promise.resolve();
    act(() => { submitted = result.current.submit(MESSAGE); });
    try {
      await waitFor(() => expect(result.current.connectionStatus).toBe("running"));
      expect(result.current.submitting).toBe(true);
    } finally {
      completed = true;
      await act(async () => {
        release.resolve(new Response(": channel-complete\n\n"));
        await submitted;
      });
    }
    expect(result.current.history.map((turn) => turn.text)).toEqual([MESSAGE, ANSWER]);
    expect(result.current.submitting).toBe(false);
    expect(api.posts()).toBe(1);
  });

  it.each([
    ["failed", "The request failed. Your message is still here. You can send it again."],
    ["cancelled", "The request was cancelled. Your message is still here."],
    ["interrupted", "The app stopped before the reply finished. Your message is still here. You can send it again."],
  ] as const)("reports a confirmed %s request", async (status, message) => {
    server({ read: async (saved) => ({ ...saved, history: saved.history.slice(0, 1), turn: { ...saved.turn, status } }) });
    const { result } = await openChat();
    await act(() => result.current.submit(MESSAGE));
    expect(result.current.error).toBe(message);
    expect(result.current.connectionStatus).toBeNull();
    expect(result.current.history.map((turn) => turn.text)).toEqual([MESSAGE]);
  });

  it("preserves a server rejection instead of trying connection recovery", async () => {
    server({ postResponse: new Response(JSON.stringify({ reason: "Choose an enabled model." }), { status: 422 }) });
    const { result } = await openChat();
    await act(() => result.current.submit(MESSAGE));
    expect(result.current.error).toBe("Choose an enabled model.");
    expect(result.current.history.map((turn) => turn.text)).toEqual([MESSAGE]);
  });

  it("aborts the recovery read when New unmounts the conversation", async () => {
    const reading = deferred<AbortSignal>();
    const release = deferred<null>();
    server({ read: async (_saved, signal) => {
      if (!signal) throw new Error("Expected a bounded recovery read");
      reading.resolve(signal);
      return release.promise;
    } });
    const { result, unmount } = await openChat();
    let submitted: Promise<void> = Promise.resolve();
    act(() => { submitted = result.current.submit(MESSAGE); });
    const signal = await reading.promise;
    unmount();
    release.resolve(null);
    await submitted;
    expect(signal.aborted).toBe(true);
  });

  it("does not call a disconnected stream a completed request", async () => {
    server({
      read: async (saved) => ({ ...saved, history: saved.history.slice(0, 1), turn: { ...saved.turn, status: "running" } }),
      stream: async () => new Response(null, { status: 404 }),
    });
    const { result } = await openChat();
    await act(() => result.current.submit(MESSAGE));
    expect(result.current.connectionStatus).toBe("unavailable");
    expect(result.current.history.map((turn) => turn.text)).toEqual([MESSAGE]);
    expect(result.current.error).toBe("Your request is still running. Check again to reconnect.");
  });
});
