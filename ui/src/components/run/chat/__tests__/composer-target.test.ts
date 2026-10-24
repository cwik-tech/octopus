import { describe, expect, it } from "vitest";

import { resolveComposerTarget } from "../composer-target";

/**
 * Who a turn is addressed to, derived from the draft and the standing target.
 *
 * A mention in the draft overrides the standing target: "@analyst summarize
 * this" goes to Analyst whatever the composer was pointed at before.
 */

const AGENTS = [{ name: "analyst" }, { name: "editor" }];

function resolve(overrides: Partial<Parameters<typeof resolveComposerTarget>[0]>) {
  return resolveComposerTarget({
    text: "",
    targetTeamId: null,
    mentionAgents: AGENTS,
    mentionAgentsReady: true,
    ...overrides,
  });
}

describe("resolveComposerTarget", () => {
  it("lets a mention in the draft override the standing selection", () => {
    const resolved = resolve({ text: "@analyst summarize this" });

    expect(resolved.target).toEqual({ kind: "agents", agentNames: ["analyst"] });
  });

  it("keeps the standing selection when the draft mentions nobody", () => {
    const resolved = resolve({
      text: "summarize this",
      target: { kind: "team", teamId: "writing-team" },
    });

    expect(resolved.target).toEqual({ kind: "team", teamId: "writing-team" });
  });

  it("ignores mentions inside a Team turn, whose roster is the Team's", () => {
    const resolved = resolve({
      text: "@analyst summarize this",
      targetTeamId: "writing-team",
      target: { kind: "team", teamId: "writing-team" },
    });

    expect(resolved.target).toEqual({ kind: "team", teamId: "writing-team" });
  });

  it("reports mentions it cannot resolve yet rather than guessing", () => {
    const resolved = resolve({
      text: "@analyst summarize this",
      mentionAgentsReady: false,
    });

    expect(resolved.mentionsPending).toBe(true);
    expect(resolved.target).toBeUndefined();
  });

  it("reports an overflowing roster", () => {
    const many = Array.from({ length: 9 }, (_unused, index) => ({
      name: `agent-${index}`,
    }));
    const resolved = resolveComposerTarget({
      text: many.map((agent) => `@${agent.name}`).join(" "),
      targetTeamId: null,
      mentionAgents: many,
      mentionAgentsReady: true,
    });

    expect(resolved.overflow).toBe(true);
  });

  it("lets a routed retry name its own addressee and consult nothing else", () => {
    const resolved = resolve({
      text: "@analyst summarize this",
      routedTo: { kind: "team", teamId: "writing-team" },
      target: { kind: "agents", agentNames: ["editor"] },
    });

    expect(resolved.target).toEqual({ kind: "team", teamId: "writing-team" });
  });
});
