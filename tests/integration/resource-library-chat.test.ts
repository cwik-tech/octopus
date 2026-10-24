import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";

import { FileSystemRunStore } from "../../domains/run/run-store.js";
import { FileSystemSessionStore } from "../../domains/sessions/session-store.js";
import { configuredProviderName } from "../../domains/provider/provider-settings.js";
import { startApiServer } from "../../server/api-server.js";
import { ProviderSettingsService } from "../../services/provider-settings-service.js";
import { ResourceLibraryService } from "../../services/resource-library-service.js";
import { startFakeChatCompletionsServer } from "../support/fake-chat-completions-server.js";

test("a chat loads its admitted skill snapshot after another window selects a new revision", { timeout: 25000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "resource-library-chat-"));
  const repoRoot = path.join(root, "project");
  const workspacePath = path.join(root, "workspace");
  const libraryRoot = path.join(root, "library");
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markRequested = () => {};
  const requested = new Promise<void>((resolve) => { markRequested = resolve; });
  const firstArguments: Record<string, unknown> = {};
  const secondArguments: Record<string, unknown> = {};
  // Paid generation is replaced only at HTTP. API, tools, capability dispatch and files are real.
  const provider = await startFakeChatCompletionsServer({ models: ["fixture/library"], script: [
    { match: (request) => {
      if (request.stream || !request.systemPrompt?.includes("Available skills")) return false;
      firstArguments.source = request.systemPrompt.match(/source: (.+)/)?.[1];
      firstArguments.sha256 = request.systemPrompt.match(/sha256: ([a-f0-9]+)/)?.[1];
      markRequested(); return true;
    }, gate, toolCalls: [{ id: "load-first", name: "mcp__pipeline_skills__load_skill", arguments: firstArguments }] },
    { match: (request) => !request.stream && request.systemPrompt?.includes("Available skills") === true,
      content: "Original skill loaded." },
    { match: (request) => request.stream && request.systemPrompt?.includes("Available skills") === true,
      content: "Original skill loaded." },
    { match: (request) => {
      if (request.stream || !request.systemPrompt?.includes("Available skills")) return false;
      secondArguments.source = request.systemPrompt.match(/source: (.+)/)?.[1];
      secondArguments.sha256 = request.systemPrompt.match(/sha256: ([a-f0-9]+)/)?.[1];
      return true;
    }, toolCalls: [{ id: "load-second", name: "mcp__pipeline_skills__load_skill", arguments: secondArguments }] },
    { content: "Skill loaded." },
  ] });
  t.after(async () => { release(); await provider.close(); await fs.rm(root, { recursive: true, force: true }); });
  const settings = new ProviderSettingsService({ storagePath: path.join(root, "providers.json") });
  const connection = await settings.saveConnection({ kind: "lm-studio", name: "Fixture", baseUrl: `${provider.url}/v1`, enabled: true });
  await settings.validateConnection(connection.id);
  await settings.setModelEnabled(connection.id, "fixture/library", true);
  const providerName = configuredProviderName(connection.id);
  await settings.setDefaultModel({ provider: providerName, model: "fixture/library" });
  const agentDir = path.join(repoRoot, "agents/alpha");
  await fs.mkdir(path.join(agentDir, "skills/research"), { recursive: true });
  await fs.writeFile(path.join(agentDir, "alpha.md"), `---\nname: alpha\ndescription: Research.\nprovider: ${providerName}\nmodel: fixture/library\n---\n\nResearch.\n{{SKILLS_BLOCK}}\n`);
  await fs.writeFile(path.join(agentDir, "skills/research/SKILL.md"), skill("Original"));
  await fs.writeFile(path.join(repoRoot, "teams.yaml"), "");
  const store = new FileSystemSessionStore(workspacePath);
  const session = await store.createSession({ title: "Library chat" });
  const server = await startApiServer({ repoRootPath: repoRoot, workspacePath, requireResourceLibraryMigrationApproval: false,
    resourceLibraryRootPath: libraryRoot,
    sessionStore: store, store: new FileSystemRunStore(workspacePath), providerSettingsService: settings,
    launcher: { async startRun() { return { launched: true, pid: 0, cwd: repoRoot }; } },
  });
  t.after(() => server.close());
  const send = () => fetch(`${server.url}/sessions/${session.id}/messages`, { method: "POST",
    headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ text: "Load research.", target: { kind: "agents", agentNames: ["alpha"] }, turnId: randomUUID() }),
  });
  const pending = send();
  t.after(async () => { release(); await pending.catch(() => undefined); });
  await Promise.race([requested, pending.then(async (response) => { throw new Error(`Chat ended before tool request: ${response.status} ${await response.clone().text()}`); }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("No skill request")), 10000); timer.unref(); })]);
  const library = new ResourceLibraryService({ requireMigrationApproval: false, repoRootPath: repoRoot, rootPath: libraryRoot });
  const before = await library.getBrowserSnapshot();
  const research = before.skills[0];
  assert.ok(research);
  const edited = await library.saveSkillRevision({ skillId: research.id, baseRevisionId: research.currentRevisionId,
    changeNote: "Update", expectedGeneration: before.generation,
    files: new Map([["SKILL.md", { contents: Buffer.from(skill("Updated")), mode: 0o644, executable: false }]]),
  });
  await library.selectAgentSkillRevision({ agentId: "alpha", skillId: research.id, revisionId: edited.revision.id, expectedGeneration: before.generation + 1 });
  release();
  const response = await pending;
  assert.equal(response.status, 201, await response.clone().text());
  const next = await send();
  assert.equal(next.status, 201, await next.clone().text());
  const toolMessages = provider.requests.flatMap((request) => {
    const body = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown().optional() }).passthrough()) }).parse(request.body);
    return body.messages.filter((message) => message.role === "tool").map((message) => String(message.content));
  });
  assert.ok(toolMessages.some((content) => content.includes("Original")), "admitted chat loads original skill bytes");
  assert.ok(toolMessages.some((content) => content.includes("Updated")), "next chat loads updated skill bytes");
  assert.notEqual(firstArguments.source, secondArguments.source);
});

function skill(body: string) { return `---\nname: research\ndescription: Researches exactly. Use when research is needed.\n---\n\n${body}\n`; }
