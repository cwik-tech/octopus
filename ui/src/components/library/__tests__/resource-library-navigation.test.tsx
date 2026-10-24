import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";

import { LibraryResourcesSidebar } from "@/components/sidebar/library-resources-sidebar";
import { ResourceLibraryPanel } from "@/components/library/resource-library-panel";
import type { LibrarySection } from "@/hooks/use-library-workspace-controller";
import type { ResourceLibraryBrowserSnapshot } from "@contracts/resource-library";

const revision = {
  id: "revision-1",
  sequence: 1,
  parentRevisionId: null,
  digest: `sha256:${"a".repeat(64)}`,
  createdAt: "2026-10-18T10:00:00.000Z",
  changeNote: "Initial skill",
  files: [{ path: "SKILL.md", sha256: `sha256:${"b".repeat(64)}`, sizeBytes: 20, executable: false }],
};
const snapshot: ResourceLibraryBrowserSnapshot = {
  schemaVersion: 1,
  generation: 1,
  generationId: "generation-1",
  skills: [{
    id: "skill-1",
    slug: "research",
    displayName: "research",
    description: "Researches exactly.",
    origin: "legacy",
    provenance: ["agents/spec-alpha/skills/research"],
    archived: false,
    currentRevisionId: revision.id,
    revisions: [revision],
  }],
  agents: [{
    id: "spec-alpha",
    attachments: [{ agentId: "spec-alpha", skillId: "skill-1", revisionId: revision.id, alias: "research" }],
  }],
  teams: [],
  packages: [],
  agentDetails: [{
    name: "spec-alpha",
    skills: ["research"],
    usedInTeams: [{ teamId: "board-team", teamName: "board-team" }],
  }],
  teamDetails: [{
    id: "board-team",
    name: "board-team",
    tags: [],
    agentCount: 1,
    agents: [{ name: "board-lead", role: "Lead" }],
  }],
};

vi.mock("@/lib/clients/resource-library-client", () => ({
  readResourceLibraryRevisionFiles: vi.fn(async () => ({
    files: [
      { path: "SKILL.md", contentBase64: Buffer.from("# Shared instructions\n").toString("base64"), executable: false },
      { path: "scripts/run.mjs", contentBase64: Buffer.from("console.log('shared');\n").toString("base64"), executable: true },
    ],
  })),
}));

function Harness() {
  const [section, setSection] = useState<LibrarySection>("projects");
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(null);
  return (
    <>
      <LibraryResourcesSidebar
        section={section}
        snapshot={snapshot}
        loading={false}
        error={null}
        selectedResourceId={selectedResourceId}
        projects={[]}
        projectsLoading={false}
        projectsError={null}
        selectedProjectId={null}
        onSectionChange={(next) => {
          setSection(next);
          setSelectedResourceId(null);
        }}
        onResourceSelect={setSelectedResourceId}
        onCreateProject={() => undefined}
        onOverviewSelect={() => undefined}
        onProjectSelect={() => undefined}
      />
      {section !== "projects" ? (
        <ResourceLibraryPanel
          section={section}
          snapshot={snapshot}
          selectedResourceId={selectedResourceId}
        />
      ) : null}
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

it("navigates every resource section and displays the selected resource", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const sections = screen.getByRole("tablist", { name: "Library sections" });
  expect(screen.getByRole("tab", { name: "Projects", selected: true })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^All projects/ })).toBeInTheDocument();

  await user.click(screen.getByRole("tab", { name: "Skills" }));
  await user.click(screen.getByRole("button", { name: /^research/ }));
  await waitFor(() => expect(screen.getByRole("region", { name: "Skill library" })).toHaveTextContent("Shared instructions"));
  expect(screen.getByRole("region", { name: "Skill library" })).toHaveTextContent("scripts/run.mjs");

  await user.click(screen.getByRole("tab", { name: "Agents" }));
  await user.click(screen.getByRole("button", { name: /^Spec Alpha/ }));
  expect(screen.getByRole("region", { name: "Agent library" })).toHaveTextContent("spec-alpha");
  expect(screen.getByRole("region", { name: "Agent library" })).toHaveTextContent("research");

  await user.click(screen.getByRole("tab", { name: "Teams" }));
  await user.click(screen.getByRole("button", { name: /^Board Team/ }));
  expect(screen.getByRole("region", { name: "Team library" })).toHaveTextContent("board-team");
  expect(screen.getByRole("region", { name: "Team library" })).toHaveTextContent("board-lead");
  expect(sections).toBeInTheDocument();
});

it("switches Library sections using the tab strip keyboard controls", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  screen.getByRole("tab", { name: "Projects" }).focus();
  await user.keyboard("{ArrowRight}{Enter}");
  expect(screen.getByRole("tab", { name: "Skills", selected: true })).toHaveFocus();
  expect(screen.getByRole("region", { name: "Skill library" })).toBeInTheDocument();
});
