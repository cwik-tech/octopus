/**
 * What the handoff bubble actually says.
 *
 * The label is the only account the user gets of an attempt that produced no
 * durable message. Describing a failed or cancelled step as completed is the
 * one thing this bubble must never do.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TeamStreamHandoffMessage } from "@/components/run/chat/chat-panel";

describe("team stream handoff message", () => {
  it("names the artifact when the step finished", () => {
    render(
      <TeamStreamHandoffMessage agentName="line-one" label="line-result.md" />,
    );

    expect(screen.getByTestId("stream-handoff")).toHaveTextContent(
      "line-result.md",
    );
  });

  it("says a failed step failed rather than completed", () => {
    render(<TeamStreamHandoffMessage agentName="line-one" label="failed" />);

    const bubble = screen.getByTestId("stream-handoff");
    expect(bubble).toHaveTextContent(/did not complete|failed/i);
    expect(bubble).not.toHaveTextContent(/step completed/i);
  });

  it("says a cancelled step was cancelled", () => {
    render(<TeamStreamHandoffMessage agentName="line-one" label="cancelled" />);

    const bubble = screen.getByTestId("stream-handoff");
    expect(bubble).toHaveTextContent(/cancel/i);
    expect(bubble).not.toHaveTextContent(/step completed/i);
  });

  it("shows why a failed step failed", () => {
    render(
      <TeamStreamHandoffMessage
        agentName="brief-builder"
        label="failed"
        detail="You've hit your provider usage limit. It resets on Sep 14, 2026 at 9:45 PM."
      />,
    );

    const bubble = screen.getByTestId("stream-handoff");
    expect(bubble).toHaveTextContent(/did not complete/i);
    expect(bubble).toHaveTextContent("It resets on Sep 14, 2026 at 9:45 PM.");
  });

  it("says a skipped step was skipped", () => {
    render(<TeamStreamHandoffMessage agentName="line-one" label="skipped" />);

    expect(screen.getByTestId("stream-handoff")).toHaveTextContent(/skip/i);
  });
})
