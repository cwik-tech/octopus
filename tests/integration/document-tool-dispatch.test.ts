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
  GENERATE_EXCEL_SERVER_ID,
  GENERATE_EXCEL_TOOL_CONTRACT_VERSION,
  type GenerateExcelToolOutput,
} from '../../domains/excel-generation/generate-excel-types.js'
import {
  MCP_RUNTIME_CONTRACT_VERSION,
  type McpBrokerRequestContext,
} from '../../domains/mcp/mcp-runtime.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import {
  GENERATE_WORD_SERVER_ID,
  GENERATE_WORD_TOOL_CONTRACT_VERSION,
  type GenerateWordToolOutput,
} from '../../domains/word-generation/generate-word-types.js'
import { GenerateExcelToolService } from '../../services/generate-excel-tool-service.js'
import { GenerateWordToolService } from '../../services/generate-word-tool-service.js'
import { generateExcelToolModule } from '../../server/tools/generate-excel.js'
import { generateWordToolModule } from '../../server/tools/generate-word.js'
import { createCapabilityTestDispatcher } from '../support/capability-dispatcher.js'

const WORD_CAPABILITY_ID = 'word.generate'
const EXCEL_CAPABILITY_ID = 'excel.generate'

test('Generate Word provider and parent-route calls cross the injected dispatcher', async (context) => {
  const fixture = await createFixture(context)
  const output: GenerateWordToolOutput = {
    ok: true,
    action: 'list_profiles',
    profiles: [{
      id: 'governed-word',
      displayName: 'Governed Word',
      description: 'Returned by the shared dispatcher.',
    }],
  }
  const dispatches: CapabilityDispatchRequest[] = []
  const contribution = generateWordToolModule.build({
    capabilityDispatcher: recordingDispatcher(dispatches, output),
    runtimeCapabilityAuthority: allowRuntimeAuthority,
    moduleOptions: {
      'generate-word': {
        toolService: new GenerateWordToolService(fixture),
        endpoint: { token: 'word-dispatch' },
      },
    },
  })

  const providerResult = await contribution.agentTool?.execute({
    context: brokerContext(),
    toolCallId: 'word-provider-call',
    input: { action: 'list_profiles' },
  })
  assert.deepEqual(providerResult?.output, output)

  const routeOutput = await invokeCapabilityRoute({
    route: contribution.routes[0],
    path: '/_pipeline-generate-word/word-dispatch',
    body: toolRequest(
      GENERATE_WORD_TOOL_CONTRACT_VERSION,
      'word-parent-call',
      { action: 'list_profiles' },
    ),
  })
  assert.deepEqual(routeOutput, output)
  assert.equal(dispatches.length, 2)
  assertDispatchIdentity(dispatches[0], {
    capabilityId: WORD_CAPABILITY_ID,
    sourceId: GENERATE_WORD_SERVER_ID,
    sourceVersion: String(GENERATE_WORD_TOOL_CONTRACT_VERSION),
    toolCallId: 'word-provider-call',
    authority: {
      kind: 'mcp-lease',
      leaseId: 'lease-1',
    },
  })
  assertDispatchIdentity(dispatches[1], {
    capabilityId: WORD_CAPABILITY_ID,
    sourceId: GENERATE_WORD_SERVER_ID,
    sourceVersion: String(GENERATE_WORD_TOOL_CONTRACT_VERSION),
    toolCallId: 'word-parent-call',
    authority: {
      kind: 'parent-capability',
      endpointId: WORD_CAPABILITY_ID,
      processIdentity: 'process-1',
    },
  })
})

