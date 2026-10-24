import { describe, expect, it } from "vitest";

import * as sharedParsers from "@contracts/persona-frontmatter";

import {
  applyPersonaBrowser,
  applyPersonaBrowserDomains,
  applyPersonaBrowserDomainsRestricted,
  applyPersonaGenerateExcel,
  applyPersonaGenerateWord,
  applyPersonaWebResearch,
  applyPersonaAppDefault,
  applyPersonaModel,
  applyPersonaEffort,
  parsePersonaBrowser,
  parsePersonaBrowserDomains,
  parsePersonaBrowserDomainsRestricted,
  parsePersonaGenerateExcel,
  parsePersonaGenerateWord,
  parsePersonaModel,
  parsePersonaEffort,
  parsePersonaModelMode,
  parsePersonaToolList,
  parsePersonaWebResearch,
} from "../persona-frontmatter";

describe("persona frontmatter", () => {
  it.each([
    "tools:\n  - research_web\n  - generate_word",
    "tools:\n- research_web\n- generate_word",
    "tools: [research_web, generate_word]",
  ])("reads and safely edits list-form tools: %s", (declaration) => {
    const markdown = `---\nname: alpha\n${declaration}\nmodel: fixture\n---\nBody`;
    expect(parsePersonaWebResearch(markdown)).toBe(true);
    expect(applyPersonaWebResearch(markdown, false)).toBe(
      "---\nname: alpha\ntools: generate_word\nmodel: fixture\n---\nBody",
    );
  });

  it("fills empty frontmatter and preserves CRLF when saving tools", () => {
    expect(applyPersonaWebResearch("---\r\n---\r\nBody\r\n", true))
      .toBe("---\r\ntools: research_web\r\n---\r\nBody\r\n");
  });
  it("reads quoted model fields without changing the document", () => {
    const markdown = [
      "---",
      "provider: 'anthropic'",
      'model: "claude-opus"',
      "---",
      "",
      "# Persona",
    ].join("\n");

    expect(parsePersonaModel(markdown)).toEqual({
      provider: "anthropic",
      model: "claude-opus",
    });
  });

  it("inserts model fields while preserving existing frontmatter and body", () => {
    expect(applyPersonaModel("---\nname: Alpha\n---\n\nBody", "openai", "gpt-5"))
      .toBe("---\nname: Alpha\nprovider: openai\nmodel: gpt-5\n---\n\nBody");
  });

  it("creates frontmatter when the persona has none", () => {
    expect(applyPersonaModel("# Alpha", "openai", "gpt-5"))
      .toBe("---\nprovider: openai\nmodel: gpt-5\n---\n\n# Alpha");
  });

  it("preserves other tools when toggling browser access", () => {
    const markdown = "---\ntools: bash, browser, files\n---\n\nBody";
    const disabled = applyPersonaBrowser(markdown, false);

    expect(disabled).toBe("---\ntools: bash, files\n---\n\nBody");
    expect(parsePersonaToolList(disabled)).toEqual(["bash", "files"]);
    expect(parsePersonaBrowser(disabled)).toBe(false);
    expect(applyPersonaBrowser(disabled, true))
      .toBe("---\ntools: bash, files, browser\n---\n\nBody");
  });

  it("writes none when browser was the only tool", () => {
    expect(applyPersonaBrowser("---\ntools: browser\n---\n", false))
      .toBe("---\ntools: none\n---\n");
  });

  it("preserves unrelated tools when toggling governed Web research", () => {
    const markdown = "---\ntools: read, browser\n---\n\nBody";
    const enabled = applyPersonaWebResearch(markdown, true);

    expect(enabled)
      .toBe("---\ntools: read, browser, research_web\n---\n\nBody");
    expect(parsePersonaWebResearch(enabled)).toBe(true);
    expect(applyPersonaWebResearch(enabled, false)).toBe(markdown);
  });

  it("preserves browser while toggling Generate Word", () => {
    const markdown = "---\ntools: browser\n---\n\nBody";
    const enabled = applyPersonaGenerateWord(markdown, true);
    expect(enabled)
      .toBe("---\ntools: browser, generate_word\n---\n\nBody");
    expect(parsePersonaGenerateWord(enabled)).toBe(true);
    expect(applyPersonaGenerateWord(enabled, false)).toBe(markdown);
  });

  it("preserves other tools while toggling Generate Excel", () => {
    const markdown = "---\ntools: generate_word\n---\n\nBody";
    const enabled = applyPersonaGenerateExcel(markdown, true);
    expect(enabled)
      .toBe("---\ntools: generate_word, generate_excel\n---\n\nBody");
    expect(parsePersonaGenerateExcel(enabled)).toBe(true);
    expect(parsePersonaGenerateWord(enabled)).toBe(true);
    expect(applyPersonaGenerateExcel(enabled, false)).toBe(markdown);
  });

  it("keeps website restrictions opt-in", () => {
    const markdown = "---\ntools: browser\n---\n\nBody";
    expect(parsePersonaBrowserDomainsRestricted(markdown)).toBe(false);
    const restricted = applyPersonaBrowserDomainsRestricted(markdown, true);
    expect(restricted)
      .toBe("---\ntools: browser\nbrowser_restrict_domains: true\n---\n\nBody");
    expect(parsePersonaBrowserDomainsRestricted(restricted)).toBe(true);
  });

  it("normalizes browser domains exactly as the editor does", () => {
    const markdown = applyPersonaBrowserDomains(
      "---\ntools: browser\n---\n\nBody",
      " Example.COM, , *.Research.Example.Org ",
    );
    expect(markdown)
      .toBe("---\ntools: browser\nbrowser_domains: example.com, *.research.example.org\n---\n\nBody");
    expect(parsePersonaBrowserDomains(markdown))
      .toBe("example.com, *.research.example.org");
  });
});

