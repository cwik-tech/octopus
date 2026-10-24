/**
 * Integration test: the app-wide default model reaches the runtime selection
 * and is invalidated as soon as its backing connection/model is disabled or
 * deleted — no stale in-memory defaults.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { ProviderSettingsService } from "../../services/provider-settings-service.js";
import {
  getRuntimeDefaultModelState,
  runtimeAppDefaultPair,
  setRuntimeDefaultModelState,
} from "../../domains/provider/default-model-selection.js";
import {
  DEFAULT_MODEL_SELECTION_ENV,
  configuredProviderName,
} from "../../domains/provider/provider-settings.js";

test("runtime default model tracks the settings default and invalidates on disable/delete", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "default-model-runtime-"));
  const fixture = await startModelFixture();
  const service = new ProviderSettingsService({
    storagePath: path.join(directory, "provider-settings.json"),
    secretCodec: {
      encrypt: (value) => Buffer.from(value, "utf8").toString("base64"),
      decrypt: (value) => Buffer.from(value, "base64").toString("utf8"),
    },
  });

  setRuntimeDefaultModelState({ status: "unset" });
  try {
    const saved = await service.saveConnection({
      kind: "openai-compatible",
      name: "Fixture API",
      baseUrl: `${fixture.url}/v1`,
      apiKey: "fixture-key",
      enabled: true,
    });
    await service.validateConnection(saved.id);
    await service.setModelEnabled(saved.id, "fixture/chat-model", true);

    const provider = configuredProviderName(saved.id);
    await service.setDefaultModel({ provider, model: "fixture/chat-model" });

    // In-process runtime selection follows the settings default immediately.
    assert.deepEqual(getRuntimeDefaultModelState(), {
      status: "available",
      provider,
      model: "fixture/chat-model",
    });

    // Spawned runtimes receive the selection through the environment.
    const environment = await service.runtimeEnvironment();
    const transported = JSON.parse(
      Buffer.from(
        environment[DEFAULT_MODEL_SELECTION_ENV] ?? "",
        "base64",
      ).toString("utf8"),
    ) as { status: string; provider: string; model: string };
    // The child process must receive exactly the state this process holds.
    assert.deepEqual(transported, {
      status: "available",
      provider,
      model: "fixture/chat-model",
    });
    assert.deepEqual(transported, getRuntimeDefaultModelState());

    // Disabling the backing model makes the default unusable at once — and
    // the deliberate choice stays named rather than being replaced by whatever
    // else the catalog happens to list first.
    await service.setModelEnabled(saved.id, "fixture/chat-model", false);
    assert.equal(getRuntimeDefaultModelState().status, "unavailable");
    assert.equal(runtimeAppDefaultPair(), null);
    const unavailable = getRuntimeDefaultModelState();
    assert.equal(unavailable.status !== "unset" && unavailable.provider, provider);
    assert.equal(
      unavailable.status !== "unset" && unavailable.model,
      "fixture/chat-model",
    );

    // Re-selecting and then disabling the whole connection invalidates too.
    await service.setModelEnabled(saved.id, "fixture/chat-model", true);
    await service.setDefaultModel({ provider, model: "fixture/chat-model" });
    assert.deepEqual(runtimeAppDefaultPair(), {
      provider,
      model: "fixture/chat-model",
    });
    await service.setConnectionEnabled(saved.id, false);
    assert.equal(runtimeAppDefaultPair(), null);

    // Deleting the connection keeps the runtime selection clear of it.
    await service.setConnectionEnabled(saved.id, true);
    await service.setDefaultModel({ provider, model: "fixture/chat-model" });
    await service.deleteConnection(saved.id);
    assert.equal(runtimeAppDefaultPair(), null);

    // A workspace with an enabled model but no deliberate choice has no
    // default. Catalog order is not a second, silent default, and no child
    // process is handed one either.
    const secondFixture = await startModelFixture();
    const freshService = new ProviderSettingsService({
      storagePath: path.join(directory, "fresh-provider-settings.json"),
      secretCodec: {
        encrypt: (value) => Buffer.from(value, "utf8").toString("base64"),
        decrypt: (value) => Buffer.from(value, "base64").toString("utf8"),
      },
    });
    try {
      const other = await freshService.saveConnection({
        kind: "openai-compatible",
        name: "Second Fixture API",
        baseUrl: `${secondFixture.url}/v1`,
        apiKey: "fixture-key",
        enabled: true,
      });
      await freshService.validateConnection(other.id);
      await freshService.setModelEnabled(other.id, "fixture/chat-model", true);
      const snapshot = await freshService.snapshot(false);
      assert.ok(snapshot.catalog.some((group) => group.models.length > 0));
      assert.deepEqual(snapshot.defaultModelState, { status: "unset" });
      const freshEnvironment = await freshService.runtimeEnvironment();
      assert.equal(freshEnvironment[DEFAULT_MODEL_SELECTION_ENV], undefined);
      assert.equal(runtimeAppDefaultPair(), null);
    } finally {
      await secondFixture.close();
    }
  } finally {
    setRuntimeDefaultModelState({ status: "unset" });
    await fixture.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function startModelFixture(): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/models" && req.headers.authorization === "Bearer fixture-key") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ data: [{ id: "fixture/chat-model", name: "Fixture Chat Model" }] }),
      );
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
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