test('Generate Excel provider and parent-route calls cross the injected dispatcher', async (context) => {
  const fixture = await createFixture(context)
  const output: GenerateExcelToolOutput = {
    ok: true,
    action: 'list_templates',
    templates: [],
    warnings: ['Returned by the shared dispatcher.'],
  }
  const dispatches: CapabilityDispatchRequest[] = []
  const contribution = generateExcelToolModule.build({
    capabilityDispatcher: recordingDispatcher(dispatches, output),
    runtimeCapabilityAuthority: allowRuntimeAuthority,
    moduleOptions: {
      'generate-excel': {
        toolService: new GenerateExcelToolService(fixture),
        endpoint: { token: 'excel-dispatch' },
      },
    },
  })

  const providerResult = await contribution.agentTool?.execute({
    context: brokerContext(),
    toolCallId: 'excel-provider-call',
    input: { action: 'list_templates' },
  })
  assert.deepEqual(providerResult?.output, output)

  const routeOutput = await invokeCapabilityRoute({
    route: contribution.routes[0],
    path: '/_pipeline-generate-excel/excel-dispatch',
    body: toolRequest(
      GENERATE_EXCEL_TOOL_CONTRACT_VERSION,
      'excel-parent-call',
      { action: 'list_templates' },
    ),
  })
  assert.deepEqual(routeOutput, output)
  assert.equal(dispatches.length, 2)
  assertDispatchIdentity(dispatches[0], {
    capabilityId: EXCEL_CAPABILITY_ID,
    sourceId: GENERATE_EXCEL_SERVER_ID,
    sourceVersion: String(GENERATE_EXCEL_TOOL_CONTRACT_VERSION),
    toolCallId: 'excel-provider-call',
    authority: {
      kind: 'mcp-lease',
      leaseId: 'lease-1',
    },
  })
  assertDispatchIdentity(dispatches[1], {
    capabilityId: EXCEL_CAPABILITY_ID,
    sourceId: GENERATE_EXCEL_SERVER_ID,
    sourceVersion: String(GENERATE_EXCEL_TOOL_CONTRACT_VERSION),
    toolCallId: 'excel-parent-call',
    authority: {
      kind: 'parent-capability',
      endpointId: EXCEL_CAPABILITY_ID,
      processIdentity: 'process-1',
    },
  })
})

test('governed document providers preserve artifact output and contained-path validation', async (context) => {
  const fixture = await createFixture(context)
  const identity = {
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
  }
  const location = buildSessionRunAssignmentLocation(
    fixture.workspacePath,
    identity,
  )
  assert.ok(location)
  await fs.mkdir(location.assignmentPath, { recursive: true })
  await fs.writeFile(
    path.join(location.assignmentPath, 'word-source.md'),
    '# Governed report\n\nThe content crosses the shared dispatcher.\n',
  )
  await fs.writeFile(
    path.join(location.assignmentPath, 'excel-source.md'),
    '# Metrics\n\n| Metric | Value |\n| --- | ---: |\n| Leads | 42 |\n',
  )
  const dispatcher = createCapabilityTestDispatcher()
  const word = generateWordToolModule.build({
    capabilityDispatcher: dispatcher,
    moduleOptions: {
      'generate-word': {
        toolService: new GenerateWordToolService(fixture),
      },
    },
  }).agentTool
  const excel = generateExcelToolModule.build({
    capabilityDispatcher: dispatcher,
    moduleOptions: {
      'generate-excel': {
        toolService: new GenerateExcelToolService(fixture),
      },
    },
  }).agentTool
  assert.ok(word)
  assert.ok(excel)

  const wordResult = await word.execute({
    context: brokerContext(),
    toolCallId: 'word-artifact',
    input: {
      action: 'generate',
      inputPath: 'word-source.md',
      outputPath: 'exports/report.docx',
      renderMermaid: false,
    },
  })
  assert.equal(wordResult.isError, false)
  assert.equal(
    (await fs.readFile(path.join(location.assignmentPath, 'exports/report.docx')))
      .subarray(0, 2)
      .toString('ascii'),
    'PK',
  )

  const excelResult = await excel.execute({
    context: brokerContext(),
    toolCallId: 'excel-artifact',
    input: {
      action: 'generate',
      inputPath: 'excel-source.md',
      outputPath: 'exports/metrics.xlsx',
    },
  })
  assert.equal(excelResult.isError, false)
  assert.equal(
    (await fs.readFile(path.join(location.assignmentPath, 'exports/metrics.xlsx')))
      .subarray(0, 2)
      .toString('ascii'),
    'PK',
  )

  const escapedWord = await word.execute({
    context: brokerContext(),
    toolCallId: 'word-escape',
    input: {
      action: 'generate',
      inputPath: 'word-source.md',
      outputPath: '../outside.docx',
    },
  })
  const escapedExcel = await excel.execute({
    context: brokerContext(),
    toolCallId: 'excel-escape',
    input: {
      action: 'generate',
      inputPath: 'excel-source.md',
      outputPath: '../outside.xlsx',
    },
  })
  assert.equal(failureCode(escapedWord.output), 'invalid_request')
  assert.equal(failureCode(escapedExcel.output), 'invalid_request')
  await assert.rejects(fs.access(path.join(location.runPath, 'outside.docx')))
  await assert.rejects(fs.access(path.join(location.runPath, 'outside.xlsx')))
})

