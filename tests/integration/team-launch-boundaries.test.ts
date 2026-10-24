/**
 * Every way a team can be launched refuses one that is still being built.
 *
 * The shared contract resolver covers delegated launches, and that is not all
 * of them. Team Chat materializes its own wrapper workflow and reads the team
 * config itself; workflow validation reads it again through `parseTeamConfig`
 * and reported no errors at all. Both would admit an unfinished team: a shell
 * with no roster that fails at run time for a reason the user did not cause.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ensureTeamChatTarget } from "../../services/team-chat-target.js";
import { validateWorkflowTemplate } from "../../workflows/validation.js";
import { parseTeamRegistry } from "../../parsers/team-registry.js";
import type { WorkflowTemplate } from "../../workflows/types.js";

const TEAM_ID = "half-built";

/** A repository holding one team, built or still building. */
function makeRepo(building: boolean): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "launch-boundaries-"));
  const teamDir = path.join(repoRoot, "teams", TEAM_ID);
  fs.mkdirSync(path.join(teamDir, "agents", "alpha"), { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, "agents", "alpha", "alpha.md"),
    "---\nname: alpha\ndescription: d\ntier: strategic\n---\n\n# alpha\n",
  );
  fs.writeFileSync(
    path.join(teamDir, "team.yaml"),
    [
      "team:",
      `  name: "${TEAM_ID}"`,
      "  description: Still being assembled.",
      ...(building ? ["  building: true"] : []),
      "workflow:",
      "  entry_level: setup",
      "  invocation_modes:",
      "    - user",
      "  user_facing: true",
      "agents:",
      '  - name: "alpha"',
      "    type: agent",
      "    role: Alpha.",
      "    tools: []",
      '    agent_file: "./agents/alpha/alpha.md"',
      "levels:",
      "  - id: setup",
      "    name: Setup",
      "    order: 0",
      "    stage:",
      "      type: chain",
      "      sequence:",
      '        - "alpha"',
      "gates: []",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(repoRoot, "teams.yaml"),
    [
      `${TEAM_ID}:`,
      "  type: team",
      "  description: Still being assembled.",
      `  team_path: ./teams/${TEAM_ID}`,
      "",
    ].join("\n"),
  );
  fs.mkdirSync(path.join(repoRoot, "workflows", "user-generated"), {
    recursive: true,
  });
  fs.writeFileSync(path.join(repoRoot, "workflows", "registry.yaml"), "");
  return repoRoot;
}

function withRepo(building: boolean, fn: (repoRoot: string) => void | Promise<void>) {
  const repoRoot = makeRepo(building);
  return Promise.resolve(fn(repoRoot)).finally(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });
}

/** A workflow whose only step runs the team. */
function workflowNaming(teamId: string): WorkflowTemplate {
  return {
    id: "runs-the-team",
    description: "Runs the team.",
    steps: [{
      id: "run",
      type: "team",
      team: teamId,
      input_artifact: "incoming-brief.md",
      result_artifact: "final-result.md",
    }],
    output: { from_step: "run", artifact: "final-result.md" },
  };
}

test("Team Chat refuses to materialize a target for a team still being built", async () => {
  await withRepo(true, async (repoRoot) => {
    await assert.rejects(
      () => ensureTeamChatTarget({ teamId: TEAM_ID }, { repoRootPath: repoRoot }),
      /still being built/iu,
    );
    // And nothing was written for it.
    assert.deepEqual(
      fs.readdirSync(path.join(repoRoot, "workflows", "user-generated")),
      [],
    );
  });
});

test("Team Chat materializes the same team once it is published", async () => {
  await withRepo(false, async (repoRoot) => {
    const target = await ensureTeamChatTarget(
      { teamId: TEAM_ID },
      { repoRootPath: repoRoot },
    );
    assert.ok(target.workflowId);
  });
});

test("workflow validation refuses a step naming a team still being built", async () => {
  await withRepo(true, (repoRoot) => {
    const registry = parseTeamRegistry(path.join(repoRoot, "teams.yaml"));
    const errors = validateWorkflowTemplate(
      workflowNaming(TEAM_ID),
      new Map(registry.entries.map((entry) => [entry.name, entry])),
    );
    assert.ok(
      errors.some((error) => /still being built/iu.test(error)),
      JSON.stringify(errors),
    );
  });
});

test("workflow validation accepts the same step once the team is published", async () => {
  await withRepo(false, (repoRoot) => {
    const registry = parseTeamRegistry(path.join(repoRoot, "teams.yaml"));
    const errors = validateWorkflowTemplate(
      workflowNaming(TEAM_ID),
      new Map(registry.entries.map((entry) => [entry.name, entry])),
    );
    assert.deepEqual(
      errors.filter((error) => /still being built/iu.test(error)),
      [],
    );
  });
});
