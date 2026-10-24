/**
 * An Agent reply shows how long the Agent has been working on it, or how long
 * it took: from the moment the question is sent until the reply is saved.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderCatalogProvider } from "@/contexts/provider-catalog-context";
import ChatPanel from "../chat-panel";

const model = { provider: "openai", model: "fixture" };
const SENT_AT = Date.parse("2026-10-21T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(SENT_AT + offsetMs).toISOString();
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const reviewer = { type: "agent", id: "reviewer", name: "Reviewer" };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * The app's HTTP boundary. Model output is paid, so the reply arrives as real
 * SSE bytes from this stub; ChatPanel and its clients are not mocked.
 */
function stubServer(transcript: () => unknown[], onPost: () => Promise<unknown>) {
  let channelId = "";
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
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
      if (init?.method !== "POST") return json({ messages: transcript(), outcomes: [] });
      return json(await onPost());
    }
    if (path.endsWith("/research-activity")) return json({ activities: [] });
    if (path.endsWith("/files")) return json({ files: [] });
    if (path.endsWith("/results")) return json({ results: [] });
    if (path.endsWith("/mcp-interactions")) return json({ interactions: [], truncated: false });
    if (path.endsWith("/servers")) return json({ servers: [] });
    return json([]);
  }));
  return { turnId: () => channelId, stream: () => stream };
}

function renderPanel() {
  render(<ProviderCatalogProvider><ChatPanel
    session={{ id: "session", title: "Review", status: "active", activityType: "chat", createdAt: iso(0), updatedAt: iso(0) }}
    target={{ kind: "agents", agentNames: ["reviewer"] }}
  /></ProviderCatalogProvider>);
}

it("shows the response time from the moment the question is sent until the reply is saved", async () => {
  // Only `Date` is replaced, so the panel's own clock is the test's clock.
  // Timers, promises and events stay real.
  vi.useFakeTimers({ toFake: ["Date"], now: SENT_AT });
  let finalMessages: unknown[] = [];
  let finish: () => void = () => { throw new Error("POST not started"); };
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const server = stubServer(() => finalMessages, async () => {
    await finished;
    const turnId = server.turnId();
    // The server saves the question when the turn starts and the reply when
    // the Agent finishes: 2 minutes 5 seconds later.
    const question = { id: `${turnId}:user`, role: "user", text: "Review this", createdAt: iso(0), turnId };
    const reply = { id: `${turnId}:assistant:0`, role: "assistant", text: "The completed answer", createdAt: iso(125_000), turnId, speaker: reviewer };
    finalMessages = [question, reply];
    return { user: question, messages: [reply], dispatch: { kind: "agents", agentNames: ["reviewer"] }, meta: { replies: [] }, replayed: false };
  });
  renderPanel();
  const input = await screen.findByPlaceholderText("Send a message to the selected agents...");
  await waitFor(() => expect(input).toBeEnabled());
  await userEvent.type(input, "Review this");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));

  // Waiting: the counter starts at the moment of sending.
  // The waiting row names the Agent by its id until a reply arrives.
  await screen.findByRole("status", { name: "reviewer is responding" });
  expect(screen.getByRole("timer", { name: "Response time" })).toHaveTextContent("00:00");

  // Streaming, 65 seconds after sending: the counter still measures from
  // the question, not from when the answer started to arrive.
  vi.setSystemTime(SENT_AT + 65_000);
  await act(async () => {
    server.stream()?.enqueue(new TextEncoder().encode(`id: 0\nevent: delta\ndata: ${JSON.stringify({ type: "delta", channelId: server.turnId(), cursor: 0, replyId: "reviewer:0", channel: "text", text: "The streamed answer" })}\n\n`));
  });
  const streaming = await screen.findByTestId("streaming-reply");
  expect(within(streaming).getByRole("timer", { name: "Response time" })).toHaveTextContent("01:05");

  // Saved: the time between the saved question and the saved reply.
  await act(async () => {
    server.stream()?.enqueue(new TextEncoder().encode(": channel-complete\n\n"));
    server.stream()?.close();
    finish();
  });
  await screen.findByText("The completed answer");
  await waitFor(() => expect(screen.queryByTestId("streaming-reply")).not.toBeInTheDocument());
  expect(screen.getByRole("timer", { name: "Response time" })).toHaveTextContent("02:05");
});

it("shows how long a reply from history took, and nothing for a reply whose question is unknown", async () => {
  stubServer(() => [
    { id: "turn-1:user", role: "user", text: "First question", createdAt: iso(0), turnId: "turn-1" },
    { id: "turn-1:assistant:0", role: "assistant", text: "First answer", createdAt: iso(3_723_000), turnId: "turn-1", speaker: reviewer },
    { id: "legacy-reply", role: "assistant", text: "Legacy answer", createdAt: iso(4_000_000), speaker: reviewer },
  ], async () => { throw new Error("No turn is sent in this test"); });
  renderPanel();

  await screen.findByText("Legacy answer");
  // One hour, two minutes and three seconds.
  const timers = screen.getAllByRole("timer", { name: "Response time" });
  expect(timers).toHaveLength(1);
  expect(timers[0]).toHaveTextContent("1:02:03");
});
