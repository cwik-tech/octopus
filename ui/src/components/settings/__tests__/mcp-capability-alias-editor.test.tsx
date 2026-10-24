import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { McpCapabilityAliasEditor } from "@/components/settings/mcp-capability-alias-editor";

it("explains optional workflow capability matching in accessible tooltips", async () => {
  const user = userEvent.setup();

  render(
    <McpCapabilityAliasEditor
      aliases={[{
        id: "capability-1",
        capability: "web.search",
        access: "read",
      }]}
      onChange={vi.fn()}
    />,
  );

  expect(screen.getByText(
    "Optional labels used to match this connection to workflow requirements before a run. Most connections can leave this section empty.",
  )).toBeInTheDocument();

  await user.hover(screen.getByRole("button", { name: "Help: workflow matching" }));
  await waitFor(() => {
    expect(screen.getByText(/They are not MCP tool names and do not grant or restrict server permissions/))
      .toBeInTheDocument();
  });

  await user.unhover(screen.getByRole("button", { name: "Help: workflow matching" }));
  const capabilityNameHelp = screen.getByRole("button", { name: "Help: workflow capability labels" });
  await user.hover(capabilityNameHelp);
  await waitFor(() => {
    expect(document.querySelector('[data-slot="tooltip-content"]'))
      .toHaveTextContent("Enter the exact label used by the workflow");
  });
  await user.unhover(capabilityNameHelp);

  const capabilityAccessHelp = screen.getByRole("button", {
    name: "Help: workflow access matching",
  });
  await user.hover(capabilityAccessHelp);
  await waitFor(() => {
    expect(document.querySelector('[data-slot="tooltip-content"]'))
      .toHaveTextContent("matching metadata only; it does not enforce runtime permissions");
  });
  await user.unhover(capabilityAccessHelp);

  await user.tab();
  await user.tab();
  await user.tab();
  expect(capabilityNameHelp).toHaveFocus();
  expect(capabilityNameHelp).toHaveAttribute("data-popup-open");

  await user.tab();
  expect(capabilityAccessHelp).toHaveFocus();
  expect(capabilityAccessHelp).toHaveAttribute("data-popup-open");
});
