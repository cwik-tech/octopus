/**
 * ChatPanel streaming on the Run → Workflows surface.
 *
 * The receptionist branch has to earn the same contract the selected-agent
 * branch already has: mint the turn id, open the stream before the POST, and
 * let the saved reply replace the preview rather than sit beside it.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatPanel from "@/components/run/chat/chat-panel";
import {
  openAgentTextStream as mockOpenAgentTextStream,
  postSessionMessage as mockPostSessionMessage,
} from "@/lib/clients/session-client";
import type { AgentTextStreamDelivery } from "@contracts/agent-text-stream";
import type { SessionSummary } from "@/lib/models/session-model";

vi.mock("@/lib/clients/session-client", () => ({
  listSessionResults: vi.fn().mockResolvedValue([]),
  postSessionMessage: vi.fn(),
  listChatMessages: vi.fn().mockResolvedValue({ messages: [], outcomes: [] }),
  openAgentTextStream: vi.fn(),
  updateSessionTitle: vi.fn(),
  listSessionFiles: vi.fn().mockResolvedValue([]),
  uploadSessionFile: vi.fn(),
  deleteSessionFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/clients/mcp-resources-client", () => ({
  mcpResourcesClient: {
    listServers: vi.fn(),
    listResources: vi.fn(),
    listImports: vi.fn(),
    importResource: vi.fn(),
  },
}));

vi.mock("@/lib/clients/chat-defaults-client", () => ({
  fetchChatDefaults: vi.fn().mockResolvedValue({
    workflow: { provider: "deepseek", model: "deepseek-v4-flash" },
    team: { provider: "deepseek", model: "deepseek-v4-flash" },
    agent: { provider: "deepseek", model: "deepseek-v4-flash" },
    run: { provider: "deepseek", model: "deepseek-v4-flash" },
  }),
}));

vi.mock("@/lib/clients/runtime-client", () => ({
  artifactUrl: (runId: string, artifactPath: string) =>
    `/api/runs/${runId}/assignments/${artifactPath}`,
  fetchArtifact: vi.fn(),
  fetchExcelWorkbookPreview: vi.fn(),
}));

vi.mock("@/contexts/provider-catalog-context", () => ({
  useProviderCatalog: () => ({
    groups: [
      {
        provider: "deepseek",
        name: "DeepSeek",
        icon: "deepseek",
        source: "cli",
        models: [
          {
            id: "deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            enabled: true,
            capabilities: ["chat"],
          },
        ],
      },
    ],
    defaultModel: { provider: "deepseek", model: "deepseek-v4-flash" },
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const SESSION_FIXTURE: SessionSummary = {
  id: "sess-1",
  title: "Test Session",
  status: "active",
  activityType: "chat",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function frame(
  cursor: number,
  replyId: string,
  text: string,
): AgentTextStreamDelivery {
  return {
    type: "delta",
    channelId: "channel-1",
    cursor,
    replyId,
    channel: "text",
    text,
  };
}

/** Capture the panel's stream subscription so the test can drive it. */
function captureStream(order?: string[]) {
  const captured: {
    channelId?: string;
    deliver?: (delivery: AgentTextStreamDelivery) => void;
    aborted: boolean;
  } = { aborted: false };

  vi.mocked(mockOpenAgentTextStream).mockImplementation(async (params) => {
    order?.push("stream");
    captured.channelId = params.channelId;
    captured.deliver = params.onDelivery;
    params.signal.addEventListener("abort", () => {
      captured.aborted = true;
    });
    await new Promise<void>((resolve) => {
      params.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });

  return captured;
}

async function sendWorkflowMessage(text: string): Promise<void> {
  const input = await screen.findByPlaceholderText(/Send a message/i);
  await userEvent.type(input, text);
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
}

describe("ChatPanel — Run Workflows streaming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the stream before posting the receptionist turn, on the same id", async () => {
    const order: string[] = [];
    const stream = captureStream(order);
    vi.mocked(mockPostSessionMessage).mockImplementation(async () => {
      order.push("post");
      return {
        user: { id: "u1", role: "user", text: "hi", createdAt: "" },
        dispatch: { kind: 'coordinator' },
        messages: [{
          id: "a1",
          role: "assistant",
          text: "Tell me more.",
          createdAt: "",
        }],
        meta: { model: 'test-model', fallback: false },
        replayed: false,
        plan: { status: "draft" },
      } as never;
    });

    render(<ChatPanel session={SESSION_FIXTURE} />);
    await sendWorkflowMessage("hi");

    await waitFor(() => expect(order).toContain("post"));
    // Both boundaries are recorded, so the ordering is asserted rather than
    // inferred from one of them existing.
    expect(order).toEqual(["stream", "post"]);
    expect(stream.channelId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const posted = vi.mocked(mockPostSessionMessage).mock.calls[0];
    expect(posted?.[2]).toMatchObject({ turnId: stream.channelId });
  });

  it("grows the reply, then lets the saved message replace it", async () => {
    const stream = captureStream();
    let release: (() => void) | undefined;
    vi.mocked(mockPostSessionMessage).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        user: { id: "u1", role: "user", text: "hi", createdAt: "" },
        dispatch: { kind: 'coordinator' },
        messages: [{
          id: "a1",
          role: "assistant",
          text: "Tell me more about the brief.",
          createdAt: "",
        }],
        meta: { model: 'test-model', fallback: false },
        replayed: false,
        plan: { status: "draft" },
      } as never;
    });

    render(<ChatPanel session={SESSION_FIXTURE} />);
    await sendWorkflowMessage("hi");
    await waitFor(() => expect(stream.deliver).toBeDefined());

    stream.deliver?.(frame(0, "assistant:0", "Tell me more"));
    await waitFor(() =>
      expect(screen.getByTestId("streaming-reply")).toHaveTextContent(
        "Tell me more",
      ),
    );

    release?.();

    await waitFor(() =>
      expect(screen.queryByTestId("streaming-reply")).not.toBeInTheDocument(),
    );
    expect(
      await screen.findByText("Tell me more about the brief."),
    ).toBeInTheDocument();
    expect(stream.aborted).toBe(true);
  });
});
