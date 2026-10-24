import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import { SidebarDeleteDialog } from "@/components/sidebar/sidebar-delete-dialog";

test("allows Run session deletion confirmation to be disabled", async () => {
  const onConfirm = vi.fn();
  const user = userEvent.setup();

  render(
    <SidebarDeleteDialog
      target={{ label: "session “Draft”", allowSkipConfirmation: true }}
      onConfirm={onConfirm}
      onOpenChange={vi.fn()}
    />,
  );

  expect(screen.getByText("Are you sure you want to delete session “Draft”?"))
    .toBeInTheDocument();
  await user.click(
    screen.getByRole("checkbox", {
      name: "Never ask again for session deletion",
    }),
  );
  await user.click(screen.getByRole("button", { name: "Yes, delete" }));

  expect(onConfirm).toHaveBeenCalledWith(true);
});

test("keeps the skip-confirmation option out of Create deletion dialogs", () => {
  render(
    <SidebarDeleteDialog
      target={{ label: "agent “Researcher”", allowSkipConfirmation: false }}
      onConfirm={vi.fn()}
      onOpenChange={vi.fn()}
    />,
  );

  expect(screen.getByText("Delete agent “Researcher”?")).toBeInTheDocument();
  expect(
    screen.queryByRole("checkbox", {
      name: "Never ask again for session deletion",
    }),
  ).not.toBeInTheDocument();
});
