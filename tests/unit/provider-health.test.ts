import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { PROVIDER_FAILURE_USER_MESSAGES } from "../../contracts/provider.js";
import { registerProvider } from "../../providers/registry.js";
import type { Provider, ProviderExecuteOptions } from "../../providers/types.js";
import { ProviderError } from "../../domains/provider/provider-error.js";
import { checkAgentProviderHealth } from "../../domains/agent-generator/provider-health.js";
import { KNOWN_AGENT_PROVIDER_NAMES } from "../../domains/provider/provider-preflight.js";
import type { LocalCliAgentView } from "../../domains/provider/provider-settings.js";
import {
  getRuntimeDefaultModelState,
  setRuntimeDefaultModelState,
} from "../../domains/provider/default-model-selection.js";

const CLI_PROVIDER_NAMES = [
  "codex",
  "claude",
  "gemini",
  "kimi-cli",
  "qwen",
  "pi",
] as const;
const API_PROVIDER_NAMES = KNOWN_AGENT_PROVIDER_NAMES.filter(
  (providerName) => !CLI_PROVIDER_NAMES.includes(
    providerName as (typeof CLI_PROVIDER_NAMES)[number],
  ),
);

test("agent provider health live-pings API providers", async () => {
  const calls: string[] = [];
  for (const providerName of API_PROVIDER_NAMES) {
    registerHealthProvider(providerName, calls);
  }

  await withAgentRepo(API_PROVIDER_NAMES, async (repoRoot) => {
    const health = await checkAgentProviderHealth({ repoRoot });

    assert.equal(health.length, API_PROVIDER_NAMES.length);
    assert.deepEqual(
      health.map((item) => item.status),
      API_PROVIDER_NAMES.map(() => "ok"),
    );
    assert.deepEqual(new Set(calls), new Set(API_PROVIDER_NAMES));
    assert.equal(
      health.some((item) =>
        item.message?.includes("does not expose an API health ping"),
      ),
      false,
    );
  });
});

test("agent provider health uses cached settings for CLI providers without executing them", async () => {
  const calls: string[] = [];
  let settingsReads = 0;
  for (const providerName of CLI_PROVIDER_NAMES) {
    registerHealthProvider(providerName, calls);
  }

  await withAgentRepo(CLI_PROVIDER_NAMES, async (repoRoot) => {
    const health = await checkAgentProviderHealth({
      repoRoot,
      cliSettingsReader: {
        async listCliAgents() {
          settingsReads += 1;
          return CLI_PROVIDER_NAMES.map((provider) => cliAgent(provider));
        },
      },
    });

    assert.deepEqual(
      health.map((item) => item.status),
      CLI_PROVIDER_NAMES.map(() => "ok"),
    );
    assert.equal(settingsReads, 1);
    assert.deepEqual(calls, []);
  });
});

test("agent provider health checks configured provider names", async () => {
  await withAgentRepo(["connection:missing"], async (repoRoot) => {
    const [health] = await checkAgentProviderHealth({ repoRoot });

    assert.equal(health?.status, "error");
    assert.match(
      health?.message ?? "",
      /Configured provider 'connection:missing' is unavailable/,
    );
    assert.equal(
      health?.message?.includes("does not expose an API health ping"),
      false,
    );
  });
});

test("agent provider health reports disabled CLIs and unavailable CLI models", async () => {
  const calls: string[] = [];
  registerHealthProvider("codex", calls);
  registerHealthProvider("claude", calls);

  await withAgentRepo([], async (repoRoot) => {
    const health = await checkAgentProviderHealth({
      repoRoot,
      targets: [
        {
          agentName: "draft-agent",
          provider: "codex",
          model: "gpt-5.5",
        },
        {
          agentName: "draft-claude-agent",
          provider: "claude",
          model: "opus",
        },
      ],
      cliSettingsReader: {
        async listCliAgents() {
          return [
            cliAgent("codex", { enabled: false }),
            cliAgent("claude", {
              models: [{ id: "sonnet", name: "Sonnet", enabled: true }],
            }),
          ];
        },
      },
    });

    assert.equal(health[0]?.status, "error");
    assert.match(health[0]?.message ?? "", /Enable Codex CLI in AI Providers/);
    assert.equal(health[1]?.status, "error");
    assert.match(
      health[1]?.message ?? "",
      /Enable model 'opus' for Claude Code in AI Providers/,
    );
    assert.deepEqual(calls, []);
  });
});

for (const scenario of [
  {
    name: "an exhausted quota",
    error: () =>
      new ProviderError({
        provider: "openai",
        message: "You exceeded your current quota",
        code: "insufficient_quota",
        retryable: false,
      }),
    kind: "billing" as const,
  },
  {
    name: "a rate limit",
    error: () =>
      new ProviderError({
        provider: "openai",
        message: "Rate limit reached for gpt-5.4",
        statusCode: 429,
        retryable: true,
      }),
    kind: "rate_limit" as const,
  },
  {
    name: "a rejected key",
    error: () =>
      new ProviderError({
        provider: "openai",
        message: "Incorrect API key provided: sk-proj-AbCdEf123456",
        statusCode: 401,
        retryable: false,
      }),
    kind: "authentication" as const,
  },
] as const) {
  test(`a health ping that fails on ${scenario.name} is classified rather than quoted`, async () => {
    registerProvider(
      {
        name: "openai",
        async execute() {
          throw scenario.error();
        },
      },
      { source: "tests/unit/provider-health.test.ts", trustClass: "test" },
      { replaceExisting: true },
    );

    await withAgentRepo(["openai"], async (repoRoot) => {
      const [checked] = await checkAgentProviderHealth({ repoRoot });

      assert.ok(checked);
      assert.equal(checked.status, "error");
      assert.equal(checked.diagnostics?.[0]?.kind, scenario.kind);
      assert.equal(
        checked.diagnostics?.[0]?.message,
        `Agent 'agent-openai' (openai): ${PROVIDER_FAILURE_USER_MESSAGES[scenario.kind]}`,
      );
    });
  });
}

