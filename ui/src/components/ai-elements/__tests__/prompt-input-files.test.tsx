import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputAttachments,
  PromptInputSpeechButton,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";

const noop = () => undefined;

function makeFile(name: string, type = "", size = 128): File {
  return new File([new Uint8Array(size)], name, { type });
}

function fileDragData(files: File[] = []) {
  return { dataTransfer: { files, types: ["Files"] } };
}

function renderComposer(
  props: Partial<React.ComponentProps<typeof PromptInput>> = {},
) {
  return render(
    <PromptInput onSubmit={noop} {...props}>
      <PromptInputTextarea />
    </PromptInput>,
  );
}

beforeEach(() => {
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:mock"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PromptInput file delegation", () => {
  it("delegates picker-selected files with original File identity", () => {
    const onFilesAccepted = vi.fn();
    const { container } = renderComposer({ onFilesAccepted });

    const input = screen.getByLabelText("Upload files");
    const file = makeFile("report.pdf", "application/pdf");
    fireEvent.change(input, { target: { files: [file] } });

    expect(onFilesAccepted).toHaveBeenCalledTimes(1);
    const delegated = onFilesAccepted.mock.calls[0]?.[0] as File[];
    expect(delegated).toHaveLength(1);
    expect(delegated[0]).toBe(file);

    // No composer attachments, no object URLs.
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(container.querySelector("form")?.textContent).not.toContain(
      "report.pdf",
    );
  });

  it("delegates dropped files with original File identity", () => {
    const onFilesAccepted = vi.fn();
    const { container } = renderComposer({ onFilesAccepted });

    const form = container.querySelector("form")!;
    const file = makeFile("dropped.txt", "text/plain");
    fireEvent.drop(form, fileDragData([file]));

    expect(onFilesAccepted).toHaveBeenCalledTimes(1);
    expect((onFilesAccepted.mock.calls[0]?.[0] as File[])[0]).toBe(file);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("delegates pasted files with original File identity", () => {
    const onFilesAccepted = vi.fn();
    renderComposer({ onFilesAccepted });

    const file = makeFile("pasted.png", "image/png");
    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: {
        items: [{ kind: "file", getAsFile: () => file }],
      },
    });

    expect(onFilesAccepted).toHaveBeenCalledTimes(1);
    expect((onFilesAccepted.mock.calls[0]?.[0] as File[])[0]).toBe(file);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("shows and hides the drag-over indicator across nested drag enter/leave", () => {
    const { container } = renderComposer({ onFilesAccepted: vi.fn() });

    const form = container.querySelector("form")!;
    const textarea = screen.getByRole("textbox");
    const indicator = () =>
      screen.queryByTestId("prompt-input-drag-over-indicator");

    expect(indicator()).not.toBeInTheDocument();

    fireEvent.dragEnter(form, fileDragData());
    expect(indicator()).toBeInTheDocument();

    // Moving into a nested child must not flicker the indicator off.
    fireEvent.dragEnter(textarea, fileDragData());
    fireEvent.dragLeave(textarea, fileDragData());
    expect(indicator()).toBeInTheDocument();

    fireEvent.dragLeave(form, fileDragData());
    expect(indicator()).not.toBeInTheDocument();
  });

  it("hides the drag-over indicator after a drop", () => {
    const onFilesAccepted = vi.fn();
    const { container } = renderComposer({ onFilesAccepted });

    const form = container.querySelector("form")!;
    fireEvent.dragEnter(form, fileDragData());
    expect(
      screen.getByTestId("prompt-input-drag-over-indicator"),
    ).toBeInTheDocument();

    fireEvent.drop(form, fileDragData([makeFile("a.txt", "text/plain")]));
    expect(
      screen.queryByTestId("prompt-input-drag-over-indicator"),
    ).not.toBeInTheDocument();
    expect(onFilesAccepted).toHaveBeenCalledTimes(1);
  });

  it("accepts extension patterns case-insensitively and rejects non-matches", () => {
    const onFilesAccepted = vi.fn();
    const onError = vi.fn();
    renderComposer({
      onFilesAccepted,
      onError,
      accept: ".pdf,.docx",
    });

    const input = screen.getByLabelText("Upload files");

    const upper = makeFile("REPORT.PDF");
    fireEvent.change(input, { target: { files: [upper] } });
    expect(onFilesAccepted).toHaveBeenCalledTimes(1);
    expect((onFilesAccepted.mock.calls[0]?.[0] as File[])[0]).toBe(upper);

    const txt = makeFile("notes.txt", "text/plain");
    fireEvent.change(input, { target: { files: [txt] } });
    expect(onFilesAccepted).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "accept" }),
    );
  });

  it("rejects oversized files and does not delegate them", () => {
    const onFilesAccepted = vi.fn();
    const onError = vi.fn();
    renderComposer({ onFilesAccepted, onError, maxFileSize: 10 });

    fireEvent.change(screen.getByLabelText("Upload files"), {
      target: { files: [makeFile("big.bin", "application/octet-stream", 100)] },
    });

    expect(onFilesAccepted).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "max_file_size" }),
    );
  });

  it("caps delegated batches at maxFiles and reports the overflow", () => {
    const onFilesAccepted = vi.fn();
    const onError = vi.fn();
    renderComposer({ onFilesAccepted, onError, maxFiles: 1 });

    const first = makeFile("one.txt", "text/plain");
    const second = makeFile("two.txt", "text/plain");
    fireEvent.change(screen.getByLabelText("Upload files"), {
      target: { files: [first, second] },
    });

    expect(onFilesAccepted).toHaveBeenCalledTimes(1);
    const delegated = onFilesAccepted.mock.calls[0]?.[0] as File[];
    expect(delegated).toHaveLength(1);
    expect(delegated[0]).toBe(first);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "max_files" }),
    );
  });

  it("keeps existing MIME and wildcard accept behavior for delegated files", () => {
    const onFilesAccepted = vi.fn();
    const onError = vi.fn();
    renderComposer({
      onFilesAccepted,
      onError,
      accept: "image/*,text/plain",
    });

    const png = makeFile("a.png", "image/png");
    const txt = makeFile("b.txt", "text/plain");
    const pdf = makeFile("c.pdf", "application/pdf");
    fireEvent.change(screen.getByLabelText("Upload files"), {
      target: { files: [png, txt, pdf] },
    });

    const call = onFilesAccepted.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) throw new Error("PromptInput did not delegate the accepted files");
    const delegated = call[0] as File[];
    expect(delegated).toEqual([png, txt]);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "accept" }),
    );
  });

  it("reports oversized files in a mixed delegated selection", () => {
    const onFilesAccepted = vi.fn();
    const onError = vi.fn();
    const small = makeFile("small.txt", "text/plain", 8);
    const large = makeFile("large.txt", "text/plain", 20);
    renderComposer({ onFilesAccepted, onError, maxFileSize: 10 });

    fireEvent.change(screen.getByLabelText("Upload files"), {
      target: { files: [small, large] },
    });

    expect(onFilesAccepted).toHaveBeenCalledWith([small]);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "max_file_size" }),
    );
  });
});

