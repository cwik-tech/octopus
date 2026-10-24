import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  AgentIdentity,
} from "../agent-identity";
import {
  agentInitials,
  formatAgentDisplayName,
} from "../agent-identity-model";

describe("agent identity", () => {
  it("uses two leading letters for one-word names and initials for compound names", () => {
    expect(agentInitials("pragmatist")).toBe("PR");
    expect(agentInitials("Client Lens")).toBe("CL");
    expect(agentInitials("domain-researcher")).toBe("DR");
    expect(agentInitials("problem_decomposer")).toBe("PD");
  });

  it("formats stored agent ids for display", () => {
    expect(formatAgentDisplayName("domain-researcher")).toBe(
      "Domain Researcher",
    );
    expect(formatAgentDisplayName("pragmatist")).toBe("Pragmatist");
  });

  it("applies one identity color to both the avatar and label", () => {
    render(
      <AgentIdentity
        colorClass="text-violet-600 dark:text-violet-400"
        name="pragmatist"
        secondary="Participant · complete"
      />,
    );

    expect(screen.getByText("PR")).toHaveClass(
      "border-violet-500/40",
      "text-violet-600",
    );
    expect(screen.getByText("Pragmatist").parentElement).toHaveClass(
      "text-violet-600",
    );
    expect(screen.getByText("Participant · complete")).toBeInTheDocument();
  });

  it("shows the runtime provider after the display name with its model tooltip", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AgentIdentity
        model="gpt-5.4"
        name="domain-researcher"
        provider="openai"
      />,
    );

    expect(screen.getByText("Domain Researcher")).toBeInTheDocument();
    expect(
      container.querySelector('[data-provider-logo="openai"]'),
    ).toBeInTheDocument();
    await user.hover(screen.getByLabelText("Model: gpt-5.4"));
    expect(await screen.findByText("gpt-5.4")).toBeInTheDocument();
  });
});
