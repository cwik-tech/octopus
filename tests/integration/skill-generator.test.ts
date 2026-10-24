/**
 * Authoring one `SKILL.md` from an instruction, with one bounded repair.
 *
 * The provider is a real loopback HTTP server, because what is under test is
 * partly the conversation: what the author is given for an update, what the
 * repair request says, and how many calls the boundary is allowed to make. A
 * replaced function could not observe any of that.
 *
 * The document a repair produces is the only one that has to conform. The
 * document the Agent has now may be broken — repairing it is the whole reason
 * a user asks for an update — so it goes in as context and is never validated.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import {
  generateSkillDocument,
  SkillGenerationError,
} from "../../domains/agent-generator/skill-generator.js";

const AGENT_ID = "michigan-contract-lawyer";
const SKILL_NAME = "termination-clause-review";

function conformingSkill(name = SKILL_NAME): string {
  return [
    "---",
    `name: ${name}`,
    "description: >",
    `  Walk a contract draft through the ${name} procedure clause by clause.`,
    `  Use when a draft reaches ${name} and the reviewer needs the checklist.`,
    "---",
    "",
    `# ${name}`,
    "",
    "1. Locate the clause.",
    "",
  ].join("\n");
}

/** Conforming in shape, but its `name` does not match the folder it is for. */
function mismatchedSkill(): string {
  return conformingSkill("some-other-name");
}

interface ProviderCall {
  system: string;
  messages: Array<{ role?: string; content?: string }>;
}

interface ProviderHarness {
  url: string;
  calls: ProviderCall[];
  close(): Promise<void>;
}

async function startProvider(replies: string[]): Promise<ProviderHarness> {
  const calls: ProviderCall[] = [];
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const messages = body.messages ?? [];
      calls.push({
        system: messages.find((message) => message.role === "system")?.content ?? "",
        messages: messages.filter((message) => message.role !== "system"),
      });
      const content = replies[Math.min(calls.length - 1, replies.length - 1)] ?? "{}";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "local-test-model",
          choices: [{ message: { content } }],
        }),
      );
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    calls,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

function reply(body: string, name = SKILL_NAME): string {
  return JSON.stringify({ name, body });
}

function makeRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-generator-"));
  const teamDir = path.join(repoRoot, "teams", "workflow-architect");
  const agentDir = path.join(repoRoot, "agents", "workflow-architect");
  fs.mkdirSync(teamDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, "team.yaml"),
    [
      "team:",
      "  name: workflow-architect",
      "agents:",
      "  - name: workflow-architect",
      "    agent_file: ../../agents/workflow-architect/workflow-architect.md",
      "",
    ].join("\n"),
  );
  // The architect's own file names the pair it runs with; the team declares
  // no model, because a team no longer decides one.
  fs.writeFileSync(
    path.join(agentDir, "workflow-architect.md"),
    ["---", "provider: openai", "model: local-test-model", "---", "", "Author skills.", ""].join("\n"),
  );
  return repoRoot;
}