describe("PromptInputActionAddAttachments", () => {
  it("opens the hidden file picker when the menu item is clicked", async () => {
    // Regression test: the underlying base-ui Menu.Item only fires onClick;
    // an onSelect prop is silently attached as a DOM select-event listener.
    const onFilesAccepted = vi.fn();
    const user = userEvent.setup();
    render(
      <PromptInput onSubmit={noop} onFilesAccepted={onFilesAccepted}>
        <PromptInputActionMenu>
          <PromptInputActionMenuTrigger aria-label="Add files" />
          <PromptInputActionMenuContent>
            <PromptInputActionAddAttachments label="Add Files" />
          </PromptInputActionMenuContent>
        </PromptInputActionMenu>
        <PromptInputTextarea />
      </PromptInput>,
    );

    const input = screen.getByLabelText("Upload files");
    const clickSpy = vi.spyOn(input, "click");

    await user.click(screen.getByRole("button", { name: "Add files" }));
    const menuItem = await screen.findByRole("menuitem", { name: /Add Files/ });
    expect(menuItem.closest('[data-slot="dropdown-menu-content"]')).toHaveClass(
      "w-max",
      "min-w-max",
      "whitespace-nowrap",
    );
    await user.click(menuItem);

    expect(clickSpy).toHaveBeenCalledTimes(1);

    // The picker routes accepted files through the delegation path.
    const file = makeFile("picked.txt", "text/plain");
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFilesAccepted).toHaveBeenCalledTimes(1);
    expect((onFilesAccepted.mock.calls[0]?.[0] as File[])[0]).toBe(file);
  });
});

