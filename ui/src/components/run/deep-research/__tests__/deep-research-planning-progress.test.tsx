import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeepResearchPlanningAttemptSnapshot } from "@/lib/models/session-model";

import { DeepResearchPlanningProgress } from "../deep-research-planning-progress";

describe("DeepResearchPlanningProgress", () => {
  afterEach(cleanup);

  it("shows durable phases and elapsed time without invented completion estimates", () => {
    render(
      <DeepResearchPlanningProgress
        amendment={false}
        cancellationPending={false}
        attempt={attempt({
          phase: "validating_draft",
          status: "running",
        })}
        onRetry={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Preparing your research plan" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Checking scope, tasks, and limits"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Advanced quality review")).not.toBeInTheDocument();
    expect(screen.getByText(/elapsed/u)).toBeInTheDocument();
    expect(screen.queryByText(/minute or two|% complete/u)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Planning continues on the backend/u),
    ).toBeInTheDocument();
  });

  it("does not flash the advanced review phase before the route is known", () => {
    render(
      <DeepResearchPlanningProgress
        amendment={false}
        cancellationPending={false}
        attempt={null}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.queryByText("Advanced quality review")).not.toBeInTheDocument();
  });

  it("announces retryable terminal failures and invokes retry", () => {
    const onRetry = vi.fn();
    render(
      <DeepResearchPlanningProgress
        amendment={false}
        cancellationPending={false}
        attempt={attempt({
          error: "Advanced quality review timed out.",
          errorCategory: "timeout",
          phase: "reviewing",
          retryable: true,
          route: "sol_validation_fallback",
          status: "failed",
        })}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole("alert")).toHaveFocus();
    expect(
      screen.getByText("Advanced quality review timed out."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("shows an exhausted quota with its reset and offers no retry", () => {
    render(
      <DeepResearchPlanningProgress
        amendment={false}
        cancellationPending={false}
        attempt={attempt({
          phase: "drafting",
          status: "failed",
          error:
            "You've hit your provider usage limit. It resets on Aug 19, 2026 at " +
            "11:32 PM. You can also add credits in your provider account to continue now.",
          retryable: false,
        })}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText(/usage limit/u)).toBeInTheDocument();
    expect(screen.getByText(/Aug 19, 2026 at 11:32 PM/u)).toBeInTheDocument();
    // Retrying before the stated reset cannot succeed, so the affordance that
    // invites it must not be rendered.
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
  });

  it("does not expose cancellation after a successful attempt", () => {
    render(
      <DeepResearchPlanningProgress
        amendment={false}
        cancellationPending={false}
        attempt={attempt({
          phase: "ready",
          status: "succeeded",
        })}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });
});

function attempt(
  overrides: Partial<DeepResearchPlanningAttemptSnapshot> = {},
): DeepResearchPlanningAttemptSnapshot {
  const now = "2026-07-25T12:00:00.000Z";
  return {
    schemaVersion: 3,
    attemptId: "attempt-1",
    planningRevisionId: "planning-revision-1",
    expectedPlanId: "run-plan-1",
    revision: 0,
    retryCount: 0,
    status: "queued",
    phase: "accepted",
    route: "terra_only",
    createdAt: now,
    updatedAt: now,
    stages: {},
    candidates: {},
    findings: [],
    ...overrides,
  };
}
