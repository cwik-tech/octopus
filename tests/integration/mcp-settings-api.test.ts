import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  startApiServer,
  type StartedApiServer,
} from "../../server/api-server.js";
import { McpClientManager } from "../../domains/mcp/mcp-client-manager.js";
import type { McpServerView } from "../../domains/mcp/mcp-settings.js";
import { PiRunLauncher } from "../../domains/run/run-launcher.js";
import { FileSystemRunStore } from "../../domains/run/run-store.js";
import {
  McpSettingsService,
  type McpSecretCodec,
} from "../../services/mcp-settings-service.js";

const repoRoot = process.cwd();
const fixtureRoot = path.join(repoRoot, "tests", "fixtures", "mcp");
const waitTimeoutMs = 5_000;

interface InstrumentedStdioFixture {
  wrapperPath: string;
  startedPath: string;
  stoppedPath: string;
}

interface HttpFixture {
  url: string;
  close(): Promise<void>;
}

interface PersistedSettings {
  servers: Array<{
    id: string;
    status: string;
    transport: {
      type: string;
      encryptedEnvironment?: Record<string, { ciphertext: string }>;
      encryptedHeaders?: Record<string, { ciphertext: string }>;
    };
  }>;
}

test("MCP settings API manages real stdio and Streamable HTTP servers with encrypted restart-safe settings", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-settings-api-"));
  const settingsPath = path.join(directory, "mcp-settings.json");
  const codec = createEncryptedSecretCodec();
  const stdioFixture = createInstrumentedStdioFixture(directory);
  const httpFixture = await startHttpFixture();
  let activeServer: StartedApiServer | null = null;

  try {
    activeServer = await startSettingsApi(
      directory,
      new McpSettingsService({
        storagePath: settingsPath,
        secretCodec: codec,
        clientManager: createClientManager(),
      }),
    );

    const stdioCreateResponse = await fetch(`${activeServer.url}/settings/mcps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "stdio-fixture",
        name: "Fixture stdio",
        capabilityAliases: [{ capability: "fixture.read", access: "read" }],
        transport: {
          type: "stdio",
          command: process.execPath,
          args: [stdioFixture.wrapperPath],
          cwd: repoRoot,
          secretEnvironment: {
            MCP_FIXTURE_TOKEN: {
              operation: "replace",
              value: "stdio-secret-original",
            },
          },
        },
      }),
    });
    assert.equal(stdioCreateResponse.status, 201);
    assert.equal(stdioCreateResponse.headers.get("cache-control"), "no-store");
    const stdioCreated = await responseJson<McpServerView>(stdioCreateResponse);
    assert.equal(stdioCreated.enabled, true);
    assert.equal(stdioCreated.status, "unvalidated");
    assert.deepEqual(
      stdioCreated.transport.type === "stdio"
        ? stdioCreated.transport.environmentKeys
        : [],
      ["MCP_FIXTURE_TOKEN"],
    );
    assert.equal(fs.existsSync(stdioFixture.startedPath), false);

    const httpCreateResponse = await fetch(`${activeServer.url}/settings/mcps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "http-fixture",
        name: "Fixture HTTP",
        transport: {
          type: "streamable-http",
          url: httpFixture.url,
          secretHeaders: {
            Authorization: {
              operation: "replace",
              value: "Bearer http-secret-original",
            },
          },
          authentication: { type: "secret-headers" },
        },
      }),
    });
    assert.equal(httpCreateResponse.status, 201);
    const httpCreated = await responseJson<McpServerView>(httpCreateResponse);
    assert.equal(httpCreated.enabled, true);
    assert.equal(httpCreated.status, "unvalidated");
    assert.deepEqual(
      httpCreated.transport.type === "streamable-http"
        ? httpCreated.transport.headerKeys
        : [],
      ["authorization"],
    );

    const listResponse = await fetch(`${activeServer.url}/settings/mcps`);
    assert.equal(listResponse.status, 200);
    assert.equal(listResponse.headers.get("cache-control"), "no-store");
    const listPayload = await responseJson<{ servers: McpServerView[] }>(listResponse);
    assert.equal(listPayload.servers.length, 2);
    const redactedList = JSON.stringify(listPayload);
    assert.equal(redactedList.includes("stdio-secret-original"), false);
    assert.equal(redactedList.includes("http-secret-original"), false);
    assert.equal(redactedList.includes("ciphertext"), false);

    const stdioValidateResponse = await fetch(
      `${activeServer.url}/settings/mcps/stdio-fixture/validate`,
      { method: "POST" },
    );
    assert.equal(stdioValidateResponse.status, 400);
    assert.equal(fs.existsSync(stdioFixture.startedPath), false);
    const acknowledgedStdioValidateResponse = await fetch(
      `${activeServer.url}/settings/mcps/stdio-fixture/validate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stdioTrustAcknowledged: true }),
      },
    );
    assert.equal(acknowledgedStdioValidateResponse.status, 200);
    const stdioValidated = await responseJson<McpServerView>(
      acknowledgedStdioValidateResponse,
    );
    assert.equal(stdioValidated.status, "connected");
    assert.doesNotMatch(JSON.stringify(stdioValidated), /stdioTrustDigest/);
    const firstStdioPid = readStartedPid(stdioFixture);
    assert.equal(isProcessAlive(firstStdioPid), true);

    const httpValidateResponse = await fetch(
      `${activeServer.url}/settings/mcps/http-fixture/validate`,
      { method: "POST" },
    );
    assert.equal(httpValidateResponse.status, 200);
    const httpValidated = await responseJson<McpServerView>(httpValidateResponse);
    assert.equal(httpValidated.status, "connected");
    assert.ok(httpValidated.capabilities.tools);
    assert.ok(httpValidated.capabilities.resources);

    const originalSettingsContent = fs.readFileSync(settingsPath, "utf8");
    assert.equal(originalSettingsContent.includes("stdio-secret-original"), false);
    assert.equal(originalSettingsContent.includes("http-secret-original"), false);
    assert.match(originalSettingsContent, /"stdioTrustDigest": "[a-f0-9]{64}"/);
    const originalCiphertext = readEnvironmentCiphertext(
      settingsPath,
      "stdio-fixture",
      "MCP_FIXTURE_TOKEN",
    );
    assert.ok(originalCiphertext);

    clearStoppedMarker(stdioFixture);
    const preserveResponse = await putStdioServer(
      activeServer.url,
      stdioFixture,
      "Fixture stdio updated",
      { operation: "preserve" },
    );
    assert.equal(preserveResponse.status, 200);
    const preserved = await responseJson<McpServerView>(preserveResponse);
    assert.equal(preserved.status, "unvalidated");
    await waitForStoppedPid(stdioFixture, firstStdioPid);
    assert.equal(isProcessAlive(firstStdioPid), false);
    assert.equal(
      readEnvironmentCiphertext(
        settingsPath,
        "stdio-fixture",
        "MCP_FIXTURE_TOKEN",
      ),
      originalCiphertext,
    );

    clearStoppedMarker(stdioFixture);
    const preserveValidateResponse = await fetch(
      `${activeServer.url}/settings/mcps/stdio-fixture/validate`,
      { method: "POST" },
    );
    assert.equal(preserveValidateResponse.status, 400);
    assert.equal(readStartedPid(stdioFixture), firstStdioPid);
    const acknowledgedPreserveValidateResponse = await fetch(
      `${activeServer.url}/settings/mcps/stdio-fixture/validate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stdioTrustAcknowledged: true }),
      },
    );
    assert.equal(acknowledgedPreserveValidateResponse.status, 200);
    const secondStdioPid = readStartedPid(stdioFixture);
    assert.notEqual(secondStdioPid, firstStdioPid);

    const removeResponse = await putStdioServer(
      activeServer.url,
      stdioFixture,
      "Fixture stdio without secret",
      { operation: "remove" },
    );
    assert.equal(removeResponse.status, 200);
    const removed = await responseJson<McpServerView>(removeResponse);
    assert.equal(
      removed.transport.type === "stdio" && removed.transport.hasSecrets,
      false,
    );
    await waitForStoppedPid(stdioFixture, secondStdioPid);
    assert.equal(
      readEnvironmentCiphertext(
        settingsPath,
        "stdio-fixture",
        "MCP_FIXTURE_TOKEN",
      ),
      undefined,
    );

    const replaceResponse = await putStdioServer(
      activeServer.url,
      stdioFixture,
      "Fixture stdio restart-ready",
      { operation: "replace", value: "stdio-secret-replaced" },
    );
    assert.equal(replaceResponse.status, 200);
    assert.equal(
      fs.readFileSync(settingsPath, "utf8").includes("stdio-secret-replaced"),
      false,
    );

    clearStoppedMarker(stdioFixture);
    const replacementValidateResponse = await fetch(
      `${activeServer.url}/settings/mcps/stdio-fixture/validate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stdioTrustAcknowledged: true }),
      },
    );
    assert.equal(replacementValidateResponse.status, 200);
    const thirdStdioPid = readStartedPid(stdioFixture);

    clearStoppedMarker(stdioFixture);
    const disableResponse = await patchEnabled(
      activeServer.url,
      "stdio-fixture",
      false,
    );
    assert.equal(disableResponse.status, 200);
    const disabled = await responseJson<McpServerView>(disableResponse);
    assert.equal(disabled.status, "disabled");
    await waitForStoppedPid(stdioFixture, thirdStdioPid);
    assert.equal(isProcessAlive(thirdStdioPid), false);

    clearStoppedMarker(stdioFixture);
    const enableResponse = await patchEnabled(
      activeServer.url,
      "stdio-fixture",
      true,
    );
    assert.equal(enableResponse.status, 200);
    const enabled = await responseJson<McpServerView>(enableResponse);
    assert.equal(enabled.status, "connected");
    const fourthStdioPid = readStartedPid(stdioFixture);
    assert.notEqual(fourthStdioPid, thirdStdioPid);

    clearStoppedMarker(stdioFixture);
    const reconnectResponse = await fetch(
      `${activeServer.url}/settings/mcps/stdio-fixture/reconnect`,
      { method: "POST" },
    );
    assert.equal(reconnectResponse.status, 200);
    const reconnected = await responseJson<McpServerView>(reconnectResponse);
    assert.equal(reconnected.status, "connected");
    const fifthStdioPid = readStartedPid(stdioFixture);
    assert.notEqual(fifthStdioPid, fourthStdioPid);
    await waitForStoppedPid(stdioFixture, fourthStdioPid);

    const deleteHttpResponse = await fetch(
      `${activeServer.url}/settings/mcps/http-fixture`,
      { method: "DELETE" },
    );
    assert.equal(deleteHttpResponse.status, 204);

    clearStoppedMarker(stdioFixture);
    await activeServer.close();
    activeServer = null;
    await waitForStoppedPid(stdioFixture, fifthStdioPid);
    assert.equal(isProcessAlive(fifthStdioPid), false);

    clearStoppedMarker(stdioFixture);
    activeServer = await startSettingsApi(
      directory,
      new McpSettingsService({
        storagePath: settingsPath,
        secretCodec: codec,
        clientManager: createClientManager(),
      }),
    );
    const restartListResponse = await fetch(`${activeServer.url}/settings/mcps`);
    const restartList = await responseJson<{ servers: McpServerView[] }>(
      restartListResponse,
    );
    assert.equal(restartList.servers.length, 1);
    assert.equal(restartList.servers[0]?.id, "stdio-fixture");
    assert.equal(restartList.servers[0]?.status, "connected");
    assert.equal(JSON.stringify(restartList).includes("stdio-secret-replaced"), false);
    const restartedStdioPid = readStartedPid(stdioFixture);
    assert.notEqual(restartedStdioPid, fifthStdioPid);
    assert.equal(isProcessAlive(restartedStdioPid), true);

    clearStoppedMarker(stdioFixture);
    await activeServer.close();
    activeServer = null;
    await waitForStoppedPid(stdioFixture, restartedStdioPid);
    assert.equal(isProcessAlive(restartedStdioPid), false);
  } finally {
    await activeServer?.close().catch(() => undefined);
    await httpFixture.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP settings API rejects ambiguous bodies and preserves safe failure categories", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-settings-errors-"));
  const settingsPath = path.join(directory, "mcp-settings.json");
  const unreachablePort = await reserveClosedPort();
  const service = new McpSettingsService({
    storagePath: settingsPath,
    secretCodec: createEncryptedSecretCodec(),
    clientManager: createClientManager(),
  });
  let server: StartedApiServer | null = null;

  const brokenServerInput = {
    id: "broken-http",
    name: "Broken HTTP",
    transport: {
      type: "streamable-http",
      url: `http://127.0.0.1:${unreachablePort}/mcp`,
      authentication: { type: "none" },
    },
  };

  try {
    server = await startSettingsApi(directory, service);

    const createResponse = await fetch(`${server.url}/settings/mcps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(brokenServerInput),
    });
    assert.equal(createResponse.status, 201);

    const duplicateResponse = await fetch(`${server.url}/settings/mcps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...brokenServerInput, id: " broken-http " }),
    });
    assert.equal(duplicateResponse.status, 409);
    assert.equal(duplicateResponse.headers.get("cache-control"), "no-store");

    const validationResponse = await fetch(
      `${server.url}/settings/mcps/broken-http/validate`,
      { method: "POST" },
    );
    assert.equal(validationResponse.status, 502);
    assert.equal(validationResponse.headers.get("cache-control"), "no-store");
    const validationFailure = await responseJson<{
      error: string;
      server: McpServerView;
    }>(validationResponse);
    assert.equal(validationFailure.server.id, "broken-http");
    assert.equal(validationFailure.server.status, "error");
    assert.equal(JSON.stringify(validationFailure).includes("ciphertext"), false);
    assert.equal(
      JSON.stringify(validationFailure).includes(`127.0.0.1:${unreachablePort}`),
      true,
    );

    const failedListResponse = await fetch(`${server.url}/settings/mcps`);
    const failedList = await responseJson<{ servers: McpServerView[] }>(
      failedListResponse,
    );
    assert.equal(failedList.servers[0]?.status, "error");
    const persisted = JSON.parse(
      fs.readFileSync(settingsPath, "utf8"),
    ) as PersistedSettings;
    assert.equal(
      persisted.servers.find((candidate) => candidate.id === "broken-http")
        ?.status,
      "error",
    );

    const disableBrokenResponse = await patchEnabled(
      server.url,
      "broken-http",
      false,
    );
    assert.equal(disableBrokenResponse.status, 200);
    assert.equal(
      (await responseJson<McpServerView>(disableBrokenResponse)).status,
      "disabled",
    );
    const validateDisabledResponse = await fetch(
      `${server.url}/settings/mcps/broken-http/validate`,
      { method: "POST" },
    );
    assert.equal(validateDisabledResponse.status, 409);

    const reenableBrokenResponse = await patchEnabled(
      server.url,
      "broken-http",
      true,
    );
    assert.equal(reenableBrokenResponse.status, 502);
    const reenableFailure = await responseJson<{
      error: string;
      server: McpServerView;
    }>(reenableBrokenResponse);
    assert.equal(reenableFailure.server.enabled, true);
    assert.equal(reenableFailure.server.status, "error");
    const reenabledListResponse = await fetch(`${server.url}/settings/mcps`);
    const reenabledList = await responseJson<{ servers: McpServerView[] }>(
      reenabledListResponse,
    );
    assert.equal(reenabledList.servers[0]?.status, "error");

    const invalidCreateResponse = await fetch(`${server.url}/settings/mcps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...brokenServerInput, unexpected: true }),
    });
    assert.equal(invalidCreateResponse.status, 400);
    assert.equal(invalidCreateResponse.headers.get("cache-control"), "no-store");

    const invalidPatchResponse = await fetch(
      `${server.url}/settings/mcps/broken-http`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false, name: "Not a patch field" }),
      },
    );
    assert.equal(invalidPatchResponse.status, 400);

    const invalidPutResponse = await fetch(
      `${server.url}/settings/mcps/broken-http`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...brokenServerInput, id: "changed-id" }),
      },
    );
    assert.equal(invalidPutResponse.status, 400);

    const unknownPutResponse = await fetch(
      `${server.url}/settings/mcps/unknown-server`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Unknown stdio",
          enabled: true,
          transport: {
            type: "stdio",
            command: process.execPath,
            args: [path.join(fixtureRoot, "stdio-server.mjs")],
            cwd: repoRoot,
          },
        }),
      },
    );
    assert.equal(unknownPutResponse.status, 404);

    const unknownPatchResponse = await patchEnabled(
      server.url,
      "unknown-server",
      false,
    );
    assert.equal(unknownPatchResponse.status, 404);

    for (const action of ["validate", "reconnect"] as const) {
      const response: Response = await fetch(
        `${server.url}/settings/mcps/unknown-server/${action}`,
        { method: "POST" },
      );
      assert.equal(response.status, 404);
    }

    const unknownDeleteResponse = await fetch(
      `${server.url}/settings/mcps/unknown-server`,
      { method: "DELETE" },
    );
    assert.equal(unknownDeleteResponse.status, 404);

    const invalidIdResponse = await fetch(
      `${server.url}/settings/mcps/%252F`,
      { method: "DELETE" },
    );
    assert.equal(invalidIdResponse.status, 400);

    const wrongMethodResponse = await fetch(
      `${server.url}/settings/mcps/broken-http`,
      { method: "POST" },
    );
    assert.equal(wrongMethodResponse.status, 405);
    assert.equal(wrongMethodResponse.headers.get("allow"), "PUT, PATCH, DELETE");
  } finally {
    await server?.close().catch(() => undefined);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function startSettingsApi(
  workspacePath: string,
  mcpSettingsService: McpSettingsService,
): Promise<StartedApiServer> {
  return startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: new PiRunLauncher(),
    workspacePath,
    mcpSettingsService,
  });
}

async function reserveClosedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to reserve an unreachable fixture port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

function createClientManager(): McpClientManager {
  return new McpClientManager({
    connectTimeoutMs: 3_000,
    requestTimeoutMs: 3_000,
    closeTimeoutMs: 3_000,
  });
}

function createEncryptedSecretCodec(): McpSecretCodec {
  const key = randomBytes(32);
  return {
    encrypt(value) {
      const initializationVector = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, initializationVector);
      const ciphertext = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([
        initializationVector,
        cipher.getAuthTag(),
        ciphertext,
      ]).toString("base64");
    },
    decrypt(value) {
      const payload = Buffer.from(value, "base64");
      const initializationVector = payload.subarray(0, 12);
      const authenticationTag = payload.subarray(12, 28);
      const ciphertext = payload.subarray(28);
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        initializationVector,
      );
      decipher.setAuthTag(authenticationTag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}

function createInstrumentedStdioFixture(
  directory: string,
): InstrumentedStdioFixture {
  const wrapperPath = path.join(directory, "instrumented-stdio-fixture.mjs");
  const startedPath = path.join(directory, "stdio-started.pid");
  const stoppedPath = path.join(directory, "stdio-stopped.pid");
  const fixtureUrl = pathToFileURL(
    path.join(fixtureRoot, "stdio-server.mjs"),
  ).href;
  fs.writeFileSync(
    wrapperPath,
    [
      'import * as fs from "node:fs";',
      `const startedPath = ${JSON.stringify(startedPath)};`,
      `const stoppedPath = ${JSON.stringify(stoppedPath)};`,
      'fs.writeFileSync(startedPath, String(process.pid), "utf8");',
      'process.once("exit", () => {',
      '  fs.writeFileSync(stoppedPath, String(process.pid), "utf8");',
      '});',
      `await import(${JSON.stringify(fixtureUrl)});`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return { wrapperPath, startedPath, stoppedPath };
}

async function startHttpFixture(): Promise<HttpFixture> {
  const child = spawn(
    process.execPath,
    [path.join(fixtureRoot, "streamable-http-server.mjs")],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const url = await waitForHttpReady(child, () => stderr);
  return {
    url,
    close: () => stopChild(child),
  };
}

async function waitForHttpReady(
  child: ChildProcess,
  readStderr: () => string,
): Promise<string> {
  if (!child.stdout) throw new Error("HTTP MCP fixture stdout is unavailable");
  const stdout = child.stdout;
  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out starting HTTP MCP fixture: ${readStderr()}`));
    }, waitTimeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      stdout.off("data", onData);
      child.off("exit", onExit);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(
        `HTTP MCP fixture exited before readiness (code=${code}, signal=${signal}): ${readStderr()}`,
      ));
    };
    const onData = (chunk: Buffer | string) => {
      buffer += String(chunk);
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            const message = JSON.parse(line) as {
              type?: string;
              transport?: string;
              url?: string;
            };
            if (
              message.type === "ready" &&
              message.transport === "streamable-http" &&
              typeof message.url === "string"
            ) {
              cleanup();
              resolve(message.url);
              return;
            }
          } catch (error) {
            cleanup();
            reject(new Error(`Invalid HTTP MCP fixture output: ${String(error)}`));
            return;
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    };
    stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForChildExit(child);
  } catch {
    child.kill("SIGKILL");
    await waitForChildExit(child).catch(() => undefined);
  }
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out stopping MCP fixture process"));
    }, waitTimeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    const onExit = () => {
      cleanup();
      resolve();
    };
    child.once("exit", onExit);
  });
}

