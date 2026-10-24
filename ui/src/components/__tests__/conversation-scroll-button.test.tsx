import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stickToBottomState = vi.hoisted(() => ({
  isAtBottom: false,
  scrollToBottom: vi.fn(),
}));

vi.mock("use-stick-to-bottom", () => {
  const StickToBottom = Object.assign(
    ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    {
      Content: ({ children }: { children?: React.ReactNode }) => (
        <div>{children}</div>
      ),
    },
  );

  return {
    StickToBottom,
    useStickToBottomContext: () => stickToBottomState,
  };
});

import { ConversationScrollButton } from "@/components/ai-elements/conversation";

describe("ConversationScrollButton", () => {
  beforeEach(() => {
    stickToBottomState.isAtBottom = false;
    stickToBottomState.scrollToBottom.mockClear();
  });

  it("has an accessible name and scrolls to the latest message", async () => {
    const user = userEvent.setup();
    render(<ConversationScrollButton />);

    const button = screen.getByRole("button", {
      name: "Scroll to latest message",
    });
    await user.click(button);

    expect(stickToBottomState.scrollToBottom).toHaveBeenCalledOnce();
  });
});
