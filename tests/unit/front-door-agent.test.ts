import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { registerProvider } from "../../providers/registry.js";
import { runSessionAgentChatTurn } from "../../services/agent-chat-service.js";
import { FileSystemSessionStore } from "../../domains/sessions/session-store.js";
import { GENERAL_AGENT_NAME } from "../../domains/sessions/front-door.js";
import type { Provider } from "../../providers/types.js";
import { getRuntimeDefaultModelState, setRuntimeDefaultModelState } from "../../domains/provider/default-model-selection.js";

const PROVIDER_NAME = "fake-front-door";

beforeEach((context) => {
  assert.ok("after" in context, "The default must be restored after each test");
  const previousDefault = getRuntimeDefaultModelState();
  context.after(() => { setRuntimeDefaultModelState(previousDefault); });
  setRuntimeDefaultModelState({ status: "available", provider: PROVIDER_NAME, model: "app-default-model" });
});

interface CapturedCall {
  agentName: string;
  model: string;
  systemPrompt: string;
  userMessage: string;
}

/**
 * Every provider call the current test made, in order.
 *
 * The prompt a speaker is sent is not a return value, so the provider is the
 * seam: it is the last place the built system prompt and user message exist
 * before they leave the process. One registration for the whole file, because
 * the registry refuses a second provider under the same name.
 */
const calls: CapturedCall[] = [];

const captureProvider: Provider = {
  name: PROVIDER_NAME,
  async execute(options) {
    calls.push({
      agentName: options.agentName ?? "",
      model: options.model,
      systemPrompt: options.systemPrompt,
      userMessage: options.userMessage,
    });
    return {
      text: `Reply from ${options.agentName}`,
      cost: 0,
      durationMs: 1,
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: 0,
      model: options.model,
    };
  },
};
registerProvider(captureProvider);

function captureProviderCalls(): CapturedCall[] {
  calls.length = 0;
  return calls;
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeAgent(repoRoot: string, name: string, extra: string[] = []): void {
  const agentDir = path.join(repoRoot, "agents", name);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, `${name}.md`),
    [
      "---",
      `name: ${name}`,
      `description: ${name} description`,
      `provider: ${PROVIDER_NAME}`,
      "model: persona-model",
      ...extra,
      "---",
      "",
      `You are ${name}.`,
      "",
    ].join("\n"),
  );
}

/** A repository holding the front door, one ordinary agent, and a catalog. */
function makeRepo(): string {
  const repoRoot = makeTempDir("front-door-repo-");
  writeAgent(repoRoot, GENERAL_AGENT_NAME, ["system: true"]);
  writeAgent(repoRoot, "analyst");

  fs.writeFileSync(
    path.join(repoRoot, "teams.yaml"),
    [
      "writing-team:",
      "  type: team",
      "  description: Drafting and polishing written deliverables",
      "  team_path: ./teams/writing-team",
      "caller-only-team:",
      "  type: team",
      "  description: Reached only by another team, never by a person",
      "  team_path: ./teams/caller-only-team",
      "",
    ].join("\n"),
  );
  writeTeam(repoRoot, "writing-team", { userInvocable: true });
  writeTeam(repoRoot, "caller-only-team", { userInvocable: false });

  const workflowsDir = path.join(repoRoot, "workflows");
  fs.mkdirSync(path.join(workflowsDir, "templates"), { recursive: true });
  fs.writeFileSync(
    path.join(workflowsDir, "registry.yaml"),
    [
      "discussion-to-writing3:",
      "  description: Discuss the problem, then draft the deliverable",
      "  template_path: ./templates/discussion-to-writing.yaml",
      "chat-team-writing-team:",
      "  description: Internal wrapper for a chat-selected team",
      "  template_path: ./templates/discussion-to-writing.yaml",
      "  tags:",
      "    - chat-generated",
      "broken-workflow:",
      "  description: Names a team that is not registered",
      "  template_path: ./templates/broken.yaml",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(workflowsDir, "templates", "discussion-to-writing.yaml"),
    workflowTemplate("discussion-to-writing3", "writing-team"),
  );
  fs.writeFileSync(
    path.join(workflowsDir, "templates", "broken.yaml"),
    workflowTemplate("broken-workflow", "team-that-does-not-exist"),
  );
  return repoRoot;
}

function writeTeam(
  repoRoot: string,
  id: string,
  options: { userInvocable: boolean },
): void {
  const teamDir = path.join(repoRoot, "teams", id);
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, "team.yaml"),
    [
      "team:",
      `  name: ${id}`,
      `  description: ${id}`,
      "  version: '0.1.0'",
      "",
      "workflow:",
      "  entry_level: run",
      "  invocation_modes:",
      "    - team",
      ...(options.userInvocable ? ["    - user"] : []),
      `  user_facing: ${options.userInvocable}`,
      "  output_contract:",
      "    artifacts:",
      "      - path: final-draft.md",
      "        required: true",
      "    completion_artifact: final-draft.md",
      "",
      "agents:",
      "  - name: analyst",
      "    type: agent",
      "    role: Draft the deliverable.",
      "    tier: execution",
      "    agent_file: ../../agents/analyst/analyst.md",
      "    produces:",
      "      - path: final-draft.md",
      "",
      "levels:",
      "  - id: run",
      "    name: Run",
      "    order: 0",
      "    stage:",
      "      type: chain",
      "      sequence:",
      "        - analyst",
      "",
    ].join("\n"),
  );
}

