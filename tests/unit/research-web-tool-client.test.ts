import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import {
  RESEARCH_WEB_TOOL_CONTRACT_VERSION,
  RESEARCH_WEB_TOOL_URL_ENV,
} from '../../domains/acquisition/acquisition-types.js'
import {
  callParentResearchWebTool,
  ResearchWebToolClientError,
} from '../../domains/acquisition/research-web-tool-client.js'
import {
  MCP_WORKER_ACTIVITY_SCOPE_ID_ENV,
  MCP_WORKER_AGENT_DISPLAY_NAME_ENV,
} from '../../domains/mcp/mcp-worker-turn.js'
import {
  RUNTIME_ASSIGNMENT_ID_ENV,
  RUNTIME_RUN_ID_ENV,
  RUNTIME_SESSION_ID_ENV,
} from '../../domains/runtime/runtime-paths.js'
import {
  RUNTIME_PROCESS_IDENTITY_ENV,
  RUNTIME_TASK_ID_ENV,
} from '../../contracts/runtime-capability-authority.js'

test('research web client preserves the Deep Research activity scope', async () => {
  let captured: Record<string, unknown> | undefined
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    captured = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
      string,
      unknown
    >
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      version: RESEARCH_WEB_TOOL_CONTRACT_VERSION,
      output: {
        ok: true,
        action: 'search',
        results: [],
      },
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    const result = await callParentResearchWebTool({
      agentPath: 'agents/web-researcher',
      toolCallId: 'call-search',
      input: { action: 'search', query: 'primary evidence' },
      environment: {
        [RESEARCH_WEB_TOOL_URL_ENV]:
          `http://127.0.0.1:${address.port}/private-capability`,
        [RUNTIME_SESSION_ID_ENV]: 'session-client',
        [RUNTIME_RUN_ID_ENV]: 'run-client',
        [RUNTIME_ASSIGNMENT_ID_ENV]: 'assignment-client',
        [RUNTIME_TASK_ID_ENV]: 'task-client',
        [RUNTIME_PROCESS_IDENTITY_ENV]: 'process-client',
        [MCP_WORKER_ACTIVITY_SCOPE_ID_ENV]: 'lane-client',
        [MCP_WORKER_AGENT_DISPLAY_NAME_ENV]: 'Client Evidence Analyst',
      },
    })
    assert.equal(result.output.ok, true)
    assert.equal(captured?.activityScopeId, 'lane-client')
    assert.equal(
      (captured?.context as Record<string, unknown>)?.assignmentId,
      'assignment-client',
    )
    assert.equal(
      (captured?.context as Record<string, unknown>)?.agentId,
      'lane-client',
    )
    assert.equal(
      (captured?.context as Record<string, unknown>)?.agentDisplayName,
      'Client Evidence Analyst',
    )
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()))
  }
})

test('research web client rejects an unsafe activity scope before transport', async () => {
  await assert.rejects(
    callParentResearchWebTool({
      agentPath: 'agents/web-researcher',
      toolCallId: 'call-search',
      input: { action: 'search', query: 'primary evidence' },
      environment: {
        [RESEARCH_WEB_TOOL_URL_ENV]:
          'http://127.0.0.1:9/private-capability',
        [RUNTIME_SESSION_ID_ENV]: 'session-client',
        [RUNTIME_RUN_ID_ENV]: 'run-client',
        [RUNTIME_ASSIGNMENT_ID_ENV]: 'assignment-client',
        [RUNTIME_TASK_ID_ENV]: 'task-client',
        [RUNTIME_PROCESS_IDENTITY_ENV]: 'process-client',
        [MCP_WORKER_ACTIVITY_SCOPE_ID_ENV]: '../other-lane',
      },
    }),
    (error: unknown) =>
      error instanceof ResearchWebToolClientError &&
      /activity scope/iu.test(error.message),
  )
})
