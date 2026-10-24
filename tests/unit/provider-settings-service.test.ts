import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { ProviderSettingsService } from "../../services/provider-settings-service.js";
import { resolveProviderMaxConcurrentRequests } from "../../domains/provider/provider-concurrency.js";

test("provider settings securely persist validated models and expose only enabled catalog entries", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-settings-"));
  const storagePath = path.join(directory, "settings.json");
  const fixture = await startModelFixture();
  const codec = {
    encrypt(value: string) {
      return Buffer.from(`encrypted:${value}`, "utf8").toString("base64");
    },
    decrypt(value: string) {
      return Buffer.from(value, "base64").toString("utf8").slice("encrypted:".length);
    },
  };
  const service = new ProviderSettingsService({ storagePath, secretCodec: codec });

  try {
    const saved = await service.saveConnection({
      kind: "openai-compatible",
      name: "Fixture API",
      baseUrl: `${fixture.url}/v1`,
      apiKey: "secret-key",
      enabled: true,
      maxConcurrentRequests: 3,
    } as Parameters<ProviderSettingsService["saveConnection"]>[0] & {
      maxConcurrentRequests: number;
    });
    assert.equal(
      (saved as typeof saved & { maxConcurrentRequests?: number }).maxConcurrentRequests,
      3,
    );
    assert.equal(saved.hasApiKey, true);
    assert.equal(JSON.stringify(saved).includes("secret-key"), false);

    const validated = await service.validateConnection(saved.id);
    assert.equal(validated.status, "connected");
    assert.equal(validated.models[0]?.id, "fixture/chat-model");
    assert.equal(validated.models[0]?.enabled, false);
    assert.equal(validated.models[0]?.free, true);
    assert.deepEqual(validated.models.map((model) => model.id), [
      "fixture/chat-model",
    ]);
    assert.equal(
      resolveProviderMaxConcurrentRequests({
        provider: `connection:${saved.id}`,
        batchSize: 5,
      }),
      3,
    );

    const snapshot = await service.snapshot();
    const group = snapshot.catalog.find((entry) => entry.name === "Fixture API");
    assert.equal(group, undefined);

    await service.setModelEnabled(saved.id, "fixture/chat-model", true);
    const snapshotEnabled = await service.snapshot();
    const groupEnabled = snapshotEnabled.catalog.find((entry) => entry.name === "Fixture API");
    assert.equal(groupEnabled?.models[0]?.id, "fixture/chat-model");
    const selectedDefault = await service.setDefaultModel({
      provider: `connection:${saved.id}`,
      model: "fixture/chat-model",
    });
    assert.deepEqual(selectedDefault, {
      provider: `connection:${saved.id}`,
      model: "fixture/chat-model",
    });
    assert.deepEqual((await service.snapshot()).defaultModel, selectedDefault);
    assert.equal(JSON.stringify(fs.readFileSync(storagePath, "utf8")).includes("secret-key"), false);

    const reloaded = new ProviderSettingsService({ storagePath, secretCodec: codec });
    await reloaded.hydrateRuntime();
    assert.equal((await reloaded.listConnections())[0]?.models[0]?.enabled, true);
  } finally {
    await fixture.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("no application default is invented from catalog order", async () => {
  // Catalog order must never become a second, silent default. A workspace that
  // has models available but no deliberate choice has no default at all.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-settings-unset-"));
  const storagePath = path.join(directory, "settings.json");
  const fixture = await startModelFixture();
  const service = new ProviderSettingsService({
    storagePath,
    secretCodec: {
      encrypt: (value: string) => Buffer.from(value, "utf8").toString("base64"),
      decrypt: (value: string) => Buffer.from(value, "base64").toString("utf8"),
    },
  });

  try {
    const saved = await service.saveConnection({
      kind: "openai-compatible",
      name: "Fixture API",
      baseUrl: `${fixture.url}/v1`,
      apiKey: "secret-key",
      enabled: true,
    });
    await service.validateConnection(saved.id);
    await service.setModelEnabled(saved.id, "fixture/chat-model", true);

    const snapshot = await service.snapshot();
    assert.ok(
      snapshot.catalog.some((group) => group.models.length > 0),
      "the fixture model should be available to choose",
    );
    assert.deepEqual(snapshot.defaultModelState, { status: "unset" });
    assert.equal(snapshot.defaultModel, null);
  } finally {
    await fixture.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a chosen default that becomes unavailable stays named instead of being replaced", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-settings-unavailable-"));
  const storagePath = path.join(directory, "settings.json");
  const fixture = await startModelFixture();
  const service = new ProviderSettingsService({
    storagePath,
    secretCodec: {
      encrypt: (value: string) => Buffer.from(value, "utf8").toString("base64"),
      decrypt: (value: string) => Buffer.from(value, "base64").toString("utf8"),
    },
  });

  try {
    const saved = await service.saveConnection({
      kind: "openai-compatible",
      name: "Fixture API",
      baseUrl: `${fixture.url}/v1`,
      apiKey: "secret-key",
      enabled: true,
    });
    await service.validateConnection(saved.id);
    await service.setModelEnabled(saved.id, "fixture/chat-model", true);
    await service.setDefaultModel({
      provider: `connection:${saved.id}`,
      model: "fixture/chat-model",
    });

    // The user disables the model the default points at. The stored choice is
    // deliberate and must survive; only its readiness changed.
    await service.setModelEnabled(saved.id, "fixture/chat-model", false);

    const snapshot = await service.snapshot();
    assert.equal(snapshot.defaultModelState.status, "unavailable");
    assert.equal(
      snapshot.defaultModelState.status === "unavailable" &&
        snapshot.defaultModelState.provider,
      `connection:${saved.id}`,
    );
    assert.equal(
      snapshot.defaultModelState.status === "unavailable" &&
        snapshot.defaultModelState.model,
      "fixture/chat-model",
    );
    assert.equal(snapshot.defaultModel, null);

    const persisted = JSON.parse(fs.readFileSync(storagePath, "utf8")) as {
      defaultModel?: { provider: string; model: string };
    };
    assert.deepEqual(persisted.defaultModel, {
      provider: `connection:${saved.id}`,
      model: "fixture/chat-model",
    });
  } finally {
    await fixture.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI agents expose a safe default while discovered concrete models require opt-in", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-settings-cli-"));
  const storagePath = path.join(directory, "settings.json");
  const service = new ProviderSettingsService({ storagePath });

  try {
    const agents = await service.listCliAgents(true);
    const codex = agents.find((agent) => agent.id === "codex");
    assert.ok(codex, "codex agent should be listed");
    assert.ok(codex.models.length > 0, "codex should expose at least its default");

    assert.equal(codex.models.find((model) => model.id === "default")?.enabled, true);
    for (const model of codex.models.filter((entry) => entry.id !== "default")) {
      assert.equal(model.enabled, false);
    }

    await service.setCliModelEnabled("codex", "default", false);
    const snapshot = await service.snapshot();
    const codexGroup = snapshot.catalog.find((group) => group.provider === "codex");
    assert.equal(codexGroup, undefined);

    const reloaded = new ProviderSettingsService({ storagePath });
    const reloadedAgents = await reloaded.listCliAgents(true);
    const reloadedCodex = reloadedAgents.find((agent) => agent.id === "codex");
    const reloadedModel = reloadedCodex?.models.find((model) => model.id === "default");
    assert.equal(reloadedModel?.enabled, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI MCP probes are cached, enforce Claude isolation, and defer Kimi plugin isolation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-cli-mcp-probe-"));
  const binDirectory = path.join(directory, "bin");
  const probeLogPath = path.join(directory, "probe.log");
  const kimiSharePath = path.join(directory, "kimi-share");
  fs.mkdirSync(binDirectory, { recursive: true });
  writeCliProbeFixture(binDirectory, "codex", [
    "--config --disable --ephemeral --ignore-rules --strict-config --ignore-user-config",
    "--url --bearer-token-env-var",
  ], probeLogPath);
  writeCliProbeFixture(binDirectory, "claude", [
    "--mcp-config --strict-mcp-config --tools --allowedTools --permission-mode --setting-sources --disable-slash-commands",
  ], probeLogPath);
  writeCliProbeFixture(binDirectory, "kimi", [
    "--mcp-config-file --agent-file",
  ], probeLogPath);

  const originalEnvironment = {
    PATH: process.env.PATH,
    PIPELINE_CLI_PATH_FALLBACK: process.env.PIPELINE_CLI_PATH_FALLBACK,
    KIMI_SHARE_DIR: process.env.KIMI_SHARE_DIR,
    KIMI_CODE_HOME: process.env.KIMI_CODE_HOME,
  };
  process.env.PATH = binDirectory;
  process.env.PIPELINE_CLI_PATH_FALLBACK = "0";
  process.env.KIMI_SHARE_DIR = kimiSharePath;
  process.env.KIMI_CODE_HOME = path.join(directory, "kimi-code-home");

  try {
    const service = new ProviderSettingsService();
    const initial = await service.listCliAgents(true);
    for (const provider of ["codex", "claude", "kimi-cli"]) {
      assert.deepEqual(
        initial.find((agent) => agent.id === provider)?.mcpBridge,
        { supported: true },
        provider,
      );
    }
    const initialProbeLog = fs.readFileSync(probeLogPath, "utf8");
    await service.listCliAgents(false);
    assert.equal(fs.readFileSync(probeLogPath, "utf8"), initialProbeLog);

    await service.listCliAgents(true);
    assert.ok(fs.readFileSync(probeLogPath, "utf8").length > initialProbeLog.length);

    writeCliProbeFixture(binDirectory, "codex", [
      "--config --disable --ephemeral --ignore-rules --strict-config --ignore-user-config",
      "--url",
    ], probeLogPath);
    assert.deepEqual(
      (await service.listCliAgents(true)).find((agent) => agent.id === "codex")?.mcpBridge,
      {
        supported: false,
        reasonCode: "cli_mcp_config_unsupported",
      },
    );

    writeCliProbeFixture(binDirectory, "claude", [
      "--mcp-config --strict-mcp-config --tools --allowedTools --permission-mode --setting-sources",
    ], probeLogPath);
    assert.deepEqual(
      (await service.listCliAgents(true)).find((agent) => agent.id === "claude")?.mcpBridge,
      {
        supported: false,
        reasonCode: "cli_tool_isolation_unsupported",
      },
    );
    writeCliProbeFixture(binDirectory, "claude", [
      "--mcp-config --strict-mcp-config --tools --allowedTools --disable-slash-commands",
    ], probeLogPath);
    assert.deepEqual(
      (await service.listCliAgents(true)).find((agent) => agent.id === "claude")?.mcpBridge,
      {
        supported: false,
        reasonCode: "cli_tool_isolation_unsupported",
      },
    );

    writeCliProbeFixture(binDirectory, "kimi", ["--mcp-config-file"], probeLogPath);
    assert.deepEqual(
      (await service.listCliAgents(true)).find((agent) => agent.id === "kimi-cli")?.mcpBridge,
      {
        supported: false,
        reasonCode: "cli_tool_isolation_unsupported",
      },
    );
    writeCliProbeFixture(binDirectory, "kimi", [
      "--mcp-config-file --agent-file",
    ], probeLogPath);

    const pluginDirectory = path.join(kimiSharePath, "plugins", "unsafe-plugin");
    fs.mkdirSync(pluginDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDirectory, "plugin.json"),
      JSON.stringify({ name: "unsafe-plugin", tools: [{ command: "run" }] }),
      "utf8",
    );
    const withPlugin = await service.listCliAgents(true);
    assert.deepEqual(
      withPlugin.find((agent) => agent.id === "kimi-cli")?.mcpBridge,
      { supported: true },
    );
  } finally {
    restoreEnvironment("PATH", originalEnvironment.PATH);
    restoreEnvironment(
      "PIPELINE_CLI_PATH_FALLBACK",
      originalEnvironment.PIPELINE_CLI_PATH_FALLBACK,
    );
    restoreEnvironment("KIMI_SHARE_DIR", originalEnvironment.KIMI_SHARE_DIR);
    restoreEnvironment("KIMI_CODE_HOME", originalEnvironment.KIMI_CODE_HOME);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("all provider connections require explicit model enablement", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-settings-defaults-"));
  const storagePath = path.join(directory, "settings.json");
  const fixture = await startModelFixture();
  const codec = {
    encrypt(value: string) {
      return Buffer.from(`encrypted:${value}`, "utf8").toString("base64");
    },
    decrypt(value: string) {
      return Buffer.from(value, "base64").toString("utf8").slice("encrypted:".length);
    },
  };
  const service = new ProviderSettingsService({ storagePath, secretCodec: codec });

  try {
    const saved = await service.saveConnection({
      kind: "openrouter",
      name: "Fixture Router",
      baseUrl: `${fixture.url}/v1`,
      apiKey: "secret-key",
      enabled: true,
    });
    const validated = await service.validateConnection(saved.id);
    assert.equal(validated.status, "connected");
    assert.equal(validated.models[0]?.enabled, false);

    const saved2 = await service.saveConnection({
      kind: "openai-compatible",
      name: "Fixture API 2",
      baseUrl: `${fixture.url}/v1`,
      apiKey: "secret-key",
      enabled: true,
    });
    const validated2 = await service.validateConnection(saved2.id);
    assert.equal(validated2.models[0]?.enabled, false);
  } finally {
    await fixture.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function startModelFixture(): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/key") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: { limit: null } }));
      return;
    }
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [
            {
              id: "fixture/chat-model",
              name: "Fixture Chat Model",
              context_length: 32_000,
              pricing: { prompt: "0", completion: "0" },
            },
            { id: "fixture/embedding-model", type: "embedding" },
            { id: "fixture/tts-model", name: "Fixture TTS" },
          ],
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture failed to listen");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function writeCliProbeFixture(
  binDirectory: string,
  command: string,
  helpLines: readonly string[],
  probeLogPath: string,
): void {
  const scriptPath = path.join(binDirectory, command);
  const helpCases = command === "codex"
    ? [
        `if [ "$1 $2" = "exec --help" ]; then echo '${helpLines[0]}'; exit 0; fi`,
        `if [ "$1 $2 $3" = "mcp add --help" ]; then echo '${helpLines[1]}'; exit 0; fi`,
        "if [ \"$1 $2\" = \"debug models\" ]; then echo '{\"models\":[]}'; exit 0; fi",
      ]
    : [`if [ "$1" = "--help" ]; then echo '${helpLines[0]}'; exit 0; fi`];
  fs.writeFileSync(
    scriptPath,
    [
      "#!/bin/sh",
      `echo "$0 $*" >> ${quoteShellArgument(probeLogPath)}`,
      `if [ "$1" = "--version" ]; then echo '${command} fixture 1.0.0'; exit 0; fi`,
      ...helpCases,
      "exit 1",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(scriptPath, 0o700);
}

function quoteShellArgument(value: string): string {
  return `'${value.split("'").join("'\"'\"'")}'`;
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
