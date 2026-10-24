import { whenDefined } from '../../core/optional-properties.js'
import assert from "node:assert/strict";
import * as fs from "node:fs";

import { executeProvider, getProvider } from "../../providers/index.js";
import { configuredProviderName } from "../../domains/provider/provider-settings.js";
import { ProviderSettingsService } from "../../services/provider-settings-service.js";
import {
  apiKeyCapability,
  createLiveSecretCodec,
  createLiveTempDirectory,
  httpCapability,
  liveTest,
  selectChatModel,
} from "./live-provider-support.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const LM_STUDIO_BASE_URL =
  process.env.LM_STUDIO_BASE_URL?.trim() || "http://127.0.0.1:1234/v1";
const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434";

const openRouterNetwork = await httpCapability(`${OPENROUTER_BASE_URL}/models`);
const openRouterKey = apiKeyCapability("OPENROUTER_API_KEY");
const lmStudio = await httpCapability(`${LM_STUDIO_BASE_URL}/models`);
const ollama = await httpCapability(`${OLLAMA_BASE_URL}/api/tags`);

liveTest(
  "OpenRouter live model contract exposes priced models and free models",
  "openrouter-network",
  openRouterNetwork,
  async () => {
    const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      data?: Array<{
        id?: string;
        name?: string;
        context_length?: number;
        pricing?: { prompt?: string; completion?: string };
      }>;
    };
    assert.ok(Array.isArray(payload.data) && payload.data.length > 0);
    assert.ok(payload.data.every((model) => typeof model.id === "string"));
    assert.ok(
      payload.data.some(
        (model) =>
          Number(model.pricing?.prompt) === 0 &&
          Number(model.pricing?.completion) === 0,
      ),
      "OpenRouter did not expose any free models",
    );
  },
);

liveTest(
  "OpenRouter Save & Validate rejects an invalid key against the live key endpoint",
  "openrouter-network",
  openRouterNetwork,
  async () => {
    const directory = createLiveTempDirectory("openrouter-invalid-live-");
    try {
      const service = new ProviderSettingsService({
        storagePath: `${directory}/provider-settings.json`,
        secretCodec: createLiveSecretCodec(),
      });
      const saved = await service.saveConnection({
        kind: "openrouter",
        name: "OpenRouter invalid-key live contract",
        baseUrl: OPENROUTER_BASE_URL,
        apiKey: `invalid-live-key-${Date.now()}`,
        enabled: true,
      });
      const validated = await service.validateConnection(saved.id);
      assert.equal(validated.status, "error");
      assert.match(validated.error ?? "", /401|unauthorized|invalid/i);
      assert.equal(validated.models.length, 0);
      assert.equal(
        (await service.snapshot()).catalog.some(
          (group) => group.name === "OpenRouter invalid-key live contract",
        ),
        false,
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

liveTest(
  "OpenRouter configured connection discovers and executes a real free model",
  "openrouter",
  openRouterKey,
  async () => {
    const directory = createLiveTempDirectory("openrouter-live-");
    try {
      const service = new ProviderSettingsService({
        storagePath: `${directory}/provider-settings.json`,
        secretCodec: createLiveSecretCodec(),
      });
      const saved = await service.saveConnection({
        kind: "openrouter",
        name: "OpenRouter Live",
        baseUrl: OPENROUTER_BASE_URL,
        ...whenDefined(process.env.OPENROUTER_API_KEY, (apiKey) => ({ apiKey: apiKey })),
        enabled: true,
      });
      const validated = await service.validateConnection(saved.id);
      assert.equal(validated.status, "connected", validated.error);
      const model = selectChatModel(
        validated.models.map((entry) => entry.id),
        process.env.OPENROUTER_LIVE_MODEL?.trim() || "openrouter/free",
      );
      await service.setModelEnabled(saved.id, model, true);
      const result = await executeProvider(
        getProvider(configuredProviderName(saved.id)),
        {
          systemPrompt: "Follow the user instruction exactly.",
          userMessage: "Reply with OPENROUTER_LIVE_OK and nothing else.",
          model,
          thinking: "low",
          signal: AbortSignal.timeout(120_000),
          providerConfig: { max_tokens: 80, temperature: 0 },
        },
      );
      assert.match(result.text, /OPENROUTER_LIVE_OK/i);
      assert.equal((await service.snapshot()).catalog[0]?.models[0]?.id, model);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  180_000,
);

liveTest(
  "LM Studio connection discovers and executes a real local model",
  "lm-studio",
  lmStudio,
  async () => {
    await exerciseLocalConnection({
      kind: "lm-studio",
      name: "LM Studio Live",
      baseUrl: LM_STUDIO_BASE_URL,
      ...whenDefined(process.env.LM_STUDIO_LIVE_MODEL, (preferredModel) => ({ preferredModel: preferredModel })),
      marker: "LM_STUDIO_LIVE_OK",
    });
  },
  240_000,
);

liveTest(
  "generic OpenAI-compatible connection executes against the real LM Studio server",
  "openai-compatible",
  lmStudio,
  async () => {
    await exerciseLocalConnection({
      kind: "openai-compatible",
      name: "OpenAI-compatible Live",
      baseUrl: LM_STUDIO_BASE_URL,
      apiKey: "lm-studio-live-contract",
      ...whenDefined(process.env.LM_STUDIO_LIVE_MODEL, (preferredModel) => ({ preferredModel: preferredModel })),
      marker: "OPENAI_COMPATIBLE_LIVE_OK",
    });
  },
  240_000,
);

liveTest(
  "Ollama connection discovers and executes a real local model",
  "ollama",
  ollama,
  async () => {
    await exerciseLocalConnection({
      kind: "ollama",
      name: "Ollama Live",
      baseUrl: OLLAMA_BASE_URL,
      ...whenDefined(process.env.OLLAMA_LIVE_MODEL, (preferredModel) => ({ preferredModel: preferredModel })),
      marker: "OLLAMA_LIVE_OK",
    });
  },
  240_000,
);

async function exerciseLocalConnection(params: {
  kind: "openai-compatible" | "ollama" | "lm-studio";
  name: string;
  baseUrl: string;
  apiKey?: string;
  preferredModel?: string;
  marker: string;
}): Promise<void> {
  const directory = createLiveTempDirectory(`${params.kind}-live-`);
  try {
    const service = new ProviderSettingsService({
      storagePath: `${directory}/provider-settings.json`,
      secretCodec: createLiveSecretCodec(),
    });
    const saved = await service.saveConnection({
      kind: params.kind,
      name: params.name,
      baseUrl: params.baseUrl,
      ...whenDefined(params.apiKey, (apiKey) => ({ apiKey: apiKey })),
      enabled: true,
    });
    const validated = await service.validateConnection(saved.id);
    assert.equal(validated.status, "connected", validated.error);
    const model = selectChatModel(
      validated.models.map((entry) => entry.id),
      params.preferredModel?.trim(),
    );
    await service.setModelEnabled(saved.id, model, true);
    const catalog = (await service.snapshot()).catalog;
    assert.equal(catalog.find((group) => group.name === params.name)?.models[0]?.id, model);

    const result = await executeProvider(
      getProvider(configuredProviderName(saved.id)),
      {
        systemPrompt: "Follow the user instruction exactly.",
        userMessage: `Reply with ${params.marker} and nothing else.`,
        model,
        thinking: "low",
        signal: AbortSignal.timeout(180_000),
        providerConfig: { max_tokens: 80, temperature: 0 },
      },
    );
    assert.ok(result.text.trim().length > 0);
    assert.match(result.text, new RegExp(params.marker, "i"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
