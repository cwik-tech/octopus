import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import WorkflowGeneratorChat, {
  type WorkflowGeneratorFileComposerConfig,
} from "@/components/create/workflow-generator-chat";
import type { FileUploadApi } from "@/components/shared/file-upload";
import type { SessionFile } from "@/lib/models/session-model";

const makeSessionFile = (
  name: string,
  overrides: Partial<SessionFile> = {},
): SessionFile => ({
  name,
  size: 100,
  uploadedAt: "2026-08-04T10:00:00.000Z",
  parseStatus: "parsed",
  ...overrides,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const createApi = () => ({
  list: vi.fn<FileUploadApi["list"]>(async () => []),
  upload: vi.fn<FileUploadApi["upload"]>(async (_ownerId, file) =>
    makeSessionFile(file.name, { size: file.size }),
  ),
  delete: vi.fn<FileUploadApi["delete"]>(async () => undefined),
});

const createFileComposer = (
  api: ReturnType<typeof createApi>,
  overrides: Partial<WorkflowGeneratorFileComposerConfig> = {},
): WorkflowGeneratorFileComposerConfig => ({
  api,
  ownerId: "draft-1",
  accept: ".txt,.pdf",
  maxFiles: 8,
  ...overrides,
});

function renderChat(
  props: Partial<React.ComponentProps<typeof WorkflowGeneratorChat>> = {},
) {
  return render(
    <WorkflowGeneratorChat
      history={[]}
      submitting={false}
      error={null}
      onSubmit={vi.fn()}
      {...props}
    />,
  );
}

const fileDragData = (files: File[] = []) => ({
  dataTransfer: { files, types: ["Files"] },
});

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe("WorkflowGeneratorChat model availability", () => {
  // The picker shows a pair before anyone has chosen one, and that displayed
  // pair is not what the turn will run on: an untouched composer sends no pair
  // and the server resolves the Agent's own. Which of the two it is decides
  // whether an unavailable pair may stop the person typing.
  const unavailable = { modelProvider: "codex", model: "retired-model" };

  it("blocks a pair the person chose that cannot run", async () => {
    renderChat({ ...unavailable, modelChosen: true, onModelChange: vi.fn() });

    expect(await screen.findByRole("textbox")).toBeDisabled();
  });

  it("does not block a prefilled pair that cannot run", async () => {
    // The Agent's own pair may be perfectly valid; blocking here would stop a
    // turn that would have run.
    renderChat({ ...unavailable, modelChosen: false, onModelChange: vi.fn() });

    expect(await screen.findByRole("textbox")).not.toBeDisabled();
  });

  it("treats a caller that says nothing as having a chosen pair", async () => {
    // Every existing caller behaved this way, and a surface that has not been
    // taught the difference must not silently become more permissive.
    renderChat({ ...unavailable, onModelChange: vi.fn() });

    expect(await screen.findByRole("textbox")).toBeDisabled();
  });
});

describe("WorkflowGeneratorChat without fileComposer", () => {
  it("uses the shared borderless chat shell without a fixed header", () => {
    const { container } = renderChat();
    const shell = container.querySelector('[data-slot="chat-shell"]');

    expect(shell).toHaveClass(
      "rounded-none",
      "border-0",
      "bg-transparent",
      "p-0",
    );
    expect(
      shell?.querySelector('[data-slot="chat-shell-header"]'),
    ).not.toBeInTheDocument();
    expect(
      shell?.querySelector('[data-slot="chat-shell-composer"]'),
    ).toHaveClass("p-1");
  });

  it("shows generator errors in the conversation without restoring the fixed header", () => {
    const { container } = renderChat({ error: "Unable to generate workflow." });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unable to generate workflow.",
    );
    expect(
      container.querySelector('[data-slot="chat-shell-header"]'),
    ).not.toBeInTheDocument();
  });

  it("renders caller-supplied typed timeline entries", () => {
    renderChat({
      additionalTimelineItems: [
        {
          id: "agent:michigan-contract-lawyer",
          occurredAt: "2026-08-08T10:00:00.000Z",
          content: (
            <button type="button">Open Michigan Contract Lawyer</button>
          ),
        },
      ],
    } as Partial<React.ComponentProps<typeof WorkflowGeneratorChat>> & {
      additionalTimelineItems: Array<{
        id: string;
        occurredAt: string;
        content: React.ReactNode;
      }>;
    });

    expect(
      screen.getByRole("button", { name: "Open Michigan Contract Lawyer" }),
    ).toBeInTheDocument();
  });

  it("renders no upload controls (Workflow/Agent Architect parity)", () => {
    const { container } = renderChat();

    expect(
      screen.queryByRole("button", { name: "Add files" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Current files")).not.toBeInTheDocument();

    // Drops must not produce attachment cards or drag-over presentation.
    const form = container.querySelector("form")!;
    fireEvent.dragEnter(form, fileDragData());
    expect(
      screen.queryByTestId("prompt-input-drag-over-indicator"),
    ).not.toBeInTheDocument();
    fireEvent.drop(form, {
      dataTransfer: {
        files: [new File(["x"], "notes.txt", { type: "text/plain" })],
        types: ["Files"],
      },
    });
    expect(screen.queryByTestId("file-message-card")).not.toBeInTheDocument();
  });

  it("keeps the model selector anchored without the composer row", () => {
    renderChat({
      modelProvider: "openai",
      model: "gpt-5.4",
      onModelChange: vi.fn(),
    });
    expect(
      screen.getByLabelText("Workflow Architect model"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add files" }),
    ).not.toBeInTheDocument();
  });
});

describe("WorkflowGeneratorChat with fileComposer", () => {
  it("lists files for the owner and renders cards plus the icon row", async () => {
    const api = createApi();
    const current = makeSessionFile("brief.txt");
    api.list.mockResolvedValue([current]);
    renderChat({ fileComposer: createFileComposer(api) });

    await waitFor(() => expect(api.list).toHaveBeenCalledWith("draft-1"));
    const card = await screen.findByTestId("file-message-card");
    expect(card).toHaveAttribute("data-state", "current");
    expect(card).toHaveTextContent("brief.txt");
    expect(screen.getByLabelText("Current files")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add files" }),
    ).toBeInTheDocument();
  });

  it("opens the native picker from the Add Files menu item and delegates the selection", async () => {
    const api = createApi();
    const user = userEvent.setup();
    renderChat({ fileComposer: createFileComposer(api) });
    await waitFor(() => expect(api.list).toHaveBeenCalledWith("draft-1"));

    const input = screen.getByLabelText("Upload files");
    const clickSpy = vi.spyOn(input, "click");

    await user.click(screen.getByRole("button", { name: "Add files" }));
    await user.click(await screen.findByRole("menuitem", { name: /Add Files/ }));

    expect(clickSpy).toHaveBeenCalledTimes(1);

    // The opened picker routes accepted files through the delegation path.
    const file = new File(["hello"], "menu-picked.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(api.upload).toHaveBeenCalledWith("draft-1", file));
  });

  it("delegates picker-selected files to the controller with original identity", async () => {
    const api = createApi();
    renderChat({ fileComposer: createFileComposer(api) });
    await waitFor(() => expect(api.list).toHaveBeenCalledWith("draft-1"));

    const pending = deferred<SessionFile>();
    api.upload.mockReturnValue(pending.promise);
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Upload files"), {
      target: { files: [file] },
    });

    await waitFor(() => expect(api.upload).toHaveBeenCalledWith("draft-1", file));
    expect(api.upload.mock.calls[0]?.[1]).toBe(file);
    expect(screen.getByTestId("file-message-card")).toHaveAttribute(
      "data-state",
      "uploading",
    );

    const uploaded = makeSessionFile("notes.txt");
    api.list.mockResolvedValue([uploaded]);
    await act(async () => {
      pending.resolve(uploaded);
    });
    await waitFor(() =>
      expect(screen.getByTestId("file-message-card")).toHaveAttribute(
        "data-state",
        "current",
      ),
    );
  });

  it("delegates dropped and pasted files to the controller", async () => {
    const api = createApi();
    const { container } = renderChat({ fileComposer: createFileComposer(api) });
    await waitFor(() => expect(api.list).toHaveBeenCalledWith("draft-1"));

    // Drop.
    const firstUpload = deferred<SessionFile>();
    api.upload.mockReturnValue(firstUpload.promise);
    const dropped = new File(["d"], "dropped.txt", { type: "text/plain" });
    fireEvent.drop(container.querySelector("form")!, fileDragData([dropped]));
    await waitFor(() => expect(api.upload).toHaveBeenCalledWith("draft-1", dropped));
    api.list.mockResolvedValue([makeSessionFile("dropped.txt")]);
    await act(async () => {
      firstUpload.resolve(makeSessionFile("dropped.txt"));
    });

    // Paste (sequential controller: the first upload must settle first).
    const secondUpload = deferred<SessionFile>();
    api.upload.mockReturnValue(secondUpload.promise);
    const pasted = new File(["p"], "pasted.txt", { type: "text/plain" });
    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: {
        items: [{ kind: "file", getAsFile: () => pasted }],
      },
    });
    await waitFor(() => expect(api.upload).toHaveBeenCalledWith("draft-1", pasted));
    api.list.mockResolvedValue([
      makeSessionFile("dropped.txt"),
      makeSessionFile("pasted.txt"),
    ]);
    await act(async () => {
      secondUpload.resolve(makeSessionFile("pasted.txt"));
    });
    await waitFor(() =>
      expect(screen.getAllByTestId("file-message-card")).toHaveLength(2),
    );
  });

  it("rejects files outside the accept patterns before upload", async () => {
    const api = createApi();
    renderChat({ fileComposer: createFileComposer(api) });
    await waitFor(() => expect(api.list).toHaveBeenCalledWith("draft-1"));

    fireEvent.change(screen.getByLabelText("Upload files"), {
      target: { files: [new File(["x"], "setup.exe")] },
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(api.upload).not.toHaveBeenCalled();
    expect(screen.queryByTestId("file-message-card")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "No files match the accepted types.",
    );
  });

  it("caps picker batches at maxFiles", async () => {
    const api = createApi();
    renderChat({ fileComposer: createFileComposer(api, { maxFiles: 1 }) });
    await waitFor(() => expect(api.list).toHaveBeenCalledWith("draft-1"));

    const pending = deferred<SessionFile>();
    api.upload.mockReturnValue(pending.promise);
    const first = new File(["1"], "one.txt", { type: "text/plain" });
    const second = new File(["2"], "two.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Upload files"), {
      target: { files: [first, second] },
    });

    await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(1));
    expect(api.upload).toHaveBeenCalledWith("draft-1", first);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "A maximum of 1 file can be active at once.",
    );
    await act(async () => {
      pending.resolve(makeSessionFile("one.txt"));
    });
    expect(api.upload).toHaveBeenCalledTimes(1);
  });

  it("applies maxFiles cumulatively while allowing a same-name replacement", async () => {
    const api = createApi();
    const existing = makeSessionFile("existing.txt");
    api.list.mockResolvedValue([existing]);
    const pending = deferred<SessionFile>();
    api.upload.mockReturnValue(pending.promise);
    renderChat({ fileComposer: createFileComposer(api, { maxFiles: 1 }) });
    await screen.findByText("existing.txt");

    const replacement = new File(["replacement"], "existing.txt", {
      type: "text/plain",
    });
    const overflow = new File(["overflow"], "overflow.txt", {
      type: "text/plain",
    });
    fireEvent.change(screen.getByLabelText("Upload files"), {
      target: { files: [replacement, overflow] },
    });

    await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(1));
    expect(api.upload).toHaveBeenCalledWith("draft-1", replacement);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "A maximum of 1 file can be active at once.",
    );

    await act(async () => {
      pending.resolve(
        makeSessionFile("existing.txt", {
          uploadedAt: "2026-08-04T10:01:00.000Z",
        }),
      );
    });
  });

  it("keeps a file card between the turns that occurred around its upload", async () => {
    const api = createApi();
    const fileComposer = createFileComposer(api);
    const firstTurn = {
      role: "user" as const,
      text: "First turn",
      createdAt: "2026-08-04T09:59:00.000Z",
    };
    const laterTurn = {
      role: "assistant" as const,
      text: "Later turn",
      createdAt: "2099-08-04T10:01:00.000Z",
    };
    const pending = deferred<SessionFile>();
    api.upload.mockReturnValue(pending.promise);
    const { rerender } = renderChat({
      history: [firstTurn],
      fileComposer,
    });
    await waitFor(() => expect(api.list).toHaveBeenCalledWith("draft-1"));

    fireEvent.change(screen.getByLabelText("Upload files"), {
      target: {
        files: [new File(["context"], "context.txt", { type: "text/plain" })],
      },
    });
    const card = await screen.findByTestId("file-message-card");

    rerender(
      <WorkflowGeneratorChat
        history={[firstTurn, laterTurn]}
        submitting={false}
        error={null}
        onSubmit={vi.fn()}
        fileComposer={fileComposer}
      />,
    );

    const first = screen.getByText("First turn");
    const later = screen.getByText("Later turn");
    expect(first.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows list failures and lets the user dismiss them", async () => {
    const api = createApi();
    api.list.mockRejectedValue(new Error("list unavailable"));
    renderChat({ fileComposer: createFileComposer(api) });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "list unavailable",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss file error" }),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("refreshes the file list when refreshRevision bumps", async () => {
    const api = createApi();
    const fileComposer = createFileComposer(api, { refreshRevision: 0 });
    const { rerender } = renderChat({ fileComposer });
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));

    rerender(
      <WorkflowGeneratorChat
        history={[]}
        submitting={false}
        error={null}
        onSubmit={vi.fn()}
        fileComposer={{ ...fileComposer, refreshRevision: 1 }}
      />,
    );

    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    expect(api.list).toHaveBeenLastCalledWith("draft-1");
  });

  it("ignores late completions after owner rotation", async () => {
    const api = createApi();
    const fileComposer = createFileComposer(api);
    const { rerender } = renderChat({ fileComposer });
    await waitFor(() => expect(api.list).toHaveBeenCalledWith("draft-1"));

    const pending = deferred<SessionFile>();
    api.upload.mockReturnValue(pending.promise);
    const file = new File(["x"], "late.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Upload files"), {
      target: { files: [file] },
    });
    await waitFor(() => expect(api.upload).toHaveBeenCalledWith("draft-1", file));
    expect(screen.getByTestId("file-message-card")).toHaveAttribute(
      "data-state",
      "uploading",
    );

    rerender(
      <WorkflowGeneratorChat
        history={[]}
        submitting={false}
        error={null}
        onSubmit={vi.fn()}
        fileComposer={{ ...fileComposer, ownerId: "draft-2" }}
      />,
    );

    // Optimistic state cleared; the new owner is listed.
    await waitFor(() => expect(api.list).toHaveBeenCalledWith("draft-2"));
    expect(screen.queryByTestId("file-message-card")).not.toBeInTheDocument();

    await act(async () => {
      pending.resolve(makeSessionFile("late.txt"));
    });
    expect(screen.queryByTestId("file-message-card")).not.toBeInTheDocument();
    expect(
      api.list.mock.calls.filter(([owner]) => owner === "draft-1"),
    ).toHaveLength(1);
  });
});
