import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  WorkspaceRightSidebarContent,
  WorkspaceRightSidebarProvider,
} from "@/components/sidebar/workspace-right-sidebar";

describe("WorkspaceRightSidebarContent", () => {
  it("ports active workspace content into the shell target", () => {
    const target = document.createElement("div");
    target.dataset.testid = "right-sidebar-target";
    document.body.appendChild(target);

    render(
      <WorkspaceRightSidebarProvider target={target}>
        <WorkspaceRightSidebarContent>
          <div>Context inspector</div>
        </WorkspaceRightSidebarContent>
      </WorkspaceRightSidebarProvider>,
    );

    expect(target).toHaveTextContent("Context inspector");
    target.remove();
  });

  it("renders inline for isolated feature tests and omits inactive content", () => {
    const { rerender } = render(
      <WorkspaceRightSidebarContent>
        <div>Inline inspector</div>
      </WorkspaceRightSidebarContent>,
    );

    expect(screen.getByText("Inline inspector")).toBeInTheDocument();

    rerender(
      <WorkspaceRightSidebarContent active={false}>
        <div>Inline inspector</div>
      </WorkspaceRightSidebarContent>,
    );

    expect(screen.queryByText("Inline inspector")).not.toBeInTheDocument();
  });
});