describe("PromptInput default behavior (no delegation)", () => {
  it("still creates chips and object URLs for picker-selected files", () => {
    render(
      <PromptInput onSubmit={noop} accept="text/plain">
        <PromptInputTextarea />
        <PromptInputAttachments>
          {(attachment) => <span>{attachment.filename}</span>}
        </PromptInputAttachments>
      </PromptInput>,
    );

    const file = makeFile("notes.txt", "text/plain");
    fireEvent.change(screen.getByLabelText("Upload files"), {
      target: { files: [file] },
    });

    expect(URL.createObjectURL).toHaveBeenCalledWith(file);
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(
      screen.queryByTestId("prompt-input-drag-over-indicator"),
    ).not.toBeInTheDocument();
  });

  it("still validates dropped files against accept and creates chips", () => {
    const onError = vi.fn();
    const { container } = render(
      <PromptInput onSubmit={noop} onError={onError} accept=".md">
        <PromptInputTextarea />
        <PromptInputAttachments>
          {(attachment) => <span>{attachment.filename}</span>}
        </PromptInputAttachments>
      </PromptInput>,
    );

    const form = container.querySelector("form")!;
    fireEvent.drop(form, fileDragData([makeFile("readme.md")]));
    expect(screen.getByText("readme.md")).toBeInTheDocument();

    fireEvent.drop(form, fileDragData([makeFile("notes.txt", "text/plain")]));
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "accept" }),
    );
  });
});

// Stands in for the browser's Web Speech API. Like the real object, its
// on<event> handler properties run when the matching event is dispatched.
let startedRecognizers: FakeSpeechRecognition[] = [];

class FakeSpeechRecognition extends EventTarget {
  onstart: ((event: Event) => void) | null = null;
  onresult: ((event: Event) => void) | null = null;

  constructor() {
    super();
    this.addEventListener("start", (event) => this.onstart?.(event));
    this.addEventListener("result", (event) => this.onresult?.(event));
  }

  start() {
    startedRecognizers.push(this);
    this.dispatchEvent(new Event("start"));
  }

  stop() {
    return undefined;
  }
}

type SpokenResult = { transcript: string; isFinal: boolean };

function makeRecognitionResult({ transcript, isFinal }: SpokenResult) {
  const alternatives = [{ transcript, confidence: 0.92 }];
  return Object.assign(alternatives, {
    isFinal,
    item: (index: number) => alternatives[index] ?? null,
  });
}

function makeResultEvent(resultIndex: number, spoken: SpokenResult[]): Event {
  const results = spoken.map(makeRecognitionResult);
  const resultList = Object.assign(results, {
    item: (index: number) => results[index] ?? null,
  });
  return Object.assign(new Event("result"), {
    resultIndex,
    results: resultList,
  });
}

function DictationComposer({
  onTranscriptionChange,
}: {
  onTranscriptionChange: (text: string) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  return (
    <>
      <textarea aria-label="Message" defaultValue="Please" ref={textareaRef} />
      <PromptInputSpeechButton
        aria-label="Dictate"
        onTranscriptionChange={onTranscriptionChange}
        textareaRef={textareaRef}
      />
    </>
  );
}

function startDictation(): FakeSpeechRecognition {
  fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
  expect(startedRecognizers).toHaveLength(1);
  const [recognizer] = startedRecognizers;
  if (recognizer === undefined) {
    throw new Error("The Dictate button did not start speech recognition.");
  }
  return recognizer;
}

describe("PromptInputSpeechButton", () => {
  beforeEach(() => {
    startedRecognizers = [];
    vi.stubGlobal("SpeechRecognition", FakeSpeechRecognition);
  });

  it("appends final results from resultIndex onward to the textarea and skips interim ones", () => {
    const onTranscriptionChange = vi.fn();
    render(<DictationComposer onTranscriptionChange={onTranscriptionChange} />);
    const recognizer = startDictation();

    act(() => {
      recognizer.dispatchEvent(
        makeResultEvent(1, [
          { transcript: "Already sent", isFinal: true },
          { transcript: "book a table", isFinal: true },
          { transcript: " for tomorrow", isFinal: false },
          { transcript: " at noon", isFinal: true },
        ]),
      );
    });

    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(
      "Please book a table at noon",
    );
    expect(onTranscriptionChange).toHaveBeenCalledTimes(1);
    expect(onTranscriptionChange).toHaveBeenCalledWith(
      "Please book a table at noon",
    );
  });

  it("leaves the textarea unchanged when every result from resultIndex onward is interim", () => {
    const onTranscriptionChange = vi.fn();
    render(<DictationComposer onTranscriptionChange={onTranscriptionChange} />);
    const recognizer = startDictation();

    act(() => {
      recognizer.dispatchEvent(
        makeResultEvent(1, [
          { transcript: "Already sent", isFinal: true },
          { transcript: " book a", isFinal: false },
        ]),
      );
    });

    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(
      "Please",
    );
    expect(onTranscriptionChange).not.toHaveBeenCalled();
  });
});
