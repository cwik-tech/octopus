import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { handleBrowserToolRoute } from '../../server/routes/browser-tool.js'
import { handleGenerateExcelToolRoute } from '../../server/routes/generate-excel-tool.js'
import { handleGenerateWordToolRoute } from '../../server/routes/generate-word-tool.js'
import { BROWSER_TOOL_CONTRACT_VERSION } from '../../domains/browser/browser-types.js'
import { GENERATE_EXCEL_TOOL_CONTRACT_VERSION } from '../../domains/excel-generation/generate-excel-types.js'
import { MCP_RUNTIME_CONTRACT_VERSION } from '../../domains/mcp/mcp-runtime.js'
import type {
  BrowserCapabilityDispatchInput,
  BrowserCapabilityDispatchInvoker,
} from '../../services/browser-capability-adapter.js'
import { GenerateExcelToolService } from '../../services/generate-excel-tool-service.js'
import { GenerateWordToolService } from '../../services/generate-word-tool-service.js'
import { GenerateExcelCapabilityDispatchGateway } from '../../services/generate-excel-capability-adapter.js'
import { GenerateWordCapabilityDispatchGateway } from '../../services/generate-word-capability-adapter.js'
import { GENERATE_WORD_TOOL_CONTRACT_VERSION } from '../../domains/word-generation/generate-word-types.js'
import type { RuntimeCapabilityAuthorityPort } from '../../contracts/runtime-capability-authority.js'
import { createCapabilityTestDispatcher } from '../support/capability-dispatcher.js'

const allowRuntimeAuthority: RuntimeCapabilityAuthorityPort = {
  authorize: async (claims) => ({
    taskId: claims.taskId,
    workflowId: claims.workflowId ?? 'characterization-workflow',
    runPath: '/characterization/run',
    assignmentPath: '/characterization/run/assignments/assignment-1',
  }),
}

test('browser tool route preserves strict input parsing and permissive envelope parsing', async (context) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'browser-tool-route-')),
  )
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const dispatches: BrowserCapabilityDispatchInput[] = []
  let authorityChecks = 0
  const authority: RuntimeCapabilityAuthorityPort = {
    authorize: async (claims) => {
      authorityChecks += 1
      return allowRuntimeAuthority.authorize(claims)
    },
  }
  const invoker: BrowserCapabilityDispatchInvoker = {
    execute: async (input) => {
      dispatches.push(input)
      return {
        ok: false,
        action: 'observe',
        error: {
          code: 'domain_denied',
          message: 'This agent is not allowed to use the browser.',
          retryable: false,
        },
      }
    },
    releaseAssignment: async () => undefined,
  }
  const server = await startServer((req, res) =>
    handleBrowserToolRoute({
      req,
      res,
      invoker,
      authority,
    }))
  context.after(() => server.close())

  const request = toolRequest(
    BROWSER_TOOL_CONTRACT_VERSION,
    'agents/no-browser-permission',
    { action: 'observe', waitMs: 100 },
  )
  const accepted = await postJson(server.url, {
    ...request,
    ignoredEnvelopeField: true,
    context: { ...request.context, ignoredContextField: true },
  })
  assert.equal(accepted.status, 200)
  assert.equal(accepted.headers.get('cache-control'), 'no-store')
  assert.equal(dispatches.length, 1)
  assert.deepEqual(dispatches[0]?.authority, {
    kind: 'parent-capability',
    endpointId: 'browser.interact',
    processIdentity: request.context.processIdentity,
  })
  assert.equal(authorityChecks, 1)

  for (const input of [
    { action: 'observe', pageId: null },
    { action: 'observe', waitMs: '100' },
    { action: 'observe', unsupported: true },
  ]) {
    const response = await postJson(server.url, { ...request, input })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: 'Browser tool request is invalid',
    })
  }
  assert.equal(authorityChecks, 1)

  const unsupportedMediaType = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify(request),
  })
  assert.equal(unsupportedMediaType.status, 415)
  assert.deepEqual(await unsupportedMediaType.json(), {
    error: 'Browser tool request is invalid',
  })

  const wrongMethod = await fetch(server.url)
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.get('allow'), 'POST')
  assert.deepEqual(await wrongMethod.json(), { error: 'Method not allowed' })
})

