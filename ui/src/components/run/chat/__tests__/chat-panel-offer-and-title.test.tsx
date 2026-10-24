/**
 * ChatPanel: what approving a model-choice offer and saving a title do to the
 * error line and the conversation.
 *
 * Both were rewired to the conversation hook's `clearError`, `reportError`
 * and `reload` when the conversation moved into its own hook, and were checked
 * by reading the source only
 * (docs/adr/2026-09-26-ChatPanel-Conversation-Stream-Hook.md). These tests pin
 * what a person sees: an approval clears an earlier error and brings the
 * conversation up to date, a refused approval says why and still does, and a
 * title save reports its failure and clears it once a save succeeds.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelChoiceOffer } from "@contracts/model-choice";

import ChatPanel from "@/components/run/chat/chat-panel";
import {
  approveModelChoice as mockApproveModelChoice,
  listChatMessages as mockListChatMessages,
  updateSessionTitle as mockUpdateSessionTitle,
} from "@/lib/clients/session-client";
import type { SessionSummary } from "@/lib/models/session-model";

vi.mock("@/lib/clients/session-client", () => ({
  listSessionResults: vi.fn().mockResolvedValue([]),
  postSessionMessage: vi.fn(),
  listChatMessages: vi.fn(),
  approveModelChoice: vi.fn(),
  // Resolved, not bare: the panel chains `.catch` onto this call.
  openAgentTextStream: vi.fn().mockResolvedValue(undefined),
  updateSessionTitle: vi.fn(),
  listSessionFiles: vi.fn().mockResolvedValue([]),
  uploadSessionFile: vi.fn(),
  deleteSessionFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/clients/agent-generator-client", () => ({
  listAgents: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/clients/research-activity-client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/clients/research-activity-client")
  >()),
  listResearchActivity: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/clients/mcp-resources-client", () => ({
  mcpResourcesClient: {
    listServers: vi.fn(),
    listResources: vi.fn(),
    listImports: vi.fn(),
    importResource: vi.fn(),
  },
}));

vi.mock("@/lib/clients/mcp-interactions-client", () => ({
  mcpInteractionsClient: {
    list: vi.fn().mockResolvedValue({ interactions: [] }),
    respond: vi.fn(),
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

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

type Transcript = Awaited<ReturnType<typeof mockListChatMessages>>;
type ChatMessage = Transcript["messages"][number];

const SESSION: SessionSummary = {
  id: "sess-a",
  title: "Alpha",
  status: "active",
  activityType: "chat",
  createdAt: "2026-09-26T10:00:00.000Z",
  updatedAt: "2026-09-26T10:00:00.000Z",
};

const QUESTION: ChatMessage = {
  id: "turn-1:user",
  role: "user",
  text: "Summarize the brief.",
  createdAt: "2026-09-26T10:00:01.000Z",
  turnId: "turn-1",
};

const OFFER: ModelChoiceOffer = {
  offerId: "offer-1",
  scope: { kind: "chat", sessionId: SESSION.id, turnId: "turn-1" },
  agentName: "analyst",
  expectedRevision: "rev-1",
  failedChoice: { provider: "openai", model: "gpt-missing" },
  proposedDefault: { provider: "deepseek", model: "deepseek-v4-flash" },
  reason: "unknown-model",
};

const RETRIED_ANSWER: ChatMessage = {
  id: "turn-1:assistant:0",
  role: "assistant",
  text: "The brief asks for a two-page summary.",
  createdAt: "2026-09-26T10:00:03.000Z",
  speaker: { type: "agent", id: "analyst", name: "analyst" },
};

const OFFER_BUTTON = "Retry this Agent using app default";

/** What the server holds; read by every transcript load. */
let serverTranscript: Transcript;

function transcript(
  messages: ChatMessage[],
  modelChoices: ModelChoiceOffer[] = [],
): Transcript {
  return { messages, outcomes: [], modelChoices };
}

