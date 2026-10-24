import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ResizableRightSheetContent } from "@/components/ui/resizable-right-sheet";
import { Sheet } from "@/components/ui/sheet";

describe("ResizableRightSheetContent", () => {
  it("shares pointer resizing and removes the handle while closed", () => {
    const { rerender } = render(
      <Sheet open onOpenChange={() => undefined}>
        <ResizableRightSheetContent
          defaultWidth={600}
          open
          resizeLabel="Resize test sheet"
        >
          Sheet content
        </ResizableRightSheetContent>
      </Sheet>,
    );

    const handle = screen.getByRole("button", { name: "Resize test sheet" });
    const sheet = handle.parentElement;
    expect(sheet).toHaveStyle({ width: "600px" });

    fireEvent.pointerDown(handle, { clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 400 });
    fireEvent.pointerUp(window);
    expect(sheet).toHaveStyle({ width: "700px" });

    rerender(
      <Sheet open={false} onOpenChange={() => undefined}>
        <ResizableRightSheetContent
          defaultWidth={600}
          open={false}
          resizeLabel="Resize test sheet"
        >
          Sheet content
        </ResizableRightSheetContent>
      </Sheet>,
    );

    expect(
      screen.queryByRole("button", { name: "Resize test sheet" }),
    ).not.toBeInTheDocument();
  });

  it("carries the shell class the app's scrollbar styling is scoped to", () => {
    render(
      <Sheet open onOpenChange={() => undefined}>
        <ResizableRightSheetContent open resizeLabel="Resize test sheet">
          Sheet content
        </ResizableRightSheetContent>
      </Sheet>,
    );

    const sheet = screen.getByRole("button", { name: "Resize test sheet" })
      .parentElement;
    expect(sheet).toHaveClass("desktop-shell");
  });
});
