import assert from 'node:assert/strict'
import * as http from 'node:http'
import test from 'node:test'

import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import type { RuntimeCapabilityAuthorityPort } from '../../contracts/runtime-capability-authority.js'
import {
  RESEARCH_WEB_SERVER_ID,
  RESEARCH_WEB_TOOL_CONTRACT_VERSION,
  type ResearchWebToolOutput,
} from '../../domains/acquisition/acquisition-types.js'
import {
  MCP_RUNTIME_CONTRACT_VERSION,
  type McpBrokerRequestContext,
  type McpJsonObject,
  type McpNamespacedTool,
} from '../../domains/mcp/mcp-runtime.js'
import type { LoadSkillOutput } from '../../services/skill-loader-service.js'
import {
  RESEARCH_WEB_CAPABILITY_ID,
  type ResearchWebCapabilityDispatchInput,
  type ResearchWebCapabilityDispatchInvoker,
} from '../../services/research-web-capability-adapter.js'
import {
  SKILL_LOADER_CAPABILITY_ID,
  type SkillLoaderCapabilityDispatchInput,
  type SkillLoaderCapabilityDispatchInvoker,
} from '../../services/skill-loader-capability-adapter.js'
import {
  researchWebToolModule,
  type ResearchWebToolModuleService,
} from '../../server/tools/research-web.js'
import {
  skillLoaderToolModule,
  type SkillLoaderToolModuleService,
} from '../../server/tools/skill-loader.js'

const RESEARCH_REQUEST_URL = 'https://example.test/source?tracking=removed'

const researchOutput: ResearchWebToolOutput = {
  ok: true,
  action: 'acquire',
  requestedUrl: RESEARCH_REQUEST_URL,
  finalUrl: 'https://example.test/source',
  canonicalUrl: 'https://example.test/source',
  title: 'Receipt-backed source',
  mediaType: 'text/markdown',
  method: 'direct-http',
  text: 'Verified observation text.',
  observationReceipt: {
    schemaVersion: 2,
    receiptId: 'receipt-1',
    activityId: 'activity-1',
    activityScopeId: 'lane-1',
    relativePath: 'research/acquisitions/receipt-1.json',
    method: 'direct-http',
    requestedUrl: RESEARCH_REQUEST_URL,
    finalUrl: 'https://example.test/source',
    canonicalUrl: 'https://example.test/source',
    observedAt: '2026-08-14T12:00:00.000Z',
    contentRelativePath: 'research/acquisitions/receipt-1.md',
    contentSha256: 'a'.repeat(64),
    contentBytes: 26,
    quality: 'usable',
  },
  attempts: [{
    method: 'direct-http',
    outcome: 'usable',
    startedAt: '2026-08-14T12:00:00.000Z',
    durationMs: 12,
  }],
}

test('research provider and parent route preserve one dispatched output and provenance', async (context) => {
  let rawExecutions = 0
  const dispatches: ResearchWebCapabilityDispatchInput[] = []
  const releases: unknown[] = []
  const service: ResearchWebToolModuleService = {
    tool: researchTool(),
    isEnabledForAgent: () => true,
    listSession: async () => [],
    execute: async () => {
      rawExecutions += 1
      throw new Error('raw research service execution bypassed dispatch')
    },
    releaseAssignment: async (scope) => {
      releases.push(scope)
    },
  }
  const dispatchInvoker: ResearchWebCapabilityDispatchInvoker = {
    execute: async (input) => {
      dispatches.push(input)
      return researchOutput
    },
    releaseAssignment: (scope) => service.releaseAssignment(scope),
  }
  let routeAuthorityChecks = 0
  const authority: RuntimeCapabilityAuthorityPort = {
    authorize: async (claims) => {
      routeAuthorityChecks += 1
      return {
        taskId: claims.taskId,
        workflowId: claims.workflowId ?? 'workflow-1',
        runPath: '/runtime/run-1',
        assignmentPath: '/runtime/run-1/assignments/assignment-1',
      }
    },
  }
  const contribution = researchWebToolModule.build({
    runtimeCapabilityAuthority: authority,
    moduleOptions: {
      'research-web': {
        toolService: service,
        dispatchInvoker,
        endpoint: { token: 'research-token' },
      },
    },
  })
  assert.ok(contribution.agentTool)

  const provider = await contribution.agentTool.execute({
    context: brokerContext(),
    toolCallId: 'provider-call',
    input: { action: 'acquire', url: RESEARCH_REQUEST_URL },
  })
  assert.deepEqual(provider, {
    output: researchOutput,
    content: JSON.stringify(researchOutput),
    isError: false,
    webObservation: {
      url: researchOutput.canonicalUrl,
      title: researchOutput.title,
      text: researchOutput.text,
    },
  })

  const route = contribution.routes.find(
    (candidate) => candidate.id === 'research-web-tool-capability',
  )
  assert.ok(route)
  const server = await startRouteServer(route.handler)
  context.after(() => server.close())
  const parentResponse = await fetch(
    `${server.baseUrl}/_pipeline-research-web/research-token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: RESEARCH_WEB_TOOL_CONTRACT_VERSION,
        context: {
          ...brokerContext(),
          taskId: 'task-1',
          processIdentity: 'process-1',
        },
        activityScopeId: 'lane-1',
        toolCallId: 'parent-call',
        input: {
          action: 'acquire',
          url: RESEARCH_REQUEST_URL,
        },
      }),
    },
  )
  assert.equal(parentResponse.status, 200)
  assert.deepEqual(await parentResponse.json(), {
    version: RESEARCH_WEB_TOOL_CONTRACT_VERSION,
    output: researchOutput,
  })
  const unsafeScopeResponse = await fetch(
    `${server.baseUrl}/_pipeline-research-web/research-token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: RESEARCH_WEB_TOOL_CONTRACT_VERSION,
        context: {
          ...brokerContext(),
          taskId: 'task-1',
          processIdentity: 'process-1',
        },
        activityScopeId: '../outside',
        toolCallId: 'unsafe-scope-call',
        input: { action: 'acquire', url: RESEARCH_REQUEST_URL },
      }),
    },
  )
  assert.equal(unsafeScopeResponse.status, 400)
  assert.equal(rawExecutions, 0)
  assert.equal(routeAuthorityChecks, 1)
  assert.equal(dispatches.length, 2)
  assert.deepEqual(dispatches.map((entry) => entry.authority), [
    { kind: 'mcp-lease', leaseId: 'lease-1' },
    {
      kind: 'parent-capability',
      endpointId: RESEARCH_WEB_CAPABILITY_ID,
      processIdentity: 'process-1',
    },
  ])
  assert.deepEqual(dispatches.map((entry) => entry.source), [
    {
      kind: 'builtin',
      id: RESEARCH_WEB_SERVER_ID,
      version: String(RESEARCH_WEB_TOOL_CONTRACT_VERSION),
    },
    {
      kind: 'builtin',
      id: RESEARCH_WEB_SERVER_ID,
      version: String(RESEARCH_WEB_TOOL_CONTRACT_VERSION),
    },
  ])
  assert.equal(dispatches[1]?.context.activityScopeId, 'lane-1')

  await contribution.agentTool.releaseAssignment?.({
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    activityScopeId: 'lane-1',
  })
  assert.equal(releases.length, 1)
})

