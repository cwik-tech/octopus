import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { SkillEditorDialog } from "@/components/library/skill-editor-dialog";

afterEach(() => vi.unstubAllGlobals());

it("saves the visible skill name when only its slug was changed", async () => {
  const user = userEvent.setup();
  let submitted: unknown;
  const revision = { id: "revision", sequence: 1, parentRevisionId: null, digest: `sha256:${"0".repeat(64)}`, createdAt: "2026-10-18T00:00:00.000Z", changeNote: "", files: [] };
  // Replace the network boundary to inspect the exact bytes sent by the editor.
  vi.stubGlobal("fetch", vi.fn(async (_input: unknown, options: RequestInit) => {
    submitted = JSON.parse(String(options.body));
    return new Response(JSON.stringify({ unchanged: false, skill: { id: "skill", slug: "planning", displayName: "Planning", description: "Planning", origin: "library", provenance: [], archived: false, currentRevisionId: "revision", revisions: [revision] }, revision }), { status: 201 });
  }));
  const onSaved = vi.fn();
  render(<SkillEditorDialog open expectedGeneration={1} onOpenChange={() => undefined} onSaved={onSaved} />);

  await user.clear(screen.getByLabelText("Skill slug"));
  await user.type(screen.getByLabelText("Skill slug"), "planning");
  expect(screen.getByLabelText("Contents for file 1")).toHaveValue(
    "---\nname: planning\ndescription: Explains the task. Use when the task needs this skill.\n---\n\n# Instructions\n",
  );
  await user.click(screen.getByRole("button", { name: "Save revision" }));

  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(submitted).toEqual(expect.objectContaining({
    slug: "planning",
    files: [{ path: "SKILL.md", executable: false, contentBase64: btoa(
      "---\nname: planning\ndescription: Explains the task. Use when the task needs this skill.\n---\n\n# Instructions\n",
    ) }],
  }));
});
