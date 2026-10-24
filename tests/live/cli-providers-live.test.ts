import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { promisify } from "node:util";

import { executeProvider, getProvider, initProviders } from "../../providers/index.js";
import { ProviderSettingsService } from "../../services/provider-settings-service.js";
import {
  parseCodexModelCatalog,
  parsePiModelCatalog,
} from "../../domains/provider/cli-models.js";
import {
  cliCapability,
  createLiveTempDirectory,
  isLiveCapabilityRequired,
  liveTest,
} from "./live-provider-support.js";

initProviders();
const execFileAsync = promisify(execFile);

const CLI_PROVIDERS = [
  { id: "codex", command: "codex", marker: "CODEX_LIVE_OK" },
  { id: "claude", command: "claude", marker: "CLAUDE_LIVE_OK" },
  { id: "gemini", command: "gemini", marker: "GEMINI_LIVE_OK" },
  { id: "kimi-cli", command: "kimi", marker: "KIMI_LIVE_OK" },
  { id: "qwen", command: "qwen", marker: "QWEN_LIVE_OK" },
  { id: "pi", command: "pi", marker: "PI_LIVE_OK" },
] as const;

const capabilities = new Map(
  await Promise.all(
    CLI_PROVIDERS.map(async (definition) => [
      definition.id,
      await cliCapability(definition.command),
    ] as const),
  ),
);

for (const definition of CLI_PROVIDERS) {
  liveTest(
    `${definition.id} settings detection and real CLI completion succeed`,
    definition.id,
    capabilities.get(definition.id)!,
    async (context) => {
      const directory = createLiveTempDirectory(`${definition.id}-cli-live-`);
      try {
        const service = new ProviderSettingsService({
          storagePath: `${directory}/provider-settings.json`,
        });
        const agents = await service.listCliAgents(true);
        const detected = agents.find((agent) => agent.id === definition.id);
        assert.equal(detected?.available, true, detected?.error);
        assert.ok(detected?.path);
        assert.ok(detected?.version);
        const catalog = (await service.snapshot()).catalog;
        const group = catalog.find((entry) => entry.provider === definition.id);
        assert.ok(group, `${definition.id} should appear in catalog`);
        assert.ok(
          group.models.some((model) => model.id === "default"),
          `${definition.id} should expose its CLI default`,
        );

        const discovered = await discoverModelsForLiveCli(
          definition.id,
          detected.path,
        );
        for (const known of discovered) {
          assert.ok(
            detected.models.some((model) => model.id === known.id),
            `${definition.id} catalog should include model ${known.id}`,
          );
        }

        try {
          const result = await executeProvider(getProvider(definition.id), {
            systemPrompt: "Follow the user instruction exactly. Do not use tools.",
            userMessage: `Reply with ${definition.marker} and nothing else.`,
            model: "default",
            thinking: "low",
            tools: [],
            cwd: directory,
            signal: AbortSignal.timeout(180_000),
          });
          if (definition.id === "codex") {
            assert.equal(result.text.trim(), definition.marker);
          } else {
            assert.match(result.text, new RegExp(definition.marker, "i"));
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (
            !isLiveCapabilityRequired(definition.id) &&
            /401|403|unauthorized|invalid api.?key|auth method|auth login|not logged|credit balance|billing/i.test(
              message,
            )
          ) {
            context.skip(`real CLI is installed but authentication is unavailable: ${message.slice(0, 180)}`);
            return;
          }
          throw error;
        }
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    240_000,
  );
}

async function discoverModelsForLiveCli(
  id: string,
  executablePath: string,
) {
  if (id === "codex") {
    const { stdout } = await execFileAsync(executablePath, ["debug", "models"], {
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return parseCodexModelCatalog(stdout);
  }
  if (id === "pi") {
    const { stdout } = await execFileAsync(executablePath, ["--list-models"], {
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return parsePiModelCatalog(stdout);
  }
  return [];
}
