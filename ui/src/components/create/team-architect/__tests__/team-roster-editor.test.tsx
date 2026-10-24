import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TeamRosterEditor } from "../team-roster-editor";
import type { TeamEditorController } from "../use-team-editor";

// The roster reads the one application default from the catalog context, the
// same value the run reads.
vi.mock("@/contexts/provider-catalog-context", () => ({
  useProviderCatalog: () => ({
    groups: [],
    defaultModel: { provider: "openai", model: "gpt-5.5" },
    defaultModelState: {
      status: "available",
      provider: "openai",
      model: "gpt-5.5",
    },
    loading: false,
    error: null,
    refresh: async () => undefined,
  }),
}));

function member(name: string): Record<string, unknown> {
  return {
    name,
    type: "agent",
    role: `${name} role.`,
    tier: "strategic",
    tools: [],
    referenced: true,
  };
}

describe("TeamRosterEditor", () => {
  // The order members run in is part of what the team is. A saved team listed
  // them in whatever order they were added, which is not the order anything
  // happens in.
  it("lists a saved chain in the order it runs, and numbers the positions", () => {
    const editor = rosterEditorWithAgents(
      [member("risk-spotter"), member("risk-lead")],
      {
        shape: {
          kind: "chain",
          rationale: "this is how the team is set up now.",
          depth: "quick",
          order: ["risk-lead", "risk-spotter"],
        },
      },
    );

    renderRoster(editor);

    const names = screen
      .getAllByRole("listitem")
      .map((item) => item.textContent ?? "");
    expect(names[0]).toContain("Risk Lead");
    expect(names[1]).toContain("Risk Spotter");
    expect(names[0]).toContain("1");
    expect(names[1]).toContain("2");
  });

  // The order is not only something to read. A team that turned out to need a
  // different way of working can be told so, without being built again.
  it("offers to change how a saved team works together", async () => {
    const changeShape = vi.fn();
    const editor = {
      ...rosterEditorWithAgents([member("risk-lead"), member("risk-spotter")], {
        shape: {
          kind: "chain",
          rationale: "this is how the team is set up now.",
          depth: "quick",
          order: ["risk-lead", "risk-spotter"],
        },
      }),
      changeShape,
      shapeChangePending: false,
    } as unknown as TeamEditorController;

    renderRoster(editor);

    await userEvent.click(
      screen.getByRole("tab", { name: "Group discussion" }),
    );
    expect(changeShape).toHaveBeenCalledTimes(1);
  });

  // A team this app did not write has no shape to read and none to change.
  it("offers no change for a team whose shape it cannot read", () => {
    const editor = {
      ...rosterEditorWithAgents([member("risk-lead")]),
      changeShape: vi.fn(),
      shapeChangePending: false,
    } as unknown as TeamEditorController;

    renderRoster(editor);

    expect(
      screen.queryByRole("tablist", { name: "How they work together" }),
    ).not.toBeInTheDocument();
  });

  // A member the product keeps out of the UI is still on the team and still has
  // a part in how it works. The roster the user sees leaves them out; the roles
  // a change is built from must not, or the change describes a team that is
  // missing somebody and the server refuses it.
  it("builds a change from every member, including one the roster does not show", async () => {
    const changeShape = vi.fn();
    const editor = {
      ...rosterEditorWithAgents([member("risk-lead")], {
        shape: {
          kind: "discussion",
          rationale: "this is how the team is set up now.",
          depth: "standard",
          coordinator: "risk-lead",
          // On the team, and deliberately not in the list above.
          participants: ["risk-spotter"],
        },
      }),
      changeShape,
      shapeChangePending: false,
    } as unknown as TeamEditorController;

    renderRoster(editor);

    // The hidden member stays hidden.
    expect(screen.getAllByRole("listitem")).toHaveLength(1);

    await userEvent.click(
      screen.getByRole("tab", { name: "Draft and review" }),
    );

    expect(changeShape).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "review",
        producer: "risk-lead",
        reviewer: "risk-spotter",
      }),
    );
  });

  // A discussion has an order too, but not positions: later speakers see what
  // earlier ones said, and numbering it would read as a fixed sequence.
  it("lists a saved discussion in speaking order without numbering it", () => {
    const editor = rosterEditorWithAgents(
      [member("risk-spotter"), member("risk-lead")],
      {
        shape: {
          kind: "discussion",
          rationale: "this is how the team is set up now.",
          depth: "standard",
          coordinator: "risk-lead",
          participants: ["risk-spotter"],
        },
      },
    );

    renderRoster(editor);

    const names = screen
      .getAllByRole("listitem")
      .map((item) => item.textContent ?? "");
    expect(names[0]).toContain("Risk Lead");
    expect(names[1]).toContain("Risk Spotter");
    expect(names[0]).not.toMatch(/^1/u);
  });

  it("uses the effective provider logo and humanized agent name", () => {
    // An agent that names nothing runs on the application default, and that is
    // what the roster must show.
    const editor = rosterEditor({
      name: "vc-deal-evaluator",
      type: "agent",
      role: "Classifies the deal.",
      tier: "strategic",
      tools: [],
      referenced: true,
    });

    const { container } = renderRoster(editor);

    expect(screen.getByText("Agent Roster")).toBeInTheDocument();
    expect(screen.getByText("Vc Deal Evaluator")).toBeInTheDocument();
    expect(
      container.querySelector('[data-provider-logo="openai"]'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Model: gpt-5.5")).toBeInTheDocument();
  });

  it("keeps the model on the provider icon instead of badges under the card", () => {
    const editor = rosterEditor({
      name: "knowledge-product-architect",
      type: "agent",
      role: "Orchestration lead.",
      tier: "strategic",
      tools: [],
      referenced: true,
      personaProvider: "codex",
      personaModel: "gpt-5.6-sol",
    });

    renderRoster(editor);

    // The icon's hover label carries the agent's own pair. The card repeats
    // neither the pair nor where it came from.
    expect(screen.getByLabelText("Model: gpt-5.6-sol")).toBeInTheDocument();
    expect(screen.queryByText("Codex / gpt-5.6-sol")).not.toBeInTheDocument();
    expect(screen.queryByText("agent model")).not.toBeInTheDocument();
  });

  it("opens the agent when its card is clicked", async () => {
    const onOpenAgent = vi.fn();
    const editor = rosterEditor({
      name: "data-pipeline-engineer",
      type: "agent",
      role: "Owns batch and streaming ingestion.",
      tier: "strategic",
      tools: [],
      referenced: true,
    });

    const user = userEvent.setup();
    renderRoster(editor, { onOpenAgent });
    await user.click(screen.getByText("Owns batch and streaming ingestion."));

    expect(onOpenAgent).toHaveBeenCalledWith("data-pipeline-engineer");
  });

  it("removes an agent without opening it", async () => {
    const onOpenAgent = vi.fn();
    const editor = rosterEditor({
      name: "data-pipeline-engineer",
      type: "agent",
      role: "Owns batch and streaming ingestion.",
      tier: "strategic",
      tools: [],
      referenced: true,
    });

    const user = userEvent.setup();
    renderRoster(editor, { onOpenAgent });
    await user.click(
      screen.getByLabelText("Remove Data Pipeline Engineer from team roster"),
    );

    expect(editor.removeAgent).toHaveBeenCalledWith("data-pipeline-engineer");
    expect(onOpenAgent).not.toHaveBeenCalled();
  });

  it("marks an entry whose persona file is missing as unrunnable", () => {
    const editor = rosterEditor({
      name: "ghost",
      type: "agent",
      role: "Worker.",
      tier: "strategic",
      tools: [],
      referenced: true,
      agent_file: "../../agents/ghost/ghost.md",
      personaMissing: true,
    });

    renderRoster(editor);

    // The runtime drops this entry, so the roster must not offer a model as
    // though the agent would start on it.
    expect(
      screen.getByText("Persona missing — will not run"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Openai / gpt-5.5")).not.toBeInTheDocument();
    expect(screen.queryByText("app default")).not.toBeInTheDocument();
  });
});

function renderRoster(
  editor: TeamEditorController,
  props: { onOpenAgent?: (agentName: string) => void } = {},
) {
  return render(
    <TeamRosterEditor
      editor={editor}
      onOpenAddAgent={vi.fn()}
      onOpenAgent={props.onOpenAgent ?? vi.fn()}
    />,
  );
}

function rosterEditor(
  agent: Record<string, unknown>,
  detail: Record<string, unknown> = {},
): TeamEditorController {
  return {
    creating: false,
    detail: { agents: [agent], ...detail },
    removeAgent: vi.fn(),
    saving: false,
  } as unknown as TeamEditorController;
}

function rosterEditorWithAgents(
  agents: Record<string, unknown>[],
  detail: Record<string, unknown> = {},
): TeamEditorController {
  return {
    creating: false,
    detail: { agents, ...detail },
    removeAgent: vi.fn(),
    saving: false,
  } as unknown as TeamEditorController;
}
