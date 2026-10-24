import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SessionFile } from "@/lib/models/session-model";

import { FileMessageCard } from "../file-message-card";
import type { FileTimelineItem } from "../use-file-upload-controller";

const makeSessionFile = (
  name: string,
  overrides: Partial<SessionFile> = {},
): SessionFile => ({
  name,
  size: 2_048,
  uploadedAt: "2026-08-03T10:00:00.000Z",
  parseStatus: "parsed",
  ...overrides,
});

const makeItem = (overrides: Partial<FileTimelineItem> = {}): FileTimelineItem => ({
  key: "file:s1:a.txt:2026-08-03T10:00:00.000Z",
  ownerId: "s1",
  filename: "a.txt",
  size: 2_048,
  occurredAt: "2026-08-03T10:00:00.000Z",
  state: "current",
  file: makeSessionFile("a.txt"),
  ...overrides,
});

describe("FileMessageCard", () => {
  it('shows incomplete page coverage separately from a locked source revision', () => {
    render(<FileMessageCard item={makeItem({ file: makeSessionFile('a.txt', { usedAt: '2026-08-04T20:00:00.000Z', documentReview: { document: `doc_${'a'.repeat(64)}`, name: 'a.txt', revision: 'b'.repeat(64), state: 'partial', pageCoverage: 'known', reviewedPages: [1], unresolvedPages: [2], reviewedCharacters: 10, totalCharacters: 20 } }) })} />)
    expect(screen.getByText(/1\/2 pages processed.*incomplete/)).toBeInTheDocument()
    expect(screen.queryByText(/review complete/i)).not.toBeInTheDocument()
  })
  it("renders filename, size, and parse status for a current file", () => {
    render(<FileMessageCard item={makeItem()} />);

    expect(screen.getByText("a.txt")).toBeInTheDocument();
    expect(screen.getByText(/2 KB/)).toBeInTheDocument();
    expect(screen.getByText(/parsed ✓/)).toBeInTheDocument();
  });

  it("marks a used attachment as immutable", () => {
    render(
      <FileMessageCard
        item={makeItem({
          file: makeSessionFile("a.txt", {
            usedAt: "2026-08-04T20:00:00.000Z",
          }),
        })}
        onDelete={vi.fn(async () => true)}
      />,
    );

    expect(screen.getByText(/revision locked.*review coverage unknown/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete a.txt" }),
    ).not.toBeInTheDocument();
  });

  it("requires confirmation before deleting a current file", async () => {
    const onDelete = vi.fn(async () => true);
    const item = makeItem();
    render(<FileMessageCard item={item} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete a.txt" }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText("Delete this file?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
    expect(onDelete).toHaveBeenCalledWith(item);
    await waitFor(() =>
      expect(screen.queryByText("Delete this file?")).not.toBeInTheDocument(),
    );
  });

  it("keeps confirmation open when deletion fails", async () => {
    const onDelete = vi.fn(async () => false);
    render(<FileMessageCard item={makeItem()} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete a.txt" }));
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));

    await waitFor(() => expect(onDelete).toHaveBeenCalledOnce());
    expect(screen.getByText("Delete this file?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Delete$/ })).toBeEnabled();
  });

  it("can cancel a pending deletion", () => {
    const onDelete = vi.fn();
    render(<FileMessageCard item={makeItem()} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete a.txt" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByText("Delete this file?")).not.toBeInTheDocument();
  });

  it("renders the parser error for a failed parse", () => {
    render(
      <FileMessageCard
        item={makeItem({
          file: makeSessionFile("a.txt", {
            parseStatus: "error",
            parserError: "corrupt PDF",
          }),
        })}
      />,
    );

    expect(screen.getByText(/error: corrupt PDF/)).toBeInTheDocument();
  });

  it("renders MCP provenance when the file has an MCP source", () => {
    render(
      <FileMessageCard
        item={makeItem({
          file: makeSessionFile("spec.md", {
            source: {
              kind: "mcp-resource",
              snapshotId: "snap-1",
              serverId: "srv-1",
              serverName: "docs-server",
              resourceId: "res-1",
              resourceName: "Spec",
              resourceUri: "mcp://docs-server/spec",
              contentId: "content-1",
              contentUri: "file:///content/spec.md",
              mimeType: "text/markdown",
              capturedAt: "2026-08-03T09:00:00.000Z",
              sha256: "abc123",
            },
          }),
        })}
      />,
    );

    expect(
      screen.getByLabelText("MCP provenance for spec.md"),
    ).toBeInTheDocument();
    expect(screen.getByText("docs-server")).toBeInTheDocument();
    expect(screen.getByText("mcp://docs-server/spec")).toBeInTheDocument();
    expect(screen.getByText("abc123")).toBeInTheDocument();
  });

  it("shows an uploading state", () => {
    render(
      <FileMessageCard
        item={makeItem({ state: "uploading", file: undefined })}
      />,
    );

    expect(screen.getByText(/uploading…/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete a.txt" }),
    ).not.toBeInTheDocument();
  });

  it("shows retry and dismiss for a local error with a retained file", () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    const retryFile = new File(["x"], "a.txt");
    const item = makeItem({
      state: "error",
      file: undefined,
      error: "network down",
      retryFile,
    });
    render(
      <FileMessageCard item={item} onRetry={onRetry} onDismiss={onDismiss} />,
    );

    expect(screen.getByText("network down")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry a.txt" }));
    expect(onRetry).toHaveBeenCalledWith(item);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss a.txt" }));
    expect(onDismiss).toHaveBeenCalledWith(item);
  });

  it("offers dismiss only when no retry file remains", () => {
    render(
      <FileMessageCard
        item={makeItem({ state: "error", file: undefined, error: "gone" })}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Retry a.txt" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Dismiss a.txt" }),
    ).toBeInTheDocument();
  });
});