function workflowTemplate(id: string, team: string): string {
  return [
    "workflow:",
    `  id: ${id}`,
    `  description: ${id}`,
    "  input:",
    "    artifact: incoming-brief.md",
    "  steps:",
    "    - id: write",
    "      type: team",
    `      team: ${team}`,
    "      input_artifact: incoming-brief.md",
    "      result_artifact: final-draft.md",
    "  output:",
    "    from_step: write",
    "    artifact: final-draft.md",
    "  on_blocked: stop",
    "  on_failed: stop",
    "",
  ].join("\n");
}

function workflowsRegistryPathOf(repoRoot: string): string {
  return path.join(repoRoot, "workflows", "registry.yaml");
}

for (const agentName of [GENERAL_AGENT_NAME, "analyst"]) {
  test(`${agentName} receives shared guidance for structured lists and linked website recommendations`, async () => {
    const captured = captureProviderCalls();
    const repoRoot = makeRepo();
    const workspace = makeTempDir("front-door-formatting-");
    try {
      await runTurn({ repoRoot, workspace, agentNames: [agentName] });
      const prompt = captured[0]?.systemPrompt ?? "";
      assert.match(prompt, /Use bullet points for lists/);
      assert.match(prompt, /clickable Markdown link for each website/);
      assert.match(prompt, /Never invent URLs/);
      assert.match(prompt, /explicitly requested format/);
      assert.equal(prompt.split("Use bullet points for lists").length - 1, 1);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  test(`${agentName} may create requested text artifacts without conflicting chat restrictions`, async () => {
    const captured = captureProviderCalls();
    const repoRoot = makeRepo();
    const workspace = makeTempDir("front-door-files-");
    try {
      await runTurn({ repoRoot, workspace, agentNames: [agentName] });
      const prompt = captured[0]?.systemPrompt ?? "";
      assert.match(prompt, /create_file/);
      assert.doesNotMatch(prompt, /Do not launch workflows, mutate files/);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
}

async function runTurn(input: {
  repoRoot: string;
  workspace: string;
  agentNames: string[];
  provider?: string;
  model?: string;
}): Promise<void> {
  const store = new FileSystemSessionStore(input.workspace);
  const session = await store.createSession({ title: "Front door" });
  await runSessionAgentChatTurn({
    sessionId: session.id,
    session,
    sessionStore: store,
    repoRootPath: input.repoRoot,
    workflowsRegistryPath: workflowsRegistryPathOf(input.repoRoot),
    text: "What does this app do?",
    agentNames: input.agentNames,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
  });
}

test("the front door may close with one routing suggestion", async () => {
  const calls = captureProviderCalls();
  const repoRoot = makeRepo();
  const workspace = makeTempDir("front-door-workspace-");
  try {
    await runTurn({
      repoRoot,
      workspace,
      agentNames: [GENERAL_AGENT_NAME],
    });

    const prompt = calls[0]?.systemPrompt ?? "";
    assert.match(prompt, /name it in one closing sentence/i);
    assert.doesNotMatch(prompt, /Do not append Question, Open Questions/i);
    assert.doesNotMatch(prompt, /Do not append offers for more work/i);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("an ordinary agent still refuses to append routing choices", async () => {
  const calls = captureProviderCalls();
  const repoRoot = makeRepo();
  const workspace = makeTempDir("front-door-workspace-");
  try {
    await runTurn({ repoRoot, workspace, agentNames: ["analyst"] });

    const prompt = calls[0]?.systemPrompt ?? "";
    assert.match(prompt, /routing choices/i);
    assert.match(prompt, /Do not append offers for more work/i);
    assert.doesNotMatch(prompt, /name it in one closing sentence/i);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the front door's context carries the Team and Workflow catalog", async () => {
  const calls = captureProviderCalls();
  const repoRoot = makeRepo();
  const workspace = makeTempDir("front-door-workspace-");
  try {
    await runTurn({
      repoRoot,
      workspace,
      agentNames: [GENERAL_AGENT_NAME],
    });

    const userMessage = calls[0]?.userMessage ?? "";
    assert.match(userMessage, /Registered teams/);
    assert.match(userMessage, /writing-team/);
    assert.match(userMessage, /Registered workflows/);
    assert.match(userMessage, /discussion-to-writing3/);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("an ordinary agent's context carries no catalog to propose from", async () => {
  const calls = captureProviderCalls();
  const repoRoot = makeRepo();
  const workspace = makeTempDir("front-door-workspace-");
  try {
    await runTurn({ repoRoot, workspace, agentNames: ["analyst"] });

    const userMessage = calls[0]?.userMessage ?? "";
    assert.doesNotMatch(userMessage, /Registered teams/);
    assert.doesNotMatch(userMessage, /Registered workflows/);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the composer's model selection overrides the front door's persona default", async () => {
  const calls = captureProviderCalls();
  const repoRoot = makeRepo();
  const workspace = makeTempDir("front-door-workspace-");
  try {
    await runTurn({
      repoRoot,
      workspace,
      agentNames: [GENERAL_AGENT_NAME],
      provider: PROVIDER_NAME,
      model: "composer-model",
    });

    assert.equal(calls[0]?.model, "composer-model");
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the front door uses the app default despite a saved persona model when the composer sends none", async () => {
  const calls = captureProviderCalls();
  const repoRoot = makeRepo();
  const workspace = makeTempDir("front-door-workspace-");
  try {
    await runTurn({
      repoRoot,
      workspace,
      agentNames: [GENERAL_AGENT_NAME],
    });

    assert.equal(calls[0]?.model, "app-default-model");

    setRuntimeDefaultModelState({ status: "available", provider: PROVIDER_NAME, model: "updated-app-default" });
    captureProviderCalls();
    await runTurn({ repoRoot, workspace, agentNames: [GENERAL_AGENT_NAME] });
    assert.equal(calls[0]?.model, "updated-app-default");
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

for (const status of ["unset", "unavailable"] as const) {
  test(`the front door refuses an ${status} app default instead of using its saved persona model`, async () => {
    const calls = captureProviderCalls();
    const repoRoot = makeRepo();
    const workspace = makeTempDir("front-door-default-");
    setRuntimeDefaultModelState(status === "unset"
      ? { status }
      : { status, provider: PROVIDER_NAME, model: "unavailable-default" });
    try {
      await assert.rejects(runTurn({ repoRoot, workspace, agentNames: [GENERAL_AGENT_NAME] }),
        (error: unknown) => error instanceof Error && /default/i.test(error.message));
      assert.equal(calls.length, 0);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
}

test("a selected specialist keeps taking its model from its own persona", async () => {
  const calls = captureProviderCalls();
  const repoRoot = makeRepo();
  const workspace = makeTempDir("front-door-workspace-");
  try {
    await runTurn({
      repoRoot,
      workspace,
      agentNames: ["analyst"],
      provider: PROVIDER_NAME,
      model: "composer-model",
    });

    assert.equal(calls[0]?.model, "persona-model");
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the front door's turn records that an agent responder admitted it", async () => {
  captureProviderCalls();
  const repoRoot = makeRepo();
  const workspace = makeTempDir("front-door-workspace-");
  try {
    const store = new FileSystemSessionStore(workspace);
    const session = await store.createSession({ title: "Front door" });
    const turnId = "11111111-2222-4333-8444-555555555555";
    await runSessionAgentChatTurn({
      sessionId: session.id,
      session,
      sessionStore: store,
      repoRootPath: repoRoot,
      workflowsRegistryPath: workflowsRegistryPathOf(repoRoot),
      text: "What does this app do?",
      agentNames: [GENERAL_AGENT_NAME],
      turnId,
    });

    const messages = await store.listChatMessages(session.id);
    const user = messages.find((message) => message.role === "user");
    assert.equal(user?.turnRequest?.responder, "agents");
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("changing the front door's model changes the turn's identity", async () => {
  // The composer's model now decides what actually runs for this speaker, and
  // `requestFingerprint` already hashes the requested provider and model. The
  // two have to move together: a retry under a different model must be a new
  // request, not a replay handing back an answer a different model wrote.
  captureProviderCalls();
  const repoRoot = makeRepo();
  const workspace = makeTempDir("front-door-workspace-");
  try {
    const store = new FileSystemSessionStore(workspace);
    const session = await store.createSession({ title: "Front door" });
    const turnId = "22222222-3333-4444-8555-666666666666";
    const shared = {
      sessionId: session.id,
      session,
      sessionStore: store,
      repoRootPath: repoRoot,
      workflowsRegistryPath: workflowsRegistryPathOf(repoRoot),
      text: "What does this app do?",
      agentNames: [GENERAL_AGENT_NAME],
      provider: PROVIDER_NAME,
      turnId,
    };

    await runSessionAgentChatTurn({ ...shared, model: "composer-model" });

    await assert.rejects(
      runSessionAgentChatTurn({ ...shared, model: "a-different-model" }),
      /turn_id_reused/,
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the catalog offers only Teams a person may pick", async () => {
  // A suggestion the user cannot act on is worse than no suggestion: the front
  // door names something, the picker does not have it, and the reply is wrong
  // in a way the reader cannot check.
  const calls = captureProviderCalls();
  const repoRoot = makeRepo();
  const workspace = makeTempDir("front-door-workspace-");
  try {
    await runTurn({ repoRoot, workspace, agentNames: [GENERAL_AGENT_NAME] });

    const userMessage = calls[0]?.userMessage ?? "";
    assert.match(userMessage, /writing-team/);
    assert.doesNotMatch(userMessage, /caller-only-team/);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the catalog hides internal wrappers and workflows that cannot launch", async () => {
  const calls = captureProviderCalls();
  const repoRoot = makeRepo();
  const workspace = makeTempDir("front-door-workspace-");
  try {
    await runTurn({ repoRoot, workspace, agentNames: [GENERAL_AGENT_NAME] });

    const userMessage = calls[0]?.userMessage ?? "";
    assert.match(userMessage, /discussion-to-writing3/);
    assert.doesNotMatch(userMessage, /chat-team-writing-team/);
    assert.doesNotMatch(userMessage, /broken-workflow/);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the front door may summarize what the conversation already carries", async () => {
  // The turn's own context includes prior replies from other agents and the
  // text of delivered documents. A blanket "you cannot read run results" would
  // make the front door refuse material it is holding.
  const calls = captureProviderCalls();
  const repoRoot = makeRepo();
  const workspace = makeTempDir("front-door-workspace-");
  try {
    await runTurn({ repoRoot, workspace, agentNames: [GENERAL_AGENT_NAME] });

    const prompt = calls[0]?.systemPrompt ?? "";
    assert.match(prompt, /already in this conversation/i);
    assert.match(prompt, /Results the user chose to carry into this turn/i);
    assert.match(prompt, /neither in this conversation nor carried into this turn/i);
    assert.doesNotMatch(prompt, /You cannot see the results of Agent, Team, or Workflow runs/i);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("a resolved continuation reaches whichever speaker was addressed", async () => {
  // Not the front door only. A follow-up the user attached a result to means
  // the same thing whoever they addressed it to, and losing it by picking a
  // specialist is the discontinuity this contract exists to remove.
  for (const agentName of [GENERAL_AGENT_NAME, "analyst"]) {
    const calls = captureProviderCalls();
    const repoRoot = makeRepo();
    const workspace = makeTempDir("front-door-workspace-");
    try {
      const store = new FileSystemSessionStore(workspace);
      const session = await store.createSession({ title: "Front door" });

      await runSessionAgentChatTurn({
        sessionId: session.id,
        session,
        sessionStore: store,
        repoRootPath: repoRoot,
        workflowsRegistryPath: workflowsRegistryPathOf(repoRoot),
        text: "What did that produce?",
        agentNames: [agentName],
        continuationContext: "CARRIED-RESULT-BLOCK",
      });

      assert.match(
        calls[0]?.userMessage ?? "",
        /CARRIED-RESULT-BLOCK/,
        `${agentName} was not given the turn's continuation`,
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test("a turn that carried nothing forward says nothing about results", async () => {
  const calls = captureProviderCalls();
  const repoRoot = makeRepo();
  const workspace = makeTempDir("front-door-workspace-");
  try {
    await runTurn({ repoRoot, workspace, agentNames: [GENERAL_AGENT_NAME] });

    assert.doesNotMatch(
      calls[0]?.userMessage ?? "",
      /Results carried into this turn/,
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
