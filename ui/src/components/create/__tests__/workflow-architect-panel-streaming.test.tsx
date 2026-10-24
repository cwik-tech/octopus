/**
 * The Workflow Architect panel's renderer-to-API contract for streaming.
 *
 * Two things have to hold together: the stream must be opened on the same id
 * the turn is posted under, and the preview must give way to the saved reply
 * rather than lingering beside it.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentTextStreamDelivery } from "@contracts/agent-text-stream";
import type {
  openAgentTextStreamAt as openAgentTextStreamAtClient,
} from "@/lib/clients/agent-text-stream-client";

const postGeneratorTurn = vi.fn<(...args: unknown[]) => unknown>();
const openAgentTextStreamAt = vi.fn<typeof openAgentTextStreamAtClient>();

vi.mock("@/lib/clients/workflow-generator-client", () => ({
  postGeneratorTurn: (...args: unknown[]) => postGeneratorTurn(...args),
  fetchGeneratorRegistry: vi.fn().mockResolvedValue({ teams: [] }),
  cancelGeneratorJob: vi.fn().mockResolvedValue(undefined),
  validateWorkflowYaml: vi.fn(),
  saveGeneratorDraft: vi.fn(),
}));

vi.mock("@/lib/clients/agent-text-stream-client", () => ({
  openAgentTextStreamAt: (
    ...args: Parameters<typeof openAgentTextStreamAtClient>
  ) => openAgentTextStreamAt(...args),
}));

const DEFAULT_CATALOG_MODELS = [
  { id: "default", name: "Default model", enabled: true, capabilities: ["chat"] },
  { id: "other", name: "Other model", enabled: true, capabilities: ["chat"] },
];
const catalogModels = [
  { id: "default", name: "Default model", enabled: true, capabilities: ["chat"] },
  { id: "other", name: "Other model", enabled: true, capabilities: ["chat"] },
];
vi.mock("@/contexts/provider-catalog-context", () => ({
  useProviderCatalog: () => ({
    groups: [
      {
        provider: "codex",
        name: "Codex CLI",
        icon: "codex",
        source: "cli",
        models: catalogModels,
      },
    ],
    defaultModel: { provider: "codex", model: "default" },
    loading: false,
    error: null,
    refresh: async () => undefined,
  }),
}));

const fetchChatDefaults = vi.fn<() => unknown>();
vi.mock("@/lib/clients/chat-defaults-client", () => ({
  fetchChatDefaults: () => fetchChatDefaults(),
}));

vi.mock("@/components/create/workflow-diagram", () => ({
  default: () => <div data-testid="workflow-diagram" />,
}));

vi.mock("@/components/create/yaml-preview", () => ({
  default: () => <div data-testid="yaml-preview" />,
}));

const { default: WorkflowArchitectPanel } = await import(
  "@/components/create/workflow-architect-panel"
);

interface StreamCall {
  path: string;
  channelId: string;
  onDelivery: (delivery: AgentTextStreamDelivery) => void;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  postGeneratorTurn.mockReset();
  openAgentTextStreamAt.mockReset();
  openAgentTextStreamAt.mockReturnValue(new Promise(() => {}));
  // Restored, because one test removes a model to make it unavailable and a
  // module-level array would carry that into every test after it.
  catalogModels.splice(0, catalogModels.length, ...DEFAULT_CATALOG_MODELS);
  fetchChatDefaults.mockReset();
  fetchChatDefaults.mockResolvedValue({
    workflow: { provider: "codex", model: "default" },
  });
});

async function submitBrief(): Promise<void> {
  const composer = await screen.findByPlaceholderText(
    /Describe the workflow you want to build/i,
  );
  await userEvent.type(composer, "Build me a review workflow.");
  await userEvent.click(screen.getByRole("button", { name: "Submit" }));
}

describe("workflow architect model provenance", () => {
  it("stays usable when the app default is unavailable and the Agent has its own", async () => {
    // The picker shows the application default before anyone touches it, and
    // that default can be unavailable while the Architect Agent's own pair is
    // perfectly valid. Blocking the composer on the displayed pair stops a turn
    // that would have run — the backend resolves the Agent's pair, not this one.
    fetchChatDefaults.mockResolvedValue({
      workflow: { provider: "codex", model: "retired-model" },
    });
    postGeneratorTurn.mockResolvedValue({
      jobId: "turn-1",
      message: "Understood.",
      draft: null,
      warnings: [],
      yaml: null,
      mermaid: null,
      meta: { model: "default", fallback: false },
    });
    render(<WorkflowArchitectPanel />);

    const composer = await screen.findByPlaceholderText(
      /Describe the workflow you want to build/i,
    );
    await waitFor(() => expect(composer).not.toBeDisabled());
    await submitBrief();

    await waitFor(() => expect(postGeneratorTurn).toHaveBeenCalled());
    const [posted] = postGeneratorTurn.mock.calls[0] as [Record<string, unknown>];
    expect(posted).not.toHaveProperty("provider");
  });

  it("posts no pair when nobody chose one", async () => {
    // The composer's picker is prefilled from Settings before anyone touches
    // it. Posting that prefilled pair makes the server record an explicit user
    // choice for a model the person never picked, and it overrides the pair the
    // Workflow Architect Agent names for itself.
    postGeneratorTurn.mockResolvedValue({
      jobId: "turn-1",
      message: "Understood.",
      draft: null,
      warnings: [],
      yaml: null,
      mermaid: null,
      meta: { model: "default", fallback: false },
    });
    render(<WorkflowArchitectPanel />);

    await submitBrief();

    await waitFor(() => expect(postGeneratorTurn).toHaveBeenCalled());
    const [posted] = postGeneratorTurn.mock.calls[0] as [Record<string, unknown>];
    expect(posted).not.toHaveProperty("provider");
    expect(posted).not.toHaveProperty("model");
  });

  it("keeps a person's pick when the prefill answers late", async () => {
    // The prefill is a separate request with no ordering guarantee. Writing it
    // in after someone has picked replaces their choice while the panel still
    // counts it as one.
    let releaseDefaults!: (value: { workflow: { provider: string; model: string } }) => void;
    fetchChatDefaults.mockReturnValue(
      new Promise((resolve) => {
        releaseDefaults = resolve as (value: {
          workflow: { provider: string; model: string };
        }) => void;
      }),
    );
    postGeneratorTurn.mockResolvedValue({
      jobId: "turn-1",
      message: "Understood.",
      draft: null,
      warnings: [],
      yaml: null,
      mermaid: null,
      meta: { model: "default", fallback: false },
    });
    render(<WorkflowArchitectPanel />);

    const picker = await screen.findByRole("button", {
      name: /Workflow Architect model/i,
    });
    await waitFor(() => expect(picker).toHaveTextContent("Default model"));
    // Picked deliberately, and different from what the prefill will say, so
    // an overwrite is visible rather than hidden behind an identical value.
    await userEvent.click(picker);
    await userEvent.click(await screen.findByRole("option", { name: /Other model/ }));
    await waitFor(() => expect(picker).toHaveTextContent("Other model"));

    releaseDefaults({ workflow: { provider: "codex", model: "default" } });
    await waitFor(() => expect(picker).toHaveTextContent("Other model"));
    await submitBrief();

    await waitFor(() => expect(postGeneratorTurn).toHaveBeenCalled());
    const [posted] = postGeneratorTurn.mock.calls[0] as [Record<string, unknown>];
    expect(posted).toMatchObject({ provider: "codex", model: "other" });
  });
});

describe("workflow architect panel streaming", () => {
  it("streams the reply on the same id it posts the turn under, then hands over to the saved reply", async () => {
    const turn = deferred<Record<string, unknown>>();
    postGeneratorTurn.mockReturnValue(turn.promise);

    render(<WorkflowArchitectPanel />);
    await submitBrief();

    await waitFor(() => expect(postGeneratorTurn).toHaveBeenCalled());
    await waitFor(() => expect(openAgentTextStreamAt).toHaveBeenCalled());
    const stream = openAgentTextStreamAt.mock.calls[0]?.[0] as StreamCall;
    const posted = postGeneratorTurn.mock.calls[0]?.[0] as { jobId: string };

    // One id, or the stream would be reading somebody else's channel.
    expect(stream.channelId).toBe(posted.jobId);
    expect(stream.path).toBe("/create/turn");

    stream.onDelivery({
      type: "delta",
      channelId: stream.channelId,
      cursor: 0,
      replyId: "architect:0",
      channel: "text",
      text: "I suggest the review",
    });
    await waitFor(() =>
      expect(screen.getByTestId("streaming-reply")).toHaveTextContent(
        "I suggest the review",
      ),
    );

    turn.resolve({
      jobId: posted.jobId,
      message: "I suggest the review workflow.",
      draft: null,
      warnings: [],
      yaml: null,
      mermaid: null,
      meta: { model: "test-model", fallback: false },
    });

    // The preview must not survive alongside the answer it was previewing.
    await waitFor(() =>
      expect(screen.queryByTestId("streaming-reply")).not.toBeInTheDocument(),
    );
    expect(
      await screen.findByText("I suggest the review workflow."),
    ).toBeInTheDocument();
  });

  it("stopping abandons the preview instead of stranding it on screen", async () => {
    // Stop hands the turn's ownership away, so the completion path that
    // normally clears the bubble never runs for it. Without an explicit
    // teardown the half-written reply stays on screen indefinitely.
    const turn = deferred<Record<string, unknown>>();
    postGeneratorTurn.mockReturnValue(turn.promise);
    let aborted = false;
    openAgentTextStreamAt.mockImplementation(
      async (params: { signal: AbortSignal }) => {
        params.signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise(() => {});
      },
    );

    render(<WorkflowArchitectPanel />);
    await submitBrief();
    await waitFor(() => expect(openAgentTextStreamAt).toHaveBeenCalled());
    const stream = openAgentTextStreamAt.mock.calls[0]?.[0] as StreamCall;

    stream.onDelivery({
      type: "delta",
      channelId: stream.channelId,
      cursor: 0,
      replyId: "architect:0",
      channel: "text",
      text: "half an answer",
    });
    await waitFor(() =>
      expect(screen.getByTestId("streaming-reply")).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole("button", { name: /stop/i }));

    await waitFor(() =>
      expect(screen.queryByTestId("streaming-reply")).not.toBeInTheDocument(),
    );
    expect(aborted).toBe(true);
  });
});
