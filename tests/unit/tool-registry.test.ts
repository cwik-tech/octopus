import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { serialCapabilityEffect } from "../../contracts/capability-effect.js";
import type { RuntimeCapabilityAuthorityPort } from "../../contracts/runtime-capability-authority.js";
import {
  type BrowserToolOutput,
  BROWSER_TOOL_URL_ENV,
} from "../../domains/browser/browser-types.js";
import { BrowserManager } from "../../domains/browser/browser-manager.js";
import {
  RESEARCH_WEB_TOOL_URL_ENV,
} from "../../domains/acquisition/acquisition-types.js";
import {
  GENERATE_EXCEL_TOOL_URL_ENV,
} from "../../domains/excel-generation/generate-excel-types.js";
import {
  MCP_RUNTIME_CONTRACT_VERSION,
  type McpBrokerRequestContext,
} from "../../domains/mcp/mcp-runtime.js";
import { GenerateWordToolService } from "../../services/generate-word-tool-service.js";
import type {
  BrowserCapabilityDispatchInput,
  BrowserCapabilityDispatchInvoker,
} from "../../services/browser-capability-adapter.js";
import type { BrowserToolModuleService } from "../../server/tools/browser.js";
import {
  GENERATE_WORD_TOOL_CONTRACT_VERSION,
  GENERATE_WORD_TOOL_URL_ENV,
  type GenerateWordToolOutput,
} from "../../domains/word-generation/generate-word-types.js";
import {
  YOUTUBE_TOOL_URL_ENV,
} from "../../domains/youtube/youtube-types.js";
import {
  buildToolRegistry,
  toolModules,
  type ToolModule,
} from "../../server/tools/tool-registry.js";
import { browserToolModule } from "../../server/tools/browser.js";
import { createCapabilityTestDispatcher } from "../support/capability-dispatcher.js";

test("tool registry exposes hash-pinned progressive skill loading", async (context) => {
  const repoRootPath = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "skill-tool-registry-")),
  );
  context.after(() => fs.rm(repoRootPath, { recursive: true, force: true }));
  const skillPath = path.join(
    repoRootPath,
    "agents",
    "analyst",
    "skills",
    "evidence-review",
    "SKILL.md",
  );
  const content = "# Evidence Review\n\nSELECTED-SKILL-CONTENT\n";
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, content);
  const registered = buildToolRegistry({
    repoRootPath,
    capabilityDispatcher: createCapabilityTestDispatcher(),
  }).find(
    (entry) => entry.name === "skill-loader",
  );

  assert.ok(registered?.agentTool);
  assert.equal(
    registered.agentTool.name,
    "mcp__pipeline_skills__load_skill",
  );
  assert.equal(
    registered.agentTool.isEnabledForAgent("agents/analyst"),
    true,
  );
  const result = await registered.agentTool.execute({
    context: brokerContext("agents/analyst"),
    toolCallId: "load-skill-call",
    input: {
      source: skillPath,
      sha256: createHash("sha256").update(content).digest("hex"),
    },
  });
  assert.equal(result.isError, false);
  assert.match(result.content, /SELECTED-SKILL-CONTENT/);
});

