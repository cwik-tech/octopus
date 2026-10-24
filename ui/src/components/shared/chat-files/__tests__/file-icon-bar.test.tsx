import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { SessionFile } from "@/lib/models/session-model";

import { fileCardAnchorId, scrollToFileCard } from "../file-card-anchor";
import { FileIconBar } from "../file-icon-bar";
import type { FileTimelineItem } from "../use-file-upload-controller";

const makeSessionFile = (name: string): SessionFile => ({
  name,
  size: 100,
  uploadedAt: "2026-08-03T10:00:00.000Z",
  parseStatus: "parsed",
});

const makeItem = (
  filename: string,
  state: FileTimelineItem["state"],
): FileTimelineItem => ({
  key: `file:s1:${filename}:2026-08-03T10:00:00.000Z`,
  ownerId: "s1",
  filename,
  size: 100,
  occurredAt: "2026-08-03T10:00:00.000Z",
  state,
  file: state === "current" ? makeSessionFile(filename) : undefined,
});

describe("FileIconBar", () => {
  it("renders current files only", () => {
    render(
      <FileIconBar
        items={[
          makeItem("a.txt", "current"),
          makeItem("uploading.txt", "uploading"),
          makeItem("bad.txt", "error"),
        ]}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Scroll to a.txt" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Scroll to uploading.txt" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Scroll to bad.txt" }),
    ).not.toBeInTheDocument();
  });

  it("renders nothing when there are no current files", () => {
    const { container } = render(
      <FileIconBar items={[makeItem("bad.txt", "error")]} />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("scrolls to the matching card anchor when an icon is clicked", () => {
    const scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;

    const item = makeItem("a.txt", "current");
    render(
      <>
        <FileIconBar items={[item]} />
        <div id={fileCardAnchorId(item.key)} data-testid="card-anchor" />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Scroll to a.txt" }));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("shows the filename in the shared tooltip instead of a native title", async () => {
    const user = userEvent.setup();
    render(<FileIconBar items={[makeItem("a report.pdf", "current")]} />);

    const trigger = screen.getByRole("button", {
      name: "Scroll to a report.pdf",
    });
    expect(trigger).not.toHaveAttribute("title");

    await user.hover(trigger);
    expect(await screen.findByText("a report.pdf")).toBeInTheDocument();
    expect(
      document.querySelector('[data-slot="tooltip-content"]'),
    ).toHaveTextContent("a report.pdf");
  });
});

describe("file-card-anchor", () => {
  it("produces stable DOM-safe anchor ids per item key", () => {
    const key = "file:s1:a report.txt:2026-08-03T10:00:00.000Z";
    expect(fileCardAnchorId(key)).toBe(fileCardAnchorId(key));
    expect(fileCardAnchorId(key)).toMatch(/^file-card-[A-Za-z0-9_-]+$/);
  });

  it("keeps punctuation-distinct item keys on distinct anchors", () => {
    expect(fileCardAnchorId("file:s1:a/b.txt:t")).not.toBe(
      fileCardAnchorId("file:s1:a?b.txt:t"),
    );
  });

  it("does not throw when no card anchor exists", () => {
    expect(() => scrollToFileCard("file:s1:missing.txt:t")).not.toThrow();
  });
});
