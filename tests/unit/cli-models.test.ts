import test from "node:test";
import assert from "node:assert/strict";

import {
  fallbackCliModels,
  mergeCliModels,
  parseCodexModelCatalog,
  parsePiModelCatalog,
} from "../../domains/provider/cli-models.js";

test("Codex model discovery keeps only visible selectable models", () => {
  const models = parseCodexModelCatalog(
    JSON.stringify({
      models: [
        {
          slug: "gpt-current",
          display_name: "GPT Current",
          visibility: "list",
          context_window: 400_000,
        },
        { slug: "gpt-hidden", visibility: "hide" },
      ],
    }),
  );

  assert.deepEqual(models, [
    {
      id: "gpt-current",
      name: "GPT Current",
      enabled: false,
      capabilities: ["chat"],
      icon: "openai",
      contextLength: 400_000,
    },
  ]);
});

test("Pi model discovery preserves provider identity and parses context sizes", () => {
  const models = parsePiModelCatalog([
    "provider     model                 context  max-out  thinking  images",
    "openai       gpt-current           400K     128K     yes       yes",
    "deepseek     deepseek-current      1M       384K     yes       no",
  ].join("\n"));

  assert.deepEqual(
    models.map(({ id, contextLength }) => ({ id, contextLength })),
    [
      { id: "openai/gpt-current", contextLength: 400_000 },
      { id: "deepseek/deepseek-current", contextLength: 1_000_000 },
    ],
  );
});

test("CLI fallbacks use stable defaults and aliases rather than dated model ids", () => {
  assert.deepEqual(
    fallbackCliModels("claude").map((model) => model.id),
    ["default", "opus", "fable", "sonnet", "haiku"],
  );
  assert.deepEqual(
    fallbackCliModels("claude").map((model) => model.name),
    [
      "Default model",
      "Claude Opus 4.8 (1M context)",
      "Claude Fable 5",
      "Claude Sonnet 5",
      "Claude Haiku 4.5",
    ],
  );
  assert.deepEqual(
    mergeCliModels("qwen", []).map((model) => model.id),
    ["default"],
  );
});

test("Codex model discovery keeps the reasoning levels the payload publishes", () => {
  const models = parseCodexModelCatalog(
    JSON.stringify({
      models: [
        {
          slug: "gpt-deep",
          display_name: "GPT Deep",
          visibility: "list",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "low", description: "Fast responses" },
            { effort: "medium", description: "Balanced" },
            { effort: "high", description: "Deeper" },
            { effort: "xhigh", description: "Extra" },
            { effort: "max", description: "Most" },
            { effort: "ultra", description: "Most, with delegation" },
          ],
        },
        {
          slug: "gpt-plain",
          display_name: "GPT Plain",
          visibility: "list",
        },
      ],
    }),
  );

  assert.deepEqual(models[0]?.supportedEfforts, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]);
  assert.equal(models[0]?.defaultEffort, "medium");
  // A model that publishes nothing must not acquire a range by being listed
  // next to one that does.
  assert.equal(models[1]?.supportedEfforts, undefined);
  assert.equal(models[1]?.defaultEffort, undefined);
});

test("Codex model discovery ignores a reasoning level this application cannot express", () => {
  const models = parseCodexModelCatalog(
    JSON.stringify({
      models: [
        {
          slug: "gpt-odd",
          visibility: "list",
          supported_reasoning_levels: [
            { effort: "low" },
            { effort: "sideways" },
            { effort: "max" },
          ],
        },
      ],
    }),
  );

  assert.deepEqual(models[0]?.supportedEfforts, ["low", "max"]);
});
