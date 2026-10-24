import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AgentArchitectPanel from "@/components/create/agent-architect-panel";
import {
  listAgents,
  readAgentPersona,
  saveAgentPersona,
} from "@/lib/clients/agent-generator-client";
import { fetchChatDefaults } from "@/lib/clients/chat-defaults-client";

vi.mock("@/components/create/agent-package-editor", () => ({
  default: ({
    onPersonaChange,
    onSave,
    personaMarkdown,
  }: {
    onPersonaChange: (value: string) => void;
    onSave: (personaMarkdown?: string) => Promise<void> | void;
    personaMarkdown: string | null;
  }) => (
    <div>
      <div data-testid="persona-markdown">{personaMarkdown}</div>
      <button
        type="button"
        onClick={() =>
          onPersonaChange(
            [
              "---",
              "provider: anthropic",
              "model: claude-sonnet-4-6",
              "---",
              "",
              "# Analyst",
            ].join("\n"),
          )
        }
      >
        Change model
      </button>
      <button type="button" onClick={() => void onSave()}>
        Save agent
      </button>
      <button
        type="button"
        onClick={() => {
          // What the header's model picker does: the change and its save go
          // out together, before the new markdown has reached the panel.
          const next = "---\nprovider: openai\nmodel: gpt-5.5\n---\n\n# Analyst";
          onPersonaChange(next);
          void onSave(next);
        }}
      >
        Pick model and save
      </button>
    </div>
  ),
}));

vi.mock("@/components/create/skills-tree-picker", () => ({
  default: () => <div>Skills</div>,
}));

vi.mock("@/components/create/workflow-generator-chat", () => ({
  default: () => <div>Agent chat</div>,
}));

vi.mock("@/lib/clients/chat-defaults-client", () => ({
  fetchChatDefaults: vi.fn(() =>
    Promise.resolve({
      agent: { model: "gpt-5.4", provider: "openai" },
      run: { model: "gpt-5.4", provider: "openai" },
      team: { model: "gpt-5.4", provider: "openai" },
      workflow: { model: "gpt-5.4", provider: "openai" },
    }),
  ),
}));

vi.mock("@/lib/clients/agent-generator-client", () => ({
  cancelAgentJob: vi.fn(),
  commitAgent: vi.fn(),
  commitAgentPackageImport: vi.fn(),
  draftAgent: vi.fn(),
  listAgents: vi.fn(),
  previewAgentPackageImport: vi.fn(),
  readAgentPersona: vi.fn(),
  refineAgent: vi.fn(),
  removeAgentPackageItem: vi.fn(),
  revealAgentAsset: vi.fn(),
  saveAgentPersona: vi.fn(),
}));

describe("AgentArchitectPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAgents).mockResolvedValue([]);
    vi.mocked(readAgentPersona).mockResolvedValue({
      agentPath: "agents/analyst",
      assets: [],
      counts: {
        experience: 0,
        knowledge: 0,
        other: 0,
        references: 0,
        scripts: 0,
        skills: 0,
        templates: 0,
      },
      frontmatter: {
        model: "gpt-5.4",
        provider: "openai",
      },
      model: "gpt-5.4",
      name: "analyst",
      personaMarkdown: [
        "---",
        "provider: openai",
        "model: gpt-5.4",
        "---",
        "",
        "# Analyst",
      ].join("\n"),
      personaPath: "agents/analyst/analyst.md",
      provider: "openai",
      skillDetails: [],
      skills: [],
      usedInTeams: [],
    });
    vi.mocked(saveAgentPersona).mockResolvedValue({
      personaPath: "agents/analyst/analyst.md",
    });
  });

  it("refreshes resource summaries after saving a model change", async () => {
    const user = userEvent.setup();
    const onResourcesChanged = vi.fn(async () => {});
    render(
      <AgentArchitectPanel
        agentSelectionRequest={{ agentName: "analyst", id: "selection-1" }}
        onResourcesChanged={onResourcesChanged}
      />,
    );

    expect(await screen.findByText("Change model")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change model" }));
    await user.click(screen.getByRole("button", { name: "Save agent" }));

    await waitFor(() => {
      const saved = vi.mocked(saveAgentPersona).mock.lastCall?.[0];
      expect(saved?.agentName).toBe("analyst");
      expect(saved?.personaMarkdown).toContain("model: claude-sonnet-4-6");
      expect(onResourcesChanged).toHaveBeenCalledOnce();
    });
  });

  it("saves a picked model straight away and leaves nothing unsaved", async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    render(
      <AgentArchitectPanel
        agentSelectionRequest={{ agentName: "analyst", id: "selection-1" }}
        onDirtyChange={onDirtyChange}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Pick model and save" }),
    );

    await waitFor(() => {
      const saved = vi.mocked(saveAgentPersona).mock.lastCall?.[0];
      expect(saved?.agentName).toBe("analyst");
      expect(saved?.personaMarkdown).toContain("model: gpt-5.5");
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    });
  });

  it("reports unsaved persona edits to the inspector owner", async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    render(
      <AgentArchitectPanel
        agentSelectionRequest={{ agentName: "analyst", id: "selection-1" }}
        onDirtyChange={onDirtyChange}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Change model" }));

    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it("preserves unsaved persona edits when the selection request object is recreated", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <AgentArchitectPanel
        agentSelectionRequest={{ agentName: "analyst", id: "selection-1" }}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Change model" }));
    expect(screen.getByTestId("persona-markdown")).toHaveTextContent(
      "provider: anthropic",
    );

    // The app shell re-renders on unrelated state (e.g. the Run sidebar's
    // session poll) and recreates the request object; that is not a new
    // selection and must not reload the saved persona over the edits.
    rerender(
      <AgentArchitectPanel
        agentSelectionRequest={{ agentName: "analyst", id: "selection-1" }}
      />,
    );

    expect(readAgentPersona).toHaveBeenCalledOnce();
    expect(screen.getByTestId("persona-markdown")).toHaveTextContent(
      "provider: anthropic",
    );
  });

  it("does not initialize hidden chat state in details-only mode", async () => {
    render(
      <AgentArchitectPanel
        detailsOnly
        agentSelectionRequest={{ agentName: "analyst", id: "selection-1" }}
      />,
    );

    await waitFor(() => expect(readAgentPersona).toHaveBeenCalledOnce());
    expect(fetchChatDefaults).not.toHaveBeenCalled();
    expect(listAgents).not.toHaveBeenCalled();
  });

  it("renders the inspector without a card around it", async () => {
    const { container } = render(
      <AgentArchitectPanel
        detailsOnly
        agentSelectionRequest={{ agentName: "analyst", id: "selection-1" }}
      />,
    );

    expect(await screen.findByTestId("persona-markdown")).toBeInTheDocument();
    expect(container.querySelector('[data-slot="panel-card"]')).toBeNull();
  });
});
