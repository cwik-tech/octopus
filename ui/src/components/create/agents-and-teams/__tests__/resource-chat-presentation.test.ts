import { describe, expect, it } from "vitest";
import { withoutProposedDiagrams } from "../resource-chat-presentation";

describe("Architect diagram display", () => {
  it.each([
    ["Before\n```mermaid\ngraph LR\nA-->B\n```\nAfter", "Before\nAfter"],
    ["Before\n~~~mermaid\ngraph LR\n~~~\nAfter", "Before\nAfter"],
    ["Before\n```mermaid\ngraph LR\nA-->", "Before"],
    ["Before\n````mermaid\ngraph LR\n```\nA-->B\n````\nAfter", "Before\nAfter"],
    ["```text\n```mermaid\n```\nAfter", "```text\n```mermaid\n```\nAfter"],
    ["A Mermaid diagram is not a saved workflow.", "A Mermaid diagram is not a saved workflow."],
  ])("hides only proposed diagram blocks: %s", (source, expected) => {
    expect(withoutProposedDiagrams(source)).toBe(expected);
  });
});
