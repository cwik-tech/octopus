/**
 * A publication holds the Agent's lock for the whole package, not just the
 * folder it starts with.
 *
 * The skill updater rechecks the Agent's revision and then writes, all under
 * this lock. If a publication released it after creating the folder, the next
 * writer in the queue would be handed an Agent that has no persona and no
 * skills yet — and would go on to check and write against that.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { commitAgent } from "../../domains/agent-generator/commit-agent.js";
import { withAgentNameMutationLock } from "../../domains/agent-generator/agent-name-reservation.js";

const AGENT = "market-analyst";
const SKILL = "market-sizing";

interface PackageSnapshot {
  persona: boolean;
  scratchPad: boolean;
  skill: boolean;
}

test("the next writer of an Agent finds the whole package, never half of it", async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-commit-lock-"));
  try {
    const agentFolder = path.join(repoRoot, "agents", AGENT);
    const snapshot = (): PackageSnapshot => ({
      persona: fs.existsSync(path.join(agentFolder, `${AGENT}.md`)),
      scratchPad: fs.existsSync(path.join(agentFolder, "experience", "scratch-pad.md")),
      skill: fs.existsSync(path.join(agentFolder, "skills", SKILL, "SKILL.md")),
    });

    let observed: PackageSnapshot | null = null;
    let queued: Promise<void> | null = null;

    await commitAgent({
      repoRoot,
      approvedName: AGENT,
      personaMarkdown: `---\nname: ${AGENT}\ndescription: Sizes markets.\n---\n\n# ${AGENT}\n`,
      skillPaths: [],
      generatedSkills: [{
        name: SKILL,
        body: [
          "---",
          `name: ${SKILL}`,
          "description: >",
          "  Size a market from the bottom up. Use when a business case needs a",
          "  defensible number.",
          "---",
          "",
          "# Market sizing",
          "",
          "Work bottom up.",
          "",
        ].join("\n"),
      }],
      // Queued from inside the lock, so it is the very next writer in line.
      onPersistenceBoundary: (boundary) => {
        if (boundary !== "after_agent_folder_created" || queued) return;
        queued = withAgentNameMutationLock(repoRoot, AGENT, async () => {
          observed = snapshot();
        });
      },
    });

    assert.ok(queued, "fixture check: a second writer queued behind the publication");
    await queued;
    assert.deepEqual(
      observed,
      { persona: true, scratchPad: true, skill: true },
      "the next writer must not be handed an Agent that is still being written",
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