test('skill loading preserves its provider result while crossing the dispatcher', async () => {
  let rawExecutions = 0
  const dispatches: SkillLoaderCapabilityDispatchInput[] = []
  const output: LoadSkillOutput = {
    ok: true,
    name: 'evidence-review',
    source: '/repo/agents/analyst/skills/evidence-review/SKILL.md',
    sha256: 'b'.repeat(64),
    content: '# Evidence Review\n',
  }
  const service: SkillLoaderToolModuleService = {
    tool: skillTool(),
    isEnabledForAgent: () => true,
    execute: async () => {
      rawExecutions += 1
      throw new Error('raw skill service execution bypassed dispatch')
    },
  }
  const dispatchInvoker: SkillLoaderCapabilityDispatchInvoker = {
    execute: async (input) => {
      dispatches.push(input)
      return output
    },
  }
  const contribution = skillLoaderToolModule.build({
    moduleOptions: {
      'skill-loader': { toolService: service, dispatchInvoker },
    },
  })
  assert.ok(contribution.agentTool)

  const result = await contribution.agentTool.execute({
    context: brokerContext('agents/analyst'),
    toolCallId: 'skill-call',
    input: { source: output.source, sha256: output.sha256 },
  })

  assert.deepEqual(result, {
    output,
    content: JSON.stringify(output),
    isError: false,
  })
  assert.equal(rawExecutions, 0)
  assert.equal(dispatches.length, 1)
  assert.deepEqual(dispatches[0]?.authority, {
    kind: 'mcp-lease',
    leaseId: 'lease-1',
  })
  assert.deepEqual(dispatches[0]?.source, {
    kind: 'builtin',
    id: 'pipeline-skills',
    version: '1',
  })
  assert.equal(dispatches[0]?.toolCallId, 'skill-call')
  assert.equal(SKILL_LOADER_CAPABILITY_ID, 'skill.load')
})

function researchTool(): McpNamespacedTool {
  return {
    serverId: RESEARCH_WEB_SERVER_ID,
    serverName: 'Research Web Acquisition',
    toolName: 'research_web',
    namespacedName: 'research_web',
    inputSchema: {},
    annotations: { openWorldHint: true, readOnlyHint: true },
    risk: 'read-only',
    effect: serialCapabilityEffect('read-only'),
    requiresApproval: false,
  }
}

function skillTool(): McpNamespacedTool {
  return {
    serverId: 'pipeline-skills',
    serverName: 'Pipeline Skills',
    toolName: 'load_skill',
    namespacedName: 'mcp__pipeline_skills__load_skill',
    inputSchema: {},
    annotations: { readOnlyHint: true },
    risk: 'read-only',
    effect: serialCapabilityEffect('read-only'),
    requiresApproval: false,
  }
}

function brokerContext(
  agentPath = 'agents/researcher',
): McpBrokerRequestContext & { readonly activityScopeId: string } {
  return {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-1',
    leaseId: 'lease-1',
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    agentPath,
    activityScopeId: 'lane-1',
  }
}

async function startRouteServer(
  handler: (input: {
    readonly req: http.IncomingMessage
    readonly res: http.ServerResponse
    readonly url: URL
    readonly services: undefined
  }) => boolean | Promise<boolean>,
): Promise<{ readonly baseUrl: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    void Promise.resolve(handler({ req, res, url, services: undefined }))
      .then((handled) => {
        if (!handled && !res.headersSent) {
          res.statusCode = 404
          res.end()
        }
      })
      .catch((error: unknown) => {
        res.statusCode = 500
        res.end(error instanceof Error ? error.message : 'route failed')
      })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}