function recordingDispatcher(
  calls: CapabilityDispatchRequest[],
  value: GenerateWordToolOutput | GenerateExcelToolOutput,
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
    readonly capabilityId: string
    readonly sourceId: string
    readonly sourceVersion: string
    readonly toolCallId: string
    readonly authority: CapabilityDispatchRequest['context']['authority']
  },
): void {
  assert.ok(request)
  assert.equal(request.invocation.capabilityId, expected.capabilityId)
  assert.deepEqual(request.invocation.source, {
    kind: 'builtin',
    id: expected.sourceId,
    version: expected.sourceVersion,
  })
  assert.equal(request.invocation.toolCallId, expected.toolCallId)
  assert.deepEqual(request.context.authority, expected.authority)
}

async function createFixture(
  context: { after(fn: () => void | Promise<void>): void },
): Promise<{ readonly workspacePath: string; readonly repoRootPath: string }> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'document-dispatch-')),
  )
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspacePath = path.join(root, 'workspace')
  const repoRootPath = path.join(root, 'repo')
  await fs.mkdir(path.join(repoRootPath, 'agents', 'documenter'), {
    recursive: true,
  })
  await fs.writeFile(
    path.join(repoRootPath, 'agents', 'documenter', 'documenter.md'),
    [
      '---',
      'name: documenter',
      'tools: generate_word, generate_excel',
      '---',
      '',
      '# Documenter',
      '',
    ].join('\n'),
  )
  await fs.mkdir(workspacePath, { recursive: true })
  return { workspacePath, repoRootPath }
}

const allowRuntimeAuthority: RuntimeCapabilityAuthorityPort = {
  authorize: async (claims) => ({
    taskId: claims.taskId,
    workflowId: claims.workflowId ?? 'document-dispatch-workflow',
    runPath: '/document-dispatch/run',
    assignmentPath: '/document-dispatch/run/assignments/assignment-1',
  }),
}

function brokerContext(): McpBrokerRequestContext {
  return {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-1',
    leaseId: 'lease-1',
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    agentPath: 'agents/documenter',
  }
}

function toolRequest(
  version: number,
  toolCallId: string,
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    version,
    context: {
      ...brokerContext(),
      taskId: 'task-1',
      processIdentity: 'process-1',
    },
    toolCallId,
    input,
  }
}

async function invokeCapabilityRoute(input: {
  readonly route: ReturnType<typeof generateWordToolModule.build>['routes'][number] | undefined
  readonly path: string
  readonly body: Readonly<Record<string, unknown>>
}): Promise<unknown> {
  assert.ok(input.route)
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    void input.route?.handler({ req, res, url, services: undefined })
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
    const body: unknown = await response.json()
    assert.ok(isRecord(body))
    return body.output
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function failureCode(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.error)) return undefined
  return value.error.code
}