/** An error on the panel's error line, made the way a person makes one. */
async function showEmptyTitleError(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Edit session title" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Session title" }), {
    target: { value: "   " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save session title" }));
  expect(
    await screen.findByText("Session title must not be empty"),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Cancel session title edit" }),
  );
}

describe("ChatPanel — offer approval and title save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverTranscript = transcript([QUESTION], [OFFER]);
    vi.mocked(mockListChatMessages).mockImplementation(
      async () => serverTranscript,
    );
  });

  it("approving an offer clears an earlier error and brings the conversation up to date", async () => {
    vi.mocked(mockApproveModelChoice).mockImplementationOnce(async () => {
      // The server starts the new attempt and stops offering the choice.
      serverTranscript = transcript([QUESTION, RETRIED_ANSWER]);
      return { turnId: "turn-1" };
    });
    render(<ChatPanel session={SESSION} />);
    const approve = await screen.findByRole("button", { name: OFFER_BUTTON });
    await showEmptyTitleError();

    await userEvent.click(approve);

    expect(
      await screen.findByText("The brief asks for a two-page summary."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: OFFER_BUTTON }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Session title must not be empty"),
    ).not.toBeInTheDocument();
    // The approval names the offer and nothing else: no provider or model.
    expect(mockApproveModelChoice).toHaveBeenCalledOnce();
    const [sessionId, turnId, approval] =
      vi.mocked(mockApproveModelChoice).mock.calls[0] ?? [];
    expect([sessionId, turnId]).toEqual([SESSION.id, "turn-1"]);
    expect(approval?.offerId).toBe(OFFER.offerId);
    expect(Object.keys(approval ?? {}).sort()).toEqual([
      "idempotencyKey",
      "offerId",
    ]);
  });

  it("approves the same offer again under the same key, and another offer under its own", async () => {
    const secondQuestion: ChatMessage = {
      id: "turn-2:user",
      role: "user",
      text: "Now draft the outline.",
      createdAt: "2026-09-26T10:00:04.000Z",
      turnId: "turn-2",
    };
    const secondOffer: ModelChoiceOffer = {
      ...OFFER,
      offerId: "offer-2",
      scope: { kind: "chat", sessionId: SESSION.id, turnId: "turn-2" },
      agentName: "writer",
    };
    // The server offers both until each is approved; a lost approval changes
    // nothing on the server.
    const bothQuestions = [QUESTION, secondQuestion];
    serverTranscript = transcript(bothQuestions, [OFFER, secondOffer]);
    vi.mocked(mockApproveModelChoice)
      .mockRejectedValueOnce(new Error("The connection was lost."))
      .mockImplementationOnce(async () => {
        serverTranscript = transcript(bothQuestions, [secondOffer]);
        return { turnId: "turn-1" };
      })
      .mockImplementationOnce(async () => {
        serverTranscript = transcript(bothQuestions, []);
        return { turnId: "turn-2" };
      });
    render(<ChatPanel session={SESSION} />);
    const offerCards = () =>
      screen.queryAllByRole("note", { name: "Model choice" });
    const approveButton = (agent: string) => {
      const card = offerCards().find((candidate) =>
        candidate.textContent?.includes(agent),
      );
      if (!card) throw new Error(`No offer card for ${agent}`);
      return within(card).getByRole("button", { name: OFFER_BUTTON });
    };
    await screen.findAllByRole("note", { name: "Model choice" });

    // The first approval is lost on the way, so the person approves again.
    await userEvent.click(approveButton("Analyst"));
    expect(
      await screen.findByText("The connection was lost."),
    ).toBeInTheDocument();
    await waitFor(() => expect(approveButton("Analyst")).toBeEnabled());
    await userEvent.click(approveButton("Analyst"));
    await waitFor(() => expect(offerCards()).toHaveLength(1));
    await userEvent.click(approveButton("Writer"));
    await waitFor(() => expect(offerCards()).toHaveLength(0));

    const approvals = vi
      .mocked(mockApproveModelChoice)
      .mock.calls.map(([, turn, approval]) => ({ turn, ...approval }));
    expect(approvals.map(({ turn, offerId }) => [turn, offerId])).toEqual([
      ["turn-1", OFFER.offerId],
      ["turn-1", OFFER.offerId],
      ["turn-2", secondOffer.offerId],
    ]);
    const [first, again, other] = approvals.map(
      ({ idempotencyKey }) => idempotencyKey,
    );
    expect(first).toEqual(expect.any(String));
    expect(first?.length).toBeGreaterThan(0);
    expect(again).toBe(first);
    expect(other).toEqual(expect.any(String));
    expect(other?.length).toBeGreaterThan(0);
    expect(other).not.toBe(first);
  });

  it("a refused approval says why and still brings the conversation up to date", async () => {
    vi.mocked(mockApproveModelChoice).mockImplementationOnce(async () => {
      // The offer went stale on the server, which no longer shows it.
      serverTranscript = transcript([QUESTION]);
      throw new Error("The offer is no longer current.");
    });
    render(<ChatPanel session={SESSION} />);
    await userEvent.click(
      await screen.findByRole("button", { name: OFFER_BUTTON }),
    );

    expect(
      await screen.findByText("The offer is no longer current."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: OFFER_BUTTON }),
      ).not.toBeInTheDocument(),
    );
  });

  it("a title save reports its failure, and a later successful save clears it", async () => {
    const onSessionUpdated = vi.fn();
    vi.mocked(mockUpdateSessionTitle)
      .mockRejectedValueOnce(new Error("The title could not be saved."))
      .mockResolvedValueOnce({ ...SESSION, title: "Alpha review" });
    render(<ChatPanel session={SESSION} onSessionUpdated={onSessionUpdated} />);
    await screen.findByRole("button", { name: OFFER_BUTTON });

    fireEvent.click(screen.getByRole("button", { name: "Edit session title" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Session title" }), {
      target: { value: "Alpha review" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save session title" }));
    expect(
      await screen.findByText("The title could not be saved."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save session title" }));
    await waitFor(() =>
      expect(onSessionUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Alpha review" }),
      ),
    );
    expect(
      screen.queryByText("The title could not be saved."),
    ).not.toBeInTheDocument();
  });
});
