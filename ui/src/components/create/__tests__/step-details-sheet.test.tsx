import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import StepDetailsSheet from "@/components/create/step-details-sheet";
import { revealGeneratorArtifact } from "@/lib/clients/workflow-generator-client";
import type { StepDraft, WorkflowDraft } from "@/lib/models/workflow-generator-model";

vi.mock("@/components/create/workflow-diagram", () => ({
  default: () => <div data-testid="workflow-diagram" />,
}));

vi.mock("@/lib/clients/workflow-generator-client", () => ({
  revealGeneratorArtifact: vi.fn(),
}));

function makeStep(overrides: Partial<StepDraft> & Pick<StepDraft, "id">): StepDraft {
  return {
    type: "team",
    team: "writing-team",
    input_artifact: "input.md",
    result_artifact: "result.md",
    ...overrides,
  };
}

const researchStep = makeStep({
  id: "research",
  team: "research-team",
  input_artifact: "brief.md",
  result_artifact: "research.md",
});
const draftReviewStep = makeStep({
  id: "draft-review",
  team: "writing-team",
  input_artifact: "research.md",
  result_artifact: "draft.md",
});
const publishStep = makeStep({
  id: "publish",
  team: "publishing-team",
  input_artifact: "draft.md",
  result_artifact: "launch.md",
});

function makeDraft(overrides: Partial<WorkflowDraft> = {}): WorkflowDraft {
  return {
    id: "launch-plan",
    description: "Plan a product launch.",
    input: { artifact: "brief.md" },
    steps: [researchStep, draftReviewStep, publishStep],
    output: { from_step: "publish", artifact: "launch.md" },
    on_blocked: "stop",
    on_failed: "stop",
    ...overrides,
  };
}

interface Selection {
  selectedStepId?: string | null;
}

function sheetElement(draft: WorkflowDraft | null, selection: Selection) {
  return (
    <StepDetailsSheet
      draft={draft}
      open
      registry={null}
      registryError={null}
      onOpenChange={() => undefined}
      {...selection}
    />
  );
}

function renderSheet(draft: WorkflowDraft | null, selection: Selection = {}) {
  return render(sheetElement(draft, selection));
}