test("tool registry preserves stable order and unique capability metadata", async (context) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "tool-registry-")),
  );
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = new BrowserManager({
    profilePath: path.join(root, "browser-profile"),
    executablePath: path.join(root, "missing-browser"),
  });
  context.after(() => manager.close());
  const endpointTokens: Readonly<Record<string, string>> = {
    youtube: "youtube-token",
    browser: "browser-token",
    "research-web": "research-web-token",
    "generate-word": "word-token",
    "generate-excel": "excel-token",
  };

  assert.deepEqual(
    toolModules.map((module) => module.name),
    [
      "youtube",
      "browser",
      "research-web",
      "generate-word",
      "generate-excel",
      "skill-loader",
      "create-file",
    ],
  );
  const registry = buildToolRegistry({
    workspacePath: path.join(root, "workspace"),
    repoRootPath: process.cwd(),
    createWorkerEndpointToken: (toolName) => endpointTokens[toolName]!,
    browserManager: manager,
    runtimeCapabilityAuthority: {
      authorize: async (claims) => ({
        taskId: claims.taskId,
        workflowId: claims.workflowId ?? "registry-workflow",
        runPath: "/registry/run",
        assignmentPath: "/registry/run/assignments/assignment-1",
      }),
    },
    capabilityDispatcher: createCapabilityTestDispatcher(),
    moduleOptions: {
      browser: {
        dispatchInvoker: {
          execute: async () => ({
            ok: false,
            action: "observe",
            error: {
              code: "internal",
              message: "Registry metadata fixture does not execute Browser.",
              retryable: false,
            },
          }),
          releaseAssignment: async () => undefined,
        },
      },
      youtube: {
        settingsOptions: { environment: {} },
      },
    },
  });

  assert.deepEqual(
    registry.map((entry) => entry.name),
    [
      "youtube",
      "browser",
      "research-web",
      "generate-word",
      "generate-excel",
      "skill-loader",
      "create-file",
    ],
  );
  assert.deepEqual(
    registry.map((entry) => entry.workerEndpoint?.path),
    [
      "/_pipeline-youtube/youtube-token",
      "/_pipeline-browser/browser-token",
      "/_pipeline-research-web/research-web-token",
      "/_pipeline-generate-word/word-token",
      "/_pipeline-generate-excel/excel-token",
      undefined,
      undefined,
    ],
  );
  assert.deepEqual(
    registry.map((entry) => entry.workerEndpoint?.environmentVariable),
    [
      YOUTUBE_TOOL_URL_ENV,
      BROWSER_TOOL_URL_ENV,
      RESEARCH_WEB_TOOL_URL_ENV,
      GENERATE_WORD_TOOL_URL_ENV,
      GENERATE_EXCEL_TOOL_URL_ENV,
      undefined,
      undefined,
    ],
  );
  assert.equal(
    new Set(registry.map((entry) => entry.name)).size,
    registry.length,
  );
  assert.equal(
    new Set(registry.flatMap((entry) => entry.workerEndpoint ? [entry.workerEndpoint.path] : [])).size,
    registry.filter((entry) => entry.workerEndpoint).length,
  );
  assert.equal(
    new Set(
      registry.flatMap((entry) => entry.workerEndpoint ? [entry.workerEndpoint.environmentVariable] : []),
    ).size,
    registry.filter((entry) => entry.workerEndpoint).length,
  );
  assert.equal(
    new Set(registry.flatMap((entry) => entry.routes.map((route) => route.id)))
      .size,
    registry.flatMap((entry) => entry.routes).length,
  );
});

test("tool registry retains settings routes and omits unavailable capabilities", () => {
  for (const registry of [
    buildToolRegistry({}),
    buildToolRegistry({
      moduleOptions: {
        browser: { endpoint: { token: "unused-browser" } },
        youtube: { endpoint: { token: "unused-youtube" } },
        "generate-word": { endpoint: { token: "unused-word" } },
        "generate-excel": { endpoint: { token: "unused-excel" } },
      },
    }),
  ]) {
    assert.deepEqual(
      registry.map((entry) => entry.name),
      ["youtube", "browser", "research-web"],
    );
    assert.equal(
      registry.some((entry) => entry.workerEndpoint !== undefined),
      false,
    );
    assert.equal(
      registry.some((entry) => entry.agentTool !== undefined),
      false,
    );
    assert.deepEqual(
      registry[0]?.routes.map((route) => route.id),
      ["youtube-settings"],
    );
    assert.deepEqual(
      registry[1]?.routes.map((route) => route.id),
      ["browser-settings-and-activity"],
    );
    // The unified research-activity endpoint is always registered, like the
    // browser activity route: with no source tool it answers an empty list
    // rather than disappearing and turning a poll into a 404.
    assert.deepEqual(
      registry[2]?.routes.map((route) => route.id),
      ["research-acquisition-settings", "research-activity"],
    );
  }
});

