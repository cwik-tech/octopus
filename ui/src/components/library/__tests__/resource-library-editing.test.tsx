import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";

import { ResourceLibraryPanel } from "@/components/library/resource-library-panel";
import * as client from "@/lib/clients/resource-library-client";
import type {
  ResourceLibraryBrowserSnapshot,
  ResourceLibrarySkillRevision,
} from "@contracts/resource-library";

vi.mock("@/lib/clients/resource-library-client", () => ({
  readResourceLibraryRevisionFiles: vi.fn(),
  createResourceSkill: vi.fn(),
  saveResourceSkillRevision: vi.fn(),
  restoreResourceSkillRevision: vi.fn(),
  setResourceSkillArchived: vi.fn(),
  attachResourceSkill: vi.fn(),
  detachResourceSkill: vi.fn(),
  selectResourceAgentRevision: vi.fn(),
}));

const initialRevision = makeRevision("revision-1", 1);
const initialSnapshot: ResourceLibraryBrowserSnapshot = {
  schemaVersion: 1,
  generation: 1,
  generationId: "generation-1",
  skills: [{
    id: "skill-1",
    slug: "research",
    displayName: "research",
    description: "Researches exactly.",
    origin: "library",
    provenance: [],
    archived: false,
    currentRevisionId: initialRevision.id,
    revisions: [initialRevision],
  }],
  agents: [
    { id: "alpha", attachments: [{ agentId: "alpha", skillId: "skill-1", revisionId: initialRevision.id, alias: "research" }] },
    { id: "beta", attachments: [{ agentId: "beta", skillId: "skill-1", revisionId: initialRevision.id, alias: "research" }] },
  ],
  teams: [],
  packages: [],
  agentDetails: [
    { name: "alpha", skills: ["research"], usedInTeams: [] },
    { name: "beta", skills: ["research"], usedInTeams: [] },
  ],
  teamDetails: [],
};
let latestRevision: ResourceLibrarySkillRevision | null = null;

function Harness() {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  return (
    <ResourceLibraryPanel
      section="skills"
      snapshot={snapshot}
      selectedResourceId="skill-1"
      onResourceSelect={() => undefined}
      onRefresh={() => {
        if (!latestRevision) return;
        const nextRevision = latestRevision;
        setSnapshot((current) => ({
          ...current,
          generation: current.generation + 1,
          generationId: `generation-${current.generation + 1}`,
          skills: current.skills.map((skill) => ({
            ...skill,
            currentRevisionId: nextRevision.id,
            revisions: [...skill.revisions, nextRevision],
          })),
        }));
      }}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  latestRevision = null;
  vi.mocked(client.readResourceLibraryRevisionFiles).mockImplementation(async ({ revisionId }) => ({
    files: revisionFiles(revisionId === "revision-1" || revisionId === "revision-3" ? "old script" : "new script"),
  }));
  vi.mocked(client.saveResourceSkillRevision).mockImplementation(async (input) => {
    latestRevision = makeRevision("revision-2", 2, input.files);
    return { skill: initialSnapshot.skills[0]!, revision: latestRevision, unchanged: false };
  });
  vi.mocked(client.restoreResourceSkillRevision).mockImplementation(async () => {
    latestRevision = makeRevision("revision-3", 3, revisionFiles("old script"), "revision-1");
    return { skill: initialSnapshot.skills[0]!, revision: latestRevision, unchanged: false };
  });
});

it("publishes a staged script edit and restores it as a new revision without moving other Agent pins", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(await screen.findByRole("button", { name: "scripts/run.mjs" }));
  expect(screen.getByText("old script")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Edit" }));
  await user.clear(screen.getByRole("textbox", { name: "Contents for file 2" }));
  await user.type(screen.getByRole("textbox", { name: "Contents for file 2" }), "new script", { skipClick: true });
  await user.type(screen.getByLabelText("Change note"), "Update only the script");
  await user.click(screen.getByRole("button", { name: "Save revision" }));

  expect(client.saveResourceSkillRevision).toHaveBeenCalledWith(expect.objectContaining({
    skillId: "skill-1",
    baseRevisionId: "revision-1",
    expectedGeneration: 1,
    changeNote: "Update only the script",
  }));
  expect(await screen.findByLabelText("Revision 2 actions")).toBeInTheDocument();
  const revisionOneActions = await screen.findByLabelText("Revision 1 actions");
  await user.click(within(revisionOneActions).getByRole("button", { name: "Restore" }));

  expect(client.restoreResourceSkillRevision).toHaveBeenCalledWith(expect.objectContaining({
    skillId: "skill-1",
    sourceRevisionId: "revision-1",
    baseRevisionId: "revision-2",
    expectedGeneration: 2,
  }));
  expect(await screen.findByLabelText("Revision 3 actions")).toBeInTheDocument();
  expect(initialSnapshot.agents.find((agent) => agent.id === "beta")?.attachments[0]?.revisionId).toBe("revision-1");
});

it("discards a cancelled draft instead of publishing it", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  await user.clear(screen.getByRole("textbox", { name: "Contents for file 2" }));
  await user.type(screen.getByRole("textbox", { name: "Contents for file 2" }), "discard me", { skipClick: true });
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(client.saveResourceSkillRevision).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByRole("textbox", { name: "Contents for file 2" })).toHaveValue("old script\n");
});

function revisionFiles(script: string) {
  return [
    { path: "SKILL.md", contentBase64: encode("# Instructions\n"), executable: false },
    { path: "scripts/run.mjs", contentBase64: encode(`${script}\n`), executable: true },
  ];
}

function makeRevision(
  id: string,
  sequence: number,
  files = revisionFiles("old script"),
  restoredFromRevisionId?: string,
): ResourceLibrarySkillRevision {
  return {
    id,
    sequence,
    parentRevisionId: sequence === 1 ? null : `revision-${sequence - 1}`,
    digest: `sha256:${String(sequence).repeat(64)}`,
    createdAt: "2026-10-18T10:00:00.000Z",
    changeNote: `Revision ${sequence}`,
    ...(restoredFromRevisionId ? { restoredFromRevisionId } : {}),
    files: files.map((file) => ({
      path: file.path,
      sha256: `sha256:${"a".repeat(64)}`,
      sizeBytes: 20,
      executable: file.executable,
    })),
  };
}

function encode(value: string): string {
  return btoa(value);
}
