import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import FileUpload, {
  type FileUploadApi,
} from "@/components/shared/file-upload";
import type { SessionFile } from "@/lib/models/session-model";

const INITIAL_FILE: SessionFile = {
  name: "source.md",
  size: 12,
  uploadedAt: "2026-08-05T12:00:00.000Z",
  parseStatus: "parsed",
};

test("controlled file refreshes preserve a local upload error for the same owner", async () => {
  const api: FileUploadApi = {
    list: vi.fn(async () => []),
    upload: vi.fn(async () => {
      throw new Error("Upload rejected");
    }),
    delete: vi.fn(async () => undefined),
  };
  const user = userEvent.setup();
  const { container, rerender } = render(
    <FileUpload ownerId="project-1" api={api} initialFiles={[INITIAL_FILE]} />,
  );
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');

  await user.upload(
    input!,
    new File(["new source"], "new-source.md", { type: "text/markdown" }),
  );
  expect(await screen.findByText("Upload rejected")).toBeInTheDocument();

  rerender(
    <FileUpload
      ownerId="project-1"
      api={api}
      initialFiles={[{ ...INITIAL_FILE }]}
    />,
  );

  expect(screen.getByText("Upload rejected")).toBeInTheDocument();
  expect(api.list).not.toHaveBeenCalled();
});
