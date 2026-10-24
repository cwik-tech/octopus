/**
 * What a person is asked for when adding an existing Agent to a Team.
 *
 * The dialog used to make them pick a grade, defaulting to `strategic`. Nothing
 * reads a grade any more, so the control asked for a decision that changed
 * nothing and then wrote it into their team file. The dialog now asks for the
 * Agent and nothing else, and sends nothing else.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AddTeamAgentDialog } from "../add-team-agent-dialog";
import type { TeamEditorController } from "../use-team-editor";

function editorStub(addAgent: TeamEditorController["addAgent"]): TeamEditorController {
  return {
    saving: false,
    agents: [
      { name: "scoping-lawyer", type: "agent", role: "Scope.", tools: [], referenced: false },
    ],
    availableAgents: [{ name: "scoping-lawyer" }],
    addAgent,
  } as unknown as TeamEditorController;
}

describe("AddTeamAgentDialog", () => {
  it("offers no grade control", () => {
    render(
      <AddTeamAgentDialog
        open
        onOpenChange={vi.fn()}
        editor={editorStub(vi.fn())}
      />,
    );

    expect(screen.queryByLabelText("Agent tier")).toBeNull();
    expect(screen.queryByRole("option", { name: "strategic" })).toBeNull();
    // The dialog still does its actual job.
    expect(screen.getByText("Add agent")).toBeInTheDocument();
  });

  it("sends only the Agent that was chosen", async () => {
    const addAgent = vi.fn().mockResolvedValue(true);
    render(
      <AddTeamAgentDialog
        open
        onOpenChange={vi.fn()}
        editor={editorStub(addAgent)}
      />,
    );

    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(await screen.findByText("Scoping Lawyer"));
    await userEvent.click(screen.getByRole("button", { name: /^Add$/ }));

    await waitFor(() => expect(addAgent).toHaveBeenCalled());
    expect(addAgent.mock.calls[0]?.[0]).toEqual({ agentName: "scoping-lawyer" });
  });
});
