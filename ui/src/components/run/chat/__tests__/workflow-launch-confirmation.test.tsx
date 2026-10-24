import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkflowLaunchConfirmation } from "@/components/run/chat/workflow-launch-confirmation";

describe("WorkflowLaunchConfirmation", () => {
  it("shows the selected workflow and begins once", () => {
    const onBegin = vi.fn();

    render(
      <WorkflowLaunchConfirmation
        canBegin
        confirmationId="plan-1"
        isStarting={false}
        onBegin={onBegin}
        summary="The discussion brief is ready."
        workflowId="discussion-to-writing3"
      />,
    );

    expect(
      screen.getByRole("group", { name: "Workflow ready to begin" }),
    ).toHaveClass("bg-secondary");
    expect(
      screen.getByRole("group", { name: "Workflow ready to begin" }),
    ).toHaveTextContent("The discussion brief is ready.");
    expect(screen.getByText("Discussion To Writing3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Begin workflow" }));
    expect(onBegin).toHaveBeenCalledTimes(1);
  });

  it("keeps the confirmation visible and disabled while starting", () => {
    render(
      <WorkflowLaunchConfirmation
        canBegin={false}
        confirmationId="plan-1"
        isStarting
        onBegin={vi.fn()}
        workflowId="discussion-to-writing3"
      />,
    );

    expect(screen.getByTestId("workflow-launch-confirmation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
  });
});
