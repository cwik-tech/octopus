import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import FileUpload, {
  type FileUploadApi,
} from "@/components/shared/file-upload";
import type { SessionFile } from "@/lib/models/session-model";

const mockApi: FileUploadApi = {
  list: vi.fn(),
  upload: vi.fn(),
  delete: vi.fn(),
};

describe("FileUpload accessibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.list).mockResolvedValue([]);
    vi.mocked(mockApi.delete).mockResolvedValue(undefined);
    vi.mocked(mockApi.upload).mockResolvedValue({
      name: "report.txt",
      size: 6,
      uploadedAt: "2026-05-01T12:00:00.000Z",
      parseStatus: "pending",
    });
  });

  it("opens the file picker with pointer and keyboard activation", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <FileUpload ownerId="session-1" api={mockApi} />,
    );
    const uploadButton = await screen.findByRole("button", {
      name: "Upload files",
    });
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    expect(fileInput).not.toBeNull();
    const clickSpy = vi.spyOn(fileInput!, "click");

    await user.click(uploadButton);
    uploadButton.focus();
    await user.keyboard("{Enter}");

    expect(clickSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps the delete action visible on focus and deletes by accessible name", async () => {
    const user = userEvent.setup();
    const file: SessionFile = {
      name: "report.pdf",
      size: 2048,
      uploadedAt: "2026-05-01T12:00:00.000Z",
      parseStatus: "parsed",
    };
    vi.mocked(mockApi.list).mockResolvedValue([file]);
    render(<FileUpload ownerId="session-1" api={mockApi} />);

    const deleteButton = await screen.findByRole("button", {
      name: "Delete report.pdf",
    });
    deleteButton.focus();

    expect(deleteButton).toHaveFocus();
    expect(deleteButton).toHaveClass("focus-visible:opacity-100");
    await user.click(deleteButton);

    await waitFor(() => {
      expect(mockApi.delete).toHaveBeenCalledWith("session-1", "report.pdf");
    });
  });

  it("applies context-document type filtering and disables uploads at the file limit", async () => {
    vi.mocked(mockApi.list).mockResolvedValue([
      {
        name: "brief.md",
        size: 1024,
        uploadedAt: "2026-05-01T12:00:00.000Z",
        parseStatus: "parsed",
      },
    ]);
    const { container } = render(
      <FileUpload
        ownerId="draft-1"
        api={mockApi}
        accept=".pdf,.md"
        helperText="PDF or Markdown. Up to 1 document."
        maxFiles={1}
      />,
    );

    await waitFor(() => {
      expect(mockApi.list).toHaveBeenCalledWith("draft-1");
    });
    const uploadButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Upload files"]',
    );
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );

    expect(uploadButton).not.toBeNull();
    await waitFor(() => {
      expect(uploadButton).toBeDisabled();
    });
    expect(fileInput).toHaveAttribute("accept", ".pdf,.md");
    expect(screen.getByText(/PDF or Markdown/)).toBeInTheDocument();
  });

  it("reports when a scanned PDF needs or has completed document reading", async () => {
    vi.mocked(mockApi.list).mockResolvedValue([
      {
        name: "scanned.pdf",
        size: 2048,
        uploadedAt: "2026-05-01T12:00:00.000Z",
        parseStatus: "parsed",
        documentAnalysis: { status: "required" },
      },
      {
        name: "evidence.pdf",
        size: 4096,
        uploadedAt: "2026-05-01T12:00:00.000Z",
        parseStatus: "parsed",
        documentAnalysis: {
          status: "ready",
          provider: "gemini",
          model: "gemini-3.5-flash",
        },
      },
    ]);
    render(<FileUpload ownerId="draft-1" api={mockApi} />);

    expect(await screen.findByText(/PDF reader needed/)).toBeInTheDocument();
    expect(screen.getByText(/read by gemini \/ gemini-3.5-flash/)).toBeInTheDocument();
  });

  it("shows compact MCP provenance and reloads when its refresh key changes", async () => {
    const user = userEvent.setup();
    vi.mocked(mockApi.list).mockResolvedValue([{
      name: "mcp-report.txt",
      size: 2048,
      uploadedAt: "2026-07-12T12:00:00.000Z",
      parseStatus: "parsed",
      source: {
        kind: "mcp-resource",
        snapshotId: "snapshot-1",
        serverId: "documents",
        serverName: "Documents",
        resourceId: "resource-1",
        resourceName: "Quarterly report",
        resourceUri: "docs://reports/quarterly",
        contentId: "content-1",
        contentUri: "docs://reports/quarterly",
        mimeType: "text/plain",
        capturedAt: "2026-07-12T12:00:00.000Z",
        sha256: "d".repeat(64),
      },
    }]);
    const { rerender } = render(
      <FileUpload ownerId="session-1" api={mockApi} refreshKey={0} />,
    );

    const provenance = await screen.findByLabelText(
      /MCP resource from Documents: Quarterly report; docs:\/\/reports\/quarterly/,
    );
    expect(provenance).toHaveTextContent("MCP · Documents");
    expect(provenance).toHaveAttribute(
      "title",
      "Quarterly report · docs://reports/quarterly",
    );
    const disclosure = screen.getByLabelText("MCP provenance for mcp-report.txt");
    disclosure.focus();
    expect(disclosure).toHaveFocus();
    expect(disclosure.tagName).toBe("SUMMARY");
    expect(disclosure).toHaveProperty("tabIndex", 0);
    await user.click(disclosure);
    expect(disclosure.closest("details")).toHaveAttribute("open");
    expect(screen.getByText("docs://reports/quarterly")).toBeInTheDocument();
    expect(screen.getByText("d".repeat(64))).toBeInTheDocument();
    expect(screen.getByText("2026-07-12T12:00:00.000Z")).toBeInTheDocument();
    expect(screen.getByText("text/plain")).toBeInTheDocument();

    rerender(<FileUpload ownerId="session-1" api={mockApi} refreshKey={1} />);
    await waitFor(() => expect(mockApi.list).toHaveBeenCalledTimes(2));
  });
});