test('document tool routes preserve absent, null, unknown-field, and no-coercion behavior', async (context) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'document-tool-routes-')),
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

  const wordService = new GenerateWordToolService({
    workspacePath,
    repoRootPath,
  })
  const excelService = new GenerateExcelToolService({
    workspacePath,
    repoRootPath,
  })
  const dispatcher = createCapabilityTestDispatcher()
  const wordServer = await startServer((req, res) =>
    handleGenerateWordToolRoute({
      req,
      res,
      invoker: new GenerateWordCapabilityDispatchGateway({
        dispatcher,
        service: wordService,
      }),
      authority: allowRuntimeAuthority,
    }))
  const excelServer = await startServer((req, res) =>
    handleGenerateExcelToolRoute({
      req,
      res,
      invoker: new GenerateExcelCapabilityDispatchGateway({
        dispatcher,
        service: excelService,
      }),
      authority: allowRuntimeAuthority,
    }))
  context.after(() => Promise.all([wordServer.close(), excelServer.close()]))

  const wordRequest = toolRequest(
    GENERATE_WORD_TOOL_CONTRACT_VERSION,
    'agents/documenter',
    { action: 'list_profiles' },
  )
  const wordAccepted = await postJson(wordServer.url, {
    ...wordRequest,
    ignoredEnvelopeField: true,
    context: { ...wordRequest.context, ignoredContextField: true },
  })
  assert.equal(wordAccepted.status, 200)
  assert.equal(
    (await wordAccepted.json() as { output: { profiles: unknown[] } })
      .output.profiles.length,
    5,
  )
  for (const input of [
    { action: 'generate', inputPath: 'missing.md', outputPath: 'report.docx', profile: null },
    { action: 'generate', inputPath: 'missing.md', outputPath: 'report.docx', tableOfContents: 'false' },
    { action: 'list_profiles', unsupported: true },
  ]) {
    const response = await postJson(wordServer.url, {
      ...wordRequest,
      input,
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: 'Generate Word tool request is invalid',
    })
  }

  const excelRequest = toolRequest(
    GENERATE_EXCEL_TOOL_CONTRACT_VERSION,
    'agents/documenter',
    { action: 'list_profiles' },
  )
  const excelAccepted = await postJson(excelServer.url, {
    ...excelRequest,
    ignoredEnvelopeField: true,
    context: { ...excelRequest.context, ignoredContextField: true },
  })
  assert.equal(excelAccepted.status, 200)
  assert.equal(
    (await excelAccepted.json() as { output: { profiles: unknown[] } })
      .output.profiles.length,
    3,
  )
  for (const input of [
    { action: 'generate', inputPath: 'missing.md', outputPath: 'report.xlsx', profile: null },
    { action: 'generate', inputPath: 'missing.md', outputPath: 'report.xlsx', profile: 7 },
    { action: 'list_profiles', unsupported: true },
  ]) {
    const response = await postJson(excelServer.url, {
      ...excelRequest,
      input,
    })
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: 'Generate Excel tool request is invalid',
    })
  }

  for (const [url, error] of [
    [wordServer.url, 'Method not allowed'],
    [excelServer.url, 'Method not allowed'],
  ] as const) {
    const response = await fetch(url)
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'POST')
    assert.deepEqual(await response.json(), { error })
  }
})

function toolRequest(
  version: number,
  agentPath: string,
  input: Record<string, unknown>,
): {
  readonly version: number
  readonly context: Record<string, unknown>
  readonly toolCallId: string
  readonly input: Record<string, unknown>
} {
  return {
    version,
    context: {
      contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
      requestId: 'request-1',
      leaseId: 'lease-1',
      sessionId: 'session-1',
      runId: 'run-1',
      assignmentId: 'assignment-1',
      taskId: 'task-1',
      processIdentity: 'process-1',
      agentPath,
    },
    toolCallId: 'call-1',
    input,
  }
}

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function startServer(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<void>,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    void handler(req, res).catch((error) => {
      res.statusCode = 500
      res.end(error instanceof Error ? error.message : String(error))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}/private-tool`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}