describe("agent model mode", () => {
  it("reads a complete pair as an explicit choice", () => {
    const markdown = "---\nname: alpha\nprovider: openai\nmodel: gpt-5\n---\n\nBody\n";

    expect(parsePersonaModelMode(markdown)).toEqual({
      mode: "explicit",
      provider: "openai",
      model: "gpt-5",
    });
  });

  it("reads an agent that names nothing as app-default mode", () => {
    expect(parsePersonaModelMode("---\nname: alpha\n---\n\nBody\n")).toEqual({
      mode: "app-default",
    });
  });

  it("reads the legacy codex placeholder the same way the runtime does", () => {
    // The runtime reads `codex/default` as app-default mode. An editor that
    // showed it as an explicit choice would let the user save a pair the run
    // does not use, and would hide the fact that the agent is inheriting.
    expect(
      parsePersonaModelMode("---\nname: alpha\nprovider: codex\nmodel: default\n---\n\nBody\n"),
    ).toEqual({ mode: "app-default" });
  });

  it("keeps a CLI provider's own unpinned entry as an explicit choice", () => {
    expect(
      parsePersonaModelMode("---\nname: alpha\nprovider: claude\nmodel: default\n---\n\nBody\n"),
    ).toEqual({ mode: "explicit", provider: "claude", model: "default" });
  });

  it("reports a half-configured pair instead of showing it as inheritance", () => {
    // A model with no provider is not inheritance: the runtime refuses it. The
    // editor has to say so, or the user sees "Use app default" on an agent
    // that cannot start.
    const result = parsePersonaModelMode(
      "---\nname: alpha\nmodel: gpt-5.4-mini\n---\n\nBody\n",
    );

    expect(result.mode).toBe("invalid");
    expect(result).toMatchObject({ model: "gpt-5.4-mini" });
    expect("message" in result && result.message).toMatch(/no provider/i);
  });

  it("reports a provider whose model was left out", () => {
    const result = parsePersonaModelMode(
      "---\nname: alpha\nprovider: openai\n---\n\nBody\n",
    );

    expect(result.mode).toBe("invalid");
    expect(result).toMatchObject({ provider: "openai" });
  });

  it("persists inheritance rather than a copy of today's default", () => {
    const markdown = "---\nname: alpha\nprovider: openai\nmodel: gpt-5\n---\n\nBody\n";
    const cleared = applyPersonaAppDefault(markdown);

    // The fields are removed, not set to some current value: the agent has to
    // still be inheriting after the application default changes.
    expect(cleared).not.toMatch(/^provider:/m);
    expect(cleared).not.toMatch(/^model:/m);
    expect(parsePersonaModelMode(cleared)).toEqual({ mode: "app-default" });
    expect(cleared).toMatch(/^name: alpha$/m);
    expect(cleared).toMatch(/Body/);
  });

  it("round-trips back to an explicit choice", () => {
    const cleared = applyPersonaAppDefault(
      "---\nname: alpha\nprovider: openai\nmodel: gpt-5\n---\n\nBody\n",
    );

    expect(parsePersonaModelMode(applyPersonaModel(cleared, "codex", "gpt-5.6-sol"))).toEqual({
      mode: "explicit",
      provider: "codex",
      model: "gpt-5.6-sol",
    });
  });
});