async function putStdioServer(
  apiBaseUrl: string,
  fixture: InstrumentedStdioFixture,
  name: string,
  secretOperation:
    | { operation: "preserve" }
    | { operation: "remove" }
    | { operation: "replace"; value: string },
): Promise<Response> {
  return fetch(`${apiBaseUrl}/settings/mcps/stdio-fixture`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      enabled: true,
      capabilityAliases: [{ capability: "fixture.read", access: "read" }],
      transport: {
        type: "stdio",
        command: process.execPath,
        args: [fixture.wrapperPath],
        cwd: repoRoot,
        secretEnvironment: { MCP_FIXTURE_TOKEN: secretOperation },
      },
    }),
  });
}

function patchEnabled(
  apiBaseUrl: string,
  serverId: string,
  enabled: boolean,
): Promise<Response> {
  return fetch(`${apiBaseUrl}/settings/mcps/${serverId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

function readEnvironmentCiphertext(
  settingsPath: string,
  serverId: string,
  key: string,
): string | undefined {
  const settings = JSON.parse(
    fs.readFileSync(settingsPath, "utf8"),
  ) as PersistedSettings;
  return settings.servers
    .find((server) => server.id === serverId)
    ?.transport.encryptedEnvironment?.[key]?.ciphertext;
}

function readStartedPid(fixture: InstrumentedStdioFixture): number {
  return Number.parseInt(fs.readFileSync(fixture.startedPath, "utf8"), 10);
}

function clearStoppedMarker(fixture: InstrumentedStdioFixture): void {
  fs.rmSync(fixture.stoppedPath, { force: true });
}

async function waitForStoppedPid(
  fixture: InstrumentedStdioFixture,
  pid: number,
): Promise<void> {
  await waitForCondition(
    () =>
      fs.existsSync(fixture.stoppedPath) &&
      fs.readFileSync(fixture.stoppedPath, "utf8") === String(pid),
    `stdio fixture ${pid} to stop`,
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForCondition(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + waitTimeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

async function responseJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}
