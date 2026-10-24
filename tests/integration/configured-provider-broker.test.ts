import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";

import {
  setConfiguredProviderConnections,
} from "../../providers/configured-provider.js";
import { executeProvider, getProvider } from "../../providers/index.js";
import {
  CONFIGURED_PROVIDER_BROKER_URL_ENV,
  configuredProviderName,
} from "../../domains/provider/provider-settings.js";
import {
  ProviderError,
  formatProviderErrorForUser,
  serializeProviderError,
} from "../../domains/provider/provider-error.js";

test("configured provider children execute through the broker without credentials", async () => {
  let received: Record<string, unknown> | undefined;
  const broker = http.createServer((request, response) => {
    void readRequestBody(request).then((body) => {
      received = JSON.parse(body) as Record<string, unknown>;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        text: "Brokered response",
        cost: 0,
        durationMs: 2,
        inputTokens: 3,
        outputTokens: 2,
        contextTokens: 5,
        model: "fixture/chat-model",
      }));
    });
  });
  await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
  const address = broker.address();
  assert.ok(address && typeof address !== "string");
  const previousBrokerUrl = process.env[CONFIGURED_PROVIDER_BROKER_URL_ENV];

  try {
    setConfiguredProviderConnections([{
      id: "broker-fixture",
      kind: "openai-compatible",
      name: "Broker Fixture",
      baseUrl: "https://provider.invalid/v1",
    }]);
    process.env[CONFIGURED_PROVIDER_BROKER_URL_ENV] =
      `http://127.0.0.1:${address.port}`;

    const result = await executeProvider(
      getProvider(configuredProviderName("broker-fixture")),
      {
        systemPrompt: "System",
        userMessage: "User",
        model: "fixture/chat-model",
        thinking: "low",
      },
    );

    assert.equal(result.text, "Brokered response");
    assert.equal(received?.provider, "connection:broker-fixture");
    assert.equal(JSON.stringify(received).includes("apiKey"), false);
  } finally {
    setConfiguredProviderConnections([]);
    if (previousBrokerUrl === undefined) {
      delete process.env[CONFIGURED_PROVIDER_BROKER_URL_ENV];
    } else {
      process.env[CONFIGURED_PROVIDER_BROKER_URL_ENV] = previousBrokerUrl;
    }
    await new Promise<void>((resolve, reject) =>
      broker.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("configured provider direct failures preserve specific quota policy", async () => {
  const providerApi = http.createServer((_request, response) => {
    response.statusCode = 429;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      error: {
        message: "Quota exhausted.",
        type: "invalid_request_error",
        code: "insufficient_quota",
      },
    }));
  });
  await new Promise<void>((resolve) =>
    providerApi.listen(0, "127.0.0.1", resolve),
  );
  const address = providerApi.address();
  assert.ok(address && typeof address !== "string");
  const previousBrokerUrl = process.env[CONFIGURED_PROVIDER_BROKER_URL_ENV];

  try {
    delete process.env[CONFIGURED_PROVIDER_BROKER_URL_ENV];
    setConfiguredProviderConnections([{
      id: "direct-error-fixture",
      kind: "openai-compatible",
      name: "Direct Error Fixture",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    }]);

    await assert.rejects(
      executeProvider(
        getProvider(configuredProviderName("direct-error-fixture")),
        {
          systemPrompt: "System",
          userMessage: "User",
          model: "fixture/quota-model",
          thinking: "low",
        },
      ),
      assertQuotaFailure,
    );
  } finally {
    setConfiguredProviderConnections([]);
    restoreBrokerUrl(previousBrokerUrl);
    await new Promise<void>((resolve, reject) =>
      providerApi.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("configured provider broker preserves structured quota policy", async () => {
  const broker = http.createServer((_request, response) => {
    response.statusCode = 429;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(serializeProviderError(new ProviderError({
      provider: "connection:broker-error-fixture",
      message: "Quota exhausted.",
      kind: "billing",
      statusCode: 429,
      code: "insufficient_quota",
      retryable: false,
    }))));
  });
  await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
  const address = broker.address();
  assert.ok(address && typeof address !== "string");
  const previousBrokerUrl = process.env[CONFIGURED_PROVIDER_BROKER_URL_ENV];

  try {
    setConfiguredProviderConnections([{
      id: "broker-error-fixture",
      kind: "openai-compatible",
      name: "Broker Error Fixture",
      baseUrl: "https://provider.invalid/v1",
    }]);
    process.env[CONFIGURED_PROVIDER_BROKER_URL_ENV] =
      `http://127.0.0.1:${address.port}`;

    await assert.rejects(
      executeProvider(
        getProvider(configuredProviderName("broker-error-fixture")),
        {
          systemPrompt: "System",
          userMessage: "User",
          model: "fixture/quota-model",
          thinking: "low",
        },
      ),
      assertQuotaFailure,
    );
  } finally {
    setConfiguredProviderConnections([]);
    restoreBrokerUrl(previousBrokerUrl);
    await new Promise<void>((resolve, reject) =>
      broker.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

function assertQuotaFailure(error: unknown): boolean {
  assert.ok(error instanceof ProviderError);
  assert.equal(error.kind, "billing");
  assert.equal(error.statusCode, 429);
  assert.equal(error.code, "insufficient_quota");
  assert.equal(error.retryable, false);
  assert.equal(
    formatProviderErrorForUser(error),
    "This provider account has no remaining quota or credits. Check billing. (Status 429)",
  );
  return true;
}

function restoreBrokerUrl(previousBrokerUrl: string | undefined): void {
  if (previousBrokerUrl === undefined) {
    delete process.env[CONFIGURED_PROVIDER_BROKER_URL_ENV];
  } else {
    process.env[CONFIGURED_PROVIDER_BROKER_URL_ENV] = previousBrokerUrl;
  }
}

function readRequestBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
