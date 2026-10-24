import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getChatDefaults } from "../../services/chat-defaults-service.js";
import { RECEPTIONIST_DEFAULT } from "../../domains/sessions/chat-llm.js";
import { parseAgentFrontmatter } from "../../parsers/load-agent.js";

test("global provider setting is the default for every chat surface", () => {
  const selected = {
    provider: "connection:default-provider",
    model: "default-chat-model",
  };

  assert.deepEqual(getChatDefaults(process.cwd(), selected), {
    workflow: selected,
    agent: selected,
    team: selected,
    run: selected,
    // Reported alongside the defaults so the composer can name whoever will
    // actually answer; this repository ships the persona.
    frontDoorInstalled: true,
  });
});

/**
 * The Run composer sends a provider and model on every turn, seeded from this
 * default. "The persona file supplies the default" is therefore only true if
 * the default itself is read from the persona: otherwise a user who edits the
 * General Agent's model in Create changes a value nothing ever uses.
 */
test("the Run default comes from the front door's own persona", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-defaults-"));
  try {
    writeFrontDoor(repoRoot, {
      provider: "persona-provider",
      model: "persona-model",
    });

    assert.deepEqual(getChatDefaults(repoRoot).run, {
      provider: "persona-provider",
      model: "persona-model",
    });
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a repository without the front door keeps the Receptionist default", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-defaults-"));
  try {
    assert.deepEqual(getChatDefaults(repoRoot).run, RECEPTIONIST_DEFAULT);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("an explicit global provider still outranks the front door's persona", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-defaults-"));
  try {
    writeFrontDoor(repoRoot, {
      provider: "persona-provider",
      model: "persona-model",
    });
    const selected = { provider: "connection:chosen", model: "chosen-model" };

    assert.deepEqual(getChatDefaults(repoRoot, selected).run, selected);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

function writeFrontDoor(
  repoRoot: string,
  selection: { provider: string; model: string },
): void {
  const directory = path.join(repoRoot, "agents", "general-agent");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "general-agent.md"),
    [
      "---",
      "name: general-agent",
      "description: The Run front door.",
      "tier: orchestration",
      `provider: ${selection.provider}`,
      `model: ${selection.model}`,
      "thinking: low",
      "system: true",
      "---",
      "",
      "# General Agent",
      "",
    ].join("\n"),
  );
}

test("the shipped front door leaves the Run model to the app default", () => {
  const { frontmatter } = parseAgentFrontmatter(
    path.join(process.cwd(), "agents", "general-agent", "general-agent.md"),
  );
  assert.equal(frontmatter.provider, undefined);
  assert.equal(frontmatter.model, undefined);
  const selected = { provider: "codex", model: "gpt-6-astra" };
  assert.deepEqual(getChatDefaults(process.cwd(), selected).run, selected);
});

/**
 * A default nobody chose must not outrank a persona the user edited.
 *
 * `resolveDefaultModel` picks the first model in the catalog when no default is
 * stored, so on any machine with an enabled provider the composer is handed a
 * value that looks exactly like a user's choice. Treating that as an override
 * made the front door's persona model unreachable through the real route.
 */
test("an automatic catalog default does not outrank the front door's persona", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-defaults-"));
  try {
    writeFrontDoor(repoRoot, {
      provider: "persona-provider",
      model: "persona-model",
    });
    const automatic = {
      provider: "connection:first",
      model: "automatic-first-model",
    };

    const defaults = getChatDefaults(repoRoot, automatic, {
      globalDefaultSource: "automatic",
    });

    assert.deepEqual(defaults.run, {
      provider: "persona-provider",
      model: "persona-model",
    });
    assert.deepEqual(
      defaults.workflow,
      automatic,
      "the other surfaces keep the behaviour they already had",
    );
    assert.deepEqual(defaults.agent, automatic);
    assert.deepEqual(defaults.team, automatic);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

/**
 * The bug the persona read exists to fix, in the shape this repository ships.
 *
 * `codex`/`default` is the historical "nothing chosen" sentinel
 * (`contracts/agent-model-selection.ts:16-19`), and it is what the shipped
 * front door declares. Read literally it looks like a deliberate pair, so it
 * was handed to the composer ahead of the default the user's own providers
 * produced, and then recorded afterwards as the front door's own choice.
 *
 * Only a case with a fallback of its own can tell the two readings apart:
 * everywhere else the fallback is `RECEPTIONIST_DEFAULT`, which *is*
 * `codex`/`default`, so both readings return the same pair.
 */
test("the front door's legacy codex/default pair is not a choice", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-defaults-"));
  try {
    writeFrontDoor(repoRoot, {
      provider: "codex",
      model: "default",
    });
    const automatic = {
      provider: "connection:first",
      model: "automatic-first-model",
    };

    assert.deepEqual(
      getChatDefaults(repoRoot, automatic, { globalDefaultSource: "automatic" })
        .run,
      automatic,
      "the sentinel pair must not displace the provider layer's own default",
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("a stored default the user chose still outranks the persona", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-defaults-"));
  try {
    writeFrontDoor(repoRoot, {
      provider: "persona-provider",
      model: "persona-model",
    });
    const stored = { provider: "connection:chosen", model: "chosen-model" };

    assert.deepEqual(
      getChatDefaults(repoRoot, stored, { globalDefaultSource: "stored" }).run,
      stored,
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("an automatic default still governs a repository with no front door", () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-defaults-"));
  try {
    const automatic = {
      provider: "connection:first",
      model: "automatic-first-model",
    };

    assert.deepEqual(
      getChatDefaults(repoRoot, automatic, { globalDefaultSource: "automatic" })
        .run,
      automatic,
      "nothing changes where there is no persona to prefer",
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
