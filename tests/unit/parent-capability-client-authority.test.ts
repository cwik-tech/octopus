import assert from 'node:assert/strict'
import * as http from 'node:http'
import test from 'node:test'

import { callParentResearchWebTool } from '../../domains/acquisition/research-web-tool-client.js'
import { RESEARCH_WEB_TOOL_URL_ENV } from '../../domains/acquisition/acquisition-types.js'
import { callParentBrowserTool } from '../../domains/browser/browser-tool-client.js'
import { BROWSER_TOOL_URL_ENV } from '../../domains/browser/browser-types.js'
import { callParentGenerateExcelTool } from '../../domains/excel-generation/generate-excel-tool-client.js'
import { GENERATE_EXCEL_TOOL_URL_ENV } from '../../domains/excel-generation/generate-excel-types.js'
import { callParentGenerateWordTool } from '../../domains/word-generation/generate-word-tool-client.js'
import { GENERATE_WORD_TOOL_URL_ENV } from '../../domains/word-generation/generate-word-types.js'
import { callParentYoutubeTool } from '../../domains/youtube/youtube-tool-client.js'
import { YOUTUBE_TOOL_URL_ENV } from '../../domains/youtube/youtube-types.js'
import {
  RUNTIME_ASSIGNMENT_ID_ENV,
  RUNTIME_RUN_ID_ENV,
  RUNTIME_SESSION_ID_ENV,
} from '../../domains/runtime/runtime-paths.js'

test('all parent capability clients transmit task and process authority', async (context) => {
  const received = new Map<string, Record<string, unknown>>()
  const server = await startServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
        string,
        unknown
      >
      received.set(request.url ?? '', body)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        version: body.version,
        output: { ok: true, action: 'list_profiles' },
      }))
    })
  })
  context.after(() => server.close())
  const environment = {
    [RUNTIME_SESSION_ID_ENV]: 'session-client',
    [RUNTIME_RUN_ID_ENV]: 'run-client',
    [RUNTIME_ASSIGNMENT_ID_ENV]: 'assignment-client',
    TEAM_RUNTIME_TASK_ID: 'task-client',
    TEAM_RUNTIME_PROCESS_IDENTITY: 'process-client',
    [BROWSER_TOOL_URL_ENV]: `${server.url}/browser`,
    [RESEARCH_WEB_TOOL_URL_ENV]: `${server.url}/research`,
    [YOUTUBE_TOOL_URL_ENV]: `${server.url}/youtube`,
    [GENERATE_WORD_TOOL_URL_ENV]: `${server.url}/word`,
    [GENERATE_EXCEL_TOOL_URL_ENV]: `${server.url}/excel`,
  }

  await callParentBrowserTool({
    agentPath: 'agents/researcher',
    toolCallId: 'browser-call',
    input: { action: 'observe' },
    environment,
  })
  await callParentResearchWebTool({
    agentPath: 'agents/web-researcher',
    toolCallId: 'research-call',
    input: { action: 'search', query: 'primary evidence' },
    environment,
  })
  await callParentYoutubeTool({
    agentPath: 'agents/youtube-extractor',
    toolCallId: 'youtube-call',
    input: { action: 'inspect', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    environment,
  })
  await callParentGenerateWordTool({
    agentPath: 'agents/documenter',
    toolCallId: 'word-call',
    input: { action: 'list_profiles' },
    environment,
  })
  await callParentGenerateExcelTool({
    agentPath: 'agents/documenter',
    toolCallId: 'excel-call',
    input: { action: 'list_profiles' },
    environment,
  })

  assert.deepEqual([...received.keys()].sort(), [
    '/browser',
    '/excel',
    '/research',
    '/word',
    '/youtube',
  ])
  for (const body of received.values()) {
    const requestContext = body.context as Record<string, unknown>
    assert.equal(requestContext.taskId, 'task-client')
    assert.equal(requestContext.processIdentity, 'process-client')
  }
})

test('parent capability clients advance their wire version when runtime authority becomes mandatory', async (context) => {
  const receivedVersions = new Map<string, unknown>()
  const server = await startServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      assert.ok(body !== null && typeof body === 'object' && 'version' in body)
      receivedVersions.set(request.url ?? '', body.version)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        version: body.version,
        output: { ok: true, action: 'list_profiles' },
      }))
    })
  })
  context.after(() => server.close())
  const environment = {
    [RUNTIME_SESSION_ID_ENV]: 'session-version',
    [RUNTIME_RUN_ID_ENV]: 'run-version',
    [RUNTIME_ASSIGNMENT_ID_ENV]: 'assignment-version',
    TEAM_RUNTIME_TASK_ID: 'task-version',
    TEAM_RUNTIME_PROCESS_IDENTITY: 'process-version',
    [BROWSER_TOOL_URL_ENV]: `${server.url}/browser`,
    [RESEARCH_WEB_TOOL_URL_ENV]: `${server.url}/research`,
    [YOUTUBE_TOOL_URL_ENV]: `${server.url}/youtube`,
    [GENERATE_WORD_TOOL_URL_ENV]: `${server.url}/word`,
    [GENERATE_EXCEL_TOOL_URL_ENV]: `${server.url}/excel`,
  }

  await callParentBrowserTool({
    agentPath: 'agents/researcher',
    toolCallId: 'browser-version-call',
    input: { action: 'observe' },
    environment,
  })
  await callParentResearchWebTool({
    agentPath: 'agents/web-researcher',
    toolCallId: 'research-version-call',
    input: { action: 'search', query: 'primary evidence' },
    environment,
  })
  await callParentYoutubeTool({
    agentPath: 'agents/youtube-extractor',
    toolCallId: 'youtube-version-call',
    input: {
      action: 'inspect',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    },
    environment,
  })
  await callParentGenerateWordTool({
    agentPath: 'agents/documenter',
    toolCallId: 'word-version-call',
    input: { action: 'list_profiles' },
    environment,
  })
  await callParentGenerateExcelTool({
    agentPath: 'agents/documenter',
    toolCallId: 'excel-version-call',
    input: { action: 'list_profiles' },
    environment,
  })

  assert.deepEqual(Object.fromEntries(receivedVersions), {
    '/browser': 3,
    '/research': 3,
    '/youtube': 4,
    '/word': 3,
    '/excel': 2,
  })
})

async function startServer(
  handler: http.RequestListener,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}
