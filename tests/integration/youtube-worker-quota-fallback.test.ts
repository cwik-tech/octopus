import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { z } from 'zod/v4'
import { McpAgentToolService } from '../../services/mcp-agent-tool-service.js'
import { McpParentBroker } from '../../domains/mcp/mcp-parent-broker.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE } from '../../services/capability-dispatch-lifecycle.js'
import type { BuiltinAgentToolAdapter } from '../../domains/mcp/builtin-agent-tool-adapter.js'

const requestSchema = z.object({ model: z.string(), messages: z.array(z.object({ role: z.string(), tool_calls: z.array(z.object({ extra_content: z.unknown().optional() })).optional() })) })

// Both paid, nondeterministic model endpoints are replaced at the HTTP boundary.
// The tool loop, grants, leases and filesystem effect remain real.
async function harness(options: { afterTool?: boolean; missingKey?: boolean; fallbackFails?: boolean; requireSignature?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-quota-fallback-'))
  const effectPath = path.join(root, 'manual.md')
  const requests: string[] = []
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    requests.push(body.model)
    response.setHeader('content-type', 'application/json')
    const hasResult = body.messages.some((message) => message.role === 'tool')
    if (options.requireSignature && hasResult && body.model === 'gemini-fixture') {
      const signature = body.messages.find((message) => message.role === 'assistant')?.tool_calls?.[0]?.extra_content
      if (JSON.stringify(signature) !== JSON.stringify({ google: { thought_signature: 'fixture-signature' } })) { response.writeHead(400); response.end(JSON.stringify({ error: { message: 'Missing thought signature' } })); return }
    }
    if ((body.model === 'primary' && (!options.afterTool || hasResult)) || options.fallbackFails) {
      response.writeHead(402)
      response.end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'No credits.' } }))
    } else {
      response.end(JSON.stringify({ id: 'answer', model: body.model, choices: [{ finish_reason: hasResult ? 'stop' : 'tool_calls', message: hasResult ? { role: 'assistant', content: 'Manual published.' } : { role: 'assistant', content: null, tool_calls: [{ id: 'write-manual', type: 'function', function: { name: 'write_manual', arguments: '{}' }, ...(options.requireSignature ? { extra_content: { google: { thought_signature: 'fixture-signature' } } } : {}) }] } }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const apiUrl = `http://127.0.0.1:${address.port}/v1/chat/completions`
  const settings = new McpSettingsService({ storagePath: path.join(root, 'mcp.json') })
  const leases = new McpRunLeaseStore()
  const tool: BuiltinAgentToolAdapter = {
    name: 'write_manual', isEnabledForAgent: () => true,
    tool: { serverId: 'manual', serverName: 'Manual', toolName: 'write_manual', namespacedName: 'write_manual', inputSchema: { type: 'object', properties: {} }, annotations: {}, risk: 'mutating', effect: { kind: 'mutating', concurrency: 'serial' }, requiresApproval: false },
    execute: async () => {
      await fs.appendFile(effectPath, 'manual\n')
      return { output: { ok: true }, content: 'Manual saved.', isError: false }
    },
  }
  const service = new McpAgentToolService({
    broker: new McpParentBroker({ lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE, settingsService: settings, clientManager: settings.getBrokerClientManager(), grantResolver: () => true, leaseResolver: (context) => leases.resolve(context) }),
    leaseStore: leases,
    providerSettingsService: new ProviderSettingsService({ storagePath: path.join(root, 'providers.json') }),
    providerSupportResolver: ({ provider }) => ({ provider, state: 'supported', mode: 'native-tool-loop' }),
    builtinAgentTools: [tool],
    youtubeQuotaFallback: async () => options.missingKey ? undefined : { model: 'gemini-fixture', target: { apiUrl, apiKey: 'fixture-only' } },
  })
  const input = { sessionId: 'session', runId: 'run', assignmentId: 'assignment', taskId: 'task', workflowId: 'youtube-manual-generation', agentPath: 'agents/youtube-extractor', provider: 'lm-studio', model: 'primary', thinking: 'medium' as const, providerConfig: { base_url: apiUrl }, systemPrompt: 'Create the manual.', userMessage: 'Create a manual.', signal: AbortSignal.timeout(10_000) }
  return { service, input, requests, effectPath, cleanup: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await settings.closeAll(); await fs.rm(root, { recursive: true, force: true }) } }
}

test('a quota failure before tools completes the YouTube worker through Gemini once', async () => {
  const h = await harness()
  try {
    const result = await h.service.runTurn(h.input)
    assert.equal(result.kind, 'completed')
    assert.equal(result.providerSupport.provider, 'gemini-api')
    assert.match('result' in result ? result.result.text : '', /quota.*Gemini/s)
    assert.equal('result' in result && result.result.model, 'gemini-fixture')
    assert.equal(await fs.readFile(h.effectPath, 'utf8'), 'manual\n')
    assert.deepEqual(h.requests, ['primary', 'gemini-fixture', 'gemini-fixture'])
  } finally { await h.cleanup() }
})

test('a quota failure after a tool never replays the worker through Gemini', async () => {
  const h = await harness({ afterTool: true })
  try {
    await assert.rejects(h.service.runTurn(h.input))
    assert.equal(await fs.readFile(h.effectPath, 'utf8'), 'manual\n')
    assert.deepEqual(h.requests, ['primary', 'primary'])
  } finally { await h.cleanup() }
})

for (const scenario of ['missing key', 'other workflow', 'fallback exhausted'] as const) {
  test(`quota recovery stops safely for ${scenario}`, async () => {
    const h = await harness({ missingKey: scenario === 'missing key', fallbackFails: scenario === 'fallback exhausted' })
    try {
      await assert.rejects(h.service.runTurn({ ...h.input, workflowId: scenario === 'other workflow' ? 'another-workflow' : h.input.workflowId }))
      assert.deepEqual(h.requests, scenario === 'fallback exhausted' ? ['primary', 'gemini-fixture'] : ['primary'])
      await assert.rejects(fs.access(h.effectPath))
    } finally { await h.cleanup() }
  })
}


test('Gemini fallback returns its thought signature on the next tool round', async () => {
  const h = await harness({ requireSignature: true })
  try {
    const result = await h.service.runTurn(h.input)
    assert.equal(result.kind, 'completed')
    assert.equal(await fs.readFile(h.effectPath, 'utf8'), 'manual\n')
  } finally { await h.cleanup() }
})
