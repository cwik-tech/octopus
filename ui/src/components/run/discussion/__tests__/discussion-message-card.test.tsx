import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DiscussionMessageCard } from "../discussion-message-card";
import { messageMarkdownFileName } from "../discussion-message-model";
import type { WorkflowChatMessage } from "@/lib/utils/workflow-chat-events";

const MESSAGE = {
  id: "workflow:task-1:event-1",
  role: "assistant",
  text: "# Decision Record\n\nThe market assumptions need stronger evidence.",
  createdAt: "2026-05-01T12:00:02.000Z",
  speaker: { type: "agent", id: "critic", name: "Crypto Investment Lead" },
  workflow: {
    messageType: "position",
    round: 1,
    taskId: "task-1",
  },
} satisfies WorkflowChatMessage;

function renderCard(message: WorkflowChatMessage = MESSAGE) {
  return render(
    <DiscussionMessageCard colorClass={null} message={message}>
      <p>{message.text}</p>
    </DiscussionMessageCard>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DiscussionMessageCard response actions", () => {
  it("opens the selected response in a dialog and returns focus after closing", async () => {
    const user = userEvent.setup();
    renderCard();
    renderCard({ ...MESSAGE, id: "another-message", text: "A different response." });
    const maximize = screen.getAllByRole("button", { name: "Maximize message" })[0];
    if (!maximize) throw new Error("The first response must have a Maximize button");

    await user.click(maximize);

    const dialog = await screen.findByRole("dialog", { name: MESSAGE.speaker?.name });
    expect(dialog).toHaveTextContent("The market assumptions need stronger evidence.");
    expect(dialog).not.toHaveTextContent("A different response.");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(maximize).toHaveFocus();
  });

  it("closes the reading dialog with Escape", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "Maximize message" }));
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("copies the raw response text to the clipboard", async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole("button", { name: "Copy the response" }));

    expect(await navigator.clipboard.readText()).toBe(MESSAGE.text);
    expect(
      await screen.findByRole("button", { name: "Response copied" }),
    ).toBeInTheDocument();
  });

  it("downloads the response as a markdown file named for the speaker", async () => {
    const user = userEvent.setup();
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:response");
    const revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    renderCard();
    await user.click(
      screen.getByRole("button", { name: "Download as MD file" }),
    );

    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    const anchor = click.mock.contexts[0];
    if (!(anchor instanceof HTMLAnchorElement)) {
      throw new Error("the download did not click an anchor element");
    }
    expect(anchor.download).toBe("crypto-investment-lead-2026-05-01-12-00.md");
    expect(anchor.href).toBe("blob:response");

    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(await (blob as Blob).text()).toBe(MESSAGE.text);
    expect((blob as Blob).type).toContain("text/markdown");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:response");
  });

  it("still shows the message time beside the actions", () => {
    renderCard();

    expect(screen.getByLabelText(/Message time:/)).toHaveAttribute(
      "dateTime",
      MESSAGE.createdAt,
    );
  });
});

describe("messageMarkdownFileName", () => {
  it("slugifies the speaker name and stamps the message minute", () => {
    expect(
      messageMarkdownFileName("Crypto Risk & Compliance", "2026-05-01T12:00:02.000Z"),
    ).toBe("crypto-risk-compliance-2026-05-01-12-00.md");
  });

  it("falls back to a stable name when the speaker and time are unusable", () => {
    expect(messageMarkdownFileName("///", "not-a-date")).toBe("response.md");
  });
});
