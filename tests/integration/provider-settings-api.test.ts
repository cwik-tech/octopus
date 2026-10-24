import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { startApiServer } from "../../server/api-server.js";
import { executeProvider, getProvider } from "../../providers/index.js";
import {
  CONFIGURED_PROVIDER_BROKER_URL_ENV,
  CONFIGURED_PROVIDERS_ENV,
  configuredProviderName,
} from "../../domains/provider/provider-settings.js";
import { FileSystemRunStore } from "../../domains/run/run-store.js";
import { ProviderSettingsService } from "../../services/provider-settings-service.js";

test("provider settings API validates a real local endpoint and publishes enabled models", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-settings-api-"));
  const fixture = await startModelFixture();
  const providerSettingsService = new ProviderSettingsService({
    storagePath: path.join(directory, "provider-settings.json"),
    secretCodec: {
      encrypt: (value) => Buffer.from(value, "utf8").toString("base64"),
      decrypt: (value) => Buffer.from(value, "base64").toString("utf8"),
    },
  });
  let brokerUrl: string | undefined;
  const server = await startApiServer({
    apiToken: "master-api-token",
    brokerToken: "provider-broker-token",
    store: new FileSystemRunStore(directory),
    launcher: { async startRun(request) { return { launched: true, pid: 1, cwd: request.cwd }; } },
    providerSettingsService,
    onListening: (started) => {
      brokerUrl = started.brokerUrl;
    },
  });

  try {
    const saveResponse = await fetch(`${server.url}/settings/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "openai-compatible",
        name: "Fixture API",
        baseUrl: `${fixture.url}/v1`,
        apiKey: "fixture-key",
        enabled: true,
      }),
    });
    assert.equal(saveResponse.status, 201);
    const saved = (await saveResponse.json()) as { id: string };

    const validateResponse = await fetch(
      `${server.url}/settings/providers/${saved.id}/validate`,
      { method: "POST" },
    );
    assert.equal(validateResponse.status, 200);
    assert.equal(((await validateResponse.json()) as { status: string }).status, "connected");

    const enableResponse = await fetch(
      `${server.url}/settings/providers/${saved.id}/models`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelId: "fixture/chat-model", enabled: true }),
      },
    );
    assert.equal(enableResponse.status, 200);

    const catalogResponse = await fetch(`${server.url}/settings/model-catalog`);
    const catalog = (await catalogResponse.json()) as {
      catalog: Array<{ name: string; models: Array<{ id: string }> }>;
    };
    assert.equal(catalog.catalog.find((group) => group.name === "Fixture API")?.models[0]?.id, "fixture/chat-model");

    const provider = configuredProviderName(saved.id);
    const defaultResponse = await fetch(`${server.url}/settings/default-model`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, model: "fixture/chat-model" }),
    });
    assert.equal(defaultResponse.status, 200);
    assert.deepEqual(
      (await defaultResponse.json()) as object,
      { defaultModel: { provider, model: "fixture/chat-model" } },
    );

    assert.ok(brokerUrl);
    providerSettingsService.setBrokerUrl(brokerUrl);
    const runtimeEnvironment = await providerSettingsService.runtimeEnvironment();
    assert.equal(
      runtimeEnvironment[CONFIGURED_PROVIDER_BROKER_URL_ENV],
      brokerUrl,
    );
    const transportedConnections = Buffer.from(
      runtimeEnvironment[CONFIGURED_PROVIDERS_ENV] ?? "",
      "base64",
    ).toString("utf8");
    assert.equal(transportedConnections.includes("fixture-key"), false);

    const brokerHealthResponse = await fetch(
      `${brokerUrl.slice(0, -"/settings/provider-execute".length)}/health`,
    );
    assert.equal(brokerHealthResponse.status, 403);

    const brokerResponse = await fetch(brokerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider,
        systemPrompt: "Be concise.",
        userMessage: "Prove the broker executes.",
        model: "fixture/chat-model",
        thinking: "low",
      }),
    });
    assert.equal(brokerResponse.status, 200);
    assert.equal(
      ((await brokerResponse.json()) as { text: string }).text,
      "Configured provider response",
    );

    const brokerErrorResponse = await fetch(brokerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider,
        systemPrompt: "Be concise.",
        userMessage: "Exercise structured provider errors.",
        model: "fixture/quota-model",
        thinking: "low",
      }),
    });
    assert.equal(brokerErrorResponse.status, 429);
    assert.deepEqual(await brokerErrorResponse.json(), {
      type: "provider_error",
      error: "Quota exhausted.",
      provider,
      kind: "billing",
      statusCode: 429,
      code: "insufficient_quota",
      retryable: false,
    });

    const runtimeResult = await executeProvider(
      getProvider(provider),
      {
        systemPrompt: "Be concise.",
        userMessage: "Prove the configured provider executes.",
        model: "fixture/chat-model",
        thinking: "low",
      },
    );
    assert.equal(runtimeResult.text, "Configured provider response");
    assert.equal(runtimeResult.model, "fixture/chat-model");
  } finally {
    await server.close();
    await fixture.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("provider settings route preserves unknown, absent, null, and non-coercing request behavior", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "provider-settings-boundary-"),
  );
  const providerSettingsService = new ProviderSettingsService({
    storagePath: path.join(directory, "provider-settings.json"),
  });
  const server = await startApiServer({
    store: new FileSystemRunStore(directory),
    launcher: {
      async startRun(request) {
        return { launched: true, pid: 1, cwd: request.cwd };
      },
    },
    providerSettingsService,
  });
  const validConnection = {
    kind: "ollama",
    name: "Local fixture",
    baseUrl: "http://127.0.0.1:11434",
    enabled: true,
  };

  try {
    const acceptsUnknownAndAbsentOptional = await fetch(
      `${server.url}/settings/providers`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...validConnection,
          futureSetting: { retainedByLegacyClients: true },
        }),
      },
    );
    assert.equal(acceptsUnknownAndAbsentOptional.status, 201);
    const saved = await acceptsUnknownAndAbsentOptional.json() as
      Record<string, unknown>;
    assert.equal(saved.name, "Local fixture");
    assert.equal("futureSetting" in saved, false);
    assert.equal(saved.hasApiKey, false);

    for (const { body, error } of [
      {
        body: {},
        error: "Field kind is invalid",
      },
      {
        body: null,
        error: "Request body must be a JSON object",
      },
      {
        body: { ...validConnection, apiKey: null },
        error: "Field apiKey must be a string",
      },
      {
        body: { ...validConnection, enabled: "true" },
        error: "Field enabled must be a boolean",
      },
    ]) {
      const response = await fetch(`${server.url}/settings/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error });
    }

    const malformed = await fetch(`${server.url}/settings/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), {
      error: "Invalid JSON request body",
    });
  } finally {
    await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function startModelFixture(): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/models" && req.headers.authorization === "Bearer fixture-key") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fixture/chat-model", name: "Fixture Chat Model" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions" && req.headers.authorization === "Bearer fixture-key") {
      void readRequestBody(req).then((body) => {
        const payload = JSON.parse(body) as { model?: string };
        res.setHeader("content-type", "application/json");
        if (payload.model === "fixture/quota-model") {
          res.statusCode = 429;
          res.end(JSON.stringify({
            error: {
              message: "Quota exhausted.",
              type: "invalid_request_error",
              code: "insufficient_quota",
            },
          }));
          return;
        }
        res.end(JSON.stringify({
          model: payload.model,
          choices: [{ message: { content: "Configured provider response" } }],
          usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
        }));
      });
      return;
    }
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "unauthorized" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture failed to listen");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
