import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import WorkflowGeneratorChat from "@/components/create/workflow-generator-chat";
import {
  EMPTY_STREAMED_TURN,
  applyStreamDelivery,
  type StreamedTurn,
} from "@/lib/chat/streamed-turn";

const REPLY_ID = "architect:0";

function streamed(...texts: readonly string[]): StreamedTurn {
  return texts.reduce<StreamedTurn>(
    (current, text) =>
      applyStreamDelivery(current, {
        type: "delta",
        channelId: "channel",
        cursor: 0,
        replyId: REPLY_ID,
        channel: "text",
        text,
      }),
    EMPTY_STREAMED_TURN,
  );
}

function renderChat(streamedTurn: StreamedTurn) {
  return render(
    <WorkflowGeneratorChat
      history={[{ role: "user", text: "Design me a reviewer." }]}
      submitting
      error={null}
      onSubmit={() => {}}
      title="Agent Architect"
      streamedTurn={streamedTurn}
    />,
  );
}

describe("architect chat streaming", () => {
  it("shows the reply growing instead of the thinking indicator", () => {
    const { rerender } = renderChat(streamed("Kestrel"));

    expect(screen.getByTestId("streaming-reply")).toHaveTextContent("Kestrel");
    // A spinner alongside a reply that is already arriving tells the user the
    // opposite of what the screen shows.
    expect(
      screen.queryByLabelText("Architect is thinking"),
    ).not.toBeInTheDocument();

    rerender(
      <WorkflowGeneratorChat
        history={[{ role: "user", text: "Design me a reviewer." }]}
        submitting
        error={null}
        onSubmit={() => {}}
        title="Agent Architect"
        streamedTurn={streamed("Kestrel", " and Marlin")}
      />,
    );

    expect(screen.getByTestId("streaming-reply")).toHaveTextContent(
      "Kestrel and Marlin",
    );
  });

  it("keeps the thinking indicator while no reply text has arrived", () => {
    renderChat(EMPTY_STREAMED_TURN);

    expect(screen.queryByTestId("streaming-reply")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Architect is thinking")).toBeInTheDocument();
  });

  it("says so when the preview lost frames rather than showing a partial answer as the reply", () => {
    const lost = applyStreamDelivery(streamed("Kestrel"), {
      type: "gap",
      channelId: "channel",
      cursor: 1,
      replyId: REPLY_ID,
      missingProducerFrom: 1,
      missingProducerTo: 2,
    });
    renderChat(lost);

    expect(screen.getByTestId("streaming-reply")).toHaveTextContent(
      /Live preview unavailable/i,
    );
    expect(screen.getByTestId("streaming-reply")).not.toHaveTextContent(
      "Kestrel",
    );
  });
});
