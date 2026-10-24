import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";

import { loadDotEnv } from "../../core/env-loader.js";
import type { ProviderSecretCodec } from "../../services/provider-settings-service.js";

const REQUIRED_CAPABILITIES = new Set(
  (process.env.PIPELINE_LIVE_REQUIRE ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

const liveEnvDir = process.env.PIPELINE_LIVE_ENV_DIR?.trim();
loadDotEnv(liveEnvDir || process.cwd());

export interface LiveCapability {
  available: boolean;
  reason: string;
}

export function liveTest(
  name: string,
  capabilityId: string,
  capability: LiveCapability,
  run: (context: TestContext) => Promise<void>,
  timeout = 180_000,
): void {
  const required =
    REQUIRED_CAPABILITIES.has("all") || REQUIRED_CAPABILITIES.has(capabilityId);
  test(
    name,
    {
      timeout,
      skip: !capability.available && !required ? capability.reason : false,
    },
    async (context) => {
      assert.ok(
        capability.available,
        `Required live capability '${capabilityId}' is unavailable: ${capability.reason}`,
      );
      await run(context);
    },
  );
}

export function isLiveCapabilityRequired(capabilityId: string): boolean {
  return (
    REQUIRED_CAPABILITIES.has("all") || REQUIRED_CAPABILITIES.has(capabilityId)
  );
}

export async function httpCapability(url: string): Promise<LiveCapability> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    return response.ok
      ? { available: true, reason: `reachable at ${url}` }
      : { available: false, reason: `${url} returned HTTP ${response.status}` };
  } catch (error) {
    return {
      available: false,
      reason: `${url} is unreachable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function apiKeyCapability(
  environmentName: string,
): LiveCapability {
  return process.env[environmentName]?.trim()
    ? { available: true, reason: `${environmentName} is configured` }
    : { available: false, reason: `${environmentName} is not configured` };
}

export async function cliCapability(command: string): Promise<LiveCapability> {
  for (const directory of cliPathEntries()) {
    const candidate = path.join(directory, command);
    try {
      await fsp.access(candidate, fs.constants.X_OK);
      return { available: true, reason: `found ${candidate}` };
    } catch {
      // Continue through the real PATH.
    }
  }
  return { available: false, reason: `'${command}' is not installed on PATH` };
}

export function createLiveSecretCodec(): ProviderSecretCodec {
  const key = crypto.randomBytes(32);
  return {
    encrypt(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
    },
    decrypt(value) {
      const payload = Buffer.from(value, "base64");
      const iv = payload.subarray(0, 12);
      const tag = payload.subarray(12, 28);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(payload.subarray(28)),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}

export function createLiveTempDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function selectChatModel(
  modelIds: string[],
  preferred: string | undefined,
): string {
  if (preferred) {
    assert.ok(
      modelIds.includes(preferred),
      `Requested live model '${preferred}' is not exposed by the provider`,
    );
    return preferred;
  }
  const candidates = modelIds.filter(
    (id) => !/embed|embedding|rerank|image|vision|lyria|safety/i.test(id),
  );
  const selected = [...candidates].sort(
    (left, right) => modelSuitabilityScore(right) - modelSuitabilityScore(left),
  )[0];
  assert.ok(selected, "Provider did not expose a usable chat model");
  return selected;
}

function modelSuitabilityScore(modelId: string): number {
  let score = 0;
  if (/(?:^|[-_/])(1b|2b|3b|4b|e4b)(?:$|[-_/])/i.test(modelId)) score += 8;
  if (/(?:instruct|chat|(?:^|[-_/])it(?:$|[-_/]))/i.test(modelId)) score += 4;
  if (/nano/i.test(modelId)) score += 2;
  if (/reasoning|omni|thinking/i.test(modelId)) score -= 6;
  const parameterMatch = modelId.match(/(?:^|[-_/])(\d{1,3})b(?:$|[-_/])/i);
  if (parameterMatch) score -= Number(parameterMatch[1]) / 100;
  return score;
}

export function cliPathEntries(): string[] {
  return [
    ...(process.env.PATH?.split(path.delimiter) ?? []),
    path.dirname(process.execPath),
    path.join(os.homedir(), ".local", "bin"),
    "/Applications/ChatGPT.app/Contents/Resources",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].filter((value, index, values) => Boolean(value) && values.indexOf(value) === index);
}
