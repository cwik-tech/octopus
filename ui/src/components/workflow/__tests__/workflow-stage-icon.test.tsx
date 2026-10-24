import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  WorkflowStageIcon,
} from "../workflow-stage-icon";
import {
  isWorkflowStageType,
  WORKFLOW_STAGE_ICON_META,
  type WorkflowStageType,
} from "../workflow-stage-types";

const stageTypes: WorkflowStageType[] = [
  "routing",
  "discussion",
  "pipeline",
  "chain",
  "broadcast",
  "review",
];

describe("WorkflowStageIcon", () => {
  it.each(stageTypes)("renders an accessible %s SVG", (type) => {
    render(<WorkflowStageIcon type={type} />);

    expect(
      screen.getByRole("img", {
        name: `${WORKFLOW_STAGE_ICON_META[type].label} workflow`,
      }),
    ).toBeInTheDocument();
  });

  it("can be decorative beside a visible stage label", () => {
    const { container } = render(<WorkflowStageIcon type="review" decorative />);

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("recognizes only supported stage types", () => {
    expect(isWorkflowStageType("broadcast")).toBe(true);
    expect(isWorkflowStageType("future-stage")).toBe(false);
  });
});
