import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import { SidebarItemButton } from "@/components/sidebar/sidebar-item-button";

test("sidebar auxiliary action is accessible and does not select or delete the row", async () => {
  const onClick = vi.fn();
  const onAuxiliaryAction = vi.fn();
  const onDelete = vi.fn();
  const user = userEvent.setup();
  render(
    <SidebarItemButton
      label="Launch research"
      onClick={onClick}
      onAuxiliaryAction={onAuxiliaryAction}
      auxiliaryActionLabel="Add Launch research to project"
      onDelete={onDelete}
    />,
  );

  await user.click(
    screen.getByRole("button", { name: "Add Launch research to project" }),
  );
  expect(onAuxiliaryAction).toHaveBeenCalledOnce();
  expect(onClick).not.toHaveBeenCalled();
  expect(onDelete).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Delete Launch research" }));
  expect(onDelete).toHaveBeenCalledOnce();
  expect(onClick).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Launch research" }));
  expect(onClick).toHaveBeenCalledOnce();
});
