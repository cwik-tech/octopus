/**
 * Every writer of one Agent package takes the same lock.
 *
 * The skill updater holds the Agent-name mutation lock across its revision
 * recheck and all of its writes. That is only worth anything if the other
 * writers of the same package take the same lock: an editor save or a package
 * overwrite that slips in between the recheck and the writes leaves the update
 * publishing over content it never checked.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { withAgentNameMutationLock } from "../../domains/agent-generator/agent-name-reservation.js";
import { savePersona } from "../../domains/agent-generator/commit-agent.js";

const AGENT = "michigan-contract-lawyer";

function seedAgent(): { repoRoot: string; personaPath: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-writer-lock-"));
  const personaPath = path.join(repoRoot, "agents", AGENT, `${AGENT}.md`);
  fs.mkdirSync(path.dirname(personaPath), { recursive: true });
  fs.writeFileSync(personaPath, "---\nname: michigan-contract-lawyer\n---\n\nORIGINAL\n");
  return { repoRoot, personaPath };
}

test("a persona save waits for whoever holds the Agent's lock", async () => {
  const { repoRoot, personaPath } = seedAgent();
  try {
    const order: string[] = [];
    let announceHeld!: () => void;
    const acquired = new Promise<void>((resolve) => {
      announceHeld = resolve;
    });

    const holder = withAgentNameMutationLock(repoRoot, AGENT, async () => {
      announceHeld();
      // A real filesystem round-trip while the lock is held. A writer that
      // does not take this lock has already landed by the time it returns.
      await fs.promises.readFile(personaPath, "utf8");
      await fs.promises.readFile(personaPath, "utf8");
      order.push(`held:${fs.readFileSync(personaPath, "utf8").includes("ORIGINAL")}`);
    });
    await acquired;

    const saved = savePersona({
      repoRoot,
      agentName: AGENT,
      personaMarkdown: "---\nname: michigan-contract-lawyer\n---\n\nREPLACED\n",
    }).then(() => order.push("saved"));

    await Promise.all([holder, saved]);

    assert.deepEqual(
      order,
      ["held:true", "saved"],
      "the persona must still be the original while somebody else holds the lock",
    );
    assert.match(fs.readFileSync(personaPath, "utf8"), /REPLACED/);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
