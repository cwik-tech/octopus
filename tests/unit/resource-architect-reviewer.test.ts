import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadResourceArchitectReviewerConfig } from "../../domains/resource-architect/resource-architect-reviewer.js";
import { seedDesktopProjectRoot } from "../../electron/project-root.js";
import { listAgents } from "../../domains/agent-generator/list-agents.js";
import { readAgentDetail } from "../../domains/agent-generator/list-agents.js";

const reviewerId = "reviewer-of-agent-architect";
const appDefault = { status: "available", provider: "connection:default", model: "default-model" } as const;
const persona = (extra = "", body = "Check the request and draft.") => `---\nname: ${reviewerId}\nsystem: true\ndescription: Reviews Agent Architect replies.\nthinking: high\n${extra}---\n# Reviewer of Agent Architect\n\n${body}\n`;

function makeRoot(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "architect-reviewer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writePersona(root: string, text: string): void {
  const folder = path.join(root, "agents", reviewerId);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${reviewerId}.md`), text);
}

test("loads the exact reviewer path and frozen application default", (t) => {
  const root = makeRoot(t);
  writePersona(root, persona());
  const result = loadResourceArchitectReviewerConfig(root, appDefault);
  assert.ok(result.ok);
  assert.equal(result.config.reviewerId, reviewerId);
  assert.equal(result.config.selection.provider, "connection:default");
  assert.equal(result.config.selection.model, "default-model");
  assert.equal(result.config.selection.source, "app-default");
  assert.equal(result.config.thinking, "high");
  assert.match(result.config.systemPrompt, /^# Reviewer of Agent Architect/mu);
  assert.doesNotMatch(result.config.systemPrompt, /system: true/u);
  assert.equal(result.config.defaultFallback, null);
});

test("uses the reviewer explicit model and offers only a distinct available default", (t) => {
  const root = makeRoot(t);
  writePersona(root, persona('provider: codex\nmodel: review-model\nprovider_options: {"reasoningEffort":"high"}\n'));
  const result = loadResourceArchitectReviewerConfig(root, appDefault);
  assert.ok(result.ok);
  assert.deepEqual(result.config.selection, { provider: "codex", model: "review-model", source: "agent", reason: "explicit-agent-choice" });
  assert.deepEqual(result.config.providerOptions, { reasoningEffort: "high" });
  assert.deepEqual(result.config.defaultFallback, { provider: "connection:default", model: "default-model" });
  const identical = loadResourceArchitectReviewerConfig(root, { status: "available", provider: "codex", model: "review-model" });
  assert.ok(identical.ok);
  assert.equal(identical.config.defaultFallback, null);
  const unavailable = loadResourceArchitectReviewerConfig(root, { status: "unset" });
  assert.ok(unavailable.ok);
  assert.equal(unavailable.config.defaultFallback, null);
});

test("rereads edited reviewer instructions for the next turn", (t) => {
  const root = makeRoot(t);
  writePersona(root, persona());
  const first = loadResourceArchitectReviewerConfig(root, appDefault);
  writePersona(root, persona("", "Check sharing explicitly."));
  const second = loadResourceArchitectReviewerConfig(root, appDefault);
  assert.ok(first.ok && second.ok);
  assert.match(first.config.systemPrompt, /Check the request and draft/u);
  assert.match(second.config.systemPrompt, /Check sharing explicitly/u);
});

test("reports a missing persona without disclosing filesystem paths", (t) => {
  const result = loadResourceArchitectReviewerConfig(makeRoot(t), appDefault);
  assert.ok(!result.ok);
  assert.equal(result.error.code, "reviewer-persona-missing");
  assert.doesNotMatch(result.error.message, /\/Users|\/var|\/tmp/u);
});

for (const [name, content] of [
  ["missing frontmatter", "# Reviewer\nRead the draft."],
  ["unterminated frontmatter", "---\nname: reviewer-of-agent-architect\n"],
  ["wrong identity", persona().replace(reviewerId, "another-agent")],
  ["provider without model", persona("provider: codex\n")],
  ["model without provider", persona("model: review-model\n")],
  ["invalid provider options", persona('provider_options: {"api_key":"not-a-secret"}\n')],
  ["invalid thinking", persona().replace("thinking: high", "thinking: extreme")],
  ["empty instructions", `---\nname: ${reviewerId}\nsystem: true\n---\n`],
] as const) {
  test(`reports ${name} as configuration failure`, (t) => {
    const root = makeRoot(t);
    writePersona(root, content);
    const result = loadResourceArchitectReviewerConfig(root, appDefault);
    assert.ok(!result.ok);
    assert.equal(result.error.code, "reviewer-persona-invalid");
  });
}

test("keeps an unavailable inherited model distinguishable from malformed configuration", (t) => {
  const root = makeRoot(t);
  writePersona(root, persona());
  const result = loadResourceArchitectReviewerConfig(root, { status: "unavailable", provider: "connection:default", model: "default-model", detail: "private provider error" });
  assert.ok(!result.ok);
  assert.equal(result.error.code, "reviewer-selection-unavailable");
  assert.deepEqual(result.error.requestedReviewer, { provider: "connection:default", model: "default-model" });
  assert.doesNotMatch(result.error.message, /private provider error/u);
});

test("ships an editable system reviewer with no tools and the complete review rubric", () => {
  const root = process.cwd();
  const summary = listAgents(root).find((entry) => entry.name === reviewerId);
  assert.ok(summary);
  assert.equal(summary.system, true);
  assert.equal(summary.uiHidden, false);
  assert.equal(summary.provider, undefined);
  assert.equal(summary.model, undefined);
  const detail = readAgentDetail(root, reviewerId);
  assert.match(detail.personaMarkdown, /^# Reviewer of Agent Architect$/mu);
  assert.match(detail.personaMarkdown, /\| Skill \| Purpose \| Agents \| Sharing \|/u);
  assert.match(detail.personaMarkdown, /planned creation|planned.*reuse/u);
  assert.match(detail.personaMarkdown, /clarification/u);
  assert.match(detail.personaMarkdown, /do not.*manufactur|without.*manufactur/iu);
  assert.doesNotMatch(detail.personaMarkdown, /^tools:/mu);
});

test("packaged seeding adds the reviewer and preserves later user edits", async (t) => {
  const root = makeRoot(t);
  const projectRootPath = path.join(root, "project");
  fs.mkdirSync(path.join(projectRootPath, "agents", "user-agent"), { recursive: true });
  fs.writeFileSync(path.join(projectRootPath, "agents", "user-agent", "user-agent.md"), "# My existing Agent");
  await seedDesktopProjectRoot({ appRootPath: process.cwd(), projectRootPath });
  const initial = loadResourceArchitectReviewerConfig(projectRootPath, appDefault);
  assert.ok(initial.ok);
  writePersona(projectRootPath, persona("", "Retain my review instructions."));
  await seedDesktopProjectRoot({ appRootPath: process.cwd(), projectRootPath });
  const edited = loadResourceArchitectReviewerConfig(projectRootPath, appDefault);
  assert.ok(edited.ok);
  assert.match(edited.config.systemPrompt, /Retain my review instructions/u);
  assert.equal(fs.readFileSync(path.join(projectRootPath, "agents", "user-agent", "user-agent.md"), "utf8"), "# My existing Agent");
});

test("does not transfer unowned reviewer options onto an inherited application default", (t) => {
  const root = makeRoot(t);
  writePersona(root, persona('provider_options: {"max_tokens":512}\n'));
  const inherited = loadResourceArchitectReviewerConfig(root, appDefault);
  assert.ok(inherited.ok);
  assert.deepEqual(inherited.config.providerOptions, {});
});

test("the reviewer runs at any level this application can express", (t) => {
  // The reviewer persona is edited through the ordinary Agent editor, so the
  // vocabulary that editor offers and the vocabulary this loader accepts have
  // to be the same one. A level it rejected would make the persona invalid and
  // stop review altogether, and a level it quietly replaced would review at a
  // depth nobody chose.
  const root = makeRoot(t);
  for (const level of ["xhigh", "max", "provider-default"]) {
    writePersona(root, persona().replace("thinking: high", `thinking: ${level}`));
    const result = loadResourceArchitectReviewerConfig(root, appDefault);
    assert.ok(result.ok, `${level} should load`);
    assert.equal(result.config.thinking, level);
  }
});

test("a reviewer persona that names no level still runs at medium", (t) => {
  const root = makeRoot(t);
  writePersona(root, persona().replace("thinking: high\n", ""));
  const result = loadResourceArchitectReviewerConfig(root, appDefault);
  assert.ok(result.ok);
  assert.equal(result.config.thinking, "medium");
});
