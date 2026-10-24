/**
 * What survives a direct-chat provider that dies.
 *
 * The incident could not be diagnosed because ordinary selected-agent chat
 * persists nothing about its provider process: `providerOutputPath` is built
 * only for Deep Research turns, so when the Codex subprocess went away there
 * was no record of how far it had got, what it last emitted, or how it ended.
 * The only durable evidence was an `agent.turn.started` with nothing after it.
 *
 * This is the record that closes that gap, and the constraint on it is as
 * important as its existence: it is a content-free account of a process, not a
 * transcript. Prompts, answers, tool results, bridge tokens and environment
 * values must not be in it — a diagnostic file that quietly accumulates the
 * conversation is a worse problem than the one it solves.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { serialCapabilityEffect } from '../../contracts/capability-effect.js'
import { initProviders } from '../../providers/index.js'
import type { BuiltinAgentToolAdapter } from '../../domains/mcp/builtin-agent-tool-adapter.js'
import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { McpParentBroker } from '../../domains/mcp/mcp-parent-broker.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import { UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE } from '../../services/capability-dispatch-lifecycle.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { McpAgentToolService } from '../../services/mcp-agent-tool-service.js'
import { runSessionAgentChatTurn } from '../../services/agent-chat-service.js'
import {
  createProviderTurnDiagnosticsRecorder,
  readProviderTurnDiagnostics,
} from '../../services/provider-turn-diagnostics-store.js'
import { seedChatSessionStore } from '../helpers/chat-session-store-fixture.js'

initProviders()

/** Sentinels that must never reach the record, one per forbidden category. */
const PROMPT_SENTINEL = 'SENTINEL-PROMPT-9f21'
const ANSWER_SENTINEL = 'SENTINEL-ANSWER-4c07'
const TOKEN_SENTINEL = 'SENTINEL-BRIDGE-TOKEN-77aa'
const ENVIRONMENT_SENTINEL = 'SENTINEL-ENVIRONMENT-1bd3'

/**
 * A Codex CLI that speaks the protocol, says something, and then dies.
 *
 * The answer it emits carries a sentinel: a diagnostic record that captured
 * provider output would contain it, and that is precisely what must not
 * happen.
 */
