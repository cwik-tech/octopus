import assert from 'node:assert/strict'
import test from 'node:test'

import { BROWSER_TOOL_URL_ENV } from '../../domains/browser/browser-types.js'
import { RESEARCH_WEB_TOOL_URL_ENV } from '../../domains/acquisition/acquisition-types.js'
import { MCP_WORKER_TURN_URL_ENV } from '../../domains/mcp/mcp-worker-turn.js'
import { McpWorkerTurnRunLauncher } from '../../domains/mcp/mcp-worker-turn-launcher.js'
import { YOUTUBE_TOOL_URL_ENV } from '../../domains/youtube/youtube-types.js'
import { GENERATE_WORD_TOOL_URL_ENV } from '../../domains/word-generation/generate-word-types.js'
import { GENERATE_EXCEL_TOOL_URL_ENV } from '../../domains/excel-generation/generate-excel-types.js'
import type { RunLauncher } from '../../domains/run/run-launcher.js'
import type { RunStartRequest } from '../../domains/run/run-store.js'

test('run launcher injects private parent capabilities without replacing caller environment', async () => {
  let received: RunStartRequest | undefined
  const delegate: RunLauncher = {
    async startRun(request) {
      received = request
      return { launched: true, pid: 123, cwd: request.cwd }
    },
  }
  const launcher = new McpWorkerTurnRunLauncher(
    delegate,
    () => 'http://127.0.0.1:3001/_worker-secret',
    () => [
      {
        environmentVariable: BROWSER_TOOL_URL_ENV,
        url: 'http://127.0.0.1:3001/_browser-secret',
      },
      {
        environmentVariable: RESEARCH_WEB_TOOL_URL_ENV,
        url: 'http://127.0.0.1:3001/_research-web-secret',
      },
      {
        environmentVariable: YOUTUBE_TOOL_URL_ENV,
        url: 'http://127.0.0.1:3001/_youtube-secret',
      },
      {
        environmentVariable: GENERATE_WORD_TOOL_URL_ENV,
        url: 'http://127.0.0.1:3001/_generate-word-secret',
      },
      {
        environmentVariable: GENERATE_EXCEL_TOOL_URL_ENV,
        url: 'http://127.0.0.1:3001/_generate-excel-secret',
      },
    ],
  )

  await launcher.startRun({ cwd: '/tmp/assignment', env: { SAFE_INPUT: 'kept' } })

  assert.deepEqual(received, {
    cwd: '/tmp/assignment',
    env: {
      SAFE_INPUT: 'kept',
      [MCP_WORKER_TURN_URL_ENV]: 'http://127.0.0.1:3001/_worker-secret',
      [BROWSER_TOOL_URL_ENV]: 'http://127.0.0.1:3001/_browser-secret',
      [RESEARCH_WEB_TOOL_URL_ENV]: 'http://127.0.0.1:3001/_research-web-secret',
      [YOUTUBE_TOOL_URL_ENV]: 'http://127.0.0.1:3001/_youtube-secret',
      [GENERATE_WORD_TOOL_URL_ENV]: 'http://127.0.0.1:3001/_generate-word-secret',
      [GENERATE_EXCEL_TOOL_URL_ENV]: 'http://127.0.0.1:3001/_generate-excel-secret',
    },
  })
})

test('run launcher injects a newly registered endpoint without launcher changes', async () => {
  let received: RunStartRequest | undefined
  const delegate: RunLauncher = {
    async startRun(request) {
      received = request
      return { launched: true, pid: 123, cwd: request.cwd }
    },
  }
  const launcher = new McpWorkerTurnRunLauncher(
    delegate,
    () => 'http://127.0.0.1:3001/_worker-secret',
    () => [
      {
        environmentVariable: 'PIPELINE_FUTURE_TOOL_URL',
        url: '  http://127.0.0.1:3001/_future-secret  ',
      },
    ],
  )

  await launcher.startRun({ cwd: '/tmp/assignment' })

  assert.equal(
    received?.env?.PIPELINE_FUTURE_TOOL_URL,
    'http://127.0.0.1:3001/_future-secret',
  )
})

test('run launcher still fails closed when the required worker capability is unavailable', async () => {
  const delegate: RunLauncher = {
    async startRun(request) {
      return { launched: true, pid: 123, cwd: request.cwd }
    },
  }
  const launcher = new McpWorkerTurnRunLauncher(
    delegate,
    () => undefined,
    () => [
      {
        environmentVariable: BROWSER_TOOL_URL_ENV,
        url: 'http://127.0.0.1/browser',
      },
    ],
  )
  assert.throws(
    () => launcher.startRun({ cwd: '/tmp/assignment' }),
    /MCP worker bridge is unavailable/,
  )
})