async function withHarness(
  replies: string[],
  run: (context: { repoRoot: string; provider: ProviderHarness }) => Promise<void>,
): Promise<void> {
  const repoRoot = makeRepo();
  const provider = await startProvider(replies);
  const previousKey = process.env.OPENAI_API_KEY;
  const previousUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
  process.env.OPENAI_API_KEY = "local-test-key";
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = provider.url;
  try {
    await run({ repoRoot, provider });
  } finally {
    await provider.close();
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
    else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousUrl;
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

test("a conforming first document is taken as written, with no second call", async () => {
  await withHarness([reply(conformingSkill())], async ({ repoRoot, provider }) => {
    const result = await generateSkillDocument({
      repoRoot,
      request: {
        agentId: AGENT_ID,
        action: "create",
        name: SKILL_NAME,
        instruction: "Author a termination-clause review covering notice and cure rights.",
      },
    });

    assert.equal(result.source, conformingSkill());
    assert.equal(result.repaired, false);
    assert.equal(provider.calls.length, 1);
  });
});

test("the author is given the exact instruction and the skill's own folder name", async () => {
  await withHarness([reply(conformingSkill())], async ({ repoRoot, provider }) => {
    await generateSkillDocument({
      repoRoot,
      request: {
        agentId: AGENT_ID,
        action: "create",
        name: SKILL_NAME,
        instruction: "Cover notice periods and cure rights.",
      },
    });

    const request = provider.calls[0]!.messages.map((message) => message.content).join("\n");
    assert.match(request, /Cover notice periods and cure rights\./);
    assert.match(request, new RegExp(`Skill folder name:\\s*\`${SKILL_NAME}\``));
  });
});

/**
 * Correction: the skill the user wants rewritten may be exactly the one whose
 * current document is broken. Its bytes are context for the author, never
 * something the boundary validates.
 */
test("an update sends the current document as context even when it does not conform", async () => {
  const broken = "no frontmatter at all, and nothing that says when to use this\n";
  await withHarness([reply(conformingSkill())], async ({ repoRoot, provider }) => {
    const result = await generateSkillDocument({
      repoRoot,
      request: {
        agentId: AGENT_ID,
        action: "update",
        name: SKILL_NAME,
        instruction: "Require an explicit liability cap check.",
        currentSource: broken,
      },
    });

    const request = provider.calls[0]!.messages.map((message) => message.content).join("\n");
    assert.ok(request.includes(broken), `expected the current document as context: ${request}`);
    assert.equal(result.source, conformingSkill());
    assert.equal(provider.calls.length, 1, "a broken current document is not a repair round");
  });
});

test("an invalid first document is repaired in exactly one further call", async () => {
  const invalid = "# Termination review\n\nNo frontmatter here.\n";
  await withHarness(
    [reply(invalid), reply(conformingSkill())],
    async ({ repoRoot, provider }) => {
      const result = await generateSkillDocument({
        repoRoot,
        request: {
          agentId: AGENT_ID,
          action: "create",
          name: SKILL_NAME,
          instruction: "Author the review.",
        },
      });

      assert.equal(result.source, conformingSkill());
      assert.equal(result.repaired, true);
      assert.equal(provider.calls.length, 2);
    },
  );
});

test("the repair request names the concrete violations of the first document", async () => {
  const invalid = "# Termination review\n\nNo frontmatter here.\n";
  await withHarness(
    [reply(invalid), reply(conformingSkill())],
    async ({ repoRoot, provider }) => {
      await generateSkillDocument({
        repoRoot,
        request: {
          agentId: AGENT_ID,
          action: "create",
          name: SKILL_NAME,
          instruction: "Author the review.",
        },
      });

      const repair = provider.calls[1]!.messages.map((message) => message.content).join("\n");
      assert.match(repair, /no YAML frontmatter/i);
      assert.ok(
        repair.includes(invalid),
        "the author must be shown the document it is being asked to fix",
      );
    },
  );
});

test("a second invalid document fails the operation rather than being published", async () => {
  const invalid = "# Termination review\n\nNo frontmatter here.\n";
  await withHarness([reply(invalid), reply(invalid)], async ({ repoRoot, provider }) => {
    await assert.rejects(
      generateSkillDocument({
        repoRoot,
        request: {
          agentId: AGENT_ID,
          action: "create",
          name: SKILL_NAME,
          instruction: "Author the review.",
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof SkillGenerationError);
        assert.match(error.message, /no YAML frontmatter/i);
        return true;
      },
    );

    assert.equal(provider.calls.length, 2, "exactly one repair is permitted, never two");
  });
});

/**
 * The one repair covers output the boundary could not read at all, not only a
 * document it read and refused. A provider that answers with prose, or with
 * JSON in the wrong shape, has made exactly the mistake a correction round
 * exists to fix.
 */
test("an unreadable first answer is repaired in exactly one further call", async () => {
  await withHarness(
    ["Sure! Here is the skill you asked for.", reply(conformingSkill())],
    async ({ repoRoot, provider }) => {
      const result = await generateSkillDocument({
        repoRoot,
        request: {
          agentId: AGENT_ID,
          action: "create",
          name: SKILL_NAME,
          instruction: "Author the review.",
        },
      });

      assert.equal(result.source, conformingSkill());
      assert.equal(result.repaired, true);
      assert.equal(provider.calls.length, 2);
    },
  );
});

test("two unreadable answers fail the operation after exactly one repair", async () => {
  await withHarness(
    ["Sure! Here it is.", "Sorry, here it is again."],
    async ({ repoRoot, provider }) => {
      await assert.rejects(
        generateSkillDocument({
          repoRoot,
          request: {
            agentId: AGENT_ID,
            action: "create",
            name: SKILL_NAME,
            instruction: "Author the review.",
          },
        }),
        SkillGenerationError,
      );

      assert.equal(provider.calls.length, 2, "one repair, never two");
    },
  );
});

test("the repair request says what was unreadable about the first answer", async () => {
  await withHarness(
    ["Sure! Here is the skill.", reply(conformingSkill())],
    async ({ repoRoot, provider }) => {
      await generateSkillDocument({
        repoRoot,
        request: {
          agentId: AGENT_ID,
          action: "create",
          name: SKILL_NAME,
          instruction: "Author the review.",
        },
      });

      const repair = provider.calls[1]!.messages.map((message) => message.content).join("\n");
      assert.match(repair, /JSON object/i);
      assert.match(repair, /name/);
      assert.match(repair, /body/);
    },
  );
});

test("a document whose frontmatter names another skill is not this skill", async () => {
  await withHarness(
    [reply(mismatchedSkill()), reply(mismatchedSkill())],
    async ({ repoRoot }) => {
      await assert.rejects(
        generateSkillDocument({
          repoRoot,
          request: {
            agentId: AGENT_ID,
            action: "create",
            name: SKILL_NAME,
            instruction: "Author the review.",
          },
        }),
        /does not match the folder name/,
      );
    },
  );
});

test("a reply that is not the requested skill is refused", async () => {
  await withHarness(
    [reply(conformingSkill(), "some-other-name"), reply(conformingSkill(), "some-other-name")],
    async ({ repoRoot }) => {
      await assert.rejects(
        generateSkillDocument({
          repoRoot,
          request: {
            agentId: AGENT_ID,
            action: "create",
            name: SKILL_NAME,
            instruction: "Author the review.",
          },
        }),
        /some-other-name/,
      );
    },
  );
});

test("a withdrawn request makes no provider call at all", async () => {
  await withHarness([reply(conformingSkill())], async ({ repoRoot, provider }) => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      generateSkillDocument({
        repoRoot,
        request: {
          agentId: AGENT_ID,
          action: "create",
          name: SKILL_NAME,
          instruction: "Author the review.",
        },
        signal: controller.signal,
      }),
    );

    assert.equal(provider.calls.length, 0);
  });
});

/**
 * Every provider call this boundary makes goes through the shared budget,
 * including the repair. A repair that skipped the gate would let one operation
 * hold two provider slots at once and quietly double the configured cap.
 */
test("both the first call and the repair pass through the shared budget", async () => {
  const invalid = "# Termination review\n\nNo frontmatter here.\n";
  await withHarness([reply(invalid), reply(conformingSkill())], async ({ repoRoot }) => {
    let held = 0;
    let peak = 0;
    let acquisitions = 0;

    await generateSkillDocument({
      repoRoot,
      request: {
        agentId: AGENT_ID,
        action: "create",
        name: SKILL_NAME,
        instruction: "Author the review.",
      },
      gate: {
        acquire: async () => {
          acquisitions += 1;
          held += 1;
          peak = Math.max(peak, held);
        },
        release: () => {
          held -= 1;
        },
      },
    });

    assert.equal(acquisitions, 2, "the repair is a provider call and is budgeted like one");
    assert.equal(peak, 1, "one call at a time from one operation");
    assert.equal(held, 0, "every acquired slot is given back");
  });
});

/**
 * A provider that never answers must not hold the operation forever.
 *
 * The shared model client applies its own deadline on the HTTP routes, but the
 * architect model may be a CLI provider — `claude`, `codex`, `gemini`, and the
 * rest are all selectable — and that route forwards the caller's signal with no
 * deadline of its own. So the deadline is composed here, for every route and
 * for the repair as well as the first call.
 *
 * The two ways a call can end early stay distinguishable: a caller who
 * withdraws gets a cancellation, and a deadline that expires is a failure.
 */
async function startSlowProvider(watchdogMs = 500): Promise<{
  url: string;
  requestReceived: Promise<void>;
  close(): Promise<void>;
}> {
  let announceRequest: () => void = () => {};
  const requestReceived = new Promise<void>((resolve) => {
    announceRequest = resolve;
  });
  const timers = new Set<NodeJS.Timeout>();
  const server = http.createServer((request, response) => {
    announceRequest();
    // The harness itself is bounded. Correct code gives up at its own, much
    // shorter deadline; code with no deadline gets this answer and the
    // assertion fails promptly instead of the process hanging.
    const timer = setTimeout(() => {
      timers.delete(timer);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "local-test-model",
          choices: [{ message: { content: reply(conformingSkill()) } }],
        }),
      );
    }, watchdogMs);
    timers.add(timer);
    request.on("aborted", () => {
      clearTimeout(timer);
      timers.delete(timer);
    });
    response.on("close", () => {
      clearTimeout(timer);
      timers.delete(timer);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    requestReceived,
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function withSlowProvider(
  run: (context: { repoRoot: string; requestReceived: Promise<void> }) => Promise<void>,
): Promise<void> {
  const repoRoot = makeRepo();
  const provider = await startSlowProvider();
  const previousKey = process.env.OPENAI_API_KEY;
  const previousUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
  process.env.OPENAI_API_KEY = "local-test-key";
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = provider.url;
  try {
    await run({ repoRoot, requestReceived: provider.requestReceived });
  } finally {
    await provider.close();
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL;
    else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousUrl;
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

test("a provider slower than the deadline ends the call as a failure", async () => {
  await withSlowProvider(async ({ repoRoot }) => {
    await assert.rejects(
      generateSkillDocument({
        repoRoot,
        request: {
          agentId: AGENT_ID,
          action: "create",
          name: SKILL_NAME,
          instruction: "Author the review.",
        },
        // Far inside the harness watchdog: a call with a deadline gives up
        // first, and one without it gets an answer and resolves.
        timeoutMs: 60,
      }),
      (error: unknown) => {
        assert.ok(error instanceof SkillGenerationError, `unexpected error: ${String(error)}`);
        assert.notEqual(error.name, "AbortError", "a deadline is a failure, not a cancellation");
        assert.match(error.message, /did not answer/);
        return true;
      },
    );
  });
});

test("a caller who withdraws mid-flight is reported as cancelled, not timed out", async () => {
  await withSlowProvider(async ({ repoRoot, requestReceived }) => {
    const controller = new AbortController();
    const pending = generateSkillDocument({
      repoRoot,
      request: {
        agentId: AGENT_ID,
        action: "create",
        name: SKILL_NAME,
        instruction: "Author the review.",
      },
      signal: controller.signal,
      // Long enough that the deadline cannot be what ends this call.
      timeoutMs: 60_000,
    });
    // The request is in flight before it is withdrawn, so what this proves is
    // propagation into a live call rather than a pre-flight refusal. If the
    // call instead settles first — a configuration error, say — report that
    // rather than waiting forever for a request that will never arrive.
    const reached = await Promise.race([
      requestReceived.then(() => "provider" as const),
      pending.then(
        () => "call" as const,
        () => "call" as const,
      ),
    ]);
    if (reached === "call") {
      const settled = await pending.then(
        (value) => `resolved with ${JSON.stringify(value)}`,
        (error: unknown) =>
          `rejected with ${error instanceof Error ? error.message : String(error)}`,
      );
      assert.fail(`the call finished before reaching the provider: ${settled}`);
    }
    controller.abort();

    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "AbortError", `expected a cancellation, got ${error.message}`);
      return true;
    });
  });
});
