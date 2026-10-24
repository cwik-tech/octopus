import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderCatalogProvider } from "@/contexts/provider-catalog-context";
import ChatPanel from "../chat-panel";

const model = { provider: "openai", model: "fixture" };
const time = "2026-09-19T12:00:00.000Z";
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

/** Sends "Review this" to a reviewer whose turn is researching, and holds the reply open. */
async function startResearchTurn(state: string) {
  let channelId = "";
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let finish: () => void = () => { throw new Error("POST not started"); };
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const encoder = new TextEncoder();
  const assistant = { id: "answer", role: "assistant", text: "The completed answer", createdAt: time, speaker: { type: "agent", id: "reviewer", name: "Reviewer" } };
  let finalMessages: unknown[] = [];

  // Paid model output is delivered as real SSE bytes at the HTTP boundary.
  // ChatPanel and its stream/research clients are not mocked.
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;
    if (path.endsWith("/settings/model-catalog")) return json({ catalog: [{ provider: "openai", label: "OpenAI", models: [{ id: "fixture", label: "Fixture" }] }], defaultModel: model, defaultModelState: { status: "set", selection: model } });
    if (path.endsWith("/create/chat-defaults")) return json({ run: model, agent: model, team: model, workflow: model });
    if (path.endsWith("/create/agents")) return json({ agents: [] });
    if (path.endsWith("/agent-chat/stream")) {
      channelId = url.searchParams.get("channelId") ?? "";
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { "content-type": "text/event-stream" } });
    }
    if (path.endsWith("/messages")) {
      if (init?.method !== "POST") return json({ messages: finalMessages, outcomes: [] });
      await finished;
      finalMessages = [assistant];
      return json({ user: { id: "user", role: "user", text: "Review this", createdAt: time }, messages: finalMessages, dispatch: { kind: "agents", agentNames: ["reviewer"] }, meta: { replies: [] }, replayed: false });
    }
    if (path.endsWith("/research-activity")) return json({ activities: channelId ? [{ activityId: "research", sessionId: "session", runId: channelId, assignmentId: "assignment", agentPath: "agents/reviewer", toolCallId: "tool", source: "research-web", action: "search", kind: "search", state, createdAt: time, updatedAt: time, searchProviders: ["brave"], resultCount: 3 }] : [] });
    if (path.endsWith("/files")) return json({ files: [] });
    if (path.endsWith("/results")) return json({ results: [] });
    if (path.endsWith("/mcp-interactions")) return json({ interactions: [], truncated: false });
    if (path.endsWith("/servers")) return json({ servers: [] });
    return json([]);
  }));

  render(<ProviderCatalogProvider><ChatPanel
    session={{ id: "session", title: "Review", status: "active", activityType: "chat", createdAt: time, updatedAt: time }}
    target={{ kind: "agents", agentNames: ["reviewer"] }}
  /></ProviderCatalogProvider>);
  const input = await screen.findByPlaceholderText("Send a message to the selected agents...");
  await waitFor(() => expect(input).toBeEnabled());
  await userEvent.type(input, "Review this");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  return {
    channelId: () => channelId,
    send: (event: string, delivery: unknown, id?: number) => act(async () => {
      stream?.enqueue(encoder.encode(`${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(delivery)}\n\n`));
    }),
    complete: () => act(async () => {
      stream?.enqueue(encoder.encode(": channel-complete\n\n"));
      stream?.close();
      finish();
    }),
  };
}

it.each([
  ["running", "Researching…"],
  ["completed", "Preparing a response…"],
])("replaces the %s research status with streamed answer text", async (state, copy) => {
  const turn = await startResearchTurn(state);
  await waitFor(() => expect(screen.getByRole("status", { name: "Reviewer is responding" })).toHaveTextContent(copy));

  await turn.send("delta", { type: "delta", channelId: turn.channelId(), cursor: 0, replyId: "reviewer:0", channel: "text", text: "The streamed answer" }, 0);
  expect(await screen.findByText("The streamed answer")).toBeVisible();
  expect(screen.queryByRole("status", { name: "Reviewer is responding" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Web research activity")).toBeInTheDocument();

  await turn.complete();
  expect(await screen.findByText("The completed answer")).toBeVisible();
});

it("shows the progress row instead of a second research status while research runs", async () => {
  const turn = await startResearchTurn("completed");
  await waitFor(() => expect(screen.getByRole("status", { name: "Reviewer is responding" })).toBeInTheDocument());

  await turn.send("progress", { type: "progress", channelId: turn.channelId(), cursor: 0, replyId: "reviewer:0", progress: {
    revision: 1, startedAt: 1000, updatedAt: 1000, current: { kind: "observed", phase: "tool", toolName: "research_web" }, history: [],
  } }, 0);
  expect(await screen.findByRole("button", { name: "Agent progress: Running research_web" })).toBeVisible();
  expect(screen.queryByRole("status", { name: "Reviewer is responding" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Web research activity")).toBeInTheDocument();

  await turn.complete();
  expect(await screen.findByText("The completed answer")).toBeVisible();
});
