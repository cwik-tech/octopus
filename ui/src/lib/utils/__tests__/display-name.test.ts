import { describe, expect, it } from "vitest";

import { formatDisplayName } from "@/lib/utils/display-name";

describe("formatDisplayName", () => {
  it.each([
    ["crazy-man", "Crazy Man"],
    ["discussion-to-writing3", "Discussion To Writing3"],
    ["problem_thinking_board", "Problem Thinking Board"],
    ["pragmatist", "Pragmatist"],
    ["AI safety review", "AI Safety Review"],
  ])("formats %s as %s", (storedName, displayName) => {
    expect(formatDisplayName(storedName)).toBe(displayName);
  });
});
