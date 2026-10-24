import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PlannedAgentInternetAccess } from "../planned-agent-internet-access";

it("names the internet switch with the same readable Agent name as its label", () => {
  render(<PlannedAgentInternetAccess
    agent={{ name: "product-reviewer", role: "Reviewer", description: "Reviews products.", rationale: "Needs current sources." }}
    showName onWebResearchChange={vi.fn()}
  />);
  expect(screen.getByText("Internet access for Product Reviewer")).toBeVisible();
  expect(screen.getByRole("switch", { name: "Enable internet access for Product Reviewer" })).toBeEnabled();
});
