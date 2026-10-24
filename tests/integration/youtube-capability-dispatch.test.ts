import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import type {
  CapabilityDispatchRequest,
  CapabilityDispatchResult,
} from '../../contracts/capability-dispatch.js'
import type { RuntimeCapabilityAuthorityPort } from '../../contracts/runtime-capability-authority.js'
import {
  MCP_RUNTIME_CONTRACT_VERSION,
  type McpBrokerRequestContext,
} from '../../domains/mcp/mcp-runtime.js'
import {
  YOUTUBE_SERVER_ID,
  YOUTUBE_TOOL_CONTRACT_VERSION,
  type YoutubeToolOutput,
} from '../../domains/youtube/youtube-types.js'
import { YoutubeSettingsService } from '../../services/youtube-settings-service.js'
import { YoutubeToolService } from '../../services/youtube-tool-service.js'
import { youtubeToolModule } from '../../server/tools/youtube.js'

const YOUTUBE_CAPABILITY_ID = 'youtube.extract'

test('YouTube provider and parent-route calls cross the injected dispatcher', async (context) => {
  const workspacePath = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-dispatch-cutover-')),
  )
  context.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const assignmentPath = path.join(
    workspacePath,
    'sessions',
    'session-1',
    'runs',
    'run-1',
    'assignments',
    'assignment-1',
  )
  await fs.mkdir(assignmentPath, { recursive: true })
  const output: YoutubeToolOutput = {
    ok: true,
    action: 'write_methodology',
    artifactPath: 'output/methods/dispatcher-result.md',
  }
  const dispatches: CapabilityDispatchRequest[] = []
  const contribution = youtubeToolModule.build({
    capabilityDispatcher: recordingDispatcher(dispatches, output),
    runtimeCapabilityAuthority: allowRuntimeAuthority(assignmentPath),
    moduleOptions: {
      youtube: {
        settingsService: new YoutubeSettingsService({ environment: {} }),
        toolService: new YoutubeToolService({
          workspacePath,
          settings: new YoutubeSettingsService({ environment: {} }),
        }),
        endpoint: { token: 'youtube-dispatch' },
      },
    },
  })

  const providerResult = await contribution.agentTool?.execute({
    context: brokerContext(),
    toolCallId: 'youtube-provider-call',
    input: {
      action: 'write_methodology',
      videoId: 'dQw4w9WgXcQ',
      content: '# Raw service must not run',
    },
  })
  assert.deepEqual(providerResult?.output, output)

  const route = contribution.routes.find(
    (candidate) => candidate.id === 'youtube-tool-capability',
  )
  assert.ok(route)
  const routeOutput = await invokeCapabilityRoute({
    route,
    path: '/_pipeline-youtube/youtube-dispatch',
    body: {
      version: YOUTUBE_TOOL_CONTRACT_VERSION,
      context: {
        ...brokerContext(),
        taskId: 'task-1',
        processIdentity: 'process-1',
      },
      toolCallId: 'youtube-parent-call',
      input: {
        action: 'write_methodology',
        videoId: 'dQw4w9WgXcQ',
        content: '# Parent route must dispatch',
      },
    },
  })
  assert.deepEqual(routeOutput, output)
  assert.equal(dispatches.length, 2)
  assertDispatchIdentity(dispatches[0], {
    toolCallId: 'youtube-provider-call',
    authority: { kind: 'mcp-lease', leaseId: 'lease-1' },
  })
  assertDispatchIdentity(dispatches[1], {
    toolCallId: 'youtube-parent-call',
    authority: {
      kind: 'parent-capability',
      endpointId: YOUTUBE_CAPABILITY_ID,
      processIdentity: 'process-1',
    },
  })
})

function recordingDispatcher(
  calls: CapabilityDispatchRequest[],
  value: YoutubeToolOutput,
): { dispatch(request: CapabilityDispatchRequest): Promise<CapabilityDispatchResult> } {
  return {
    dispatch: async (request) => {
      calls.push(request)
      return {
        status: 'completed',
        dispatchId: `dispatch-${request.invocation.toolCallId}`,
        value,
        costTracked: false,
        budgetOverrun: false,
      }
    },
  }
}

function assertDispatchIdentity(
  request: CapabilityDispatchRequest | undefined,
  expected: {
    readonly toolCallId: string
    readonly authority: CapabilityDispatchRequest['context']['authority']
  },
): void {
  assert.ok(request)
  assert.equal(request.invocation.capabilityId, YOUTUBE_CAPABILITY_ID)
  assert.deepEqual(request.invocation.source, {
    kind: 'builtin',
    id: YOUTUBE_SERVER_ID,
    version: String(YOUTUBE_TOOL_CONTRACT_VERSION),
  })
  assert.equal(request.invocation.toolCallId, expected.toolCallId)
  assert.deepEqual(request.context.authority, expected.authority)
}

function allowRuntimeAuthority(
  assignmentPath: string,
): RuntimeCapabilityAuthorityPort {
  return {
    authorize: async (claims) => ({
      taskId: claims.taskId,
      workflowId: claims.workflowId ?? 'youtube-dispatch-workflow',
      runPath: path.dirname(path.dirname(assignmentPath)),
      assignmentPath,
    }),
  }
}

function brokerContext(): McpBrokerRequestContext {
  return {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-1',
    leaseId: 'lease-1',
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    agentPath: 'agents/youtube-extractor',
  }
}

async function invokeCapabilityRoute(input: {
  readonly route: NonNullable<ReturnType<typeof youtubeToolModule.build>['routes'][number]>
  readonly path: string
  readonly body: Readonly<Record<string, unknown>>
}): Promise<unknown> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    void input.route.handler({ req, res, url, services: undefined })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const response = await fetch(`http://127.0.0.1:${address.port}${input.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input.body),
    })
    assert.equal(response.status, 200)
    const payload: unknown = await response.json()
    assert.ok(isRecord(payload))
    return payload.output
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