describe("StepDetailsSheet step selection", () => {
  beforeEach(() => {
    vi.mocked(revealGeneratorArtifact).mockReset();
  });

  it("shows the selected step's name, team, files, and position in the workflow", () => {
    renderSheet(makeDraft(), { selectedStepId: "draft-review" });

    expect(
      screen.getByRole("heading", { level: 2, name: "Step Draft Review" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Writing Team")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "research.md" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "draft.md" })).toBeInTheDocument();
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    expect(
      screen.getByText("This chained step has no explicit handoff block."),
    ).toBeInTheDocument();
  });

  it("places the first step at position 1 without flagging a missing handoff", () => {
    renderSheet(makeDraft(), { selectedStepId: "research" });

    expect(screen.getByRole("heading", { level: 2, name: "Step Research" })).toBeInTheDocument();
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    expect(
      screen.queryByText("This chained step has no explicit handoff block."),
    ).not.toBeInTheDocument();
  });

  it("places the last step at the final position and marks it as the final output", () => {
    renderSheet(makeDraft(), { selectedStepId: "publish" });

    expect(screen.getByRole("heading", { level: 2, name: "Step Publish" })).toBeInTheDocument();
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
  });

  it("shows the workflow overview when the selected step id matches no step", () => {
    renderSheet(makeDraft(), { selectedStepId: "missing-step" });

    expect(
      screen.getByRole("heading", { level: 2, name: "Workflow Launch Plan" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Plan a product launch.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This workflow runs 3 steps: Research, then Draft Review, then Publish.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Position")).not.toBeInTheDocument();
  });

  const emptySelections: Array<[string, Selection]> = [
    ["null", { selectedStepId: null }],
    ["omitted", {}],
    ["an empty string", { selectedStepId: "" }],
  ];

  it.each(emptySelections)(
    "shows the workflow overview when the selection is %s",
    (_label, selection) => {
      renderSheet(makeDraft(), selection);

      expect(
        screen.getByRole("heading", { level: 2, name: "Workflow Launch Plan" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "This workflow runs 3 steps: Research, then Draft Review, then Publish.",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText("Position")).not.toBeInTheDocument();
    },
  );

  it("returns to the workflow overview when a new draft drops the selected step", () => {
    const { rerender } = renderSheet(makeDraft(), { selectedStepId: "draft-review" });
    expect(
      screen.getByRole("heading", { level: 2, name: "Step Draft Review" }),
    ).toBeInTheDocument();

    rerender(
      sheetElement(makeDraft({ steps: [researchStep, publishStep] }), {
        selectedStepId: "draft-review",
      }),
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "Workflow Launch Plan" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("This workflow runs 2 steps: Research, then Publish."),
    ).toBeInTheDocument();
  });

  it("shows the zero-step workflow overview when a step is selected in an empty workflow", () => {
    renderSheet(makeDraft({ steps: [] }), { selectedStepId: "research" });

    expect(
      screen.getByRole("heading", { level: 2, name: "Workflow Launch Plan" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("This workflow runs 0 steps: no steps."),
    ).toBeInTheDocument();
  });

  it("shows the no-workflow state when a step is selected but no draft is loaded", () => {
    renderSheet(null, { selectedStepId: "research" });

    expect(
      screen.getByRole("heading", { level: 2, name: "Workflow preview" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Select a workflow to inspect.")).toBeInTheDocument();
    expect(screen.getByText("No workflow selected.")).toBeInTheDocument();
  });
});

describe("StepDetailsSheet step artifact links", () => {
  beforeEach(() => {
    vi.mocked(revealGeneratorArtifact).mockReset();
    vi.mocked(revealGeneratorArtifact).mockResolvedValue({ path: "/work/brief.md" });
  });

  it("reveals the workflow input file from the selected step's Artifact Flow", async () => {
    const user = userEvent.setup();
    renderSheet(makeDraft(), { selectedStepId: "draft-review" });

    await user.click(screen.getByRole("tab", { name: "Artifact Flow" }));
    const panel = screen.getByRole("tabpanel", { name: "Artifact Flow" });
    await user.click(within(panel).getByRole("button", { name: "brief.md" }));

    expect(vi.mocked(revealGeneratorArtifact)).toHaveBeenCalledWith({
      artifactPath: "brief.md",
    });
  });

  it("offers no reveal action for an empty workflow input in the selected step's Artifact Flow", async () => {
    const user = userEvent.setup();
    renderSheet(makeDraft({ input: { artifact: "" } }), {
      selectedStepId: "draft-review",
    });

    await user.click(screen.getByRole("tab", { name: "Artifact Flow" }));
    const panel = screen.getByRole("tabpanel", { name: "Artifact Flow" });

    expect(within(panel).getByText("Workflow starts with")).toBeInTheDocument();
    const revealTargets = within(panel)
      .getAllByRole("button")
      .map((button) => button.textContent)
      .sort();
    expect(revealTargets).toEqual([
      "draft.md",
      "draft.md",
      "research.md",
      "research.md",
    ]);
  });

  it("shows the step handoff files in the overview as plain text without reveal actions", () => {
    const handoffStep = makeStep({
      id: "publish",
      team: "publishing-team",
      input_artifact: "draft.md",
      result_artifact: "launch.md",
      handoff: {
        from_step: "draft-review",
        from_artifact: "draft.md",
        to_artifact: "final-draft.md",
      },
    });
    renderSheet(makeDraft({ steps: [researchStep, draftReviewStep, handoffStep] }), {
      selectedStepId: "publish",
    });

    expect(screen.getByText("draft-review: draft.md")).toBeInTheDocument();
    expect(screen.getByText("final-draft.md")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "draft-review: draft.md" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "final-draft.md" }),
    ).not.toBeInTheDocument();
  });
});
