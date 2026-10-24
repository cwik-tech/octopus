import assert from 'node:assert/strict'
import test from 'node:test'

import { MCP_WORKER_TURN_URL_ENV } from '../../domains/mcp/mcp-worker-turn.js'
import { BROWSER_TOOL_URL_ENV } from '../../domains/browser/browser-types.js'
import { YOUTUBE_TOOL_URL_ENV } from '../../domains/youtube/youtube-types.js'
import {
  PI_CLI_PATH_ENV,
  PI_NODE_PATH_ENV,
  RUNTIME_EXTENSION_ENTRY_ENV,
} from '../../core/pi-runtime.js'
import {
  CONFIGURED_PROVIDER_BROKER_URL_ENV,
  CONFIGURED_PROVIDERS_ENV,
} from '../../domains/provider/provider-settings.js'
import { buildProviderSubprocessEnvironment } from '../../domains/provider/provider-subprocess-environment.js'
import {
  AGENT_TEXT_STREAM_CHANNEL_ENV,
  AGENT_TEXT_STREAM_TOKEN_ENV,
  AGENT_TEXT_STREAM_URL_ENV,
} from '../../domains/runtime/agent-text-delta-tokens.js'

test('provider subprocess environment strips worker capability, runtime identity, and other providers’ credentials', () => {
  const environment = buildProviderSubprocessEnvironment({
    [MCP_WORKER_TURN_URL_ENV]: 'http://127.0.0.1:3001/private-secret',
    [BROWSER_TOOL_URL_ENV]: 'http://127.0.0.1:3001/private-browser-secret',
    [YOUTUBE_TOOL_URL_ENV]: 'http://127.0.0.1:3001/private-youtube-secret',
    TEAM_RUNTIME_PROCESS_IDENTITY: 'process-secret',
    TEAM_RUNTIME_TASK_ID: 'task-id',
    TEAM_RUNTIME_SESSION_ID: 'session-id',
    TEAM_RUNTIME_RUN_ID: 'run-id',
    TEAM_RUNTIME_ASSIGNMENT_ID: 'assignment-id',
    TEAM_RUNTIME_ASSIGNMENT_PATH: '/private/assignment',
    TEAM_RUNTIME_RUN_PATH: '/private/run',
    TEAM_RUNTIME_WORKFLOW_ID: 'workflow-id',
    TEAM_RUNTIME_WORKFLOW_STEP_ID: 'step-id',
    [RUNTIME_EXTENSION_ENTRY_ENV]: '/private/runtime-extension.js',
    [PI_CLI_PATH_ENV]: '/safe/pi-cli.js',
    [PI_NODE_PATH_ENV]: '/safe/node',
    OPENAI_API_KEY: 'other-provider-credential',
    ANTHROPIC_API_KEY: 'other-provider-credential',
    WEBSHARE_API_KEY: 'webshare-api-secret',
    WEBSHARE_USERNAME: 'webshare-user',
    WEBSHARE_PASSWORD: 'webshare-password',
    WEBSHARE_PROXY_HOST: 'p.webshare.io',
    WEBSHARE_PROXY_PORT: '80',
    WEBSHARE_PROXY_COUNTRIES: 'us,gb',
    BROWSER_USE_API_KEY: 'bu_cloud_browser_secret',
    PATH: '/usr/bin',
    HOME: '/home/test',
    HTTPS_PROXY: 'http://proxy:8080',
    LC_ALL: 'en_US.UTF-8',
    [CONFIGURED_PROVIDER_BROKER_URL_ENV]: 'http://127.0.0.1:3001/_pipeline/broker-scoped/settings/provider-execute',
    [CONFIGURED_PROVIDERS_ENV]: 'base64-connections',
  })

  for (const key of [
    MCP_WORKER_TURN_URL_ENV,
    BROWSER_TOOL_URL_ENV,
    YOUTUBE_TOOL_URL_ENV,
    'TEAM_RUNTIME_PROCESS_IDENTITY',
    'TEAM_RUNTIME_TASK_ID',
    'TEAM_RUNTIME_SESSION_ID',
    'TEAM_RUNTIME_RUN_ID',
    'TEAM_RUNTIME_ASSIGNMENT_ID',
    'TEAM_RUNTIME_ASSIGNMENT_PATH',
    'TEAM_RUNTIME_RUN_PATH',
    'TEAM_RUNTIME_WORKFLOW_ID',
    'TEAM_RUNTIME_WORKFLOW_STEP_ID',
    RUNTIME_EXTENSION_ENTRY_ENV,
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'WEBSHARE_API_KEY',
    'WEBSHARE_USERNAME',
    'WEBSHARE_PASSWORD',
    'WEBSHARE_PROXY_HOST',
    'WEBSHARE_PROXY_PORT',
    'WEBSHARE_PROXY_COUNTRIES',
    'BROWSER_USE_API_KEY',
  ]) {
    assert.equal(environment[key], undefined, key)
  }
  assert.equal(environment[PI_CLI_PATH_ENV], '/safe/pi-cli.js')
  assert.equal(environment[PI_NODE_PATH_ENV], '/safe/node')
  assert.equal(environment.PATH, '/usr/bin')
  assert.equal(environment.HOME, '/home/test')
  assert.equal(environment.HTTPS_PROXY, 'http://proxy:8080')
  assert.equal(environment.LC_ALL, 'en_US.UTF-8')
  assert.equal(
    environment[CONFIGURED_PROVIDER_BROKER_URL_ENV],
    'http://127.0.0.1:3001/_pipeline/broker-scoped/settings/provider-execute',
  )
  assert.equal(environment[CONFIGURED_PROVIDERS_ENV], 'base64-connections')
})

