/**
 * The renderer that runs when the server hands back a placeholder draft.
 *
 * `agent-architect-panel.tsx` calls this when the architect came back with
 * nothing usable, and what it renders is written to disk as the Agent's persona
 * like any other. So it is an authoring site: a grade it writes is a grade in
 * somebody's new file, and a pair it writes would pin the Agent to whatever
 * model happened to be running.
 */
import { describe, expect, it } from "vitest";

import { repairPlaceholderAgentDraft } from "@/lib/utils/agent-draft-inference";
import type { DraftAgentResponse } from "@/lib/models/agent-generator-model";

/** A draft the panel treats as a placeholder, so the local repair runs. */
function placeholderDraft(): DraftAgentResponse {
  return {
    jobId: "job-placeholder",
    suggestedName: "agent-1779938554062",
    personaMarkdown:
      "---\nname: agent-1779938554062\n---\n\nPlaceholder persona — edit this file.\n",
    meta: { model: "fallback", fallback: true, reason: "architect unavailable" },
  };
}

/** The frontmatter block alone, so a body mention cannot satisfy a check. */
function frontmatterOf(markdown: string): string {
  return /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? "";
}

describe("locally repaired Agent drafts", () => {
  it("writes a persona with no grade and no runtime pair", () => {
    const repaired = repairPlaceholderAgentDraft(placeholderDraft(), [
      {
        role: "user",
        text: "I need an agent that validates business hypotheses with evidence.",
      },
    ]);

    expect("personaMarkdown" in repaired).toBe(true);
    if (!("personaMarkdown" in repaired)) return;
    const frontmatter = frontmatterOf(repaired.personaMarkdown);
    expect(frontmatter).not.toMatch(/^tier:/m);
    expect(frontmatter).not.toMatch(/^provider:/m);
    expect(frontmatter).not.toMatch(/^model:/m);
    // Still a usable persona: the repair is what makes the draft worth keeping.
    expect(frontmatter).toMatch(/^name: .+$/m);
    expect(frontmatter).toMatch(/^description: .+$/m);
    expect(frontmatter).toMatch(/^thinking: medium$/m);
    expect(repaired.personaMarkdown).toMatch(/## Purpose/);
    expect(repaired.generatedSkills?.length).toBeGreaterThan(0);
  });

  it("leaves a draft the architect actually produced alone", () => {
    const real: DraftAgentResponse = {
      jobId: "job-real",
      suggestedName: "hypothesis-validator",
      personaMarkdown: "---\nname: hypothesis-validator\n---\n\n# Validator\n",
      generatedSkills: [{ name: "validation", body: "---\nname: validation\n---\n" }],
      meta: { model: "gpt-5.2", fallback: false },
    };

    expect(repairPlaceholderAgentDraft(real, [])).toEqual(real);
  });
});
