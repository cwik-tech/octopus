import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import PersonaMarkdownEditor from "@/components/create/persona-markdown-editor";

describe("PersonaMarkdownEditor", () => {
  it("sizes the line-number gutter from the visible digit count", () => {
    const threeDigitValue = Array.from({ length: 149 }, (_, index) => `${index + 1}`)
      .join("\n");
    const fourDigitValue = Array.from({ length: 1000 }, (_, index) => `${index + 1}`)
      .join("\n");
    const { rerender } = render(
      <PersonaMarkdownEditor
        value={threeDigitValue}
        onChange={vi.fn()}
        diff={null}
      />,
    );

    expect(screen.getByTestId("persona-editor-gutter")).toHaveStyle({
      width: "calc(3ch + 11px)",
    });

    rerender(
      <PersonaMarkdownEditor
        value={fourDigitValue}
        onChange={vi.fn()}
        diff={null}
      />,
    );

    expect(screen.getByTestId("persona-editor-gutter")).toHaveStyle({
      width: "calc(4ch + 11px)",
    });
  });

  it("draws line numbers with no background and no left border", () => {
    render(
      <PersonaMarkdownEditor value={"a\nb"} onChange={vi.fn()} diff={null} />,
    );

    const gutter = screen.getByTestId("persona-editor-gutter");
    expect(gutter.className).not.toMatch(/\bbg-/);
    expect(gutter.className).not.toMatch(/\bborder-r\b/);
  });

  it("frames only the text, leaving the line numbers outside the border", () => {
    render(
      <PersonaMarkdownEditor value={"a\nb"} onChange={vi.fn()} diff={null} />,
    );

    const frame = screen.getByLabelText("Persona markdown").parentElement!;
    // Now that the numbers sit outside it, the frame is a whole box with
    // every corner rounded.
    expect(frame).toHaveClass("border", "rounded-lg");
    expect(frame).not.toHaveClass("border-l-0");
    expect(frame).not.toContainElement(
      screen.getByTestId("persona-editor-gutter"),
    );
  });

  it("starts each gutter row with its number, with nothing to its left", () => {
    render(
      <PersonaMarkdownEditor value={"a\nb"} onChange={vi.fn()} diff={null} />,
    );

    const firstRow = screen.getByTestId("persona-editor-gutter")
      .firstElementChild!.firstElementChild!;
    expect(firstRow.firstElementChild).toHaveTextContent("1");
    expect(firstRow.className).not.toMatch(/\bpl-/);
  });

  it("reports leaving the editor", () => {
    const onBlur = vi.fn();
    render(
      <PersonaMarkdownEditor
        value="a"
        onChange={vi.fn()}
        onBlur={onBlur}
        diff={null}
      />,
    );

    fireEvent.blur(screen.getByLabelText("Persona markdown"));

    expect(onBlur).toHaveBeenCalledTimes(1);
  });
});
