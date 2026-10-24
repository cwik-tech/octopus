import { describe, expect, it } from "vitest";

import {
  AGENT_CHAT_COLOR_CLASSES,
  AGENT_CHAT_COLOR_THEMES,
  agentAvatarColorClass,
  agentColorKey,
  buildAgentColorMap,
  buildAgentColorMapFromSpeakers,
} from "@/lib/utils/agent-chat-colors";
import type { ChatMessage } from "@/lib/models/session-model";

function agentMessage(
  id: string,
  speaker: { id: string; name: string } | null,
): ChatMessage {
  return {
    id,
    role: "assistant",
    text: `reply ${id}`,
    createdAt: "2026-05-01T12:00:00.000Z",
    ...(speaker ? { speaker: { type: "agent", id: speaker.id, name: speaker.name } } : {}),
  };
}

describe("agentColorKey", () => {
  it("prefers the id and falls back to the name", () => {
    expect(agentColorKey({ id: "contrarian", name: "Contrarian" })).toBe(
      "contrarian",
    );
    expect(agentColorKey({ name: "Contrarian" })).toBe("contrarian");
    expect(agentColorKey({ id: "Client-Lens" })).toBe("clientlens");
    expect(agentColorKey({})).toBe("");
  });
});

describe("buildAgentColorMap", () => {
  it("assigns a distinct color to each agent in first-appearance order", () => {
    const map = buildAgentColorMap([
      agentMessage("1", { id: "client-lens", name: "client-lens" }),
      agentMessage("2", { id: "contrarian", name: "contrarian" }),
    ]);

    expect(map.get("clientlens")).toBe(AGENT_CHAT_COLOR_CLASSES[0]);
    expect(map.get("contrarian")).toBe(AGENT_CHAT_COLOR_CLASSES[1]);
    expect(map.get("clientlens")).not.toBe(map.get("contrarian"));
  });

  it("assigns the same ordered palette directly from agent identities", () => {
    const map = buildAgentColorMapFromSpeakers([
      { id: "client-lens", name: "Client Lens" },
      { id: "contrarian", name: "Contrarian" },
      { id: "Client_Lens", name: "Client Lens" },
    ]);

    expect(map.size).toBe(2);
    expect(map.get("clientlens")).toBe(AGENT_CHAT_COLOR_CLASSES[0]);
    expect(map.get("contrarian")).toBe(AGENT_CHAT_COLOR_CLASSES[1]);
  });

  it("resolves the matching avatar theme from a heading color", () => {
    expect(agentAvatarColorClass(AGENT_CHAT_COLOR_CLASSES[2])).toBe(
      AGENT_CHAT_COLOR_THEMES[2]?.avatar,
    );
  });

  it("keeps one stable color per agent across repeated turns", () => {
    const map = buildAgentColorMap([
      agentMessage("1", { id: "client-lens", name: "client-lens" }),
      agentMessage("2", { id: "contrarian", name: "contrarian" }),
      agentMessage("3", { id: "client-lens", name: "client-lens" }),
    ]);

    expect(map.size).toBe(2);
    expect(map.get("clientlens")).toBe(AGENT_CHAT_COLOR_CLASSES[0]);
  });

  it("ignores non-agent speakers (receptionist / assistant)", () => {
    const map = buildAgentColorMap([
      {
        id: "r1",
        role: "assistant",
        text: "Hi, I'm the receptionist.",
        createdAt: "2026-05-01T12:00:00.000Z",
        speaker: { type: "assistant", id: "ai-assistant", name: "AI Assistant" },
      },
      agentMessage("2", { id: "client-lens", name: "client-lens" }),
    ]);

    expect(map.has("ai-assistant")).toBe(false);
    expect(map.get("clientlens")).toBe(AGENT_CHAT_COLOR_CLASSES[0]);
  });

  it("wraps around the palette once every color is used", () => {
    const messages = AGENT_CHAT_COLOR_CLASSES.map((_, index) =>
      agentMessage(String(index), {
        id: `agent-${index}`,
        name: `agent-${index}`,
      }),
    );
    messages.push(
      agentMessage("wrap", { id: "agent-wrap", name: "agent-wrap" }),
    );

    const map = buildAgentColorMap(messages);
    expect(map.get("agentwrap")).toBe(AGENT_CHAT_COLOR_CLASSES[0]);
  });
});

describe("General Agent color", () => {
  // The General Agent wears the theme's accent, so it follows the palette
  // instead of a fixed Tailwind hue.
  const generalAgentAccent = "text-primary-text";

  it("gives the General Agent the accent even when another agent speaks first", () => {
    const map = buildAgentColorMapFromSpeakers([
      { id: "contrarian", name: "Contrarian" },
      { id: "general-agent", name: "General Agent" },
    ]);

    expect(map.get("generalagent")).toBe(generalAgentAccent);
  });

  it("never gives the General Agent's accent to another agent", () => {
    const speakers = Array.from(
      { length: AGENT_CHAT_COLOR_CLASSES.length * 2 },
      (_, index) => ({ id: `agent-${index}` }),
    );

    const map = buildAgentColorMapFromSpeakers(speakers);

    expect([...map.values()]).not.toContain(generalAgentAccent);
  });

  it("shows the General Agent's avatar in the same accent as its name", () => {
    expect(agentAvatarColorClass(generalAgentAccent)).toBe(
      "border-primary/35 bg-accent text-primary-text",
    );
  });
});
