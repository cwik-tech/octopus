import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { HealthBadge } from "@/components/ui/health-badge";
import type { Diagnostic, HealthSummary } from "@contracts/health";

/**
 * The one badge every agent row, Team row, and model picker draws.
 *
 * Before it there were three: a red circle-with-a-cross for agents, a red
 * circle-with-an-exclamation for Teams, and a third with a green tick for the
 * agent editor — plus two different oranges for the same idea. The contract
 * here is that severity alone decides the drawing, and that whatever is wrong
 * is readable rather than implied by a colour.
 */

function diagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    severity: "error",
    kind: "billing",
    message: "Agent 'crypto-analyst' (openai): quota exhausted. Check billing.",
    subject: { agentName: "crypto-analyst", provider: "openai" },
    ...overrides,
  };
}

function summary(overrides: Partial<HealthSummary> = {}): HealthSummary {
  return { status: "error", diagnostics: [diagnostic()], ...overrides };
}

describe("HealthBadge", () => {
  it("reports an issue when any diagnostic is an error, whatever else is wrong", () => {
    render(
      <HealthBadge
        subject="Agent"
        summary={summary({
          diagnostics: [
            diagnostic({ severity: "warning", message: "Roster drift." }),
            diagnostic(),
          ],
        })}
      />,
    );

    const badge = screen.getByRole("img", { name: "Agent issue" });
    expect(badge).toHaveAttribute("data-health-status", "error");
  });

  it("reports a warning when nothing is worse than a warning", () => {
    render(
      <HealthBadge
        subject="Team"
        summary={summary({
          status: "warning",
          diagnostics: [
            diagnostic({
              severity: "warning",
              kind: "structure",
              message: "Roster member 'editor' is used by no stage.",
            }),
          ],
        })}
      />,
    );

    const badge = screen.getByRole("img", { name: "Team warning" });
    expect(badge).toHaveAttribute("data-health-status", "warning");
  });

  it("stays quiet about a state it could not determine", () => {
    render(
      <HealthBadge
        subject="Agent"
        summary={summary({
          status: "unknown",
          diagnostics: [
            diagnostic({
              severity: "warning",
              kind: "config",
              message: "Agent 'drafter': declares no provider and model.",
            }),
          ],
        })}
      />,
    );

    const badge = screen.getByRole("img", { name: "Agent status unknown" });
    expect(badge).toHaveAttribute("data-health-status", "unknown");
  });

  it("draws nothing at all when there is nothing wrong", () => {
    const { container } = render(
      <HealthBadge
        subject="Team"
        summary={{ status: "ok", diagnostics: [] }}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("names every diagnostic in its own tooltip when it owns one", async () => {
    const user = userEvent.setup();
    render(
      <HealthBadge
        subject="Agent"
        tooltip
        summary={summary({
          diagnostics: [
            diagnostic(),
            diagnostic({
              severity: "warning",
              kind: "rate_limit",
              message: "Agent 'crypto-analyst' (openai): too many requests.",
            }),
          ],
        })}
      />,
    );

    await user.hover(screen.getByRole("img", { name: "Agent issue" }));

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(
      "Agent 'crypto-analyst' (openai): quota exhausted. Check billing.",
    );
    expect(tooltip).toHaveTextContent(
      "Agent 'crypto-analyst' (openai): too many requests.",
    );
  });

  it("says a check is still running rather than guessing its outcome", () => {
    render(<HealthBadge subject="Agent" loading summary={undefined} />);

    expect(
      screen.getByRole("img", { name: "Checking Agent status" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /issue/ })).not.toBeInTheDocument();
  });

  it("shows the state in words where a row label cannot carry it", () => {
    render(
      <HealthBadge
        subject="Provider"
        showLabel
        summary={{ status: "ok", diagnostics: [] }}
      />,
    );

    expect(screen.getByText("Available")).toBeInTheDocument();
  });

  it("puts the state in its tooltip instead of beside the icon when asked", async () => {
    const user = userEvent.setup();
    render(
      <HealthBadge
        subject="Provider"
        tooltip
        stateInTooltip
        summary={{ status: "ok", diagnostics: [] }}
      />,
    );

    expect(screen.queryByText("Available")).not.toBeInTheDocument();
    await user.hover(screen.getByRole("img", { name: "Provider available" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Provider available",
    );
  });
});

describe("a row that delegates its accessible name to the badge", () => {
  it("hands back the status name and the reasons as one description", async () => {
    const { healthRowStatus } = await import("@/components/ui/health-badge");

    expect(
      healthRowStatus(
        summary({
          status: "warning",
          diagnostics: [
            diagnostic({ severity: "warning", message: "First reason." }),
            diagnostic({ severity: "warning", message: "Second reason." }),
          ],
        }),
        "Team",
      ),
    ).toEqual({
      name: "Team warning",
      description: "First reason. Second reason.",
    });
  });

  it("asks for no row status at all when the subject is healthy", async () => {
    const { healthRowStatus } = await import("@/components/ui/health-badge");

    expect(
      healthRowStatus({ status: "ok", diagnostics: [] }, "Team"),
    ).toBeUndefined();
  });
});

// Guards against a regression that would make the badge silently unclickable
// scaffolding: the icon must stay reachable by keyboard when it owns a tooltip.
it("lets a keyboard reach a badge that owns its tooltip", async () => {
  const user = userEvent.setup();
  render(
    <HealthBadge subject="Team" tooltip summary={summary({ status: "error" })} />,
  );

  await user.tab();

  expect(screen.getByRole("img", { name: "Team issue" })).toHaveFocus();
});