test('provider subprocess environment honors explicit pass-through keys', () => {
  const environment = buildProviderSubprocessEnvironment(
    {
      CODEX_HOME: '/isolated/codex-home',
      MCP_BRIDGE_TOKEN: 'bridge-token',
      OPENAI_API_KEY: 'other-provider-credential',
    },
    ['CODEX_HOME', 'MCP_BRIDGE_TOKEN'],
  )

  assert.equal(environment.CODEX_HOME, '/isolated/codex-home')
  assert.equal(environment.MCP_BRIDGE_TOKEN, 'bridge-token')
  assert.equal(environment.OPENAI_API_KEY, undefined)
})

test('the display-stream variables never reach a provider CLI', () => {
  // The sender lives in the run child, which is the same process as the
  // provider adapter. The provider CLI it spawns is an untrusted grandchild,
  // and handing it a posting credential would give it a way into a channel it
  // has no part in. Asserted here because the allowlist is the only thing
  // standing between the two.
  const environment = buildProviderSubprocessEnvironment({
    PATH: '/usr/bin',
    [AGENT_TEXT_STREAM_URL_ENV]: 'http://127.0.0.1:1234/internal/agent-text-stream',
    [AGENT_TEXT_STREAM_CHANNEL_ENV]: '5f3a1f1e-0000-4000-8000-000000000000',
    [AGENT_TEXT_STREAM_TOKEN_ENV]: 'a-working-credential',
  })

  assert.equal(AGENT_TEXT_STREAM_URL_ENV in environment, false)
  assert.equal(AGENT_TEXT_STREAM_CHANNEL_ENV in environment, false)
  assert.equal(AGENT_TEXT_STREAM_TOKEN_ENV in environment, false)
  assert.equal(
    JSON.stringify(environment).includes('a-working-credential'),
    false,
  )
})

test('no caller can pass the cloud browser credential through to a provider CLI', () => {
  // The key buys billable browser sessions. A provider CLI is an untrusted
  // grandchild with no part in that, and a rule a future caller can opt out of
  // is not a boundary — so this is asserted with the strongest possible
  // request: naming it explicitly in the escape hatch.
  const environment = buildProviderSubprocessEnvironment(
    { PATH: '/usr/bin', BROWSER_USE_API_KEY: 'bu_cloud_browser_secret' },
    ['BROWSER_USE_API_KEY'],
  )

  assert.equal('BROWSER_USE_API_KEY' in environment, false)
  assert.equal(environment.PATH, '/usr/bin')
})

test('no caller can pass the display-stream variables through to a provider CLI', () => {
  // The allowlist has an escape hatch for callers that need one more variable.
  // These three are never that variable, and a rule that a future caller can
  // opt out of is not a boundary. Asserted with the strongest possible
  // request: naming all three explicitly.
  const environment = buildProviderSubprocessEnvironment(
    {
      PATH: '/usr/bin',
      [AGENT_TEXT_STREAM_URL_ENV]: 'http://127.0.0.1:1234/internal/agent-text-stream',
      [AGENT_TEXT_STREAM_CHANNEL_ENV]: '5f3a1f1e-0000-4000-8000-000000000000',
      [AGENT_TEXT_STREAM_TOKEN_ENV]: 'a-working-credential',
    },
    [
      AGENT_TEXT_STREAM_URL_ENV,
      AGENT_TEXT_STREAM_CHANNEL_ENV,
      AGENT_TEXT_STREAM_TOKEN_ENV,
    ],
  )

  assert.equal(AGENT_TEXT_STREAM_URL_ENV in environment, false)
  assert.equal(AGENT_TEXT_STREAM_CHANNEL_ENV in environment, false)
  assert.equal(AGENT_TEXT_STREAM_TOKEN_ENV in environment, false)
  // The escape hatch still works for everything else.
  assert.equal(environment.PATH, '/usr/bin')
})
