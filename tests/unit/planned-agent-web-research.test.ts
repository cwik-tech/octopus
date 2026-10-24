import test from "node:test";
import assert from "node:assert/strict";
import { applyPlannedWebResearch } from "../../domains/agent-generator/planned-agent-web-research.js";
import { parseYaml } from "../../core/yaml-parser.js";

for (const declaration of [
  "tools:\n  - research_web\n  - generate_word",
  "tools:\n- 'research_web'\n- generate_word # keep document generation",
  'tools: ["research_web", generate_word]',
]) {
  test(`approved access preserves other tools in ${JSON.stringify(declaration)}`, () => {
    const source = `---\nname: reviewer\n${declaration}\nmodel: fixture\n---\nBody`;
    const result = applyPlannedWebResearch(source, true);
    assert.equal(result, "---\nname: reviewer\ntools: generate_word, research_web\nmodel: fixture\n---\nBody");
    assert.deepEqual(parseYaml(result.split("---")[1] ?? ""), {
      name: "reviewer", tools: "generate_word, research_web", model: "fixture",
    });
    assert.equal(applyPlannedWebResearch(source, false), "---\nname: reviewer\ntools: generate_word\nmodel: fixture\n---\nBody");
  });
}

test("empty frontmatter is filled without adding a second block", () => {
  assert.equal(applyPlannedWebResearch("---\n---\nBody", true), "---\ntools: research_web\n---\nBody");
});

test("tool edits preserve CRLF in frontmatter and body", () => {
  assert.equal(applyPlannedWebResearch("---\r\nname: reviewer\r\ntools: none\r\n---\r\nBody\r\n", true),
    "---\r\nname: reviewer\r\ntools: research_web\r\n---\r\nBody\r\n");
});

for (const [enabled, expected] of [[true, "generate_word, research_web"], [false, "generate_word"]] as const) {
  test(`planned internet access ${enabled} overrides generated web tools and keeps unrelated tools`, () => {
    const source = '---\nname: reviewer\ntools : "browser, research_web, generate_word"\n---\n\n# Reviewer';
    assert.equal(applyPlannedWebResearch(source, enabled), `---\nname: reviewer\ntools: ${expected}\n---\n\n# Reviewer`);
  });
}

test("missing internet approval removes generated research access", () => {
  assert.equal(applyPlannedWebResearch("---\nname: reviewer\ntools: research_web\n---\nBody", undefined), "---\nname: reviewer\ntools: none\n---\nBody");
});
