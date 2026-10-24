import { whenDefined } from '../core/optional-properties.js'
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createTextCliProvider,
  requireValidMcpBridge,
  type CliInvocation,
} from "./text-cli.js";
import type { ProviderExecuteOptions } from "./types.js";
import { effortForTurn } from "../domains/provider/effort-support.js";

export function createKimiCliProvider() {
  return createTextCliProvider({
    name: "kimi-cli",
    command: "kimi",
    installHint: "Install Kimi Code CLI and run `kimi login`.",
    buildInvocation: buildKimiInvocation,
  });
}

function buildKimiInvocation(
  options: ProviderExecuteOptions,
  tmpDir: string,
): CliInvocation {
  const args = buildKimiArgs(options);
  if (!options.mcpBridge) {
    return {
      args,
      stdin: [
        "<system-instructions>",
        options.systemPrompt,
        "</system-instructions>",
        "",
        options.userMessage,
      ].join("\n"),
      ...whenDefined(options.cwd, (cwd) => ({ cwd })),
    };
  }

  const bridge = requireValidMcpBridge(options.mcpBridge, "kimi-cli");
  const isolatedShareDir = path.join(tmpDir, "kimi-home");
  const skillsDir = path.join(tmpDir, "skills");
  fs.mkdirSync(isolatedShareDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
  copyKimiAuthenticationState(isolatedShareDir);
  sanitizeKimiConfiguration(isolatedShareDir);

  const systemPromptPath = path.join(tmpDir, "system.md");
  const agentPath = path.join(tmpDir, "agent.yaml");
  const mcpConfigPath = path.join(tmpDir, "mcp.json");
  fs.writeFileSync(systemPromptPath, options.systemPrompt, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.writeFileSync(
    agentPath,
    JSON.stringify(
      {
        version: 1,
        agent: {
          name: "pipeline-mcp",
          system_prompt_path: "./system.md",
          tools: [],
          subagents: {},
        },
      },
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  );
  fs.writeFileSync(
    mcpConfigPath,
    JSON.stringify(
      {
        mcpServers: {
          pipeline: {
            url: bridge.url,
            transport: "http",
            headers: {
              Authorization: `Bearer ${bridge.token}`,
            },
          },
        },
      },
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  );

  args.push(
    "--agent-file",
    agentPath,
    "--mcp-config-file",
    mcpConfigPath,
    "--skills-dir",
    skillsDir,
  );

  return {
    args,
    stdin: options.userMessage,
    ...whenDefined(options.cwd, (cwd) => ({ cwd })),
    environment: {
      KIMI_SHARE_DIR: isolatedShareDir,
      KIMI_CODE_HOME: isolatedShareDir,
      NO_COLOR: "1",
      TERM: "dumb",
    },
  };
}

function buildKimiArgs(options: ProviderExecuteOptions): string[] {
  const args = [
    "--print",
    "--output-format",
    "text",
    "--final-message-only",
    "--input-format",
    "text",
  ];

  if (options.cwd) {
    args.push("--work-dir", options.cwd);
  }

  if (options.model && options.model !== "default") {
    args.push("--model", options.model);
  }

  // This CLI has a switch, not a scale. `off` and `low` both turn thinking off
  // — `low` because that is what this adapter has always done with it, and
  // changing that would quietly alter every agent already set to `low`. An
  // author who asks for the CLI's own default gets neither flag.
  const effort = effortForTurn({
    provider: "kimi-cli",
    model: options.model,
    requested: options.thinking,
  });
  if (effort) {
    args.push(effort === "off" || effort === "low" ? "--no-thinking" : "--thinking");
  }

  const maxSteps = options.providerConfig?.max_steps_per_turn;
  if (typeof maxSteps === "number" && Number.isInteger(maxSteps) && maxSteps > 0) {
    args.push("--max-steps-per-turn", String(maxSteps));
  }

  return args;
}

function copyKimiAuthenticationState(targetDir: string): void {
  const sourceDir = resolveKimiShareDir();
  if (!sourceDir || !fs.existsSync(sourceDir)) return;

  for (const entry of ["config.toml", "config.json", "credentials", "device_id"]) {
    const source = path.join(sourceDir, entry);
    if (!fs.existsSync(source)) continue;
    fs.cpSync(source, path.join(targetDir, entry), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
}

const KIMI_ISOLATION_OVERRIDES = [
  ["default_yolo", "false"],
  ["default_plan_mode", "false"],
  ["skip_afk_prompt_injection", "true"],
  ["hooks", "[]"],
  ["merge_all_available_skills", "false"],
  ["extra_skill_dirs", "[]"],
  ["telemetry", "false"],
] as const;

function sanitizeKimiConfiguration(targetDir: string): void {
  const tomlPath = path.join(targetDir, "config.toml");
  if (fs.existsSync(tomlPath)) {
    let content = fs.readFileSync(tomlPath, "utf8");
    for (const [key, value] of KIMI_ISOLATION_OVERRIDES) {
      content = replaceOrPrependTomlAssignment(content, key, value);
    }
    fs.writeFileSync(tomlPath, content, { encoding: "utf8", mode: 0o600 });
  }

  const jsonPath = path.join(targetDir, "config.json");
  if (fs.existsSync(jsonPath)) {
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Kimi CLI configuration is invalid.");
    }
    const config = parsed as Record<string, unknown>;
    for (const [key, value] of KIMI_ISOLATION_OVERRIDES) {
      config[key] = JSON.parse(value) as unknown;
    }
    fs.writeFileSync(jsonPath, JSON.stringify(config, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

function replaceOrPrependTomlAssignment(
  content: string,
  key: string,
  value: string,
): string {
  const pattern = new RegExp(`^${key}\\s*=.*$`, "m");
  if (pattern.test(content)) return content.replace(pattern, `${key} = ${value}`);
  return `${key} = ${value}\n${content}`;
}

function resolveKimiShareDir(): string | undefined {
  const configured = process.env.KIMI_SHARE_DIR ?? process.env.KIMI_CODE_HOME;
  if (configured) return path.resolve(configured);

  const candidates = [
    path.join(os.homedir(), ".kimi-code"),
    path.join(os.homedir(), ".kimi"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}