test("injected service is shared exactly by services, route, and agent adapter", async (context) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "tool-registry-injected-")),
  );
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspacePath = path.join(root, "workspace");
  const repoRootPath = path.join(root, "repo");
  await fs.mkdir(path.join(repoRootPath, "agents", "documenter"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(repoRootPath, "agents", "documenter", "documenter.md"),
    [
      "---",
      "name: documenter",
      "tools: generate_word",
      "---",
      "",
      "# Documenter",
      "",
    ].join("\n"),
  );
  await fs.mkdir(workspacePath, { recursive: true });
  const service = new GenerateWordToolService({
    workspacePath,
    repoRootPath,
  });
  const runtimeCapabilityAuthority: RuntimeCapabilityAuthorityPort = {
    authorize: async (claims) => ({
      taskId: claims.taskId,
      workflowId: "tool-registry-workflow",
      runPath: "/tool-registry/run",
      assignmentPath: "/tool-registry/run/assignments/assignment-1",
    }),
  };
  const registered = buildToolRegistry({
    runtimeCapabilityAuthority,
    capabilityDispatcher: createCapabilityTestDispatcher(),
    moduleOptions: {
      "generate-word": {
        toolService: service,
        endpoint: { token: "injected-word" },
      },
    },
  }).find((entry) => entry.name === "generate-word");
  assert.ok(registered);
  assert.equal(registered.services.generateWordToolService, service);
  assert.equal(registered.agentTool?.name, service.tool.namespacedName);
  assert.equal(registered.agentTool?.tool, service.tool);
  assert.equal(
    registered.agentTool?.isEnabledForAgent("agents/documenter"),
    true,
  );

  const adapterResult = await registered.agentTool?.execute({
    context: brokerContext(),
    toolCallId: "adapter-call",
    input: { action: "list_profiles" },
  });
  const adapterOutput =
    adapterResult?.output as GenerateWordToolOutput | undefined;
  assert.equal(adapterOutput?.ok, true);
  assert.equal(adapterResult?.isError, false);
  assert.equal(adapterResult?.content, JSON.stringify(adapterResult.output));
  assert.equal(adapterOutput?.profiles?.length ?? 0, 5);

  const capabilityRoute = registered.routes.find(
    (route) => route.id === "generate-word-tool-capability",
  );
  assert.ok(capabilityRoute);
  const server = await startServer(async (req, res) => {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "127.0.0.1"}`,
    );
    const handled = await capabilityRoute.handler({
      req,
      res,
      url,
      services: undefined,
    });
    if (!handled) {
      res.statusCode = 404;
      res.end();
    }
  });
  context.after(() => server.close());

  const response = await fetch(
    `${server.baseUrl}/_pipeline-generate-word/injected-word`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: GENERATE_WORD_TOOL_CONTRACT_VERSION,
        context: {
          ...brokerContext(),
          taskId: "task-1",
          processIdentity: "process-1",
        },
        toolCallId: "route-call",
        input: { action: "list_profiles" },
      }),
    },
  );
  assert.equal(response.status, 200);
  const payload = await response.json() as {
    output: { ok: boolean; action: string; profiles: unknown[] };
  };
  assert.equal(payload.output.ok, true);
  assert.equal(payload.output.action, "list_profiles");
  assert.equal(payload.output.profiles.length, 5);
});

test("browser adapter preserves screenshots, web observations, and assignment release", async () => {
  const browserOutput: BrowserToolOutput = {
    ok: true,
    action: "observe",
    url: "https://example.test/source",
    title: "Source title",
    text: "Receipt-backed source text.",
    attachment: {
      id: "attachment-1",
      kind: "screenshot",
      name: "source.png",
      relativePath: "source.png",
      mimeType: "image/png",
      sizeBytes: 4,
    },
  };
  const released: unknown[] = [];
  const dispatches: BrowserCapabilityDispatchInput[] = [];
  const browserService = {
    tool: {
      serverId: "builtin.browser",
      serverName: "Managed Browser",
      toolName: "browser",
      namespacedName: "browser",
      inputSchema: {},
      annotations: { openWorldHint: true },
      risk: "unknown",
      effect: serialCapabilityEffect("unknown"),
      requiresApproval: false,
    },
    isEnabledForAgent: () => true,
    listSession: async () => [],
    readAttachment: async () => null,
    readToolAttachment: async () => ({
      data: Buffer.from("image"),
      mimeType: "image/png",
    }),
  } satisfies BrowserToolModuleService;
  const dispatchInvoker: BrowserCapabilityDispatchInvoker = {
    execute: async (input) => {
      dispatches.push(input);
      return browserOutput;
    },
    releaseAssignment: async (scope) => {
      released.push(scope);
    },
  };
  const contribution = browserToolModule.build({
    moduleOptions: {
      browser: { toolService: browserService, dispatchInvoker },
    },
  });
  assert.equal(contribution.agentTool?.tool, browserService.tool);

  const result = await contribution.agentTool?.execute({
    context: brokerContext(),
    toolCallId: "browser-call",
    input: { action: "observe" },
  });
  assert.deepEqual(result, {
    output: browserOutput,
    content: JSON.stringify(browserOutput),
    isError: false,
    images: [{
      data: Buffer.from("image").toString("base64"),
      mimeType: "image/png",
    }],
    webObservation: {
      url: "https://example.test/source",
      title: "Source title",
      text: "Receipt-backed source text.",
    },
  });
  assert.equal(dispatches.length, 1);
  assert.deepEqual(dispatches[0]?.authority, {
    kind: "mcp-lease",
    leaseId: brokerContext().leaseId,
  });
  assert.deepEqual(dispatches[0]?.source, {
    kind: "builtin",
    id: "builtin.browser",
    version: "3",
  });

  const scope = {
    sessionId: "session-1",
    runId: "run-1",
    assignmentId: "assignment-1",
    activityScopeId: "lane-1",
  };
  await contribution.agentTool?.releaseAssignment?.(scope);
  assert.deepEqual(released, [scope]);
});

test("a fifth tool registers through one module entry and namespaced options", () => {
  let buildCount = 0;
  const fifthTool: ToolModule<{ readonly fifthService: { readonly value: string } }> = {
    name: "fifth",
    optionKeys: ["value"],
    build(deps) {
      buildCount += 1;
      const options = deps.moduleOptions?.fifth as
        | { readonly value?: unknown }
        | undefined;
      assert.equal(options?.value, "configured");
      return {
        services: {
          fifthService: { value: String(options.value) },
        },
        routes: [{
          id: "fifth-route",
          stage: "api",
          authorization: "api",
          streaming: "none",
          methods: ["POST"],
          path: { kind: "exact", path: "/fifth" },
          handler: async () => true,
        }],
        routeOrder: 4,
        workerEndpoint: {
          environmentVariable: "FIFTH_TOOL_URL",
          path: "/_pipeline-fifth/configured",
        },
        agentTool: {
          name: "fifth",
          tool: {
            serverId: "builtin.fifth",
            serverName: "Fifth",
            toolName: "fifth",
            namespacedName: "fifth",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true },
            risk: "read-only",
            effect: serialCapabilityEffect("read-only"),
            requiresApproval: false,
          },
          isEnabledForAgent: () => true,
          execute: async () => ({
            output: { value: options.value },
            content: String(options.value),
            isError: false,
          }),
        },
        agentToolOrder: 4,
        startActions: [{
          name: "fifth-start",
          run: () => undefined,
        }],
      };
    },
  };

  const registry = buildToolRegistry(
    {
      moduleOptions: {
        fifth: { value: "configured" },
      },
    },
    [fifthTool],
  );

  assert.equal(registry.length, 1);
  assert.equal(registry[0]?.name, "fifth");
  assert.deepEqual(registry[0]?.services.fifthService, {
    value: "configured",
  });
  assert.equal(registry[0]?.routes[0]?.id, "fifth-route");
  assert.equal(registry[0]?.workerEndpoint?.environmentVariable, "FIFTH_TOOL_URL");
  assert.equal(registry[0]?.agentTool?.name, "fifth");
  assert.equal(registry[0]?.startActions?.[0]?.name, "fifth-start");
  assert.equal(buildCount, 1);
  assert.throws(
    () =>
      buildToolRegistry(
        { moduleOptions: { misspelled: {} } },
        [fifthTool],
      ),
    /Unknown tool module option: misspelled/,
  );
  assert.throws(
    () =>
      buildToolRegistry(
        { moduleOptions: { fifth: "invalid" } },
        [fifthTool],
      ),
    /Tool module options must be an object: fifth/,
  );
  assert.throws(
    () =>
      buildToolRegistry(
        {
          moduleOptions: {
            fifth: { value: "configured", unexpected: true },
          },
        },
        [fifthTool],
      ),
    /Unknown fifth tool module option: unexpected/,
  );
  assert.equal(buildCount, 1);
});

function brokerContext(
  agentPath = "agents/documenter",
): McpBrokerRequestContext {
  return {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: "request-1",
    leaseId: "lease-1",
    sessionId: "session-1",
    runId: "run-1",
    assignmentId: "assignment-1",
    agentPath,
  };
}

async function startServer(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<void>,
): Promise<{ readonly baseUrl: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    void handler(req, res).catch((error) => {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
