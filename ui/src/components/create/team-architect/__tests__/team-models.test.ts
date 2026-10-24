import { describe, expect, it } from "vitest";

import type { AppDefaultModelState } from "@contracts/agent-model-selection";
import type { TeamRosterAgent } from "@/lib/models/team-builder-model";
import {
  formatAgentModelLabel,
  formatRuntimeSource,
  resolveRosterAgentRuntime,
} from "../team-models";

const APP_DEFAULT: AppDefaultModelState = {
  status: "available",
  provider: "openai",
  model: "gpt-5",
};

describe("roster runtime resolution", () => {
  it("shows the agent's own pair, from the agent file alone", () => {
    const runtime = resolveRosterAgentRuntime(
      rosterAgent({ personaProvider: "codex", personaModel: "gpt-5.6-sol" }),
      APP_DEFAULT,
    );

    expect(runtime).toEqual({
      provider: "codex",
      model: "gpt-5.6-sol",
      source: "agent",
    });
    expect(formatRuntimeSource(runtime.source)).toBe("agent model");
  });

  it("shows the app default for an agent that chose nothing", () => {
    const runtime = resolveRosterAgentRuntime(rosterAgent({}), APP_DEFAULT);

    expect(runtime).toEqual({
      provider: "openai",
      model: "gpt-5",
      source: "app-default",
    });
    expect(formatRuntimeSource(runtime.source)).toBe("app default");
  });

  it("ignores a retired roster override entirely", () => {
    // The legacy fields are still readable so they can be reported, but the
    // roster must never present one as the pair the run will use.
    const runtime = resolveRosterAgentRuntime(
      rosterAgent({
        personaProvider: "codex",
        personaModel: "gpt-5.6-sol",
        legacyProvider: "anthropic",
        legacyModel: "claude",
      } as Partial<TeamRosterAgent>),
      APP_DEFAULT,
    );

    expect(runtime.provider).toBe("codex");
    expect(runtime.model).toBe("gpt-5.6-sol");
  });

  it("names an unset default instead of showing some other model", () => {
    const runtime = resolveRosterAgentRuntime(rosterAgent({}), {
      status: "unset",
    });

    expect(runtime.model).toBe("");
    expect(runtime.provider).toBe("");
    expect(runtime.error?.code).toBe("app-default-unset");
    expect(formatRuntimeSource(runtime.source)).toBe("not resolved");
  });

  it("names a configured default that cannot currently run", () => {
    const runtime = resolveRosterAgentRuntime(rosterAgent({}), {
      status: "unavailable",
      provider: "openai",
      model: "gpt-5",
    });

    expect(runtime.error?.code).toBe("app-default-unavailable");
    expect(runtime.error?.provider).toBe("openai");
    expect(runtime.error?.model).toBe("gpt-5");
  });

  it("reports a half-configured agent rather than guessing a provider", () => {
    const runtime = resolveRosterAgentRuntime(
      rosterAgent({ personaModel: "claude" }),
      APP_DEFAULT,
    );

    expect(runtime.error?.code).toBe("agent-model-without-provider");
  });
});

describe("labels", () => {
  it("formats a pair and an absent model", () => {
    expect(formatAgentModelLabel("openai", "gpt-5")).toBe("Openai / gpt-5");
    expect(formatAgentModelLabel("openai", "")).toBe("No model");
  });
});

function rosterAgent(overrides: Partial<TeamRosterAgent>): TeamRosterAgent {
  return {
    name: "analyst",
    type: "agent",
    role: "Examines evidence.",
    tier: "strategic",
    tools: [],
    referenced: true,
    ...overrides,
  };
}