function writeFakeCodex(binDirectory: string): void {
  fs.mkdirSync(binDirectory, { recursive: true })
  const executable = path.join(binDirectory, 'codex')
  fs.writeFileSync(
    executable,
    [
      '#!/usr/bin/env node',
      'const say = (event) => process.stdout.write(JSON.stringify(event) + "\\n");',
      'say({ type: "thread.started", thread_id: "t-1" });',
      'say({ type: "turn.started" });',
      'say({',
      '  type: "item.completed",',
      `  item: { type: "agent_message", text: ${JSON.stringify(`Here is the answer. ${ANSWER_SENTINEL}`)} },`,
      '});',
      '// No turn.completed, and a non-zero exit: the process went away.',
      'process.exit(3);',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
}

function researchTool(): BuiltinAgentToolAdapter {
  const namespacedName = 'diagnostics.probe'
  return {
    name: namespacedName,
    tool: {
      serverId: 'builtin.diagnostics',
      serverName: 'Diagnostics',
      toolName: 'probe',
      namespacedName,
      description: 'A tool that exists so the bridge has something to offer.',
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string' } },
        required: ['action'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      risk: 'read-only',
      effect: serialCapabilityEffect('read-only'),
      requiresApproval: false,
    },
    isEnabledForAgent: () => true,
    execute: async () => ({
      output: { ok: true },
      content: JSON.stringify({ ok: true }),
      isError: false,
    }),
  }
}

test(
  'a direct-chat provider that exits leaves a content-free account of how it ended',
  { timeout: 60_000 },
  async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'direct-chat-diagnostics-')),
    )
    const assignmentPath = path.join(root, 'assignment')
    fs.mkdirSync(assignmentPath, { recursive: true })
    writeFakeCodex(path.join(root, 'bin'))

    const manager = new McpClientManager()
    const settings = new McpSettingsService({
      storagePath: path.join(root, 'mcps.json'),
      secretCodec: {
        encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
        decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
      },
      clientManager: manager,
    })
    const leases = new McpRunLeaseStore()
    const broker = new McpParentBroker({
      lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
      settingsService: settings,
      clientManager: manager,
      grantResolver: () => false,
      leaseResolver: (context) => leases.resolve(context),
    })
    const service = new McpAgentToolService({
      broker,
      leaseStore: leases,
      providerSettingsService: new ProviderSettingsService({
        storagePath: path.join(root, 'providers.json'),
      }),
      providerSupportResolver: ({ provider }) => ({
        provider,
        state: 'supported',
        mode: 'host-tool-bridge',
      }),
      builtinAgentTools: [researchTool()],
    })

    const previousPath = process.env.PATH
    const previousSentinel = process.env.PIPELINE_DIAGNOSTICS_SENTINEL
    process.env.PATH = `${path.join(root, 'bin')}${path.delimiter}${previousPath ?? ''}`
    process.env.PIPELINE_DIAGNOSTICS_SENTINEL = ENVIRONMENT_SENTINEL

    const assignmentId = randomUUID()
    try {
      await assert.rejects(
        service.runTurn({
          sessionId: randomUUID(),
          runId: randomUUID(),
          assignmentId,
          activityScopeId: assignmentId,
          agentPath: 'agents/diagnostic-agent',
          provider: 'codex',
          model: 'fake/model',
          thinking: 'low',
          cwd: assignmentPath,
          systemPrompt: `You are a diagnostic agent. ${PROMPT_SENTINEL}`,
          userMessage: `Answer this. ${PROMPT_SENTINEL}`,
          // Turned on for ordinary direct chat, which is the whole point: this
          // record did not exist outside Deep Research.
          recordProviderDiagnostics: true,
        }),
        'the fake provider really did fail the turn',
      )

      const records = readProviderTurnDiagnostics(assignmentPath, assignmentId)
      const serialized = JSON.stringify(records)

      const kinds = records.map((record) => record.kind)
      assert.ok(
        kinds.includes('provider-process-started'),
        `the record names the process start: ${serialized}`,
      )
      assert.ok(
        kinds.includes('provider-process-exited'),
        `the record names how the process ended: ${serialized}`,
      )
      assert.ok(
        kinds.includes('bridge-cleanup'),
        `the record names the bridge teardown: ${serialized}`,
      )

      const exit = records.find(
        (record) => record.kind === 'provider-process-exited',
      )
      assert.equal(
        exit?.kind === 'provider-process-exited' ? exit.exitCode : undefined,
        3,
        'the exit code is the terminal identity an operator needs',
      )
      assert.equal(
        exit?.kind === 'provider-process-exited' ? exit.lastEventType : undefined,
        'item.completed',
        'the last recognized protocol event says how far the turn got',
      )

      const protocol = records.filter(
        (record) => record.kind === 'provider-protocol-event',
      )
      assert.deepEqual(
        protocol.map((record) =>
          record.kind === 'provider-protocol-event' ? record.sequence : -1,
        ),
        [1, 2, 3],
        'every protocol event is counted, in order',
      )

      for (const sentinel of [
        PROMPT_SENTINEL,
        ANSWER_SENTINEL,
        TOKEN_SENTINEL,
        ENVIRONMENT_SENTINEL,
      ]) {
        assert.ok(
          !serialized.includes(sentinel),
          `the record leaked ${sentinel}: ${serialized}`,
        )
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousSentinel === undefined) {
        delete process.env.PIPELINE_DIAGNOSTICS_SENTINEL
      } else process.env.PIPELINE_DIAGNOSTICS_SENTINEL = previousSentinel
      await manager.closeAll?.()
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)

/**
 * How much of a long turn the record is allowed to keep.
 *
 * A tool loop can emit protocol events for as long as the model keeps working,
 * and a record that grew with them would trade one unbounded file for another
 * — this time under every assignment, written a syscall at a time on the live
 * turn's own thread. So the stream half is capped, and the ending is not: an
 * operator reading this after an incident needs the exit and the failure, and
 * those must survive whatever the loop did before them.
 */
test(
  'a long provider stream is capped without losing how the turn ended',
  { timeout: 30_000 },
  async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-cap-')),
    )
    const assignmentPath = path.join(root, 'assignment')
    fs.mkdirSync(assignmentPath, { recursive: true })
    const turnKey = randomUUID()
    try {
      const recorder = createProviderTurnDiagnosticsRecorder({
        assignmentPath,
        turnKey,
        maxProtocolEvents: 5,
      })
      assert.ok(recorder)

      recorder.record({
        kind: 'provider-process-started',
        provider: 'codex',
      })
      for (let sequence = 1; sequence <= 500; sequence += 1) {
        recorder.record({
          kind: 'provider-protocol-event',
          eventType: 'item.completed',
          sequence,
        })
      }
      recorder.record({ kind: 'bridge-cleanup', outcome: 'closed' })
      recorder.record({
        kind: 'provider-process-exited',
        exitCode: 3,
        lastEventType: 'item.completed',
      })
      recorder.record({
        kind: 'provider-failure',
        failureKind: 'process_failed',
        retryable: false,
      })

      const records = readProviderTurnDiagnostics(assignmentPath, turnKey)
      const kinds = records.map((record) => record.kind)

      assert.equal(
        kinds.filter((kind) => kind === 'provider-protocol-event').length,
        5,
        'the stream half stops at the cap',
      )
      assert.equal(
        kinds.filter((kind) => kind === 'protocol-events-truncated').length,
        1,
        'the record says once that it stopped keeping them',
      )
      for (const terminal of [
        'provider-process-started',
        'bridge-cleanup',
        'provider-process-exited',
        'provider-failure',
      ] as const) {
        assert.ok(
          kinds.includes(terminal),
          `the cap never discards ${terminal}: ${kinds.join(', ')}`,
        )
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)

/**
 * The same record, reached the way a user reaches it.
 *
 * The test above drives the MCP service directly and asks it for the record,
 * which proves the record exists but not that direct chat asks for one. This
 * one goes through `runSessionAgentChatTurn` — the function the selected-agent
 * route calls — and never mentions the flag, so it can only pass if direct
 * chat turns diagnostics on for itself.
 */
test(
  'direct selected-agent chat asks for a provider record without being told to',
  { timeout: 60_000 },
  async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'direct-chat-diagnostics-wiring-')),
    )
    const repoRootPath = path.join(root, 'project')
    const workspacePath = path.join(root, 'workspace')
    fs.mkdirSync(path.join(repoRootPath, 'agents', 'diagnostic-agent'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(repoRootPath, 'agents', 'diagnostic-agent', 'diagnostic-agent.md'),
      [
        '---',
        'name: diagnostic-agent',
        'tier: strategic',
        'provider: codex',
        'model: fake/model',
        'thinking: low',
        '---',
        '',
        '# diagnostic-agent',
        '',
        'Answer the question.',
        '',
      ].join('\n'),
      'utf8',
    )
    writeFakeCodex(path.join(root, 'bin'))

    const manager = new McpClientManager()
    const settings = new McpSettingsService({
      storagePath: path.join(root, 'mcps.json'),
      secretCodec: {
        encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
        decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
      },
      clientManager: manager,
    })
    const leases = new McpRunLeaseStore()
    const broker = new McpParentBroker({
      lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
      settingsService: settings,
      clientManager: manager,
      grantResolver: () => false,
      leaseResolver: (context) => leases.resolve(context),
    })
    const mcpAgentToolService = new McpAgentToolService({
      broker,
      leaseStore: leases,
      providerSettingsService: new ProviderSettingsService({
        storagePath: path.join(root, 'providers.json'),
      }),
      providerSupportResolver: ({ provider }) => ({
        provider,
        state: 'supported',
        mode: 'host-tool-bridge',
      }),
      builtinAgentTools: [researchTool()],
    })

    const sessionId = randomUUID()
    const assignmentPaths: string[] = []
    const assignmentIds: string[] = []
    const realStore = seedChatSessionStore(workspacePath, sessionId)
    const ensureAssignment = realStore.ensureAgentChatAssignment.bind(realStore)
    const sessionStore = Object.assign(realStore, {
      listChatMessages: async () => [],
      appendChatMessageIfAbsent: async () => 'appended' as const,
      ensureAgentChatAssignment: async (
        _id: string,
        runId: string,
        assignmentId: string,
      ) => {
        const location = await ensureAssignment(sessionId, runId, assignmentId)
        assert.ok(location, 'the real store creates the diagnostic assignment')
        assignmentPaths.push(location.assignmentPath)
        assignmentIds.push(assignmentId)
        return location
      },
      updateSessionTitle: async () => null,
      listFiles: async () => [],
    })

    const previousPath = process.env.PATH
    process.env.PATH = `${path.join(root, 'bin')}${path.delimiter}${previousPath ?? ''}`
    try {
      // The provider fails, which is the point: a failed turn is exactly when
      // the record has to exist. The turn itself converts that into safe
      // display text, so it resolves rather than throwing.
      await runSessionAgentChatTurn({
        sessionId,
        session: {
          id: sessionId,
          title: 'diagnostics wiring',
          status: 'active',
          activityType: 'chat',
          createdAt: '2026-08-31T09:00:00.000Z',
          updatedAt: '2026-08-31T09:00:00.000Z',
        },
        sessionStore,
        repoRootPath,
        text: 'Answer this.',
        agentNames: ['diagnostic-agent'],
        turnId: randomUUID(),
        mcpAgentToolService,
      })

      const assignmentPath = assignmentPaths[0]
      const assignmentId = assignmentIds[0]
      assert.ok(assignmentPath && assignmentId, 'the turn created an assignment')
      const records = readProviderTurnDiagnostics(assignmentPath, assignmentId)
      assert.ok(
        records.some((record) => record.kind === 'provider-process-exited'),
        `direct chat kept an account of its provider: ${JSON.stringify(records)}`,
      )
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      await manager.closeAll?.()
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  'a redirected diagnostics directory is refused rather than followed',
  { timeout: 30_000 },
  async () => {
    // `O_NOFOLLOW` guards the file it opens and nothing above it. A symlink
    // standing where the diagnostics directory belongs would send every write
    // wherever it points — outside the assignment, outside the workspace — and
    // the assignment's own path validation does not reach this new child.
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-symlink-')),
    )
    const assignmentPath = path.join(root, 'assignment')
    const elsewhere = path.join(root, 'elsewhere')
    fs.mkdirSync(assignmentPath, { recursive: true })
    fs.mkdirSync(elsewhere, { recursive: true })
    const turnKey = randomUUID()
    try {
      // Stand the link exactly where the recorder is about to write, and put a
      // perfectly valid record behind it. Without that, a reader that still
      // followed the link would find nothing and look innocent.
      const runtimePath = path.join(assignmentPath, '.runtime')
      fs.mkdirSync(runtimePath, { recursive: true })
      fs.symlinkSync(elsewhere, path.join(runtimePath, 'provider-turns'))
      fs.writeFileSync(
        path.join(elsewhere, `${turnKey}.jsonl`),
        `${JSON.stringify({
          kind: 'provider-process-started',
          at: '2026-08-31T09:00:00.000Z',
          provider: 'codex',
        })}\n`,
        'utf8',
      )

      const recorder = createProviderTurnDiagnosticsRecorder({
        assignmentPath,
        turnKey,
      })
      recorder?.record({
        kind: 'provider-process-started',
        provider: 'codex',
      })

      assert.deepEqual(
        fs.readdirSync(elsewhere),
        [`${turnKey}.jsonl`],
        'only the file this test planted is there; nothing was written through the link',
      )
      assert.equal(
        fs.readFileSync(path.join(elsewhere, `${turnKey}.jsonl`), 'utf8').split('\n')
          .filter((line) => line.trim() !== '').length,
        1,
        'and the planted file was not appended to',
      )
      assert.deepEqual(
        readProviderTurnDiagnostics(assignmentPath, turnKey),
        [],
        'the reader does not follow the link either, planted record or not',
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)

test('CLI errors remain recordable after the protocol-event budget is exhausted', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-error-budget-')))
  const assignmentPath = path.join(root, 'assignment')
  fs.mkdirSync(assignmentPath)
  const turnKey = randomUUID()
  try {
    const recorder = createProviderTurnDiagnosticsRecorder({ assignmentPath, turnKey, maxProtocolEvents: 1 })
    assert.ok(recorder)
    recorder.record({ kind: 'provider-protocol-event', eventType: 'stream_event', sequence: 1 })
    recorder.record({ kind: 'provider-protocol-event', eventType: 'stream_event', sequence: 2 })
    recorder.record({ kind: 'provider-cli-diagnostic', channel: 'stderr', category: 'rate_limit', statusCode: 429 })
    assert.ok(readProviderTurnDiagnostics(assignmentPath, turnKey).some((entry) => entry.kind === 'provider-cli-diagnostic'),
      'answer token events must not consume the error and retry record budget')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('an already-cancelled provider turn records its cause before awaiting provider cleanup', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-immediate-cancel-')))
  const assignmentPath = path.join(root, 'assignment')
  fs.mkdirSync(assignmentPath)
  writeFakeCodex(path.join(root, 'bin'))
  const manager = new McpClientManager()
  const settings = new McpSettingsService({ storagePath: path.join(root, 'mcps.json'), clientManager: manager,
    secretCodec: { encrypt: (value) => value, decrypt: (value) => value } })
  const leases = new McpRunLeaseStore()
  const broker = new McpParentBroker({ lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE, settingsService: settings,
    clientManager: manager, grantResolver: () => false, leaseResolver: (context) => leases.resolve(context) })
  const service = new McpAgentToolService({ broker, leaseStore: leases,
    providerSettingsService: new ProviderSettingsService({ storagePath: path.join(root, 'providers.json') }),
    providerSupportResolver: ({ provider }) => ({ provider, state: 'supported', mode: 'host-tool-bridge' }), builtinAgentTools: [researchTool()] })
  const assignmentId = randomUUID()
  const caller = new AbortController()
  caller.abort({ kind: 'provider-abort', source: 'request-disconnected' })
  const previousPath = process.env.PATH
  process.env.PATH = `${path.join(root, 'bin')}${path.delimiter}${previousPath ?? ''}`
  const operation = service.runTurn({ sessionId: randomUUID(), runId: randomUUID(), assignmentId,
    agentPath: 'agents/diagnostic-agent', provider: 'codex', model: 'default', thinking: 'low', cwd: assignmentPath,
    systemPrompt: '', userMessage: '', recordProviderDiagnostics: true, signal: caller.signal })
  try {
    assert.ok(readProviderTurnDiagnostics(assignmentPath, assignmentId).some((entry) =>
      entry.kind === 'provider-cancellation' && entry.source === 'request-disconnected' && entry.phase === 'turn'),
    'the cancellation cause must survive even if later cleanup never settles')
    await assert.rejects(operation)
  } finally {
    await operation.catch(() => undefined)
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    await manager.closeAll()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