test("a health ping failure never repeats the provider's own words", async () => {
  // The provider's prose can carry an account identifier, a file path, or a
  // slice of the request. The kind is the whole of what crosses; the sentence
  // is this build's.
  const leakySecret = "sk-proj-AbCdEf123456";
  registerProvider(
    {
      name: "openai",
      async execute() {
        throw new ProviderError({
          provider: "openai",
          message: `Incorrect API key provided: ${leakySecret}`,
          statusCode: 401,
          retryable: false,
        });
      },
    },
    { source: "tests/unit/provider-health.test.ts", trustClass: "test" },
    { replaceExisting: true },
  );

  await withAgentRepo(["openai"], async (repoRoot) => {
    const [checked] = await checkAgentProviderHealth({ repoRoot });

    assert.ok(checked);
    assert.equal(checked.message?.includes(leakySecret), false);
  });
});

test("a health ping that fails in a way this build cannot name keeps the raw reason", async () => {
  registerProvider(
    {
      name: "openai",
      async execute() {
        throw new Error("socket hang up while dialling the fixture endpoint");
      },
    },
    { source: "tests/unit/provider-health.test.ts", trustClass: "test" },
    { replaceExisting: true },
  );

  await withAgentRepo(["openai"], async (repoRoot) => {
    const [checked] = await checkAgentProviderHealth({ repoRoot });

    assert.ok(checked);
    assert.equal(checked.diagnostics?.[0]?.kind, "unknown");
    assert.match(checked.message ?? "", /socket hang up/);
  });
});

test("agent provider health states the agent, the provider, and the reason as one diagnostic", async () => {
  await withAgentRepo([], async (repoRoot) => {
    const health = await checkAgentProviderHealth({
      repoRoot,
      targets: [
        { agentName: "draft-agent", provider: "codex", model: "gpt-5.5" },
      ],
      cliSettingsReader: {
        async listCliAgents() {
          return [cliAgent("codex", { enabled: false })];
        },
      },
    });

    const [checked] = health;
    assert.ok(checked);
    assert.deepEqual(checked.diagnostics, [
      {
        severity: "error",
        kind: "config",
        message:
          "Agent 'draft-agent' (codex): Enable Codex CLI in AI Providers.",
        subject: {
          agentName: "draft-agent",
          provider: "codex",
          model: "gpt-5.5",
        },
      },
    ]);
    // The badge and any other reader see the same sentence, so a tooltip and a
    // log line can never disagree about what is wrong.
    assert.equal(checked.message, checked.diagnostics?.[0]?.message);
  });
});

test("an inheriting agent is unknown when no app default is selected", async (t) => {
  const previousDefault = getRuntimeDefaultModelState();
  t.after(() => setRuntimeDefaultModelState(previousDefault));
  setRuntimeDefaultModelState({ status: "unset" });
  await withAgentRepo([], async (repoRoot) => {
    const health = await checkAgentProviderHealth({
      repoRoot,
      targets: [{ agentName: "unconfigured-agent" }],
    });

    const [checked] = health;
    assert.ok(checked);
    assert.equal(checked.status, "unknown");
    assert.deepEqual(checked.diagnostics, [
      {
        severity: "warning",
        kind: "config",
        message:
          "Agent 'unconfigured-agent': No application default model is selected. Choose one in Settings → AI Providers.",
        subject: { agentName: "unconfigured-agent" },
      },
    ]);
  });
});

test("a healthy agent carries no diagnostics at all", async () => {
  const calls: string[] = [];
  registerHealthProvider("openai", calls);

  await withAgentRepo(["openai"], async (repoRoot) => {
    const [checked] = await checkAgentProviderHealth({ repoRoot });

    assert.ok(checked);
    assert.equal(checked.status, "ok");
    assert.deepEqual(checked.diagnostics, []);
  });
});

function successfulProvider(providerName: string, calls: string[]): Provider {
  return {
    name: providerName,
    async execute(options: ProviderExecuteOptions) {
      calls.push(providerName);
      return {
        text: "OK",
        cost: 0,
        durationMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        contextTokens: 0,
        model: options.model,
      };
    },
  };
}

function registerHealthProvider(name: string, calls: string[]): void {
  registerProvider(
    successfulProvider(name, calls),
    {
      source: "tests/unit/provider-health.test.ts",
      trustClass: "test",
    },
    { replaceExisting: true },
  );
}

function cliAgent(
  id: string,
  overrides: Partial<LocalCliAgentView> = {},
): LocalCliAgentView {
  return {
    id,
    name: id,
    command: id === "kimi-cli" ? "kimi" : id,
    available: true,
    enabled: true,
    path: `/fixture/${id}`,
    models: [
      { id: "health-test-model", name: "Health test model", enabled: true },
    ],
    mcpBridge: { supported: true },
    ...overrides,
  };
}

async function withAgentRepo<T>(
  providerNames: readonly string[],
  fn: (repoRoot: string) => Promise<T>,
): Promise<T> {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "provider-health-"));
  try {
    const agentsDir = path.join(repoRoot, "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    for (const providerName of providerNames) {
      const agentName = `agent-${providerName.replace(/[^a-z0-9-]/g, "-")}`;
      const agentDir = path.join(agentsDir, agentName);
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentDir, `${agentName}.md`),
        [
          "---",
          `name: ${agentName}`,
          `provider: ${providerName}`,
          "model: health-test-model",
          "---",
          "",
          "# Agent",
          "",
        ].join("\n"),
      );
    }
    return await fn(repoRoot);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}
