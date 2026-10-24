import { describe, expect, it } from "vitest";

import type { TeamBuilderDetail } from "@/lib/models/team-builder-model";
import {
  draftFromTeam,
  draftToInput,
  emptyDraft,
  sameTeamDraft,
} from "../team-draft";

describe("team drafts", () => {
  it("carries only team identity, description and tags", () => {
    // A team draft has no runtime settings left to carry: an agent runs with
    // its own provider/model, or with the application default.
    expect(emptyDraft()).toEqual({ id: "", description: "", tagsInput: "" });
  });

  it("ignores retired runtime settings on a legacy team and converts tags", () => {
    const draft = draftFromTeam(
      teamDetail({
        tags: ["research", "writing"],
        legacyDefaultProvider: "openai",
        legacyModels: {
          strategic: { model: "reasoner", thinking: "high", provider: "openai" },
        },
      }),
    );
    draft.tagsInput = " research, , writing , review ";

    expect(draftToInput(draft)).toEqual({
      id: "research-team",
      description: "Research team",
      tags: ["research", "writing", "review"],
    });
  });

  it("compares the fields a save actually writes", () => {
    const clean = emptyDraft();
    const unchanged = emptyDraft();
    const renamed = { ...clean, id: "renamed" };

    expect(sameTeamDraft(clean, unchanged)).toBe(true);
    expect(sameTeamDraft(clean, renamed)).toBe(false);
  });
});

function teamDetail(
  overrides: Partial<TeamBuilderDetail> = {},
): TeamBuilderDetail {
  return {
    id: "research-team",
    name: "research-team",
    description: "Research team",
    tags: [],
    agentCount: 0,
    revision: "sha256:fixture",
    teamPath: "teams/research-team",
    yaml: "",
    agents: [],
    warnings: [],
    ...overrides,
    health: overrides.health ?? { status: "ok", errors: [], warnings: [] },
  };
}