describe("persona effort", () => {
  it("reads the level the file names", () => {
    const markdown = ["---", "name: alpha", "thinking: xhigh", "---", "", "Body."].join("\n");
    expect(parsePersonaEffort(markdown)).toBe("xhigh");
  });

  it("reports an absent level as absent rather than as the default", () => {
    // The editor has to be able to tell "this agent never named a level" from
    // "this agent asked for medium", because the two look identical on screen
    // and only one of them follows a change to the application default.
    const markdown = ["---", "name: alpha", "---", "", "Body."].join("\n");
    expect(parsePersonaEffort(markdown)).toBeNull();
  });

  it("writes a chosen level into the frontmatter", () => {
    const markdown = ["---", "name: alpha", "---", "", "Body."].join("\n");
    expect(applyPersonaEffort(markdown, "max")).toContain("thinking: max");
  });

  it("replaces a level rather than adding a second one", () => {
    const markdown = ["---", "name: alpha", "thinking: low", "---", "", "Body."].join("\n");
    const next = applyPersonaEffort(markdown, "high");
    expect(next).toContain("thinking: high");
    expect(next).not.toContain("thinking: low");
  });

  it("removes the field when the agent should follow the application default", () => {
    const markdown = ["---", "name: alpha", "thinking: high", "---", "", "Body."].join("\n");
    const next = applyPersonaEffort(markdown, null);
    expect(next).not.toContain("thinking:");
    expect(next).toContain("name: alpha");
  });

  it("leaves the body untouched", () => {
    const markdown = ["---", "name: alpha", "---", "", "# Heading", "", "Prose."].join("\n");
    expect(applyPersonaEffort(markdown, "minimal")).toContain("# Heading");
  });
});

describe("shared persona tool view", () => {
  const persona = [
    "---",
    "name: researcher",
    "tools:",
    "  - research_web",
    "  - generate_word",
    "browser_restrict_domains: 'true'",
    'browser_domains: "evidence.example.org, archive.example.org"',
    "---",
    "",
    "# Researcher",
  ].join("\n");

  it("gives the package editor and the Agent Architect one implementation", () => {
    expect(parsePersonaToolList).toBe(sharedParsers.parsePersonaToolList);
    expect(parsePersonaWebResearch).toBe(sharedParsers.parsePersonaWebResearch);
    expect(parsePersonaBrowserDomainsRestricted).toBe(sharedParsers.parsePersonaBrowserDomainsRestricted);
    expect(parsePersonaBrowserDomains).toBe(sharedParsers.parsePersonaBrowserDomains);
    expect(parsePersonaGenerateWord).toBe(sharedParsers.parsePersonaGenerateWord);
    expect(parsePersonaGenerateExcel).toBe(sharedParsers.parsePersonaGenerateExcel);
  });

  it("reads the tool state the Tools tab shows from one persona", () => {
    const expected = {
      tools: ["research_web", "generate_word"],
      webResearch: true,
      browserDomainsRestricted: true,
      browserDomains: "evidence.example.org, archive.example.org",
      generateWord: true,
      generateExcel: false,
    };

    expect(sharedParsers.readPersonaToolState(persona)).toEqual(expected);
    // The editor's own reads agree field by field.
    expect({
      tools: parsePersonaToolList(persona),
      webResearch: parsePersonaWebResearch(persona),
      browserDomainsRestricted: parsePersonaBrowserDomainsRestricted(persona),
      browserDomains: parsePersonaBrowserDomains(persona),
      generateWord: parsePersonaGenerateWord(persona),
      generateExcel: parsePersonaGenerateExcel(persona),
    }).toEqual(expected);
  });
});
